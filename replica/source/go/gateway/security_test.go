package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testAccessToken = "not-a-real-secret-012345678901234567890123456789"

func testGuard(t *testing.T) *Guard {
	t.Helper()
	g, err := newGuard(testAccessToken)
	if err != nil {
		t.Fatal(err)
	}
	return g
}
func authed(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testAccessToken)
	return r
}
func TestAccessTokenConfigurationFailsClosed(t *testing.T) {
	for _, token := range []string{"", "short", strings.Repeat("a", 257), strings.Repeat("中", 32), strings.Repeat(" ", 40)} {
		if _, err := newGuard(token); err == nil {
			t.Fatal("accepted invalid token")
		}
	}
	t.Setenv("QTTS_MAX_UPLOAD_BYTES", "invalid")
	if _, err := newGuard(testAccessToken); err == nil {
		t.Fatal("invalid budget silently accepted")
	}
}
func TestAPIAuthRejectsAnonymousWrongQueryAndDuplicateCredentials(t *testing.T) {
	g := testGuard(t)
	calls := 0
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	for _, auth := range []string{"", "Bearer wrong", testAccessToken, "Basic " + testAccessToken} {
		r := httptest.NewRequest("GET", "/api/profiles?token="+testAccessToken, nil)
		r.Header.Set("Authorization", auth)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		if rr.Code != 401 {
			t.Fatal(rr.Code)
		}
	}
	req := authed("GET", "/api/profiles", "")
	req.Header.Add("Authorization", "Bearer "+testAccessToken)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 401 {
		t.Fatal(rr.Code)
	}
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, authed("GET", "/api/profiles", ""))
	if rr.Code != 204 || calls != 1 {
		t.Fatalf("status=%d calls=%d", rr.Code, calls)
	}
}
func TestAuthFailureBudgetDoesNotLockOutValidOwner(t *testing.T) {
	g := testGuard(t)
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	var last int
	for i := 0; i < 11; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/profiles", nil))
		last = rr.Code
	}
	if last != 429 {
		t.Fatal(last)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, authed("GET", "/api/profiles", ""))
	if rr.Code != 204 {
		t.Fatal(rr.Code)
	}
}
func TestGatewayRoutesProtectEveryAPIAndWhitelistStaticAssets(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "index.html"), []byte("public shell"), 0600)
	os.WriteFile(filepath.Join(d, "private.txt"), []byte("private"), 0600)
	a := &App{cfg: &Config{WebDir: d, StateDir: d, AnalystURL: "http://127.0.0.1:1"}, guard: testGuard(t), metrics: NewMetrics()}
	h := a.routes()
	for _, path := range []string{"/api", "/api/health", "/api/preflight", "/api/profiles", "/api/workers", "/api/metrics", "/api/speak", "/api/profiles/activate", "/api/prep/profiles", "/api/prep/jobs/x"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != 401 {
			t.Fatalf("%s status=%d", path, rr.Code)
		}
	}
	for _, tc := range []struct {
		path string
		want int
	}{{"/", 200}, {"/private.txt", 404}, {"/.env", 404}} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", tc.path, nil))
		if rr.Code != tc.want {
			t.Fatal(tc.path, rr.Code)
		}
	}
	a.guard = nil
	rr := httptest.NewRecorder()
	a.routes().ServeHTTP(rr, authed("GET", "/api/profiles", ""))
	if rr.Code != 503 {
		t.Fatal("nil guard is not closed", rr.Code)
	}
}
func TestJSONKnownAndChunkedBodyBudgetsAndTrailingGarbage(t *testing.T) {
	g := testGuard(t)
	g.limits.JSONBytes = 32
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if decodeJSON(w, r, &body) {
			w.WriteHeader(204)
		}
	}))
	for _, tc := range []struct {
		body    string
		unknown bool
		want    int
	}{
		{`{"v":"` + strings.Repeat("x", 40) + `"}`, false, 413},
		{`{"v":"` + strings.Repeat("x", 40) + `"}`, true, 413},
		{`{} ` + strings.Repeat(" ", 40), true, 413}, {`{} {}`, false, 400}, {`{} garbage`, false, 400}, {`{} `, false, 204},
	} {
		r := authed("POST", "/api/report", tc.body)
		if tc.unknown {
			r.ContentLength = -1
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		if rr.Code != tc.want {
			t.Fatalf("unknown=%v expected %d got %d %s", tc.unknown, tc.want, rr.Code, rr.Body.String())
		}
	}
}
func TestAdmissionRejectsConcurrentAndReleasesSlot(t *testing.T) {
	g := testGuard(t)
	g.speakSlots = make(chan struct{}, 1)
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	var calls atomic.Int32
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		w.WriteHeader(204)
	}))
	go func() { defer close(done); h.ServeHTTP(httptest.NewRecorder(), authed("POST", "/api/speak", "{}")) }()
	<-entered
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, authed("POST", "/api/speak", "{}"))
	if rr.Code != 429 {
		t.Fatal(rr.Code)
	}
	close(release)
	<-done
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, authed("POST", "/api/speak", "{}"))
	if rr.Code != 204 {
		t.Fatal(rr.Code)
	}
}
func TestSpeechAndGeneralRequestBuckets(t *testing.T) {
	g := testGuard(t)
	g.speech = newBucket(1, 0)
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, want := range []int{204, 429} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, authed("POST", "/api/speak", "{}"))
		if rr.Code != want {
			t.Fatal(rr.Code)
		}
	}
	g.all = newBucket(0, 0)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, authed("GET", "/api/profiles", ""))
	if rr.Code != 429 {
		t.Fatal(rr.Code)
	}
}
func TestRequestDeadlineAndCancellationReachHandler(t *testing.T) {
	g := testGuard(t)
	g.limits.RequestSeconds = 1
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done(); w.WriteHeader(408) }))
	rr := httptest.NewRecorder()
	start := time.Now()
	h.ServeHTTP(rr, authed("POST", "/api/speak", "{}"))
	if rr.Code != 408 || time.Since(start) > 2*time.Second {
		t.Fatal(rr.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := authed("POST", "/api/speak", "{}").WithContext(ctx)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != 408 || len(g.speakSlots) != 0 {
		t.Fatal("cancelled request leaked slot")
	}
}
func TestSpeakTextAndHistoryBudgetsUseCharacters(t *testing.T) {
	l := defaultLimits()
	l.TextChars = 3
	l.HistoryChars = 3
	for _, tc := range []struct {
		req SpeakReq
		bad bool
	}{
		{SpeakReq{Text: "你好啊"}, false}, {SpeakReq{Text: "你好啊啊"}, true},
		{SpeakReq{Text: "a", History: []ChatMsg{{Role: "system", Content: "a"}}}, true},
		{SpeakReq{Text: "a", History: []ChatMsg{{Role: "user", Content: "超过三个字"}}}, true},
		{SpeakReq{Text: "a", System: strings.Repeat("a", 4097)}, true},
	} {
		if err := validateSpeak(tc.req, l); (err != nil) != tc.bad {
			t.Fatal(tc, err)
		}
	}
}
func TestProxyStripsCredentialsAndRejectsOversizeStreamingUpload(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		for _, name := range []string{"Authorization", "X-DeepSeek-Key", "Cookie", "Proxy-Authorization"} {
			if r.Header.Get(name) != "" {
				t.Error("credential forwarded", name)
			}
		}
		_, err := io.ReadAll(r.Body)
		if err == nil {
			w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer upstream.Close()
	a := &App{cfg: &Config{AnalystURL: upstream.URL}, guard: testGuard(t)}
	a.guard.limits.UploadBytes = 32
	server := httptest.NewServer(a.guard.middleware(a.proxy()))
	defer server.Close()
	req, _ := http.NewRequest("POST", server.URL+"/api/prep/profiles", strings.NewReader("small"))
	req.Header.Set("Authorization", "Bearer "+testAccessToken)
	req.Header.Set("X-DeepSeek-Key", "fake")
	req.Header.Set("Cookie", "fake")
	req.Header.Set("Proxy-Authorization", "fake")
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || calls.Load() != 1 {
		t.Fatal(response.StatusCode)
	}
	req, _ = http.NewRequest("POST", server.URL+"/api/prep/profiles", strings.NewReader(strings.Repeat("x", 100)))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+testAccessToken)
	response, err = server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 413 {
		t.Fatal(response.StatusCode)
	}
}

func TestRawLibraryUploadsHaveExactBoundedBudget(t *testing.T) {
	g := testGuard(t)
	g.limits.JSONBytes, g.limits.UploadBytes = 16, 64
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			writeJSON(w, 413, map[string]string{"error": "bounded"})
			return
		}
		w.WriteHeader(204)
	}))
	prefix := "/api/prep/libraries/" + strings.Repeat("a", 32)
	for _, tc := range []struct {
		method, path string
		size, want   int
	}{
		{"POST", prefix + "/samples", 32, 204}, {"POST", prefix + "/samples", 65, 413},
		{"POST", prefix + "/process", 32, 413}, {"DELETE", prefix + "/samples", 32, 413},
		{"POST", prefix + "/samples/extra", 32, 413}, {"POST", "/api/prep/libraries/wrong/samples", 32, 413},
		{"POST", "/api/prep/libraries", 32, 413},
		{"POST", "/api/prep/training-data", 32, 413},
		{"POST", "/api/prep/training-data/" + strings.Repeat("a", 32) + "/verify", 32, 413},
	} {
		for _, chunked := range []bool{false, true} {
			r := authed(tc.method, tc.path, strings.Repeat("x", tc.size))
			if chunked {
				r.ContentLength = -1
			}
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, r)
			if rr.Code != tc.want {
				t.Fatalf("%s chunked=%v want=%d got=%d", tc.path, chunked, tc.want, rr.Code)
			}
		}
	}
}

func TestRawLibraryRoutesAreAuthenticatedAndProxyRemovesCredentials(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/libraries/"+strings.Repeat("a", 32)+"/samples" {
			t.Error("unexpected proxy path", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Deepseek-Key") != "" {
			t.Error("credentials forwarded to analyst")
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	defer upstream.Close()
	a := &App{cfg: &Config{AnalystURL: upstream.URL}, guard: testGuard(t)}
	h := a.routes()
	path := "/api/prep/libraries/" + strings.Repeat("a", 32) + "/samples"
	for _, route := range []string{"/api/prep/training-data", "/api/prep/training-data/" + strings.Repeat("a", 32) + "/verify", "/api/prep/libraries", path, strings.TrimSuffix(path, "/samples") + "/process"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("POST", route, strings.NewReader("x")))
		if rr.Code != 401 {
			t.Fatal("raw library route is not authenticated", route, rr.Code)
		}
	}
	r := authed("POST", path, "small")
	r.Header.Set("X-Deepseek-Key", "private-key")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != 200 || calls.Load() != 1 {
		t.Fatal(rr.Code, calls.Load(), rr.Body.String())
	}
}
