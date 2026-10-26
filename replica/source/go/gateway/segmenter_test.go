package main

import (
	"strings"
	"testing"
)

func feedAll(s *Segmenter, text string, step int) []Segment {
	var out []Segment
	rs := []rune(text)
	for i := 0; i < len(rs); i += step {
		j := i + step
		if j > len(rs) {
			j = len(rs)
		}
		out = append(out, s.Feed(string(rs[i:j]))...)
	}
	return append(out, s.Flush()...)
}

const sample = "你好呀，今天过得怎么样？我刚刚想了一件有意思的事情，就是人为什么会在说话的时候换气。其实呢，这和我们的节奏有关……你说对不对？\n\n好了，我们继续聊吧。"

func TestFirstSegmentIsShort(t *testing.T) {
	segs := feedAll(NewSegmenter(DefaultSegCfg(nil), 1), sample, 3)
	if len(segs) < 4 {
		t.Fatalf("expected several segments, got %d: %+v", len(segs), segs)
	}
	if segs[0].Units > 20 {
		t.Fatalf("first segment too long: %v (%s)", segs[0].Units, segs[0].Text)
	}
	if segs[0].PauseBeforeMs != 0 || segs[0].Breath {
		t.Fatalf("first segment must have no pause/breath")
	}
}

func TestStreamingEqualsBatch(t *testing.T) {
	a := feedAll(NewSegmenter(DefaultSegCfg(nil), 5), sample, 1)
	b := feedAll(NewSegmenter(DefaultSegCfg(nil), 5), sample, 1000)
	if len(a) != len(b) {
		t.Fatalf("segment count differs by chunking: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Text != b[i].Text {
			t.Fatalf("seg %d differs: %q vs %q", i, a[i].Text, b[i].Text)
		}
	}
}

func TestNoTextLostAndEndsWithPunct(t *testing.T) {
	segs := feedAll(NewSegmenter(DefaultSegCfg(nil), 2), sample, 2)
	var joined strings.Builder
	for _, s := range segs {
		joined.WriteString(s.Text)
		r, _ := lastRune(s.Text)
		if !isPunct(r) && !isClosers(r) {
			t.Fatalf("segment without terminal punctuation: %q", s.Text)
		}
	}
	strip := func(x string) string {
		var b strings.Builder
		for _, r := range x {
			if isCJK(r) || isWordRune(r) {
				b.WriteRune(r)
			}
		}
		return b.String()
	}
	if strip(joined.String()) != strip(sample) {
		t.Fatalf("text lost:\n%s\n%s", strip(joined.String()), strip(sample))
	}
}

func TestMaxLengthRespected(t *testing.T) {
	long := strings.Repeat("这是一段没有任何标点的很长很长的文字", 12)
	segs := feedAll(NewSegmenter(DefaultSegCfg(nil), 3), long, 7)
	for _, s := range segs {
		if s.Units > 70 {
			t.Fatalf("segment too long: %v", s.Units)
		}
	}
}

func TestEnglishAndDecimals(t *testing.T) {
	text := "Pi is about 3.14 and that is fine. Let me explain why, because it matters a lot to people who build things."
	segs := feedAll(NewSegmenter(DefaultSegCfg(nil), 4), text, 4)
	for _, s := range segs {
		if strings.HasSuffix(strings.TrimSpace(s.Text), "3.") {
			t.Fatalf("cut inside decimal: %q", s.Text)
		}
	}
	if len(segs) < 2 {
		t.Fatalf("expected >=2 segments: %+v", segs)
	}
}

func TestPausesAndBreaths(t *testing.T) {
	segs := feedAll(NewSegmenter(DefaultSegCfg(nil), 9), strings.Repeat(sample+"\n\n", 3), 5)
	para, breaths := 0, 0
	for _, s := range segs {
		if s.Boundary == BPara {
			para++
			if !s.Breath {
				t.Fatalf("paragraph boundary must breathe")
			}
		}
		if s.Breath {
			breaths++
			if s.PauseBeforeMs < 280 {
				t.Fatalf("breath needs room: %d", s.PauseBeforeMs)
			}
		}
	}
	if para == 0 || breaths == len(segs) {
		t.Fatalf("breath policy broken: para=%d breaths=%d/%d", para, breaths, len(segs))
	}
}

func TestCleanDelta(t *testing.T) {
	got := CleanDelta("**你好** 😀 看 https://x.com/a `code`")
	if strings.ContainsAny(got, "*`😀") || strings.Contains(got, "http") {
		t.Fatalf("not cleaned: %q", got)
	}
}
