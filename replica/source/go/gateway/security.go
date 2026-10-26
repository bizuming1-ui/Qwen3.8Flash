package main

// Single-user access control and process-wide admission budgets. TLS must be
// provided by a trusted proxy; this is not a multi-tenant identity system.
import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Limits struct {
	JSONBytes, UploadBytes           int64
	TextChars, HistoryChars          int
	SpeakConcurrent, HeavyConcurrent int
	SpeakPerMinute                   int
	RequestSeconds                   int
}

func defaultLimits() Limits { return Limits{1 << 20, 128 << 20, 20000, 32000, 2, 2, 12, 1800} }
func boundedEnv(name string, fallback, min, max int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s must be an integer in [%d,%d]", name, min, max)
	}
	return n, nil
}
func loadLimits() (Limits, error) {
	l := defaultLimits()
	for _, item := range []struct {
		name     string
		field    *int
		min, max int
	}{
		{"QTTS_MAX_TEXT_CHARS", &l.TextChars, 1, 200000}, {"QTTS_MAX_HISTORY_CHARS", &l.HistoryChars, 1, 200000},
		{"QTTS_MAX_SPEAK_CONCURRENT", &l.SpeakConcurrent, 1, 8}, {"QTTS_MAX_HEAVY_CONCURRENT", &l.HeavyConcurrent, 1, 8},
		{"QTTS_SPEAK_PER_MINUTE", &l.SpeakPerMinute, 1, 120}, {"QTTS_REQUEST_TIMEOUT_S", &l.RequestSeconds, 1, 7200},
	} {
		n, err := boundedEnv(item.name, *item.field, item.min, item.max)
		if err != nil {
			return l, err
		}
		*item.field = n
	}
	for _, item := range []struct {
		name               string
		field              *int64
		fallback, min, max int
	}{
		{"QTTS_MAX_JSON_BYTES", &l.JSONBytes, 1 << 20, 1024, 4 << 20},
		{"QTTS_MAX_UPLOAD_BYTES", &l.UploadBytes, 128 << 20, 1024, 512 << 20},
	} {
		n, err := boundedEnv(item.name, item.fallback, item.min, item.max)
		if err != nil {
			return l, err
		}
		*item.field = int64(n)
	}
	return l, nil
}

type tokenBucket struct {
	mu                          sync.Mutex
	tokens, capacity, perSecond float64
	last                        time.Time
}

func newBucket(capacity int, perSecond float64) *tokenBucket {
	return &tokenBucket{tokens: float64(capacity), capacity: float64(capacity), perSecond: perSecond, last: time.Now()}
}
func (b *tokenBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens += now.Sub(b.last).Seconds() * b.perSecond
	b.last = now
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type Guard struct {
	entry                  *entryAccess
	digest                 [32]byte
	limits                 Limits
	all, failed, speech    *tokenBucket
	speakSlots, heavySlots chan struct{}
}

func newGuard(token string) (*Guard, error) {
	if len(token) < 32 || len(token) > 256 {
		return nil, fmt.Errorf("QTTS_ACCESS_TOKEN must contain 32..256 printable non-space ASCII characters")
	}
	for _, c := range []byte(token) {
		if c < 33 || c > 126 {
			return nil, fmt.Errorf("QTTS_ACCESS_TOKEN must contain 32..256 printable non-space ASCII characters")
		}
	}
	limits, err := loadLimits()
	if err != nil {
		return nil, err
	}
	return &Guard{entry: newEntryAccess(), digest: sha256.Sum256([]byte(token)), limits: limits,
		all: newBucket(120, 20), failed: newBucket(10, 1), speech: newBucket(limits.SpeakPerMinute, float64(limits.SpeakPerMinute)/60),
		speakSlots: make(chan struct{}, limits.SpeakConcurrent), heavySlots: make(chan struct{}, limits.HeavyConcurrent)}, nil
}
func (g *Guard) authorizedBearer(r *http.Request) bool {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || len(values[0]) > 1024 {
		return false
	}
	token, ok := strings.CutPrefix(values[0], "Bearer ")
	if !ok {
		return false
	}
	got := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(got[:], g.digest[:]) == 1
}
func denyBusy(w http.ResponseWriter, message string) {
	w.Header().Set("Retry-After", "5")
	writeJSON(w, 429, map[string]string{"error": message})
}

var librarySamplesUpload = regexp.MustCompile(`^/api/prep/libraries/[0-9a-f]{32}/samples$`)

func (g *Guard) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if g == nil {
			writeJSON(w, 503, map[string]string{"error": "access control is not configured"})
			return
		}
		if !g.authorized(r) {
			if !g.failed.allow() {
				denyBusy(w, "too many failed access attempts")
				return
			}
			w.Header().Set("WWW-Authenticate", `Bearer realm="QTTS"`)
			writeJSON(w, 401, map[string]string{"error": "access token required or invalid"})
			return
		}
		if !g.all.allow() {
			denyBusy(w, "request rate exceeded")
			return
		}
		max := g.limits.JSONBytes
		if r.URL.Path == "/api/prep/profiles" || r.URL.Path == "/api/prep/evaluate" || (r.Method == http.MethodPost && librarySamplesUpload.MatchString(r.URL.Path)) {
			max = g.limits.UploadBytes
		}
		if r.ContentLength > max {
			writeJSON(w, 413, map[string]string{"error": "request body exceeds configured limit"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, max)
		var slots chan struct{}
		if r.URL.Path == "/api/speak" && r.Method == http.MethodPost {
			slots = g.speakSlots
		} else if r.Method != http.MethodGet && r.Method != http.MethodHead && (strings.HasPrefix(r.URL.Path, "/api/prep/") || r.URL.Path == "/api/profiles/activate") {
			slots = g.heavySlots
		}
		if slots != nil {
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			default:
				denyBusy(w, "concurrent operation limit reached")
				return
			}
		}
		if r.URL.Path == "/api/speak" && r.Method == http.MethodPost && !g.speech.allow() {
			denyBusy(w, "speech request budget exceeded")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(g.limits.RequestSeconds)*time.Second)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(r.Body)
	err := decoder.Decode(dst)
	if err == nil {
		var extra any
		if e := decoder.Decode(&extra); e != io.EOF {
			if e == nil {
				err = fmt.Errorf("multiple JSON values")
			} else {
				err = e
			}
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, 413, map[string]string{"error": "JSON body exceeds configured limit"})
		} else {
			writeJSON(w, 400, map[string]string{"error": "a single valid JSON value is required"})
		}
		return false
	}
	return true
}
func (a *App) requestLimits() Limits {
	if a.guard != nil {
		return a.guard.limits
	}
	return defaultLimits()
}
func validateSpeak(req SpeakReq, l Limits) error {
	if !utf8.ValidString(req.Text) || utf8.RuneCountInString(req.Text) > l.TextChars {
		return fmt.Errorf("text exceeds configured character limit")
	}
	if len(req.History) > 16 || utf8.RuneCountInString(req.System) > 4096 {
		return fmt.Errorf("history/system budget exceeded")
	}
	total := 0
	for _, m := range req.History {
		if m.Role != "user" && m.Role != "assistant" {
			return fmt.Errorf("history role must be user or assistant")
		}
		total += utf8.RuneCountInString(m.Content)
	}
	if total > l.HistoryChars {
		return fmt.Errorf("history character budget exceeded")
	}
	return nil
}
