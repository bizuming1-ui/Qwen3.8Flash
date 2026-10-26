package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVoiceBindingCrossLanguageAndRevision(t *testing.T) {
	dir := t.TempDir()
	raw := []byte{'R', 'I', 'F', 'F', 0, 255, 'T', 'E', 'S', 'T'}
	if err := os.WriteFile(filepath.Join(dir, "a.wav"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	p := &ProfileInfo{Anchor: "a.wav", RefText: "你好 café\x00声音", Language: "Chinese"}
	pin, err := referenceBinding(dir, p)
	if err != nil || pin != "17f55c974517bf2cfa3cde3f0c3b207952acb89b174595fde9b25920c59625ab" {
		t.Fatalf("cross-language binding: %s %v", pin, err)
	}
	p.RefText += "x"
	next, err := referenceBinding(dir, p)
	if err != nil || next == pin {
		t.Fatal("text revision not bound")
	}
	p.RefText = "你好 café\x00声音"
	p.Language = "English"
	next, err = referenceBinding(dir, p)
	if err != nil || next == pin {
		t.Fatal("language revision not bound")
	}
	p.Language = "Chinese"
	os.WriteFile(filepath.Join(dir, "a.wav"), append(raw, 1), 0600)
	next, err = referenceBinding(dir, p)
	if err != nil || next == pin {
		t.Fatal("wave content revision not bound")
	}
}

func TestVoiceBindingRejectsUnsafeAnchor(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.wav"), []byte("wave"), 0600)
	for _, name := range []string{"", "..", ".", "../a.wav", "a\\b.wav", "/tmp/a.wav"} {
		if _, err := referenceBinding(dir, &ProfileInfo{Anchor: name}); err == nil {
			t.Fatalf("unsafe anchor accepted: %s", name)
		}
	}
	if err := os.Symlink(filepath.Join(dir, "a.wav"), filepath.Join(dir, "link.wav")); err != nil {
		t.Fatal(err)
	}
	if _, err := referenceBinding(dir, &ProfileInfo{Anchor: "link.wav"}); err == nil {
		t.Fatal("symlink accepted")
	}
}

func TestTrainedProfilePinsNativeConditioningBeforeWorkerAdmission(t *testing.T) {
	t.Setenv("QTTS_MOCK", "1")
	t.Setenv("QTTS_TTS_ENGINE", "faster")
	dir := t.TempDir()
	p := filepath.Join(dir, "profiles", "voice")
	os.MkdirAll(p, 0700)
	os.WriteFile(filepath.Join(p, "profile.json"), []byte(`{"id":"voice","model_output_mode":"sentence-buffered"}`), 0600)
	prof, err := loadProfileInfo(dir, "voice")
	if err != nil || prof.VoiceConditioning != "trained-speaker-vector" {
		t.Fatalf("trained profile mode lost: %v %v", prof, err)
	}
	// A non-native worker still refuses this expected mode; this does not bypass its trained-profile guard.
}

func TestGenerationParametersBoundAndValidated(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.wav"), []byte("wave"), 0600)
	p := &ProfileInfo{Anchor: "a.wav", RefText: "你好", Language: "Chinese"}
	first, err := referenceBinding(dir, p)
	if err != nil {
		t.Fatal(err)
	}
	p.Gen = map[string]float64{"temperature": .8, "top_k": 50, "top_p": 1, "repetition_penalty": 1.05}
	same, err := referenceBinding(dir, p)
	if err != nil || same != first {
		t.Fatal("effective defaults differ")
	}
	for k, v := range map[string]float64{"temperature": .65, "top_k": 40, "top_p": .9, "repetition_penalty": 1.1} {
		p.Gen = map[string]float64{k: v}
		next, e := referenceBinding(dir, p)
		if e != nil || next == first {
			t.Fatal("generation revision not bound", k)
		}
	}
	for _, g := range []map[string]float64{{"top_k": 1.5}, {"top_p": 0}, {"temperature": 3}, {"repetition_penalty": -1}} {
		if _, e := generationBytes(g); e == nil {
			t.Fatal("invalid generation accepted", g)
		}
	}
}

func TestReadGroupingPreservesChatFirstPrefixPolicy(t *testing.T) {
	read := ReadSegCfg(nil)
	chat := LiveSegCfg(nil)
	if read.Target <= chat.Target || read.ImmediateFirst || !read.PreserveText || !chat.ImmediateFirst {
		t.Fatal("read/chat grouping policy incorrect")
	}
	text := "这是一段完整朗读。不能为了拼接删除正文，也不能混入参考录音。接下来的段落仍要保持原有文字和自然标点。"
	s := NewSegmenter(read, 17)
	parts := s.Feed(text)
	parts = append(parts, s.Flush()...)
	got := ""
	for _, part := range parts {
		got += part.Text
	}
	if got != text {
		t.Fatalf("source text changed: %q", got)
	}
}
