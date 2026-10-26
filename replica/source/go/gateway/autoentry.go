package main

// Automatic private entry: short-lived one-use grants, HttpOnly sessions.
// The existing Bearer guard and all API admission budgets remain in force.
import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const sessionCookie = "qtts_private_session"
const grantTTL = 10 * time.Minute
const sessionTTL = 8 * time.Hour

type entryAccess struct {
	mu       sync.Mutex
	grants   map[[32]byte]time.Time
	sessions map[[32]byte]time.Time
	requests *tokenBucket
}

func newEntryAccess() *entryAccess {
	return &entryAccess{grants: make(map[[32]byte]time.Time), sessions: make(map[[32]byte]time.Time), requests: newBucket(20, 2)}
}
func entrySecret() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func validEntrySecret(s string) bool {
	if len(s) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	return err == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == s
}
func (e *entryAccess) prune(now time.Time) {
	for k, t := range e.grants {
		if !now.Before(t) {
			delete(e.grants, k)
		}
	}
	for k, t := range e.sessions {
		if !now.Before(t) {
			delete(e.sessions, k)
		}
	}
}
func (e *entryAccess) validSession(r *http.Request) bool {
	var value string
	count := 0
	for _, c := range r.Cookies() {
		if c.Name == sessionCookie {
			value = c.Value
			count++
		}
	}
	if count != 1 || !validEntrySecret(value) {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.prune(time.Now())
	until, ok := e.sessions[sha256.Sum256([]byte(value))]
	return ok && time.Now().Before(until)
}

// A forwarded HTTPS Origin is expected behind cloudflared. Arbitrary remote
// plaintext origins and missing Origins on cookie-authenticated writes fail shut.
func entryOrigin(r *http.Request, required bool) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return !required
	}
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || !strings.EqualFold(u.Host, r.Host) {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	return os.Getenv("QTTS_AUTOENTRY_ALLOW_LOOPBACK_HTTP") == "1" && u.Scheme == "http" && (host == "localhost" || ip != nil && ip.IsLoopback())
}
func cookieSecure(r *http.Request) bool {
	u, _ := url.Parse(r.Header.Get("Origin"))
	return r.TLS != nil || u != nil && u.Scheme == "https"
}
func setEntryCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: value, Path: "/", HttpOnly: true, Secure: cookieSecure(r), SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}
func (g *Guard) authorized(r *http.Request) bool {
	// An explicitly supplied invalid Bearer must never be rescued by a cookie.
	if len(r.Header.Values("Authorization")) > 0 {
		return g.authorizedBearer(r)
	}
	unsafe := r.Method != http.MethodGet && r.Method != http.MethodHead
	return entryOrigin(r, unsafe) && g.entry != nil && g.entry.validSession(r)
}
func entryHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}
func (g *Guard) issueEntry(w http.ResponseWriter, r *http.Request) {
	entryHeaders(w)
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	// Cookie sessions cannot mint new entry grants. Notebook uses the private Bearer.
	if !g.authorizedBearer(r) {
		writeJSON(w, 403, map[string]string{"error": "notebook credential required"})
		return
	}
	if r.URL.RawQuery != "" {
		writeJSON(w, 400, map[string]string{"error": "query parameters not accepted"})
		return
	}
	value, err := entrySecret()
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "secure randomness unavailable"})
		return
	}
	g.entry.mu.Lock()
	defer g.entry.mu.Unlock()
	now := time.Now()
	g.entry.prune(now)
	if len(g.entry.grants) >= 8 {
		denyBusy(w, "pending private entry limit reached")
		return
	}
	g.entry.grants[sha256.Sum256([]byte(value))] = now.Add(grantTTL)
	writeJSON(w, 200, map[string]any{"grant": value, "expires_in": int(grantTTL.Seconds())})
}
func (g *Guard) exchangeEntry(w http.ResponseWriter, r *http.Request) {
	entryHeaders(w)
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if !entryOrigin(r, true) {
		writeJSON(w, 403, map[string]string{"error": "trusted same-origin HTTPS required"})
		return
	}
	if !g.entry.requests.allow() {
		denyBusy(w, "entry request budget exceeded")
		return
	}
	mediaType, _, mediaError := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if r.URL.RawQuery != "" || mediaError != nil || mediaType != "application/json" {
		writeJSON(w, 400, map[string]string{"error": "JSON body required; no query parameters"})
		return
	}
	var body struct {
		Grant string `json:"grant"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2048)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&body) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid entry request"})
		return
	}
	var extra any
	if dec.Decode(&extra) != io.EOF || !validEntrySecret(body.Grant) {
		writeJSON(w, 400, map[string]string{"error": "invalid entry request"})
		return
	}
	value, err := entrySecret()
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "secure randomness unavailable"})
		return
	}
	g.entry.mu.Lock()
	defer g.entry.mu.Unlock()
	now := time.Now()
	g.entry.prune(now)
	digest := sha256.Sum256([]byte(body.Grant))
	until, ok := g.entry.grants[digest]
	if !ok || !now.Before(until) {
		writeJSON(w, 401, map[string]string{"error": "entry expired or already used; open a new Notebook entry"})
		return
	}
	if len(g.entry.sessions) >= 32 {
		denyBusy(w, "browser session limit reached")
		return
	}
	// One-use exchange is atomic, including concurrent requests.
	delete(g.entry.grants, digest)
	// A fresh entry in this browser replaces its previous server-side session.
	for _, c := range r.Cookies() {
		if c.Name == sessionCookie {
			delete(g.entry.sessions, sha256.Sum256([]byte(c.Value)))
		}
	}
	g.entry.sessions[sha256.Sum256([]byte(value))] = now.Add(sessionTTL)
	setEntryCookie(w, r, value, int(sessionTTL.Seconds()))
	writeJSON(w, 200, map[string]any{"ready": true, "expires_in": int(sessionTTL.Seconds())})
}
func (g *Guard) sessionStatus(w http.ResponseWriter, r *http.Request) {
	entryHeaders(w)
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]string{"error": "GET only"})
		return
	}
	writeJSON(w, 200, map[string]bool{"ready": true})
}
func (g *Guard) logoutEntry(w http.ResponseWriter, r *http.Request) {
	entryHeaders(w)
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	if !entryOrigin(r, true) {
		writeJSON(w, 403, map[string]string{"error": "same-origin required"})
		return
	}
	g.entry.mu.Lock()
	for _, c := range r.Cookies() {
		if c.Name == sessionCookie {
			delete(g.entry.sessions, sha256.Sum256([]byte(c.Value)))
		}
	}
	g.entry.mu.Unlock()
	setEntryCookie(w, r, "", -1)
	writeJSON(w, 200, map[string]bool{"ready": true})
}
