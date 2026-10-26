package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProfileIDsStayInsideWorkspace(t *testing.T) {
	for _, id := range []string{"../escape", "/tmp/file", "a/b", "a\\b", ".", "", strings.Repeat("a", 65)} {
		if _, err := loadProfileInfo(t.TempDir(), id); err == nil || !strings.Contains(err.Error(), "invalid profile id") {
			t.Fatalf("accepted unsafe ID %q: %v", id, err)
		}
	}
}
func makeVoice(t *testing.T, state, id, embedded string) {
	t.Helper()
	dir := filepath.Join(state, "profiles", id)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]string{"id": embedded, "name": id})
	if err := os.WriteFile(filepath.Join(dir, "profile.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}
func TestRejectProfileIdentityMismatch(t *testing.T) {
	d := t.TempDir()
	makeVoice(t, d, "safe", "another")
	if _, err := loadProfileInfo(d, "safe"); err == nil {
		t.Fatal("accepted mismatched profile")
	}
}
func TestActivationPublishesOnlyAfterWorkerConfirmation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{"success", 200, `{"ok":true}`, 200}, {"http failure despite ok", 500, `{"ok":true}`, 503},
		{"negative acknowledgement", 200, `{"ok":false}`, 503}, {"invalid JSON", 200, `broken`, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := t.TempDir()
			makeVoice(t, d, "new", "new")
			os.WriteFile(filepath.Join(d, "active.json"), []byte(`{"id":"old"}`), 0600)
			good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if activeProfileID(d) != "old" {
					t.Error("active voice changed before workers acknowledged")
				}
				w.Write([]byte(`{"ok":true}`))
			}))
			defer good.Close()
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
			defer other.Close()
			a := &App{cfg: &Config{StateDir: d, WorkerURLs: []string{good.URL, other.URL}}}
			req := httptest.NewRequest("POST", "/api/profiles/activate", strings.NewReader(`{"id":"new"}`))
			rr := httptest.NewRecorder()
			a.activate(rr, req)
			if rr.Code != tc.want {
				t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
			}
			want := "old"
			if tc.want == 200 {
				want = "new"
			}
			if got := activeProfileID(d); got != want {
				t.Fatalf("active %s want %s", got, want)
			}
		})
	}
}
func TestActivationRequiresWorkersAndPost(t *testing.T) {
	d := t.TempDir()
	makeVoice(t, d, "new", "new")
	a := &App{cfg: &Config{StateDir: d}}
	rr := httptest.NewRecorder()
	a.activate(rr, httptest.NewRequest("GET", "/", nil))
	if rr.Code != 405 {
		t.Fatal(rr.Code)
	}
	rr = httptest.NewRecorder()
	a.activate(rr, httptest.NewRequest("POST", "/", strings.NewReader(`{"id":"new"}`)))
	if rr.Code != 503 {
		t.Fatal(rr.Code)
	}
}
func TestLLMStreamCompletionAndBudget(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		bad        bool
	}{
		{"done", "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n", false},
		{"stop", "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"},\"finish_reason\":\"stop\"}]}\n", false},
		{"truncated", "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"},\"finish_reason\":\"length\"}]}\n", true},
		{"broken connection", "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n", true},
		{"empty", "", true}, {"bad JSON", "data: no-json\n", true}, {"provider error", "data: {\"error\":{\"message\":\"failure\"}}\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				if body["max_tokens"] != float64(8192) {
					t.Error("output budget not forwarded", body)
				}
				if r.Header.Get("Authorization") != "Bearer fake-test-key" {
					t.Error("missing authorization")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			var text strings.Builder
			err := StreamLLM(context.Background(), &Config{LLMBase: srv.URL, LLMMaxTokens: 8192, LLMModel: "test"}, "fake-test-key", nil, func(s string) { text.WriteString(s) })
			if (err != nil) != tc.bad {
				t.Fatalf("bad=%v err=%v", tc.bad, err)
			}
			if tc.name == "done" && text.String() != "你好" {
				t.Fatal(text.String())
			}
		})
	}
}
func TestBudgetConfigValidation(t *testing.T) {
	for _, x := range []struct {
		in   string
		want int
	}{{"8192", 8192}, {"16384", 16384}, {"0", 8192}, {"bad", 8192}, {"999999", 8192}} {
		t.Setenv("DEEPSEEK_MAX_TOKENS", x.in)
		if got := loadConfig().LLMMaxTokens; got != x.want {
			t.Fatalf("%s got %d", x.in, got)
		}
	}
}
func TestSameOriginOnly(t *testing.T) {
	for _, x := range []struct {
		origin string
		want   int
	}{{"", 204}, {"https://studio.example", 204}, {"https://evil.example", 403}, {"null", 403}} {
		req := httptest.NewRequest("POST", "https://studio.example/api", nil)
		if x.origin != "" {
			req.Header.Set("Origin", x.origin)
		}
		rr := httptest.NewRecorder()
		cors(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(rr, req)
		if rr.Code != x.want {
			t.Fatalf("%q got %d", x.origin, rr.Code)
		}
		if rr.Header().Get("Access-Control-Allow-Origin") == "*" {
			t.Fatal("wildcard CORS")
		}
	}
}
