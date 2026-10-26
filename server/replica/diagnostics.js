'use strict';
/**
 * diagnostics.js — faithful port of go/gateway/monitor.go diagnosticClean().
 *
 * The original never returns arbitrary browser text in /api/diagnostics: it
 * walks the value with a fixed field whitelist, a fixed enum whitelist, a
 * recursion cap of 9 and a 64-element array cap. This module makes the replica
 * observe the same privacy contract, and refuses client claims over server-owned
 * fields (mergeDiagnosticClient).
 */
const DIAG_ID = /^[0-9a-f]{12,64}$/;

const FIELDS = new Set((`
request_mode content_source source_build_id source_build_match source_build_attested
acoustic_text_verified first_generated_codes_ms generated_frames decoder_calls
quality_policy codec_policy soft_limited_samples soft_limited_fraction
soft_limiter_peak_reduction_db linear_peak_limited session id segment segments chars
audio_s wall_s overall_rtf_x timeline_ms per_gpu client diagnostic_segments
diagnostic_segments_total diagnostic_segments_truncated gpu0 gpu1 gpu gen_s gen_ms
rtf rtf_x first_chunk_ms model_first_chunk_ms first_chunk_ms_mean gain_db_mean
gain_db dsp_ms max_gain_db seed speech_samples chunks chunk_size queue_ms
lock_wait_ms profile_prepare_ms worker_wall_ms queue_wait_ms dispatch_queue_ms
worker_roundtrip_ms attempts lead_ms model_stages prepare_ms token_decode_ms
codec_window_frames reference_codes_decoded prefill_ms decode_ms first_decode_ms
codec_ms model_ms quality_verified reference_pcm_splicing extra_breath_requested
extra_breath_available output_target_dbfs voice_binding cancelled failed
diagnostics available observer_failed raw_pretrim emitted_pcm_including_pause_tail
observer_cpu_ms samples sample_rate frame_samples frames active_frames
nonfinite_samples rms_dbfs peak dc_offset clip_fraction envelope_p10_dbfs
envelope_p50_dbfs envelope_p90_dbfs envelope_spread_db max_active_jump_db
active_jumps_ge6db max_sample_step spectral_frames high_band_fraction_mean
spectral_flatness_mean noise_clue_frame_fraction measured hiss_verified
naturalness_verified speaker_identity_verified analysis_clamped_samples
llm_request_start llm_response_headers llm_first_token llm_done read_text_ready
first_segment first_dispatch first_seg_worker_audio first_audio_sent all_audio_sent
stream_interrupted generation_completed llm_error error_count llm_delta_count
phase clock_origin report_sequence response_headers_ms event engine dtype rt
voice_conditioning model_output_mode first_byte_ms first_pcm_ms first_played_ms
play_command_ms first_consumed_ms generation_received_ms playback_completed_ms
end_to_end_click_completed_ms ui_initialization_ms underruns gaps_ms min_buffer_s
played_s buffered_s pending_samples end_acknowledged stream_epoch
audio_context_state base_latency_s output_latency_s speaker_heard client_untrusted
audio_bytes text_deltas text_chars received_segments stats_frames end_received
has_error events elapsed_ms at_ms pcm text_delta segment_received stats headers
request network_end worklet_first_consumed playback_drained cancelled_event
superseded_event error_event interrupted_event generation_error
`).trim().split(/\s+/));

const ENUMS = {
  phase: new Set(['generation_received', 'playing', 'playback_completed', 'cancelled',
    'superseded', 'error', 'interrupted', 'running', 'suspended', 'closed', 'browser_request_start']),
  audio_context_state: new Set(['running', 'suspended', 'closed']),
  clock_origin: new Set(['server_request_start', 'browser_request_start']),
  event: new Set(['request', 'headers', 'pcm', 'text_delta', 'segment_received', 'stats',
    'network_end', 'worklet_first_consumed', 'playback_drained', 'cancelled_event',
    'superseded_event', 'interrupted_event', 'error_event', 'generation_error']),
  request_mode: new Set(['read', 'chat']),
  content_source: new Set(['user_text', 'llm_output']),
  engine: new Set(['mock', 'faster-qwen3-tts', 'qwen-adapter-buffered']),
  dtype: new Set(['mock', 'fp16', 'bf16', 'fp32']),
  quality_policy: new Set(['sentence-linear', 'legacy-stream', 'sentence-agc',
    'sentence-agc-headroom', 'windowed-linear']),
  codec_policy: new Set(['sentence', 'windowed', 'adapter-native']),
  rt: new Set(['numpy-causal-v1', 'numpy-sentence-linear-v1']),
  voice_conditioning: new Set(['mock', 'trained-speaker-vector', 'speaker-vector-only', 'icl-generated-only-codec']),
  model_output_mode: new Set(['sentence-buffered']),
};

function clean(value, key = '', depth = 0) {
  if (depth > 9) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) return null;
    return value;
  }
  if (typeof value === 'string') {
    if ((key === 'session' || key === 'id' || key === 'voice_binding') && DIAG_ID.test(value)) return value;
    if (key === 'source_build_id' && value.length === 64 && DIAG_ID.test(value)) return value;
    if (ENUMS[key] && ENUMS[key].has(value)) return value;
    return null;   // all other strings (including user text) are dropped
  }
  if (Array.isArray(value)) {
    const v = value.length > 64 ? value.slice(value.length - 64) : value;
    return v.map((item) => clean(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, item] of Object.entries(value)) {
      if (FIELDS.has(k)) out[k] = clean(item, k, depth + 1);
    }
    return out;
  }
  return null;
}

function cleanMap(value) { return clean(value, '', 0); }

const SERVER_OWNED = ['request_mode', 'content_source', 'source_build_id',
  'source_build_match', 'source_build_attested', 'acoustic_text_verified',
  'reference_pcm_splicing', 'diagnostic_segments', 'diagnostics', 'timeline_ms',
  'per_gpu'];

/** Port of mergeDiagnosticClient(): browser reports are untrusted and bounded. */
function cleanClientPatch(patch) {
  const safe = cleanMap(patch && typeof patch === 'object' ? patch : {});
  for (const k of SERVER_OWNED) delete safe[k];
  safe.quality_verified = false;
  safe.client_untrusted = true;
  safe.speaker_heard = false;
  return safe;
}
function sequence(patch) { return Number(patch && patch.report_sequence) || 0; }

module.exports = { DIAG_ID, FIELDS, ENUMS, clean, cleanMap, cleanClientPatch, sequence, SERVER_OWNED };
