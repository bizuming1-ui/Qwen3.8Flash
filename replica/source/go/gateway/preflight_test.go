package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreflightReportIsAuthenticatedBoundedAndReadOnly(t *testing.T) {
	directory := t.TempDir()
	a := &App{cfg: &Config{StateDir: directory, WebDir: directory}, guard: testGuard(t)}
	handler := a.routes()
	unauth := httptest.NewRecorder()
	handler.ServeHTTP(unauth, httptest.NewRequest("GET", "/api/preflight", nil))
	if unauth.Code != 401 {
		t.Fatal(unauth.Code)
	}
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, authed(method, "/api/preflight", "{}"))
		if rr.Code != 405 {
			t.Fatalf("%s: %d", method, rr.Code)
		}
	}
	for _, tc := range []struct {
		name, body string
		want       int
		contains   string
	}{
		{"not_run", "", 200, `"status":"not_run"`},
		{"valid", `{"schema":1,"status":"blocked","model_loaded":false}`, 200, `"status":"blocked"`},
		{"broken", "{", 500, "invalid or oversized probe report"},
		{"null", "null", 500, "invalid or oversized probe report"},
		{"oversized", `{"data":"` + strings.Repeat("x", 256<<10) + `"}`, 500, "invalid or oversized probe report"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.body != "" {
				if err := os.WriteFile(filepath.Join(directory, "backend_probe.json"), []byte(tc.body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, authed("GET", "/api/preflight", ""))
			if rr.Code != tc.want || !strings.Contains(rr.Body.String(), tc.contains) {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			if strings.Contains(rr.Body.String(), directory) {
				t.Fatal("local path leaked")
			}
		})
	}
}

func TestRecorderStaticAssetIsExplicitlyPublic(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "recorder.js"), []byte("public recorder code"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &App{cfg: &Config{StateDir: directory, WebDir: directory}, guard: testGuard(t)}
	rr := httptest.NewRecorder()
	a.routes().ServeHTTP(rr, httptest.NewRequest("GET", "/recorder.js", nil))
	if rr.Code != 200 || rr.Body.String() != "public recorder code" {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
}
