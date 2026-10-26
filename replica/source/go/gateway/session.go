package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const sampleRate = 24000

// client frame types
const (
	cPCM    = 1
	cSeg    = 2
	cText   = 3
	cStats  = 4
	cEnd    = 5
	cError  = 6
	cPolicy = 7
)

type ProfileInfo struct {
	Gen               map[string]float64 `json:"gen"`
	VoiceConditioning string             `json:"-"`
	Anchor            string             `json:"anchor"`
	RefText           string             `json:"ref_text"`
	VoiceBinding      string             `json:"-"`
	ModelOutputMode   string             `json:"model_output_mode,omitempty"`
	ID                string             `json:"id"`
	Name              string             `json:"name"`
	Language          string             `json:"language"`
	UnitsPerSec       float64            `json:"units_per_sec"`
	PauseClauseMs     int                `json:"pause_clause_ms"`
	PauseSentenceMs   int                `json:"pause_sentence_ms"`
	PauseParaMs       int                `json:"pause_para_ms"`
	BreathLevelDB     float64            `json:"breath_level_db"`
}

var validProfileID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func loadProfileInfo(state, id string) (*ProfileInfo, error) {
	if !validProfileID.MatchString(id) {
		return nil, fmt.Errorf("invalid profile id")
	}
	b, err := os.ReadFile(filepath.Join(state, "profiles", id, "profile.json"))
	if err != nil {
		return nil, fmt.Errorf("profile %q not found", id)
	}
	var p ProfileInfo
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	if p.ID != "" && p.ID != id {
		return nil, fmt.Errorf("profile id mismatch")
	}
	p.ID = id
	p.VoiceConditioning = configuredConditioning()
	if p.ModelOutputMode == "sentence-buffered" {
		p.VoiceConditioning = "trained-speaker-vector"
	}
	if p.Anchor != "" {
		pin, e := referenceBinding(filepath.Join(state, "profiles", id), &p)
		if e != nil && os.Getenv("QTTS_MOCK") != "1" {
			return nil, e
		}
		p.VoiceBinding = pin
	}
	return &p, nil
}

func configuredConditioning() string {
	if os.Getenv("QTTS_MOCK") == "1" {
		return "mock"
	}
	if env("QTTS_TTS_ENGINE", "faster") == "qwen-adapter-buffered" {
		return "trained-speaker-vector"
	}
	mode, present := os.LookupEnv("QTTS_CLONE_MODE")
	if !present { mode = "xvector" }
	if strings.ToLower(strings.TrimSpace(mode)) == "xvector" {
		return "speaker-vector-only"
	}
	return "icl-generated-only-codec"
}

// Must match Python voice_binding.reference_binding byte-for-byte.
func referenceBinding(dir string, p *ProfileInfo) (string, error) {
	if p.Anchor == "" || filepath.Base(p.Anchor) != p.Anchor || p.Anchor == "." || p.Anchor == ".." || strings.Contains(p.Anchor, "\\") {
		return "", fmt.Errorf("voice anchor must be a single safe filename")
	}
	f, err := os.OpenFile(filepath.Join(dir, p.Anchor), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Size() <= 0 || st.Size() > 64*1024*1024 {
		return "", fmt.Errorf("invalid reference file size/type")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 64*1024*1024+1))
	if err != nil {
		return "", err
	}
	if int64(len(raw)) != st.Size() {
		return "", fmt.Errorf("reference changed while reading")
	}
	h := sha256.New()
	h.Write([]byte("qtts-voice-v2\x00"))
	generation, err := generationBytes(p.Gen)
	if err != nil {
		return "", err
	}
	for _, part := range [][]byte{raw, []byte(p.RefText), []byte(p.Language), generation} {
		var length [8]byte
		binary.LittleEndian.PutUint64(length[:], uint64(len(part)))
		h.Write(length[:])
		h.Write(part)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func generationBytes(g map[string]float64) ([]byte, error) {
	keys := []string{"temperature", "top_k", "top_p", "repetition_penalty"}
	defaults := []float64{.8, 50, 1, 1.05}
	out := make([]byte, 32)
	for i, k := range keys {
		v, ok := g[k]
		if !ok {
			v = defaults[i]
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("non-finite generation parameter")
		}
		valid := true
		switch k {
		case "temperature":
			valid = v > 0 && v <= 2
		case "top_k":
			valid = v >= 0 && v <= 4096 && math.Trunc(v) == v
		case "top_p":
			valid = v > 0 && v <= 1
		case "repetition_penalty":
			valid = v > 0 && v <= 4
		}
		if !valid {
			return nil, fmt.Errorf("invalid generation parameter: %s", k)
		}
		if v == 0 {
			v = 0
		}
		binary.LittleEndian.PutUint64(out[i*8:], math.Float64bits(v))
	}
	return out, nil
}

func activeProfileID(state string) string {
	b, err := os.ReadFile(filepath.Join(state, "active.json"))
	if err != nil {
		return ""
	}
	var a struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &a)
	return a.ID
}

type Policy struct {
	Low   float64 `json:"low_s"`
	High  float64 `json:"high_s"`
	Start float64 `json:"start_s"`
	Agg   float64 `json:"agg_rtf"`
}

// policyFor maps the measured aggregate throughput (x real time) to watermark seconds.
// Slower systems need more cushion; hysteresis (mid-point resume) lives in allowDispatch.
func policyFor(agg float64, underruns int) Policy {
	var p Policy
	switch {
	case agg >= 2.2:
		p = Policy{Low: 3.5, High: 36, Start: 1.3}
	case agg >= 1.5:
		p = Policy{Low: 5, High: 42, Start: 2.0}
	case agg >= 1.0:
		p = Policy{Low: 7, High: 50, Start: 3.5}
	default:
		p = Policy{Low: 10, High: 60, Start: 6}
	}
	p.Low += math.Min(float64(underruns)*1.5, 6)
	p.Start += math.Min(float64(underruns), 3)
	p.Agg = agg
	return p
}

type SpeakReq struct {
	QualityPolicy string    `json:"quality_policy"`
	TestSeed      *int64    `json:"test_seed"`
	Text          string    `json:"text"`
	Mode          string    `json:"mode"` // "chat" (LLM answers) | "read" (speak text verbatim)
	Profile       string    `json:"profile"`
	Language      string    `json:"language"`
	History       []ChatMsg `json:"history"`
	System        string    `json:"system"`
}

type Session struct {
    requestMode string
	qualityPolicy    string
	diagnosticClient map[string]any
	diagnosticDeltas int
	ID               string
	ctx              context.Context
	cancel           context.CancelFunc
	t0               time.Time
	profile          *ProfileInfo
	lang             string
	seed             int64
	sched            *Scheduler
	seg              *Segmenter

	mu           sync.Mutex
	jobs         []*Job
	texts        []string
	allSubmitted bool
	wake         chan struct{}
	produced     int64
	headIdx      int
	played       float64
	clientBuf    float64
	clientState  string
	lastTelem    time.Time
	urgency      float64
	underruns    int
	throttled    bool
	timeline     map[string]float64
	segStats     []map[string]any
	llmErr       string
	chars        int
	firstPlayed  float64
}

func (s *Session) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Session) mark(name string) {
	s.mu.Lock()
	if _, ok := s.timeline[name]; !ok {
		s.timeline[name] = float64(time.Since(s.t0).Microseconds()) / 1000
	}
	s.mu.Unlock()
}

func (s *Session) addProduced(n int64) {
	s.mu.Lock()
	s.produced += n
	if s.produced < 0 {
		s.produced = 0
	}
	s.mu.Unlock()
}

func (s *Session) isUrgent() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.urgency > 0.6
}

// aheadLocked = seconds of audio produced but not yet played by the client.
func (s *Session) aheadLocked() float64 {
	if s.lastTelem.IsZero() {
		return float64(s.produced)/sampleRate - 0
	}
	played := s.played
	if s.clientState == "playing" {
		played += math.Min(time.Since(s.lastTelem).Seconds(), 1.0)
	}
	return float64(s.produced)/sampleRate - played
}

func (s *Session) policyLocked() Policy { return policyFor(s.sched.AggRTF(), s.underruns) }

// allowDispatch implements the dynamic high/low watermark with hysteresis:
//   - the next two segments are never gated (a GPU is never idle while the client needs data)
//   - generation pauses only when the client holds >= High seconds, and resumes at the mid-point,
//     long before Low, so the GPUs never oscillate generate/stop/generate/stop near starvation.
func (s *Session) allowDispatch(j *Job) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	// head-of-line: the first two segments always go (fast start, both GPUs busy immediately).
	// Beyond that the gate looks ONLY at what the client has really buffered (produced - played),
	// never at forwarding progress (forwarding is instant and says nothing about playback).
	if j.seg.Index <= 1 {
		return true
	}
	if s.lastTelem.IsZero() || time.Since(s.lastTelem) > 2500*time.Millisecond {
		return true
	}
	p := s.policyLocked()
	ahead := s.aheadLocked()
	if s.throttled {
		if ahead <= p.High*0.55 { // wide hysteresis band: duty cycle of tens of seconds, no chatter
			s.throttled = false
		}
	} else if ahead >= p.High {
		s.throttled = true
	}
	return !s.throttled
}

func (s *Session) chunkSize(idx int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if idx == 0 {
		// Opt-in experiment: do not claim a real TTFA improvement without GPU A/B.
		if n, err := strconv.Atoi(os.Getenv("QTTS_FIRST_CHUNK_SIZE")); err == nil && n >= 2 && n <= 8 {
			return n
		}
		return 4
	}
	p := s.policyLocked()
	ahead := s.aheadLocked()
	switch {
	case s.urgency > 0.6 || ahead < p.Low:
		return 6
	case ahead > (p.Low+p.High)/2:
		return 12
	}
	return 8
}

func (s *Session) pushText(t string) {
	s.mu.Lock()
	s.texts = append(s.texts, t)
	s.chars += len([]rune(t))
	s.diagnosticDeltas++
	s.mu.Unlock()
	s.signal()
}

func (s *Session) submit(seg Segment) {
	j := &Job{sess: s, seg: seg, buf: &SegBuf{wake: s.wake}, tried: map[int]bool{}}
	s.mu.Lock()
	s.jobs = append(s.jobs, j)
	s.mu.Unlock()
	s.mark("first_segment")
	s.sched.Submit(j)
	s.signal()
}

func (s *Session) finishSubmit() {
	s.mu.Lock()
	s.allSubmitted = true
	s.mu.Unlock()
	s.signal()
}

func (s *Session) telemetry(t Telemetry) {
	s.mu.Lock()
	s.played = t.PlayedS
	s.clientBuf = t.BufferedS
	s.clientState = t.State
	s.urgency = t.Urgency
	if t.Underruns > s.underruns {
		s.underruns = t.Underruns
	}
	if t.FirstPlayedMs > 0 && s.firstPlayed == 0 {
		s.firstPlayed = t.FirstPlayedMs
	}
	s.lastTelem = time.Now()
	s.mu.Unlock()
	s.signal()
}

type Telemetry struct {
	Session       string  `json:"session"`
	PlayedS       float64 `json:"played_s"`
	BufferedS     float64 `json:"buffered_s"`
	State         string  `json:"state"`
	Urgency       float64 `json:"urgency"`
	Underruns     int     `json:"underruns"`
	FirstPlayedMs float64 `json:"first_played_ms"`
}

// produce runs the LLM (or just feeds the text) and cuts it into segments.
func (s *Session) produce(cfg *Config, req SpeakReq, key string) {
	defer s.finishSubmit()
	feed := func(d string) {
		for _, sg := range s.seg.Feed(d) {
			s.submit(sg)
		}
	}
	if req.Mode == "read" {
		s.mark("read_text_ready")
		feed(req.Text)
		for _, sg := range s.seg.Flush() {
			s.submit(sg)
		}
		return
	}
	sys := req.System
	if sys == "" {
		sys = defaultSystemPrompt
	}
	msgs := []ChatMsg{{Role: "system", Content: sys}}
	msgs = append(msgs, req.History...)
	msgs = append(msgs, ChatMsg{Role: "user", Content: req.Text})
	first := true
	s.mark("llm_request_start")
	ctx := context.WithValue(s.ctx, diagnosticMarkKey{}, s.mark)
	err := StreamLLM(ctx, cfg, key, msgs, func(d string) {
		if first {
			first = false
			s.mark("llm_first_token")
		}
		s.pushText(d)
		feed(d)
	})
	if err != nil && s.ctx.Err() == nil {
		s.mu.Lock()
		s.llmErr = err.Error()
		s.mu.Unlock()
		s.signal()
	}
	for _, sg := range s.seg.Flush() {
		s.submit(sg)
	}
	s.mark("llm_done")
}

func writeFrame(w http.ResponseWriter, f http.Flusher, typ byte, seg uint32, payload []byte) error {
	b := make([]byte, 9+len(payload))
	b[0] = typ
	binary.LittleEndian.PutUint32(b[1:], seg)
	binary.LittleEndian.PutUint32(b[5:], uint32(len(payload)))
	copy(b[9:], payload)
	if _, err := w.Write(b); err != nil {
		return err
	}
	f.Flush()
	return nil
}

func jsonFrame(w http.ResponseWriter, f http.Flusher, typ byte, seg uint32, v any) error {
	b, _ := json.Marshal(v)
	return writeFrame(w, f, typ, seg, b)
}

// serve is the ordered forwarder: it streams segment i's audio as it is produced, then moves on to
// segment i+1 (whose audio is typically already buffered because the other GPU worked on it).
func (s *Session) serve(w http.ResponseWriter, f http.Flusher, m *Metrics) {
	defer s.cancel()
	cur := 0
	var curJob *Job
	sentSamples := int64(0)
	firstAudioSent := false
	var errs []string
	recorded := false
	defer func() {
		if !recorded {
			s.mark("stream_interrupted")
			run := s.summary(sentSamples, errs)
			run["generation_completed"] = false
			run["stream_interrupted"] = true
			m.record(run)
		}
	}()
	policySent := time.Time{}
	finalPass := false
	pol := func() {
		s.mu.Lock()
		p := s.policyLocked()
		s.mu.Unlock()
		_ = jsonFrame(w, f, cPolicy, 0, p)
		policySent = time.Now()
	}
	pol()
	for {
		if s.ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		texts := s.texts
		s.texts = nil
		llmErr := s.llmErr
		s.llmErr = ""
		s.mu.Unlock()
		for _, t := range texts {
			if err := jsonFrame(w, f, cText, 0, map[string]string{"t": t}); err != nil {
				return
			}
		}
		if llmErr != "" {
			errs = append(errs, llmErr)
			_ = jsonFrame(w, f, cError, 0, map[string]string{"error": llmErr, "stage": "llm"})
		}
		if curJob == nil {
			s.mu.Lock()
			if cur < len(s.jobs) {
				curJob = s.jobs[cur]
				s.headIdx = cur
			}
			done := s.allSubmitted && cur >= len(s.jobs)
			s.mu.Unlock()
			if curJob != nil {
				if err := jsonFrame(w, f, cSeg, uint32(cur), curJob.seg); err != nil {
					return
				}
				if time.Since(policySent) > 700*time.Millisecond {
					pol()
				}
			} else if done {
				// everything was submitted before allSubmitted flipped: one more pass drains
				// any text / LLM error that raced with the flag, then we finish.
				if finalPass {
					break
				}
				finalPass = true
				continue
			}
		}
		if curJob != nil {
			frames, done, jerr, stats := curJob.buf.take()
			for _, fr := range frames {
				if err := writeFrame(w, f, cPCM, uint32(cur), fr); err != nil {
					return
				}
				sentSamples += int64(len(fr) / 2)
				if !firstAudioSent {
					firstAudioSent = true
					s.mark("first_audio_sent")
				}
			}
			if done {
				if jerr != "" && jerr != "cancelled" {
					errs = append(errs, fmt.Sprintf("seg %d: %s", cur, jerr))
					_ = jsonFrame(w, f, cError, uint32(cur), map[string]string{"error": jerr, "stage": "tts"})
				}
				if stats != nil {
					s.mu.Lock()
					s.segStats = append(s.segStats, stats)
					s.mu.Unlock()
					_ = jsonFrame(w, f, cStats, uint32(cur), stats)
				}
				cur++
				curJob = nil
				continue
			}
		}
		select {
		case <-s.wake:
		case <-s.ctx.Done():
			return
		case <-time.After(400 * time.Millisecond):
		}
	}
	s.mark("all_audio_sent")
	run := s.summary(sentSamples, errs)
	run["generation_completed"] = true
	run["stream_interrupted"] = false
	m.record(run)
	recorded = true
	_ = jsonFrame(w, f, cEnd, 0, run)
}

func (s *Session) summary(sent int64, errs []string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	per := map[string]map[string]float64{}
	var anomalies []string
	for _, st := range s.segStats {
		g := fmt.Sprintf("gpu%v", st["gpu"])
		if per[g] == nil {
			per[g] = map[string]float64{}
		}
		per[g]["segments"]++
		if v, ok := st["audio_s"].(float64); ok {
			per[g]["audio_s"] += v
		}
		if v, ok := st["gen_ms"].(float64); ok {
			per[g]["gen_s"] += v / 1000
		}
		if v, ok := st["gain_db"].(float64); ok {
			per[g]["gain_db_sum"] += v
		}
		if v, ok := st["first_chunk_ms"].(float64); ok {
			per[g]["first_chunk_ms_sum"] += v
		}
		if a, ok := st["anomalies"].([]any); ok {
			for _, x := range a {
				anomalies = append(anomalies, fmt.Sprint(x))
			}
		}
	}
	for _, v := range per {
		if v["gen_s"] > 0 {
			v["rtf_x"] = math.Round(v["audio_s"]/v["gen_s"]*1000) / 1000
			if v["audio_s"] > 0 {
				v["rtf"] = math.Round(v["gen_s"]/v["audio_s"]*10000) / 10000
			}
		}
		if v["segments"] > 0 {
			v["gain_db_mean"] = math.Round(v["gain_db_sum"]/v["segments"]*100) / 100
			v["first_chunk_ms_mean"] = math.Round(v["first_chunk_ms_sum"] / v["segments"])
		}
		delete(v, "gain_db_sum")
		delete(v, "first_chunk_ms_sum")
	}
	timeline := map[string]float64{}
	for key, value := range s.timeline {
		timeline[key] = value
	}
	audio := float64(sent) / sampleRate
	wall := time.Since(s.t0).Seconds()
	return map[string]any{
		"request_mode": s.requestMode, "content_source": diagnosticContentSource(s.requestMode), "source_build_id": runtimeSourceID, "source_build_attested": false, "acoustic_text_verified": false,
        "session": s.ID, "at": time.Now().Format(time.RFC3339), "chars": s.chars, "segments": len(s.jobs),
		"audio_s": math.Round(audio*100) / 100, "wall_s": math.Round(wall*100) / 100,
		"overall_rtf_x":       math.Round(audio/math.Max(wall, 0.001)*100) / 100,
		"diagnostic_segments": diagnosticRetain(s.segStats), "diagnostic_segments_total": len(s.segStats), "diagnostic_segments_truncated": len(s.segStats) > 32, "client": s.diagnosticClient,
		"llm_delta_count": s.diagnosticDeltas, "llm_error": s.llmErr != "", "error_count": len(errs),
		"timeline_ms": timeline, "per_gpu": per, "anomalies": anomalies, "errors": errs,
		"underruns": s.underruns, "client_first_played_ms": s.firstPlayed, "profile": s.profile.ID,
		"policy": policyFor(s.sched.AggRTF(), s.underruns),
	}
}

// ------------------------------------------------------------------------------------------
// Metrics + session registry
// ------------------------------------------------------------------------------------------

type Metrics struct {
	mu       sync.Mutex
	runs     []map[string]any
	sessions map[string]*Session
	total    int
}

func NewMetrics() *Metrics { return &Metrics{sessions: map[string]*Session{}} }

func (m *Metrics) register(s *Session) {
	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()
}

func (m *Metrics) unregister(id string) {
	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()
}

func (m *Metrics) get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *Metrics) record(run map[string]any) {
	m.mu.Lock()
	if id, ok := run["session"].(string); ok {
		if s := m.sessions[id]; s != nil {
			s.mu.Lock()
			if diagnosticSequence(s.diagnosticClient) >= diagnosticSequenceClient(run["client"]) {
				run["client"] = s.diagnosticClient
			}
			s.mu.Unlock()
		}
	}
	m.runs = append(m.runs, run)
	if len(m.runs) > 100 {
		m.runs = m.runs[len(m.runs)-100:]
	}
	m.total++
	m.mu.Unlock()
}

func (m *Metrics) mergeClient(id string, patch map[string]any) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := len(m.runs) - 1; i >= 0; i-- {
		if m.runs[i]["session"] == id {
			m.runs[i]["client"] = patch
			return true
		}
	}
	return false
}

func (m *Metrics) snapshot() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	runs := append([]map[string]any(nil), m.runs...)
	// stage summary: median of key timeline marks across recent runs
	stages := map[string][]float64{}
	for _, r := range runs {
		if tl, ok := r["timeline_ms"].(map[string]float64); ok {
			for k, v := range tl {
				stages[k] = append(stages[k], v)
			}
		}
	}
	med := map[string]float64{}
	for k, v := range stages {
		sort.Float64s(v)
		med[k] = v[len(v)/2]
	}
	return map[string]any{"total_runs": m.total, "runs": diagnosticCloneRuns(runs), "stage_median_ms": med, "active_sessions": len(m.sessions)}
}

var errNoProfile = errors.New("no voice profile selected: create one in the Voice Lab first")
