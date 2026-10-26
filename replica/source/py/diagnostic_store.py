"""Small atomic diagnostic journals: no audio, text, filenames, keys or raw exceptions."""
from __future__ import annotations
import json
import math
import os
import re
import threading
import time
import uuid
from pathlib import Path

_LOCK = threading.RLock()
_ROLES = {"worker0", "worker1", "reference", "pair"}
# Explicit string whitelist. Unrecognized strings, keys and arbitrary payloads never export.
_KEYS = set("""request_mode content_source source_build_id source_build_attested acoustic_text_verified reference_pcm_splicing extra_breath_requested extra_breath_available id session segment at_unix_ms revision events schema role kind history_limit status phase progress_pct
samples audio_s sample_rate frame_samples frames active_frames nonfinite_samples rms_dbfs peak dc_offset
clip_fraction envelope_p10_dbfs envelope_p50_dbfs envelope_p90_dbfs envelope_spread_db max_active_jump_db
active_jumps_ge6db max_sample_step spectral_frames high_band_fraction_mean spectral_flatness_mean
noise_clue_frame_fraction observer_cpu_ms measured hiss_verified naturalness_verified speaker_identity_verified
available observer_failed quality_verified raw_pretrim emitted_pcm_including_pause_tail diagnostics
reference_raw reference_processed file_index stage_ms decode denoise speaker asr candidates speaker_load decode_denoise transcription scoring anchor_save workers_load optional_calibration
anchor anchor_candidate breath calibrated no_ref_text manual_text_used build_s duration_s files_count training_started training_completed
trained_adapter_verified gpu seed gen_ms first_chunk_ms model_first_chunk_ms queue_ms lock_wait_ms profile_prepare_ms worker_wall_ms lead_ms
RTF rtf rtf_x dsp_ms model_stages gain_db max_gain_db audio_samples binding_matches same_binding engine dtype rt voice_conditioning model_output_mode rtf binding_matches same_text same_seed
same_engine same_dtype distinct_gpu_labels observed_pair_valid waveform_identical waveform_lag0_correlation
waveform_compared_samples speaker_cosine speaker_metric_available reference_speaker_metric_available reference_cosine_gpu0 reference_cosine_gpu1
same_binding output_dbfs_delta output_high_band_delta gpu0 gpu1 hashes_equal physical_identity_verified
voice_binding model_ready dataset_preparation_only run_started steps_completed loss loss_finite
input_samples output_samples last_step elapsed_s checkpoint_published state_changed event_count missing_sources
analysis_clamped_samples speaker_load prepare_ms codec_ms token_decode_ms codec_window_frames reference_codes_decoded first_generated_codes_ms generated_frames decoder_calls quality_policy codec_policy soft_limited_samples soft_limited_fraction soft_limiter_peak_reduction_db soft_limiter_ceiling_dbfs linear_peak_limited""".split())
_ENUMS = {"qtts-diagnostics-v1", "worker0", "worker1", "reference", "pair", "synthesis", "reference_processing",
          "profile_ready", "failed", "cancelled", "running", "done", "pair_test", "training", "unavailable"}


def clean(value, key="", depth=0):
    if depth > 8:
        return None
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or abs(value) > 1e15:
            return None
        return value
    if isinstance(value, str):
        if key in {"schema","role","kind","status","phase"} and value in _ENUMS:
            return value
        if key == "source_build_id" and re.fullmatch(r"[0-9a-f]{64}", value):
            return value
        if key == "request_mode" and value in {"read", "chat"}:
            return value
        if key == "content_source" and value in {"user_text", "llm_output"}:
            return value
        if key in {"id", "session", "voice_binding"} and re.fullmatch(r"[0-9a-f]{12,64}", value):
            return value
        if key in {"engine","dtype","rt","voice_conditioning","model_output_mode","quality_policy","codec_policy"} and value in {
            "mock","faster-qwen3-tts","qwen-adapter-buffered","fp16","bf16","fp32","numpy-causal-v1",
            "sentence-linear","sentence-agc","sentence-agc-headroom","windowed-linear","legacy-stream","windowed","sentence","adapter-native","numpy-sentence-linear-v1","trained-speaker-vector","speaker-vector-only","icl-generated-only-codec","sentence-buffered"}:
            return value
        return None
    if isinstance(value, dict):
        return {k: clean(v, k, depth + 1) for k, v in value.items() if k in _KEYS}
    if isinstance(value, (list, tuple)):
        return [clean(v, key, depth + 1) for v in value[:64]]
    return None


def directory(state=None):
    state = Path(state or os.environ.get("QTTS_STATE", Path(os.environ.get("QTTS_ROOT", ".")) / "state"))
    result = state / "diagnostics"
    result.mkdir(mode=0o700, parents=True, exist_ok=True)
    if result.is_symlink():
        raise OSError("diagnostic directory must not be a symlink")
    return result


def _read(path):
    if path.is_symlink() or not path.is_file():
        return {"events": [], "revision": 0}
    if path.stat().st_size > 262144:
        raise ValueError("diagnostic journal exceeds budget")
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        raise ValueError("invalid diagnostic journal")
    return clean(data)


def save(role, event, state=None):
    if role not in _ROLES:
        raise ValueError("invalid diagnostic role")
    with _LOCK:
        target = directory(state) / (role + ".json")
        previous = _read(target)
        item = clean({**event, "role": role, "at_unix_ms": int(time.time() * 1000)})
        events = [e for e in previous["events"] if isinstance(e, dict) and e.get("id") != item.get("id")]
        events.append(item)
        data = {"schema": "qtts-diagnostics-v1", "revision": previous.get("revision", 0) + 1,
                "events": events[-16:]}
        encoded = json.dumps(data, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode()
        if len(encoded) > 262144:
            raise ValueError("diagnostic journal exceeds budget")
        temp = target.with_name("." + role + "." + uuid.uuid4().hex)
        try:
            with temp.open("xb") as stream:
                os.chmod(temp, 0o600)
                stream.write(encoded)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        return item


def snapshot(state=None):
    result, missing = {}, []
    folder = directory(state)
    with _LOCK:
        for role in sorted(_ROLES):
            try:
                if not (folder / (role + ".json")).exists():
                    missing.append(role)
                    continue
                result[role] = _read(folder / (role + ".json"))
            except Exception:
                missing.append(role)
    return {"schema": "qtts-diagnostics-v1", "history_limit": 16, "journals": result, "missing_sources": missing,
            "quality_verified": False, "training_verified": False}


def best_effort(role, event):
    try:
        save(role, event)
        return True
    except Exception:
        return False
