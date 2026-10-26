package main

// Dual-GPU scheduler.
//
// One goroutine per GPU worker pulls the best eligible segment job. Jobs of one session run
// on both GPUs in parallel; the forwarder (session.go) re-assembles them in order so audio
// reaches the browser strictly in sequence while later segments are already being synthesised.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	fPCM   = 1
	fStats = 2
	fErr   = 3
)

type WorkerRef struct {
	ID  int
	URL string

	mu       sync.Mutex
	healthy  bool
	ready    bool
	busy     bool
	health   map[string]any
	rtf      float64 // audio seconds per wall second while generating (EMA)
	firstMs  float64
	served   int
	failed   int
	lastErr  string
	audioSec float64
}

func (w *WorkerRef) isHealthy() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.healthy
}

func (w *WorkerRef) snapshot() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	m := map[string]any{
		"id": w.ID, "url": w.URL, "healthy": w.healthy, "ready": w.ready, "busy": w.busy,
		"rtf_x": w.rtf, "first_chunk_ms": w.firstMs, "served": w.served, "failed": w.failed,
		"last_error": w.lastErr, "audio_s": w.audioSec,
	}
	if w.health != nil {
		m["worker"] = w.health
	}
	return m
}

type SegBuf struct {
	mu       sync.Mutex
	frames   [][]byte
	done     bool
	err      string
	stats    map[string]any
	samples  int64
	consumed int
	wake     chan struct{}
}

func (b *SegBuf) signal() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

func (b *SegBuf) push(f []byte, samples int) {
	b.mu.Lock()
	b.frames = append(b.frames, f)
	b.samples += int64(samples)
	b.mu.Unlock()
	b.signal()
}

func (b *SegBuf) take() (frames [][]byte, done bool, err string, stats map[string]any) {
	b.mu.Lock()
	defer b.mu.Unlock()
	frames = b.frames
	b.frames = nil
	b.consumed += len(frames)
	return frames, b.done, b.err, b.stats
}

func (b *SegBuf) finish(err string, stats map[string]any) {
	b.mu.Lock()
	b.done = true
	b.err = err
	if stats != nil {
		b.stats = stats
	}
	b.mu.Unlock()
	b.signal()
}

// resetIfUnconsumed discards what this attempt produced if the forwarder has not read it yet.
func (b *SegBuf) resetIfUnconsumed() (ok bool, dropped int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.consumed > 0 {
		return false, 0
	}
	d := b.samples
	b.frames, b.samples, b.err, b.stats, b.done = nil, 0, "", nil, false
	return true, d
}

type Job struct {
	seq      int64
	sess     *Session
	seg      Segment
	buf      *SegBuf
	tried    map[int]bool
	attempts int
	enq      time.Time
}

type Scheduler struct {
	mu      sync.Mutex
	cond    *sync.Cond
	jobs    []*Job
	workers []*WorkerRef
	seq     int64
	client  *http.Client
	closed  bool
}

func NewScheduler(urls []string) *Scheduler {
	s := &Scheduler{client: &http.Client{Transport: &http.Transport{
		MaxIdleConnsPerHost: 8, DisableCompression: true, IdleConnTimeout: 60 * time.Second,
	}}}
	s.cond = sync.NewCond(&s.mu)
	for i, u := range urls {
		s.workers = append(s.workers, &WorkerRef{ID: i, URL: u})
	}
	return s
}

func (s *Scheduler) Start() {
	for _, w := range s.workers {
		go s.workerLoop(w)
	}
	go s.healthLoop()
	go func() { // lets watermark gates re-open without any explicit event
		t := time.NewTicker(80 * time.Millisecond)
		for range t.C {
			s.cond.Broadcast()
		}
	}()
}

func (s *Scheduler) Submit(j *Job) {
	s.mu.Lock()
	if j.seq == 0 {
		s.seq++
		j.seq = s.seq
	}
	j.enq = time.Now()
	s.jobs = append(s.jobs, j)
	s.mu.Unlock()
	s.cond.Broadcast()
}

func (s *Scheduler) anyOtherHealthy(w *WorkerRef, j *Job) bool {
	for _, o := range s.workers {
		if o.ID != w.ID && !j.tried[o.ID] && o.isHealthy() {
			return true
		}
	}
	return false
}

// pickLocked chooses the best job for worker w. Caller holds s.mu.
func (s *Scheduler) pickLocked(w *WorkerRef) *Job {
	bestIdx := -1
	var best *Job
	bestPrio := 1 << 30
	for i := 0; i < len(s.jobs); {
		j := s.jobs[i]
		if j.sess.ctx.Err() != nil {
			j.buf.finish("cancelled", nil)
			s.jobs = append(s.jobs[:i], s.jobs[i+1:]...)
			continue
		}
		i++
		if j.tried[w.ID] && s.anyOtherHealthy(w, j) {
			continue
		}
		if !j.sess.allowDispatch(j) {
			continue
		}
		prio := 1
		if j.seg.Index == 0 || j.sess.isUrgent() {
			prio = 0
		}
		if best == nil || prio < bestPrio || (prio == bestPrio && j.seq < best.seq) {
			best, bestIdx, bestPrio = j, i-1, prio
		}
	}
	if best != nil {
		s.jobs = append(s.jobs[:bestIdx], s.jobs[bestIdx+1:]...)
	}
	return best
}

func (s *Scheduler) workerLoop(w *WorkerRef) {
	for {
		s.mu.Lock()
		var j *Job
		for {
			if s.closed {
				s.mu.Unlock()
				return
			}
			if w.isHealthy() {
				if j = s.pickLocked(w); j != nil {
					break
				}
			}
			s.cond.Wait()
		}
		s.mu.Unlock()
		s.run(w, j)
	}
}

type synthReq struct {
    RequestMode string `json:"request_mode,omitempty"`
	QualityPolicy     string `json:"quality_policy,omitempty"`
	DiagnosticSession string `json:"diagnostic_session,omitempty"`
	DiagnosticSegment int    `json:"diagnostic_segment"`
	VoiceConditioning string `json:"voice_conditioning,omitempty"`
	VoiceBinding      string `json:"voice_binding,omitempty"`
	Profile           string `json:"profile"`
	Text              string `json:"text"`
	Language          string `json:"language"`
	ChunkSize         int    `json:"chunk_size"`
	LeadPauseMs       int    `json:"lead_pause_ms"`
	Breath            bool   `json:"breath"`
	Seed              int64  `json:"seed"`
}

func (s *Scheduler) run(w *WorkerRef, j *Job) {
	sess := j.sess
	dispatchQueueMs := float64(time.Since(j.enq).Microseconds()) / 1000
	workerStart := time.Now()
	w.mu.Lock()
	w.busy = true
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		w.busy = false
		w.mu.Unlock()
		s.cond.Broadcast()
	}()

	sess.mark("first_dispatch")
	chunk := sess.chunkSize(j.seg.Index)
	body, _ := json.Marshal(synthReq{
		QualityPolicy: sess.qualityPolicy, RequestMode: sess.requestMode,
		Profile:       sess.profile.ID, VoiceConditioning: sess.profile.VoiceConditioning, VoiceBinding: sess.profile.VoiceBinding, Text: j.seg.Text, Language: sess.lang, ChunkSize: chunk,
		LeadPauseMs: j.seg.PauseBeforeMs, Breath: j.seg.Breath, Seed: sess.seed, DiagnosticSession: sess.ID, DiagnosticSegment: j.seg.Index,
	})

	ctx, cancel := context.WithCancel(sess.ctx)
	defer cancel()
	var stallMu sync.Mutex
	lastFrame := time.Now()
	stallLimit := 60 * time.Second
	if sess.profile.ModelOutputMode == "sentence-buffered" || (sess.qualityPolicy == "sentence-linear" || sess.qualityPolicy == "sentence-agc" || sess.qualityPolicy == "windowed-linear") {
		stallLimit = 180 * time.Second
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() { // stall watchdog: a worker that stops producing mid-segment is cut loose
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				stallMu.Lock()
				idle := time.Since(lastFrame)
				stallMu.Unlock()
				if idle > stallLimit {
					cancel()
					return
				}
			}
		}
	}()

	fail := func(msg string, markUnhealthy bool) {
		w.mu.Lock()
		w.failed++
		w.lastErr = msg
		if markUnhealthy {
			w.healthy = false
		}
		w.mu.Unlock()
		if sess.ctx.Err() == nil && j.attempts < 2 {
			if ok, dropped := j.buf.resetIfUnconsumed(); ok {
				sess.addProduced(-dropped)
				j.attempts++
				if j.tried == nil {
					j.tried = map[int]bool{}
				}
				j.tried[w.ID] = true
				s.Submit(j)
				return
			}
		}
		j.buf.finish(msg, nil)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.URL+"/synth", bytes.NewReader(body))
	if err != nil {
		fail(err.Error(), false)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		if sess.ctx.Err() != nil {
			j.buf.finish("cancelled", nil)
			return
		}
		fail("worker unreachable: "+err.Error(), true)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
		fail(fmt.Sprintf("worker http %d %s", resp.StatusCode, string(b)), false)
		return
	}
	rd := bufio.NewReaderSize(resp.Body, 64*1024)
	var hdr [5]byte
	var stats map[string]any
	var werr string
	first := true
	for {
		if _, err := io.ReadFull(rd, hdr[:]); err != nil {
			if err != io.EOF && sess.ctx.Err() == nil && stats == nil && werr == "" {
				werr = "worker stream broken: " + err.Error()
			}
			break
		}
		n := binary.LittleEndian.Uint32(hdr[1:])
		if n > 32<<20 {
			werr = "oversized frame"
			break
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(rd, payload); err != nil {
			werr = "worker stream truncated"
			break
		}
		stallMu.Lock()
		lastFrame = time.Now()
		stallMu.Unlock()
		switch hdr[0] {
		case fPCM:
			if first {
				first = false
				sess.mark("first_worker_audio")
				if j.seg.Index == 0 {
					sess.mark("first_seg_worker_audio")
				}
			}
			sess.addProduced(int64(n / 2))
			j.buf.push(payload, int(n/2))
		case fStats:
			_ = json.Unmarshal(payload, &stats)
		case fErr:
			var e struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(payload, &e)
			werr = e.Error
		}
	}
	if sess.ctx.Err() != nil {
		j.buf.finish("cancelled", stats)
		return
	}
	if stats == nil && werr == "" {
		werr = "worker returned no stats frame"
	}
	if werr != "" {
		fail(werr, false)
		return
	}
	if stats != nil {
		if b, _ := stats["failed"].(bool); b {
			fail("worker reported failure", false)
			return
		}
		w.mu.Lock()
		w.served++
		if v, ok := stats["rtf_x"].(float64); ok && v > 0 {
			if w.rtf == 0 {
				w.rtf = v
			} else {
				w.rtf += 0.3 * (v - w.rtf)
			}
		}
		if v, ok := stats["first_chunk_ms"].(float64); ok && v > 0 {
			if w.firstMs == 0 {
				w.firstMs = v
			} else {
				w.firstMs += 0.3 * (v - w.firstMs)
			}
		}
		if v, ok := stats["audio_s"].(float64); ok {
			w.audioSec += v
		}
		w.mu.Unlock()
		stats["segment"] = j.seg.Index
        stats["request_mode"] = sess.requestMode
        stats["content_source"] = diagnosticContentSource(sess.requestMode)
        workerBuild, _ := stats["source_build_id"].(string)
        stats["source_build_match"] = workerBuild == runtimeSourceID
        stats["source_build_attested"] = false
        stats["acoustic_text_verified"] = false // No output-ASR gate in this build.
        stats["queue_wait_ms"] = dispatchQueueMs
		stats["dispatch_queue_ms"] = dispatchQueueMs
		stats["worker_roundtrip_ms"] = float64(time.Since(workerStart).Microseconds()) / 1000
		stats["attempts"] = j.attempts + 1
	}
	j.buf.finish("", stats)
}

func (s *Scheduler) healthLoop() {
	hc := &http.Client{Timeout: 2 * time.Second}
	for {
		for _, w := range s.workers {
			resp, err := hc.Get(w.URL + "/health")
			w.mu.Lock()
			if err != nil {
				w.healthy, w.ready = false, false
				w.lastErr = "health: " + err.Error()
			} else {
				var h map[string]any
				_ = json.NewDecoder(resp.Body).Decode(&h)
				resp.Body.Close()
				w.health = h
				ready, _ := h["ready"].(bool)
				stalled, _ := h["stalled_s"].(float64)
				w.ready = ready
				stallLimit := 75.0
				if h["model_output_mode"] == "sentence-buffered" {
					stallLimit = 180
				}
				w.healthy = ready && stalled < stallLimit
			}
			w.mu.Unlock()
		}
		s.cond.Broadcast()
		time.Sleep(1500 * time.Millisecond)
	}
}

// AggRTF = how many seconds of audio per wall second all healthy GPUs deliver together.
func (s *Scheduler) AggRTF() float64 {
	total := 0.0
	for _, w := range s.workers {
		w.mu.Lock()
		if w.healthy {
			if w.rtf > 0 {
				total += w.rtf
			} else {
				total += 0.9
			}
		}
		w.mu.Unlock()
	}
	if total == 0 {
		return 0.9
	}
	return total
}

func (s *Scheduler) Snapshots() []map[string]any {
	out := make([]map[string]any, 0, len(s.workers))
	for _, w := range s.workers {
		out = append(out, w.snapshot())
	}
	return out
}
