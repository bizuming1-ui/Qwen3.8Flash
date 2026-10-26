package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSourceTextSegmentsDoNotRewrite(t *testing.T) {
	for _, text := range []string{
		"请原样读出这个没有句号的文字", "Price is 12.50, not 15.25! Keep _name_ and #tag",
		"访问 https://example.com/a_b?q=1 再读 Qwen3，保留正文",
		"他说：\"不要添加其他东西\"，接着读下一句。\n保留  两个空格",
		"中文混合 English 123，不补句号", "**强调**与💡符号仍是原输入，不能悄悄删除",
	} {
		for _, step := range []int{1, 2, 7, 4096} {
			segs := feedAll(NewSegmenter(ExactSegCfg(nil), 3), text, step)
			var b strings.Builder
			for _, seg := range segs {
				b.WriteString(seg.Text)
			}
			if b.String() != text {
				t.Fatalf("chunk=%d: source altered: %q -> %q", step, text, b.String())
			}
		}
	}
}
func TestFirstChunkBudgetOptIn(t *testing.T) {
	s := &Session{}
	for _, entry := range []struct {
		value string
		want  int
	}{{"", 4}, {"2", 2}, {"8", 8}, {"0", 4}, {"9", 4}, {"nan", 4}} {
		t.Setenv("QTTS_FIRST_CHUNK_SIZE", entry.value)
		if got := s.chunkSize(0); got != entry.want {
			t.Fatalf("%q got=%d", entry.value, got)
		}
	}
}
func TestLongUploadDefaultBudget(t *testing.T) {
	if defaultLimits().UploadBytes != 128<<20 {
		t.Fatal("gateway disagrees with long-recording request budget")
	}
}

func TestLiveFirstPrefixDoesNotWaitForNextDelta(t *testing.T) {
	for _, text := range []string{"你好。", "你好。 ", "我已经看懂你的问题了，", "我已经看懂你的问题了， ", "先回答第一个问题！", "Hello!"} {
		s := NewSegmenter(LiveSegCfg(nil), 1)
		segs := s.Feed(text)
		if len(segs) != 1 || segs[0].Text != text {
			t.Fatalf("prefix %q not submitted immediately: %+v", text, segs)
		}
		if len(s.Flush()) != 0 {
			t.Fatal("prefix duplicated at end")
		}
	}
}
func TestLiveFirstKeepsDecimalsAndOpenQuotes(t *testing.T) {
	s := NewSegmenter(LiveSegCfg(nil), 1)
	if len(s.Feed("The value is 12.")) != 0 {
		t.Fatal("decimal prefix prematurely submitted")
	}
	segs := append(s.Feed("50, and it remains exact."), s.Flush()...)
	var all strings.Builder
	for _, v := range segs {
		all.WriteString(v.Text)
	}
	if all.String() != "The value is 12.50, and it remains exact." {
		t.Fatal(all.String())
	}
	q := NewSegmenter(LiveSegCfg(nil), 1)
	if len(q.Feed("他说：“你好。")) != 0 {
		t.Fatal("open quote sent without closer")
	}
	quoted := append(q.Feed("”"), q.Flush()...)
	if len(quoted) != 1 || quoted[0].Text != "他说：“你好。”" {
		t.Fatal(quoted)
	}
}
func TestLiveAndReadUseSeparateFirstPolicies(t *testing.T) {
	a := &App{sched: NewScheduler(nil)}
	for _, mode := range []string{"read", "chat"} {
		s := a.newSession(context.Background(), SpeakReq{Mode: mode}, &ProfileInfo{ID: "test"})
		if s.seg.cfg.ImmediateFirst != (mode != "read") {
			t.Fatal("wrong first-prefix policy", mode)
		}
		s.cancel()
	}
}

// Real local HTTP/SSE + application producer + scheduler worker request.
// The worker is a protocol fixture, NOT a Qwen model or real DeepSeek service.
func TestFirstTTSRequestBeforeLLMTailArrives(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"你好。\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"后面的内容稍后再生成。\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer llm.Close()
	defer once.Do(func() { close(release) })
	received := make(chan synthReq, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body synthReq
		json.NewDecoder(r.Body).Decode(&body)
		received <- body
		payload := []byte(`{"audio_s":0,"rtf_x":1}`)
		header := make([]byte, 5)
		header[0] = 2
		binary.LittleEndian.PutUint32(header[1:], uint32(len(payload)))
		w.Write(header)
		w.Write(payload)
	}))
	defer worker.Close()
	scheduler := NewScheduler([]string{worker.URL})
	app := &App{sched: scheduler}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sess := app.newSession(ctx, SpeakReq{Mode: "chat"}, &ProfileInfo{ID: "fixture"})
	defer sess.cancel()
	done := make(chan struct{})
	go func() {
		sess.produce(&Config{LLMBase: llm.URL, LLMModel: "fixture", LLMMaxTokens: 100}, SpeakReq{Mode: "chat", Text: "测试"}, "fixture-key")
		close(done)
	}()
	timeout := time.NewTimer(3 * time.Second)
	defer timeout.Stop()
	var first *Job
	for first == nil {
		// Take through the real scheduler queue, not Session.jobs (published before enqueue).
		scheduler.mu.Lock()
		first = scheduler.pickLocked(scheduler.workers[0])
		scheduler.mu.Unlock()
		if first != nil {
			break
		}
		select {
		case <-sess.wake:
		case <-timeout.C:
			t.Fatal("first sentence waited for LLM tail")
		}
	}
	scheduler.run(scheduler.workers[0], first)
	select {
	case req := <-received:
		if req.Text != "你好。" {
			t.Fatal(req.Text)
		}
	case <-timeout.C:
		t.Fatal("worker never received first prefix")
	}
	sess.mu.Lock()
	_, ended := sess.timeline["llm_done"]
	sess.mu.Unlock()
	if ended {
		t.Fatal("TTS only dispatched after LLM finished")
	}
	once.Do(func() { close(release) })
	select {
	case <-done:
	case <-timeout.C:
		t.Fatal("producer failed to finish")
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	var joined strings.Builder
	for _, j := range sess.jobs {
		joined.WriteString(j.seg.Text)
	}
	if joined.String() != "你好。后面的内容稍后再生成。" {
		t.Fatal(joined.String())
	}
}
