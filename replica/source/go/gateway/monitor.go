package main

// Observational, bounded, privacy-filtered views. These are not acoustic quality certificates.
import (
	"context"
	"encoding/json"
	"math"
	"regexp"
)

type diagnosticMarkKey struct{}

func diagnosticLLMMark(ctx context.Context, name string) {
	if mark, ok := ctx.Value(diagnosticMarkKey{}).(func(string)); ok {
		mark(name)
	}
}

var diagnosticID = regexp.MustCompile(`^[0-9a-f]{12,64}$`)
var diagnosticEnums = map[string]bool{"generation_received": true, "playing": true, "playback_completed": true, "cancelled": true, "superseded": true, "error": true, "interrupted": true, "running": true, "suspended": true, "closed": true, "browser_request_start": true}
var diagnosticFields = func() map[string]bool {
	result := map[string]bool{}
	for _, k := range []string{
		"request_mode", "content_source", "source_build_id", "source_build_match", "source_build_attested", "acoustic_text_verified", "first_generated_codes_ms", "generated_frames", "decoder_calls", "quality_policy", "codec_policy", "soft_limited_samples", "soft_limited_fraction", "soft_limiter_peak_reduction_db", "linear_peak_limited", "session", "id", "segment", "segments", "chars", "audio_s", "wall_s", "overall_rtf_x", "timeline_ms", "per_gpu", "client", "diagnostic_segments", "diagnostic_segments_total", "diagnostic_segments_truncated",
		"gpu0", "gpu1", "gpu", "gen_s", "gen_ms", "rtf", "rtf_x", "first_chunk_ms", "model_first_chunk_ms", "first_chunk_ms_mean", "gain_db_mean", "gain_db", "dsp_ms", "max_gain_db", "seed", "speech_samples", "chunks", "chunk_size", "queue_ms", "lock_wait_ms", "profile_prepare_ms", "worker_wall_ms", "queue_wait_ms", "dispatch_queue_ms", "worker_roundtrip_ms", "attempts", "lead_ms", "model_stages", "prepare_ms", "token_decode_ms", "codec_window_frames", "reference_codes_decoded", "prefill_ms", "decode_ms", "first_decode_ms", "codec_ms", "model_ms", "quality_verified", "reference_pcm_splicing", "extra_breath_requested", "extra_breath_available", "output_target_dbfs", "voice_binding", "cancelled", "failed",
		"diagnostics", "available", "observer_failed", "raw_pretrim", "emitted_pcm_including_pause_tail", "observer_cpu_ms", "samples", "sample_rate", "frame_samples", "frames", "active_frames", "nonfinite_samples", "rms_dbfs", "peak", "dc_offset", "clip_fraction", "envelope_p10_dbfs", "envelope_p50_dbfs", "envelope_p90_dbfs", "envelope_spread_db", "max_active_jump_db", "active_jumps_ge6db", "max_sample_step", "spectral_frames", "high_band_fraction_mean", "spectral_flatness_mean", "noise_clue_frame_fraction", "measured", "hiss_verified", "naturalness_verified", "speaker_identity_verified", "analysis_clamped_samples",
		"llm_request_start", "llm_response_headers", "llm_first_token", "llm_done", "read_text_ready", "first_segment", "first_dispatch", "first_seg_worker_audio", "first_audio_sent", "all_audio_sent", "stream_interrupted", "generation_completed", "llm_error", "error_count", "llm_delta_count",
		"phase", "clock_origin", "report_sequence", "response_headers_ms", "event", "engine", "dtype", "rt", "voice_conditioning", "model_output_mode", "first_byte_ms", "first_pcm_ms", "first_played_ms", "play_command_ms", "first_consumed_ms", "generation_received_ms", "playback_completed_ms", "end_to_end_click_completed_ms", "ui_initialization_ms", "underruns", "gaps_ms", "min_buffer_s", "played_s", "buffered_s", "pending_samples", "end_acknowledged", "stream_epoch", "audio_context_state", "base_latency_s", "output_latency_s", "speaker_heard", "client_untrusted", "audio_bytes", "text_deltas", "text_chars", "received_segments", "stats_frames", "end_received", "has_error", "events", "elapsed_ms", "at_ms", "pcm", "text_delta", "segment_received", "stats", "headers", "request", "network_end", "worklet_first_consumed", "playback_drained", "cancelled_event", "superseded_event", "error_event", "generation_error",
	} {
		result[k] = true
	}
	return result
}()

func diagnosticClean(value any, key string, depth int) any {
	if depth > 9 {
		return nil
	}
	switch v := value.(type) {
	case nil, bool:
		return v
	case string:
		if (key == "session" || key == "id" || key == "voice_binding") && diagnosticID.MatchString(v) {
			return v
		}
		switch key {
		case "phase", "audio_context_state", "clock_origin":
			if diagnosticEnums[v] {
				return v
			}
		case "event":
			if map[string]bool{"request": true, "headers": true, "pcm": true, "text_delta": true, "segment_received": true, "stats": true, "network_end": true, "worklet_first_consumed": true, "playback_drained": true, "cancelled_event": true, "superseded_event": true, "interrupted_event": true, "error_event": true}[v] {
				return v
			}
		case "request_mode":
            if v == "read" || v == "chat" { return v }
        case "content_source":
            if v == "user_text" || v == "llm_output" { return v }
        case "source_build_id":
            if len(v)==64 && diagnosticID.MatchString(v) { return v }
        case "engine":
			if v == "mock" || v == "faster-qwen3-tts" || v == "qwen-adapter-buffered" {
				return v
			}
		case "dtype":
			if v == "mock" || v == "fp16" || v == "bf16" || v == "fp32" {
				return v
			}
		case "quality_policy":
			if v == "sentence-linear" || v == "legacy-stream" || v == "sentence-agc" || v == "windowed-linear" {
				return v
			}
		case "codec_policy":
			if v == "sentence" || v == "windowed" || v == "adapter-native" {
				return v
			}
		case "rt":
			if v == "numpy-causal-v1" || v == "numpy-sentence-linear-v1" {
				return v
			}
		case "voice_conditioning":
			if v == "mock" || v == "trained-speaker-vector" || v == "speaker-vector-only" || v == "icl-generated-only-codec" {
				return v
			}
		case "model_output_mode":
			if v == "sentence-buffered" {
				return v
			}
		}
		return nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 1e15 {
			return nil
		}
		return v
	case float32:
		return diagnosticClean(float64(v), key, depth)
	case int:
		return diagnosticClean(float64(v), key, depth)
	case int64:
		return diagnosticClean(float64(v), key, depth)
	case map[string]any:
		out := map[string]any{}
		for k, item := range v {
			if diagnosticFields[k] {
				out[k] = diagnosticClean(item, k, depth+1)
			}
		}
		return out
	case map[string]float64:
		out := map[string]any{}
		for k, item := range v {
			if diagnosticFields[k] {
				out[k] = diagnosticClean(item, k, depth+1)
			}
		}
		return out
	case map[string]map[string]float64:
		out := map[string]any{}
		for k, item := range v {
			if diagnosticFields[k] {
				out[k] = diagnosticClean(item, k, depth+1)
			}
		}
		return out
	case []map[string]any:
		start := 0
		if len(v) > 64 {
			start = len(v) - 64
		}
		out := []any{}
		for _, item := range v[start:] {
			out = append(out, diagnosticClean(item, key, depth+1))
		}
		return out
	case []any:
		if len(v) > 64 {
			v = v[len(v)-64:]
		}
		out := []any{}
		for _, item := range v {
			out = append(out, diagnosticClean(item, key, depth+1))
		}
		return out
	case []float64:
		if len(v) > 64 {
			v = v[len(v)-64:]
		}
		out := []any{}
		for _, item := range v {
			out = append(out, diagnosticClean(item, key, depth+1))
		}
		return out
	}
	return nil
}
func diagnosticMap(v map[string]any) map[string]any {
	return diagnosticClean(v, "", 0).(map[string]any)
}

// Keep legacy metrics snapshots independent of later /api/report map replacements.
func diagnosticCloneRuns(runs []map[string]any) []map[string]any {
	data, err := json.Marshal(runs)
	if err != nil {
		return nil
	}
	var copy []map[string]any
	if json.Unmarshal(data, &copy) != nil {
		return nil
	}
	return copy
}

func (m *Metrics) mergeDiagnosticClient(id string, patch map[string]any) bool {
	if !diagnosticID.MatchString(id) {
		return false
	}
	safe := diagnosticMap(patch)
    // Browser cannot claim a server mode, source build, content check or DSP policy.
    for _, key := range []string{"request_mode","content_source","source_build_id","source_build_match","source_build_attested","acoustic_text_verified","reference_pcm_splicing"} { delete(safe,key) }
	delete(safe, "diagnostic_segments")
	delete(safe, "diagnostics")
	delete(safe, "timeline_ms")
	delete(safe, "per_gpu")
	safe["quality_verified"] = false
	safe["client_untrusted"] = true
	safe["speaker_heard"] = false
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := len(m.runs) - 1; i >= 0; i-- {
		if m.runs[i]["session"] == id {
			if old, ok := m.runs[i]["client"].(map[string]any); ok && diagnosticSequence(old) > diagnosticSequence(safe) {
				return true
			}
			m.runs[i]["client"] = safe
			return true
		}
	}
	if s := m.sessions[id]; s != nil {
		s.mu.Lock()
		if diagnosticSequence(s.diagnosticClient) <= diagnosticSequence(safe) {
			s.diagnosticClient = safe
		}
		s.mu.Unlock()
		return true
	}
	return false
}

func (m *Metrics) diagnosticSnapshot() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	runs := []any{}
	start := 0
	if len(m.runs) > 8 {
		start = len(m.runs) - 8
	}
	for _, run := range m.runs[start:] {
		runs = append(runs, diagnosticMap(run))
	}
	active := []any{}
	for _, s := range m.sessions {
		s.mu.Lock()
		entry := diagnosticMap(map[string]any{"request_mode":s.requestMode,"content_source":diagnosticContentSource(s.requestMode),"source_build_id":runtimeSourceID,"source_build_attested":false,"acoustic_text_verified":false,"session": s.ID, "timeline_ms": s.timeline, "chars": s.chars, "segments": len(s.jobs), "llm_delta_count": s.diagnosticDeltas, "client": s.diagnosticClient, "diagnostic_segments": diagnosticRetain(s.segStats), "diagnostic_segments_total": len(s.segStats), "diagnostic_segments_truncated": len(s.segStats) > 32})
		s.mu.Unlock()
		active = append(active, entry)
		if len(active) >= 8 {
			break
		}
	}
	return map[string]any{"schema": "qtts-diagnostics-v1", "total_runs": m.total, "runs": runs, "active": active, "quality_verified": false, "training_verified": false, "clock_origin": "server_request_start", "client_clock_origin": "browser_request_start", "physical_speaker_output_verified": false}
}

func diagnosticSequence(m map[string]any) float64 { v, _ := m["report_sequence"].(float64); return v }

func diagnosticSequenceClient(value any) float64 {
	m, _ := value.(map[string]any)
	return diagnosticSequence(m)
}
func diagnosticRetain(rows []map[string]any) []map[string]any {
	if len(rows) <= 32 {
		return rows
	}
	out := append([]map[string]any(nil), rows[:8]...)
	return append(out, rows[len(rows)-24:]...)
}
