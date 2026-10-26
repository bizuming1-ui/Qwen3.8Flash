package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Bind         string
	Port         int
	WorkerURLs   []string
	AnalystURL   string
	WebDir       string
	StateDir     string
	LLMKey       string
	LLMBase      string
	LLMModel     string
	LLMMaxTokens int
	AccessToken  string
}

func env(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func loadConfig() *Config {
	c := &Config{
		Bind:        env("QTTS_BIND", "127.0.0.1"),
		StateDir:    env("QTTS_STATE", "./state"),
		WebDir:      env("QTTS_WEB", "./web"),
		LLMKey:      env("DEEPSEEK_API_KEY", ""),
		LLMBase:     env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
		LLMModel:    env("DEEPSEEK_MODEL", "deepseek-chat"),
		AccessToken: os.Getenv("QTTS_ACCESS_TOKEN"),
	}
	c.LLMMaxTokens, _ = strconv.Atoi(env("DEEPSEEK_MAX_TOKENS", "8192"))
	if c.LLMMaxTokens < 1 || c.LLMMaxTokens > 65536 {
		c.LLMMaxTokens = 8192
	}
	c.Port, _ = strconv.Atoi(env("QTTS_GATEWAY_PORT", "7860"))
	for _, p := range strings.Split(env("QTTS_WORKER_PORTS", "7001,7002"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			c.WorkerURLs = append(c.WorkerURLs, "http://127.0.0.1:"+p)
		}
	}
	c.AnalystURL = "http://127.0.0.1:" + env("QTTS_ANALYST_PORT", "7010")
	return c
}

type App struct {
	cfg        *Config
	sched      *Scheduler
	metrics    *Metrics
	activateMu sync.Mutex
	guard      *Guard
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func detectLang(s string) string {
	cjk, kana, hangul, latin := 0, 0, 0, 0
	for _, r := range s {
		switch {
		case r >= 0x3040 && r <= 0x30ff:
			kana++
		case r >= 0xac00 && r <= 0xd7af:
			hangul++
		case r >= 0x3400 && r <= 0x9fff:
			cjk++
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			latin++
		}
	}
	switch {
	case kana > 0 && float64(kana) >= float64(cjk)*0.2:
		return "Japanese"
	case hangul > cjk && hangul > 0:
		return "Korean"
	case cjk > 0 && float64(cjk) >= float64(latin)*0.35:
		return "Chinese"
	}
	return "English"
}

func (a *App) newSession(ctx context.Context, req SpeakReq, prof *ProfileInfo) *Session {
	cctx, cancel := context.WithCancel(ctx)
	lang := req.Language
	if lang == "" || strings.EqualFold(lang, "auto") {
		lang = detectLang(req.Text)
	}
	seed := time.Now().UnixNano() & 0x3fffffff
	if req.TestSeed != nil {
		seed = *req.TestSeed
	}
	policy := req.QualityPolicy
	if policy == "" {
		policy = "legacy-stream"
	}
	segCfg := ReadSegCfg(prof)
	if req.Mode != "read" {
		segCfg = LiveSegCfg(prof)
	}
	return &Session{
        requestMode: diagnosticMode(req.Mode),
		qualityPolicy: policy,
		ID:            newID(), ctx: cctx, cancel: cancel, t0: time.Now(), profile: prof, lang: lang, seed: seed,
		sched: a.sched, seg: NewSegmenter(segCfg, seed), wake: make(chan struct{}, 1),
		timeline: map[string]float64{},
	}
}

func (a *App) speak(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	var req SpeakReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if (req.QualityPolicy != "" && req.QualityPolicy != "legacy-stream" && req.QualityPolicy != "sentence-linear" && req.QualityPolicy != "sentence-agc" && req.QualityPolicy != "sentence-agc-headroom" && req.QualityPolicy != "windowed-linear") || (req.TestSeed != nil && (*req.TestSeed < 0 || *req.TestSeed > 2147483647)) {
		writeJSON(w, 400, map[string]string{"error": "unsupported quality policy or test seed"})
		return
	}
	if err := validateSpeak(req, a.requestLimits()); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		writeJSON(w, 400, map[string]string{"error": "text is empty"})
		return
	}
	if req.Mode != "read" {
		req.Mode = "chat"
	}
	pid := req.Profile
	if pid == "" {
		pid = activeProfileID(a.cfg.StateDir)
	}
	if pid == "" {
		writeJSON(w, 400, map[string]string{"error": errNoProfile.Error()})
		return
	}
	prof, err := loadProfileInfo(a.cfg.StateDir, pid)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, 500, map[string]string{"error": "streaming unsupported"})
		return
	}
	sess := a.newSession(r.Context(), req, prof)
	defer sess.cancel()
	a.metrics.register(sess)
	defer a.metrics.unregister(sess.ID)
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	h.Set("X-Session-Id", sess.ID)
	h.Set("Access-Control-Expose-Headers", "X-Session-Id")
	w.WriteHeader(200)
	fl.Flush()

	key := r.Header.Get("X-DeepSeek-Key")
	if key == "" {
		key = a.cfg.LLMKey
	}
	go sess.produce(a.cfg, req, key)
	sess.serve(w, fl, a.metrics)
}

func (a *App) telemetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	var t Telemetry
	if !decodeJSON(w, r, &t) {
		return
	}
	s := a.metrics.get(t.Session)
	if s == nil {
		writeJSON(w, 404, map[string]string{"error": "no such session"})
		return
	}
	s.telemetry(t)
	w.WriteHeader(204)
}

func (a *App) report(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	var m map[string]any
	if !decodeJSON(w, r, &m) {
		return
	}
	id, _ := m["session"].(string)
	writeJSON(w, 200, map[string]bool{"merged": a.metrics.mergeDiagnosticClient(id, m)})
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	ws := a.sched.Snapshots()
	healthy := 0
	for _, x := range ws {
		if b, _ := x["healthy"].(bool); b {
			healthy++
		}
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "workers_total": len(ws), "workers_healthy": healthy, "workers": ws,
		"agg_rtf": a.sched.AggRTF(), "policy": policyFor(a.sched.AggRTF(), 0),
		"llm_key_set": a.cfg.LLMKey != "", "llm_model": a.cfg.LLMModel,
		"active_profile": activeProfileID(a.cfg.StateDir),
	})
}

func (a *App) listProfiles(w http.ResponseWriter, r *http.Request) {
	dir := filepath.Join(a.cfg.StateDir, "profiles")
	ents, _ := os.ReadDir(dir)
	out := []map[string]any{}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name(), "profile.json"))
		if err != nil {
			continue
		}
		var m map[string]any
		if json.Unmarshal(b, &m) == nil {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]["created"]) > fmt.Sprint(out[j]["created"]) })
	writeJSON(w, 200, map[string]any{"profiles": out, "active": activeProfileID(a.cfg.StateDir)})
}

// activate selects the profile and makes every GPU worker build its voice-clone prompt cache.
func (a *App) activate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	a.activateMu.Lock()
	defer a.activateMu.Unlock()
	var req struct {
		ID string `json:"id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.ID == "" {
		writeJSON(w, 400, map[string]string{"error": "id required"})
		return
	}

	profile, err := loadProfileInfo(a.cfg.StateDir, req.ID)
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": err.Error()})
		return
	}
	res := make([]map[string]any, len(a.cfg.WorkerURLs))
	var wg sync.WaitGroup
	hc := &http.Client{Timeout: 10 * time.Minute}
	for i, u := range a.cfg.WorkerURLs {
		wg.Add(1)
		go func(i int, u string) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]string{"profile": req.ID})
			request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, u+"/profile/load", bytes.NewReader(body))
			if err != nil {
				res[i] = map[string]any{"ok": false}
				return
			}
			request.Header.Set("Content-Type", "application/json")
			resp, err := hc.Do(request)
			if err != nil {
				res[i] = map[string]any{"ok": false, "error": err.Error()}
				return
			}
			defer resp.Body.Close()
			var m map[string]any
			err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m)
			if err != nil || resp.StatusCode != http.StatusOK || m["ok"] != true {
				res[i] = map[string]any{"ok": false, "error": "worker did not confirm profile load", "status": resp.StatusCode}
				return
			}
			res[i] = m
		}(i, u)
	}
	wg.Wait()
	if len(res) == 0 {
		writeJSON(w, 503, map[string]string{"error": "no workers configured"})
		return
	}
	for _, result := range res {
		if result["ok"] != true || (profile.VoiceBinding != "" && result["voice_binding"] != profile.VoiceBinding) || (profile.VoiceBinding != "" && result["voice_conditioning"] != profile.VoiceConditioning) {
			writeJSON(w, 503, map[string]any{"error": "voice activation failed; previous active voice retained", "workers": res})
			return
		}
	}
	current, err := loadProfileInfo(a.cfg.StateDir, req.ID)
	if err != nil || current.VoiceBinding != profile.VoiceBinding {
		writeJSON(w, 503, map[string]string{"error": "reference changed during activation; retry new session"})
		return
	}
	b, _ := json.Marshal(map[string]string{"id": req.ID})
	tmp, err := os.CreateTemp(a.cfg.StateDir, ".active-*.tmp")
	if err == nil {
		defer os.Remove(tmp.Name())
		_, err = tmp.Write(b)
		closeErr := tmp.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(tmp.Name(), filepath.Join(a.cfg.StateDir, "active.json"))
		}
	}
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "could not save active voice"})
		return
	}
	writeJSON(w, 200, map[string]any{"active": req.ID, "workers": res})
}

func (a *App) proxy() http.Handler {
	u, _ := url.Parse(a.cfg.AnalystURL)
	rp := httputil.NewSingleHostReverseProxy(u)
	rp.FlushInterval = -1
	orig := rp.Director
	rp.Director = func(r *http.Request) {
		orig(r)
		for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie", "X-DeepSeek-Key"} {
			r.Header.Del(name)
		}
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/prep")
		if r.URL.Path == "" {
			r.URL.Path = "/"
		}
		r.Host = u.Host
	}
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, 413, map[string]string{"error": "upload exceeds configured request limit"})
			return
		}
		writeJSON(w, 502, map[string]string{"error": "analyst service unavailable or request interrupted"})
	}
	return rp
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Host, r.Host) {
				writeJSON(w, 403, map[string]string{"error": "cross-origin requests are not allowed"})
				return
			}
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-DeepSeek-Key")
			h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) preflight(w http.ResponseWriter, r *http.Request) {
	file, err := os.Open(filepath.Join(a.cfg.StateDir, "backend_probe.json"))
	if os.IsNotExist(err) {
		writeJSON(w, 200, map[string]any{"status": "not_run", "model_loaded": false, "inference_verified": false, "training_verified": false, "performance_verified": false})
		return
	}
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "probe report unavailable"})
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, (256<<10)+1))
	var report map[string]any
	if err != nil || len(raw) > 256<<10 || json.Unmarshal(raw, &report) != nil || report == nil {
		writeJSON(w, 500, map[string]string{"error": "invalid or oversized probe report"})
		return
	}
	writeJSON(w, 200, report)
}

func (a *App) routes() http.Handler {
	api := http.NewServeMux()
	getOnly := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				writeJSON(w, 405, map[string]string{"error": "GET only"})
				return
			}
			fn(w, r)
		}
	}
	api.HandleFunc("/api/health", getOnly(a.health))
	api.HandleFunc("/api/preflight", getOnly(a.preflight))
	api.HandleFunc("/api/workers", getOnly(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.sched.Snapshots()) }))
	api.HandleFunc("/api/metrics", getOnly(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.metrics.snapshot()) }))
	api.HandleFunc("/api/diagnostics", getOnly(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.metrics.diagnosticSnapshot()) }))
	api.HandleFunc("/api/profiles", getOnly(a.listProfiles))
	api.HandleFunc("/api/speak", a.speak)
	api.HandleFunc("/api/telemetry", a.telemetry)
	api.HandleFunc("/api/report", a.report)
	api.HandleFunc("/api/profiles/activate", a.activate)
	api.Handle("/api/prep/", a.proxy())
	api.HandleFunc("/api/session/issue", a.guard.issueEntry)
	api.HandleFunc("/api/session/status", a.guard.sessionStatus)
	api.HandleFunc("/api/session/logout", a.guard.logoutEntry)
	mux := http.NewServeMux()
	if a.guard != nil {
		mux.HandleFunc("/api/session/exchange", a.guard.exchangeEntry)
	}
	mux.Handle("/api/", a.guard.middleware(api))
	mux.Handle("/api", a.guard.middleware(api))
	fs := http.FileServer(http.Dir(a.cfg.WebDir))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path != "/" && r.URL.Path != "/index.html" && r.URL.Path != "/app.js" && r.URL.Path != "/recorder.js" && r.URL.Path != "/diagnostic-trace.js") || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Referrer-Policy", "no-referrer")
		fs.ServeHTTP(w, r)
	}))
	return cors(mux)
}

func main() {
	cfg := loadConfig()
	guard, err := newGuard(cfg.AccessToken)
	if err != nil {
		log.Fatal(err)
	}
	sched := NewScheduler(cfg.WorkerURLs)
	sched.Start()
	app := &App{cfg: cfg, sched: sched, metrics: NewMetrics(), guard: guard}
	go PreconnectLLM(cfg.LLMBase)
	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port),
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("qtts gateway on %s  workers=%v analyst=%s web=%s llm_key=%v", srv.Addr, cfg.WorkerURLs, cfg.AnalystURL, cfg.WebDir, cfg.LLMKey != "")
	log.Fatal(srv.ListenAndServe())
}
