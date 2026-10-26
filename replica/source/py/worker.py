"""QTTS GPU worker: one process per T4.

Streams Qwen3-TTS-12Hz-1.7B-Base voice-clone audio (faster-qwen3-tts CUDA-graph backend),
post-processes every chunk through isolated18 S4 bounded trimming and causal NumPy DSP and frames it for the Go gateway.

Wire format (worker -> gateway), repeated frames:  [type u8][len u32 LE][payload]
    1 = PCM int16 LE mono @ 24 kHz     2 = JSON stats (always the last frame)    3 = JSON error
"""
from __future__ import annotations

import argparse
import asyncio
import gc
import hashlib
import json
import math
import os
import queue
import random
import struct
import sys
import threading
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--gpu", type=int, default=0)
ap.add_argument("--port", type=int, default=7001)
ap.add_argument("--host", default="127.0.0.1")
ARGS, _ = ap.parse_known_args()

# must be set before torch is imported anywhere
if os.environ.get("QTTS_MOCK", "0") != "1":
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", str(ARGS.gpu))
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np  # noqa: E402

# Isolated18: unique module name avoids frozen audio_rt already in sys.modules.
# Common runtime dependencies remain frozen17; deployment entry is NOT switched.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(1, str(Path(__file__).resolve().parents[1] / "source" / "py"))
import step18_audio_rt as audio_rt  # noqa: E402
from qtts_common import (  # noqa: E402
    MOCK, MODEL_ID, SAMPLE_RATE, Ema, output_target_dbfs, count_text_units, get_logger, load_profile, now_ms, profile_dir,
)

from qwen_compat import install_qwen_rope_bridge,fatal_configuration_error
from clone_stream import conditioning, generated_only_stream
from reference_guard import clone_mode, resolved_speaker_prompt
from runtime_build import SOURCE_BUILD_ID, content_source
from voice_binding import reference_binding
from trained_profiles import guard_profile
from gpu_ownership import inference_guard
# Must precede any model load, including delayed ASR/speaker initialization.
GPU_RESOURCE_LEASE = inference_guard(mock=MOCK)

# Experimental hybrid mode: B's sentence AGC plus a policy-local soft peak guard.
# 0.86 is a test setting informed by the separate A sample peak, not a quality guarantee.
AGC_HEADROOM_PEAK_CEILING = .86
AGC_HEADROOM_LIMITER_KNEE = .02

log = get_logger(f"worker{ARGS.gpu}")
from diagnostic_audio import JobProbe
from diagnostic_store import best_effort as diagnostic_save
import uuid as diagnostic_uuid
import re as diagnostic_re


def output_max_gain_db():
    try:
        value = float(os.environ.get("QTTS_MAX_GAIN_DB", "6"))
        return value if math.isfinite(value) and 0 <= value <= 12 else 6.0
    except (TypeError, ValueError):
        return 6.0


def voice_conditioning(engine):
    if getattr(engine, "supports_trained", False):
        return "trained-speaker-vector"
    if engine.name == "mock":
        return "mock"
    clone_mode()
    return "speaker-vector-only"

F_PCM, F_STATS, F_ERR = 1, 2, 3
RESTART_EXIT_CODE = 75


def frame(t: int, payload: bytes) -> bytes:
    return struct.pack("<BI", t, len(payload)) + payload


def jframe(t: int, obj: dict) -> bytes:
    return frame(t, json.dumps(obj, ensure_ascii=False).encode("utf-8"))


# --------------------------------------------------------------------------------------
# Edge trimmer: drops model-generated leading silence, holds back trailing silence so it
# can be discarded at the end of a segment (explicit pauses are produced by the planner).
# --------------------------------------------------------------------------------------
from step18_trimmer import EdgeTrimmer


# --------------------------------------------------------------------------------------
# Engines
# --------------------------------------------------------------------------------------
class MockEngine:
    """Deterministic fake TTS (voice-like harmonic signal) so the whole pipeline can be
    exercised on machines without a GPU. ~3x real time."""

    name = "mock"
    dtype_name = "mock"
    sample_rate = SAMPLE_RATE

    def __init__(self, gpu: int):
        self.gpu = gpu
        self.speed = float(os.environ.get("QTTS_MOCK_SPEED", "3.0"))

    def load(self):
        time.sleep(0.2)

    def load_profile(self, prof: dict) -> dict:
        return {"prompt_cache": "mock", "ms": 1.0}

    def stream(self, prof, text, language, chunk_size, max_new_tokens, seed, cancel):
        sr = self.sample_rate
        units = max(count_text_units(text), 1.0)
        dur = units / float(prof.get("units_per_sec", 4.5))
        total = int(dur * sr)
        step = int(sr * 0.08 * chunk_size)
        time.sleep(0.25 / self.speed)
        rng = np.random.default_rng(seed)
        f0 = 110 + 25 * rng.random()
        pos = 0
        phase = 0.0
        while pos < total and not cancel.is_set():
            n = min(step, total - pos)
            t = (np.arange(n) + pos) / sr
            f = f0 * (1 + 0.04 * np.sin(2 * np.pi * 5 * t))
            phase_arr = phase + np.cumsum(2 * np.pi * f / sr)
            phase = float(phase_arr[-1])
            sig = sum(np.sin(k * phase_arr) / k for k in range(1, 6))
            env = 0.5 + 0.5 * np.sin(2 * np.pi * 3.8 * t)
            lead = np.clip(t / 0.15, 0, 1)
            tail = np.clip((dur - t) / 0.15, 0, 1)
            y = (0.09 * sig * env * lead * tail).astype(np.float32)
            pos += n
            time.sleep((n / sr) / self.speed)
            yield y


def next_fallback_dtype(current: str, supports_bf16: bool, allow_fp32: bool) -> str | None:
    if current == "fp16" and supports_bf16:
        return "bf16"
    if current in ("fp16", "bf16") and allow_fp32:
        return "fp32"
    return None


def native_bf16_supported(torch) -> bool:
    # Some torch versions count software/emulated BF16 as supported on Turing.
    return torch.cuda.get_device_capability()[0] >= 8 and torch.cuda.is_bf16_supported()


class RealEngine:
    name = "faster-qwen3-tts"

    def __init__(self, gpu: int):
        self.gpu = gpu
        self.model = None
        self.sample_rate = SAMPLE_RATE
        self.dtype_name = os.environ.get("QTTS_DTYPE", "fp16")
        self.allow_fp32 = os.environ.get("QTTS_ALLOW_FP32", "0") == "1"
        self.sane = False
        self._loaded_profiles: set[str] = set()
        self.last_stream_metrics = {}
        self._prompts = {}

    @staticmethod
    def _torch_dtype(name: str):
        import torch
        return {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": torch.float32}[name]

    def load(self):
        clone_mode()  # Reject conflicting mode BEFORE loading weights.
        import torch
        from faster_qwen3_tts import FasterQwen3TTS
        install_qwen_rope_bridge()

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA not available in worker")
        if torch.cuda.device_count()!=1:raise RuntimeError("worker requires one visible CUDA device; start via supervisor")
        if self.dtype_name not in ("fp16", "bf16", "fp32"):
            raise RuntimeError("QTTS_DTYPE must be fp16, bf16 or fp32")
        if self.dtype_name == "bf16" and not native_bf16_supported(torch):
            raise RuntimeError("This GPU does not support native BF16; use FP16 on T4")
        if self.dtype_name == "fp32" and not self.allow_fp32:
            raise RuntimeError("FP32 requires QTTS_ALLOW_FP32=1 after checking available memory")
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.set_float32_matmul_precision("high")
        t0 = now_ms()
        log.info("loading %s dtype=%s on cuda:0 (physical GPU %d)", MODEL_ID, self.dtype_name, ARGS.gpu)
        self.model = FasterQwen3TTS.from_pretrained(
            MODEL_ID, device="cuda", dtype=self._torch_dtype(self.dtype_name),
            attn_implementation="sdpa", max_seq_len=2048,
        )
        self.sample_rate = int(getattr(self.model, "sample_rate", SAMPLE_RATE) or SAMPLE_RATE)
        t1 = now_ms()
        self.model.warmup(prefill_len=100)
        log.info("model loaded in %.1fs, CUDA graphs captured in %.1fs", (t1 - t0) / 1000, (now_ms() - t1) / 1000)

    def _unload(self):
        import torch
        self.model = None
        self._loaded_profiles.clear()
        self._prompts.clear()
        gc.collect()
        torch.cuda.empty_cache()

    def load_profile(self, prof: dict) -> dict:
        t0 = now_ms()
        self._prompts.pop(prof["id"], None)  # No stale fallback after a failed reload.
        self._loaded_profiles.discard(prof["id"])
        anchor = str(profile_dir(prof["id"]) / prof["anchor"])
        ref_text, xvec_only = conditioning(prof)
        # Faster 0.5.4 keys by path, not file content. A deliberate reload must
        # evict every mode/text entry for that path before extracting the prompt.
        cache = getattr(self.model, "_voice_prompt_cache", {})
        for key in list(cache):
            if isinstance(key, tuple) and key and key[0] == anchor:
                del cache[key]
        how = "precomputed-version-snapshot"
        prompt, _ids, _icl = self.model._resolve_voice_clone_prompt_from_reference(
            input_ids=[None], ref_audio=anchor, ref_text=ref_text, xvec_only=xvec_only, append_silence=False)
        self._prompts[prof["id"]] = resolved_speaker_prompt(prompt, _ids, _icl)
        try:
            if not self.sane:
                self._sanity(prof)
        except BaseException:
            self._prompts.pop(prof["id"], None)
            self._loaded_profiles.discard(prof["id"])
            raise
        self._loaded_profiles.add(prof["id"])
        return {"prompt_cache": how, "ms": round(now_ms() - t0, 1), "dtype": self.dtype_name,
                "voice_conditioning": "speaker-vector-only" if xvec_only else "icl-generated-only-codec", "reference_pcm_splicing": False}

    def _sanity(self, prof: dict):
        """Validate output, using only supported and explicitly permitted fallback dtypes."""
        import torch
        for attempt in range(3):
            cancel = threading.Event()
            chunks = []
            err = None
            try:
                for i, c in enumerate(self.stream(prof, "你好，很高兴见到你。", "Chinese", 8, 90, 7, cancel)):
                    chunks.append(np.asarray(c, dtype=np.float32))
                    if len(chunks) >= 2:
                        cancel.set()
                        break
            except Exception as e:
                err = e
            audio = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
            ok = err is None and audio.size > 4000 and bool(np.isfinite(audio).all()) and audio_rt.rms_dbfs(audio) > -55
            if ok:
                self.sane = True
                log.info("sanity ok (dtype=%s, %.2fs audio, rms %.1f dBFS)", self.dtype_name, audio.size / self.sample_rate,
                         audio_rt.rms_dbfs(audio))
                return
            log.error("sanity FAILED dtype=%s err=%r n=%d", self.dtype_name, err, audio.size)
            nxt = next_fallback_dtype(self.dtype_name, native_bf16_supported(torch), self.allow_fp32)
            if not nxt:
                break
            self.dtype_name = nxt
            self._unload()
            self.load()
            anchor = str(profile_dir(prof["id"]) / prof["anchor"])
            ref_text, xvec_only = conditioning(prof)
            prompt, _ids, _icl = self.model._resolve_voice_clone_prompt_from_reference(
                input_ids=[None], ref_audio=anchor, ref_text=ref_text, xvec_only=xvec_only, append_silence=False)
            self._prompts[prof["id"]] = resolved_speaker_prompt(prompt, _ids, _icl)
        raise RuntimeError("TTS sanity check failed for every dtype")

    def stream_quality(self, *args):
        return self.stream(*args, codec_policy="sentence")

    def stream(self, prof, text, language, chunk_size, max_new_tokens, seed, cancel, codec_policy="windowed"):
        import torch
        torch.manual_seed(int(seed) & 0x7FFFFFFF)
        g = prof.get("gen", {})
        anchor = str(profile_dir(prof["id"]) / prof["anchor"])
        ref_text, xvec_only = conditioning(prof)
        if prof["id"] not in self._prompts:
            raise RuntimeError("reference prompt must be loaded and version-checked before synthesis")
        self.last_stream_metrics = {"prepare_ms": 0.0, "codec_ms": 0.0, "token_decode_ms": 0.0,
                                    "codec_window_frames": 0, "reference_codes_decoded": 0}
        it = generated_only_stream(self.model,
            text=text, language=language, ref_audio=anchor, ref_text=ref_text,
            max_new_tokens=int(max_new_tokens), temperature=float(g.get("temperature", 0.8)),
            top_k=int(g.get("top_k", 50)), top_p=float(g.get("top_p", 1.0)),
            repetition_penalty=float(g.get("repetition_penalty", 1.05)),
            chunk_size=int(chunk_size), xvec_only=xvec_only, append_silence=False, cancel=cancel,
            voice_clone_prompt=self._prompts[prof["id"]], codec_policy=codec_policy,
        )
        try:
            for audio, sr, _timing in it:
                if cancel.is_set():
                    break
                self.last_stream_metrics["prepare_ms"] = max(self.last_stream_metrics["prepare_ms"], float(_timing.get("prepare_ms", 0)))
                self.last_stream_metrics["codec_ms"] += float(_timing.get("codec_ms", 0))
                self.last_stream_metrics["token_decode_ms"] += float(_timing.get("decode_ms", 0))
                self.last_stream_metrics["codec_window_frames"] = max(self.last_stream_metrics["codec_window_frames"], int(_timing.get("codec_window_frames", 0)))
                for key in ("first_generated_codes_ms", "generated_frames", "decoder_calls"):
                    if key in _timing:
                        self.last_stream_metrics[key] = _timing[key]
                a = np.asarray(audio, dtype=np.float32).reshape(-1)
                if int(sr) != SAMPLE_RATE:
                    raise RuntimeError(f"TTS returned {sr}Hz but the PCM protocol requires {SAMPLE_RATE}Hz")
                yield a
        finally:
            close = getattr(it, "close", None)
            if close:
                close()

    def vram(self):
        import torch
        free, total = torch.cuda.mem_get_info()
        return {"used_mb": round((total - free) / 2**20), "total_mb": round(total / 2**20),
                "alloc_mb": round(torch.cuda.memory_allocated() / 2**20)}


# --------------------------------------------------------------------------------------
# Worker core
# --------------------------------------------------------------------------------------
class Worker:
    def __init__(self):
        kind=os.environ.get('QTTS_TTS_ENGINE','faster')
        if kind not in ('faster','qwen-adapter-buffered'):raise RuntimeError('unknown QTTS_TTS_ENGINE; no fallback')
        if kind=='qwen-adapter-buffered':
            if MOCK:raise RuntimeError('trained adapter backend cannot run as Mock')
            from adapter_engine import AdapterEngine
            from qtts_common import STATE
            self.engine=AdapterEngine(ARGS.gpu,STATE,MODEL_ID,os.environ.get('QTTS_BASE_SHA256',''))
        else:self.engine=MockEngine(ARGS.gpu) if MOCK else RealEngine(ARGS.gpu)
        self.ready = False
        self.error: str | None = None
        self.lock = threading.Lock()
        self.busy = False
        self.last_progress = time.time()
        self.served = 0
        self.failed = 0
        self.rtf = Ema(0.25)      # audio seconds / wall second
        self.ttfa = Ema(0.25)     # ms to first speech chunk of the engine
        self.profiles: dict[str, dict] = {}
        self.levelers: dict[str, audio_rt.Leveler] = {}
        self.voice_bindings: dict[str, str] = {}
        self.breath_banks: dict[str, list[np.ndarray]] = {}
        self.fatal_error = False
        self.restart_requested = False
        self.started = time.time()

    # -- loading ---------------------------------------------------------------------
    def boot(self):
        try:
            self.engine.load()
            self.ready = True
            log.info("worker ready (engine=%s rt=%s)", self.engine.name, audio_rt.BACKEND)
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"
            self.fatal_error=fatal_configuration_error(e)
            log.exception("engine load failed")

    def _load_profile_locked(self, pid: str, prof: dict) -> dict:
        if prof.get("id") != pid:
            raise ValueError("profile id mismatch")
        guard_profile(prof, getattr(self.engine, "supports_trained", False))
        binding = reference_binding(profile_dir(pid), prof, allow_missing=MOCK)
        info = self.engine.load_profile(prof)
        if reference_binding(profile_dir(pid), prof, allow_missing=MOCK) != binding:
            raise RuntimeError("reference changed during prompt extraction; retry a new session")
        self.profiles[pid] = prof
        self.voice_bindings[pid] = binding
        self._reset_leveler(pid)
        self.breath_banks[pid] = []
        info.update(breath_clips=0, output_target_dbfs=output_target_dbfs(), voice_binding=binding, voice_conditioning=voice_conditioning(self.engine))
        return info

    def _reset_leveler(self, pid, *, peak_ceiling=.99, limiter_knee=.10):
        old = self.levelers.pop(pid, None)
        if old:
            old.close()
        self.levelers[pid] = audio_rt.Leveler(
            SAMPLE_RATE, output_target_dbfs(), max_gain_db=output_max_gain_db(),
            peak_ceiling=peak_ceiling, limiter_knee=limiter_knee,
        )
        return self.levelers[pid]

    def load_profile(self, pid: str) -> dict:
        if not self.ready:
            raise RuntimeError("engine not ready")
        with self.lock:
            # Read after acquiring the same lock used by synthesis, not before it.
            prof = load_profile(pid)
            if not prof:
                raise FileNotFoundError(f"profile {pid} not found")
            return self._load_profile_locked(pid, prof)

    # -- lead pause / breath ---------------------------------------------------------
    def lead_audio(self, prof: dict, pause_ms: int, want_breath: bool, seed: int) -> np.ndarray:
        """Planner pauses only. User reference clips never become playback samples."""
        pause_ms = int(max(0, min(pause_ms, 1500)))
        return np.zeros(int(SAMPLE_RATE * pause_ms / 1000), dtype=np.float32)

    def run_job(self, body: dict, emit, cancel: threading.Event, t_req: float):
        stats: dict = {"gpu": ARGS.gpu, "engine": self.engine.name, "rt": audio_rt.BACKEND,
                       "dtype": self.engine.dtype_name, "anomalies": [], "source_build_id": SOURCE_BUILD_ID, "source_build_attested": False, "acoustic_text_verified": False}
        request_mode = body.get("request_mode")
        if type(request_mode) is str and request_mode in ("read", "chat"):
            stats.update(request_mode=request_mode, content_source=content_source(request_mode))
        if getattr(self.engine,"supports_trained",False):stats.update(model_output_mode="sentence-buffered",quality_verified=False,inference_reload_verified=False)
        probe = JobProbe()
        monitor_id = diagnostic_uuid.uuid4().hex
        monitor_session = body.get("diagnostic_session", "")
        if not isinstance(monitor_session, str) or not diagnostic_re.fullmatch(r"[0-9a-f]{12,64}", monitor_session):
            monitor_session = ""
        monitor_segment = body.get("diagnostic_segment", -1)
        if type(monitor_segment) is not int or not -1 <= monitor_segment <= 100000:
            monitor_segment = -1
        acquired = False
        trimmer = None
        try:
            policy = body.get("quality_policy", "legacy-stream")
            if policy not in ("legacy-stream", "sentence-linear", "sentence-agc", "sentence-agc-headroom", "windowed-linear"):
                raise ValueError("unsupported quality policy")
            quality = policy in ("sentence-linear", "windowed-linear")
            sentence_codec = policy in ("sentence-linear", "sentence-agc", "sentence-agc-headroom")
            stats["quality_policy"] = policy
            stats["codec_policy"] = "adapter-native" if getattr(self.engine, "supports_trained", False) else "sentence" if sentence_codec else "windowed"
            if quality or sentence_codec:
                stats["model_output_mode"] = "sentence-buffered"
            if quality:
                stats["rt"] = "numpy-sentence-linear-v1"
                stats["model_output_mode"] = "sentence-buffered"
            if not self.ready:
                raise RuntimeError(self.error or "worker not ready")
            pid = body["profile"]
            text = str(body["text"]).strip()
            if not text:
                raise ValueError("empty text")
            lock_started = now_ms()
            while not self.lock.acquire(timeout=0.1):
                if cancel.is_set():
                    return
            acquired = True
            stats["lock_wait_ms"] = round(now_ms()-lock_started,3)
            profile_prepare_started = now_ms()
            if cancel.is_set():
                return
            # Session pins are checked BEFORE even silent lead PCM is emitted.
            prof = load_profile(pid) or (self.profiles.get(pid) if MOCK else None)
            if not prof:
                raise FileNotFoundError(f"profile {pid} not found")
            guard_profile(prof, getattr(self.engine, "supports_trained", False))
            binding = reference_binding(profile_dir(pid), prof, allow_missing=MOCK)
            if body.get("voice_conditioning") is not None and body["voice_conditioning"] != voice_conditioning(self.engine):
                raise RuntimeError("worker conditioning mode differs from session; no mixed-mode fallback")
            requested = body.get("voice_binding")
            if requested is not None and (not isinstance(requested, str) or requested != binding):
                raise RuntimeError("voice reference changed; start a new session (no mixed-voice fallback)")
            if pid not in self.profiles or self.voice_bindings.get(pid, "") != binding or (hasattr(self.engine, "_prompts") and pid not in self.engine._prompts):
                self._load_profile_locked(pid, prof)
            # Use the loaded immutable dict, never a snapshot captured before lock.
            prof = self.profiles[pid]
            stats["voice_binding"] = binding
            stats["profile_prepare_ms"] = round(now_ms()-profile_prepare_started,3)
            self.busy = True
            self.last_progress = time.time()
            t_start = now_ms()
            stats["queue_ms"] = round(t_start - t_req, 1)
            seed = int(body.get("seed", random.randrange(1 << 30)))
            chunk_size = int(max(2, min(int(body.get("chunk_size", 8)), 16)))
            lang = body.get("language") or "Auto"
            ups = float(prof.get("units_per_sec", 4.5))
            units = max(count_text_units(text), 1.0)
            exp_s = units / ups
            max_new = int(max(40, min(1500, exp_s * 12.5 * 2.2 + 25)))
            if quality:
                old = self.levelers.pop(pid, None)
                if old:
                    old.close()
                leveler = audio_rt.SentenceLinearLeveler(SAMPLE_RATE, output_target_dbfs(), output_max_gain_db())
                self.levelers[pid] = leveler
            elif policy == "sentence-agc-headroom":
                leveler = self._reset_leveler(
                    pid, peak_ceiling=AGC_HEADROOM_PEAK_CEILING,
                    limiter_knee=AGC_HEADROOM_LIMITER_KNEE,
                )
            else:
                leveler = self._reset_leveler(pid)
            quality_parts, quality_samples, quality_finalizing = [], 0, False
            dsp_ms = 0.0

            # Explicit silent pause only; never send a reference clip as a low-latency placeholder.
            lead = self.lead_audio(prof, int(body.get("lead_pause_ms", 0)), bool(body.get("breath", False)), seed)
            if lead.size and not (quality or sentence_codec) and not getattr(self.engine,"supports_trained",False):
                lead_pcm = audio_rt.f32_to_i16(lead)
                emit(frame(F_PCM, lead_pcm.tobytes()))
                probe.feed(lead_pcm, output=True)
            stats["lead_ms"] = round(lead.size * 1000 / SAMPLE_RATE, 1)

            trimmer = EdgeTrimmer()
            leveler.start_segment()
            speech_samples = 0
            chunks = 0
            first_ms = None
            model_first_ms = None
            stats["cancelled_after_trim_samples"] = 0

            def emit_trimmed(a):
                nonlocal dsp_ms, first_ms, speech_samples, chunks, quality_samples
                if not a.size:
                    return
                if cancel.is_set():
                    stats["cancelled_after_trim_samples"] += int(a.size)
                    return
                if quality and not quality_finalizing:
                    quality_samples += int(a.size)
                    if quality_samples > 384 * 1920:
                        raise RuntimeError("quality sentence exceeds PCM budget; no truncated/fallback audio")
                    quality_parts.append(a.copy())
                    return
                dsp_start = now_ms()
                pcm = leveler.process(a)
                dsp_ms += now_ms() - dsp_start
                if cancel.is_set():
                    stats["cancelled_after_trim_samples"] += int(a.size)
                    return
                if not pcm.size:
                    return
                if first_ms is None:
                    first_ms = now_ms() - t_start
                    if lead.size and (quality or sentence_codec or getattr(self.engine,"supports_trained",False)):
                        lead_pcm = audio_rt.f32_to_i16(lead)
                        emit(frame(F_PCM,lead_pcm.tobytes()))
                        probe.feed(lead_pcm, output=True)
                speech_samples += pcm.size
                chunks += 1
                emit(frame(F_PCM, pcm.tobytes()))
                probe.feed(pcm, output=True)
            stream = self.engine.stream
            if sentence_codec and self.engine.name != "mock" and not getattr(self.engine, "supports_trained", False):
                stream = self.engine.stream_quality
            for a in stream(prof, text, lang, chunk_size, max_new, seed, cancel):
                if cancel.is_set():
                    break
                self.last_progress = time.time()
                if not np.asarray(a).size:
                    continue  # internal code progress: heartbeat only, no fake first PCM
                if model_first_ms is None:
                    model_first_ms = now_ms() - t_start
                probe.feed(a)
                if quality and not np.isfinite(a).all():
                    raise ValueError("non-finite quality audio; no concealed sample replacement")
                if not np.isfinite(a).all():
                    stats["anomalies"].append("nan_chunk")
                    a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)
                dsp_start = now_ms()
                trimmed = trimmer.push(a)
                dsp_ms += now_ms() - dsp_start
                emit_trimmed(trimmed)
            dsp_start = now_ms()
            final_audio = trimmer.finish(cancelled=cancel.is_set())
            dsp_ms += now_ms() - dsp_start
            emit_trimmed(final_audio)
            if quality:
                quality_finalizing = True
                if quality_parts and not cancel.is_set():
                    emit_trimmed(np.concatenate(quality_parts))
                quality_parts.clear()
            if cancel.is_set():
                stats["cancelled"] = True
            else:
                if speech_samples:
                    tail_pcm = leveler.flush(192)
                    if tail_pcm.size and not cancel.is_set():
                        emit(frame(F_PCM, tail_pcm.tobytes()))
                        probe.feed(tail_pcm, output=True)
                tail = int(body.get("tail_pause_ms", 0))
                if tail > 0 and not cancel.is_set():
                    pause_pcm = np.zeros(int(SAMPLE_RATE * min(tail, 1500) / 1000), np.int16)
                    emit(frame(F_PCM, pause_pcm.tobytes()))
                    probe.feed(pause_pcm, output=True)
                if cancel.is_set():
                    stats["cancelled"] = True
            gen_ms = now_ms() - t_start
            audio_s = speech_samples / SAMPLE_RATE
            stats.update({
                "first_chunk_ms": round(first_ms if first_ms is not None else -1, 1), "model_first_chunk_ms": round(model_first_ms if model_first_ms is not None else -1, 1),
                "extra_breath_mode": "disabled-no-reference-playback",
                "extra_breath_requested": bool(body.get("breath", False)),
                "extra_breath_available": False,
                "voice_conditioning": voice_conditioning(self.engine),
                "reference_pcm_splicing": False, "output_target_dbfs": output_target_dbfs(), "acoustic_text_verified": False, "gen_ms": round(gen_ms, 1), "audio_s": round(audio_s, 3), "speech_samples": speech_samples,
                "rtf_x": round(audio_s / max(gen_ms / 1000, 1e-3), 3),
                "rtf": round(gen_ms / 1000 / audio_s, 4) if audio_s > 0 else None, "chunks": chunks, "chunk_size": chunk_size,
                "soft_limited_samples": leveler._stats.soft_limited_samples,
                "soft_limited_fraction": leveler._stats.soft_limited_samples / max(1, leveler._stats.samples),
                "soft_limiter_peak_reduction_db": leveler._stats.soft_limiter_peak_reduction_db,
                "soft_limiter_ceiling_dbfs": round(leveler.soft_limiter_ceiling_dbfs, 2) if hasattr(leveler, "soft_limiter_ceiling_dbfs") else None,
                "linear_peak_limited": getattr(leveler, "peak_limited", False),
                "gain_db": round(leveler.gain_db, 2), "env_dbfs": round(leveler.env_dbfs, 2), "expected_s": round(exp_s, 2),
                "seed": seed, "max_gain_db": output_max_gain_db(), "dsp_ms": round(dsp_ms, 3),
                "model_stages": getattr(self.engine, "last_stream_metrics", {}),
                "quality_verified": False, "rtf_target": 0.3,
            })
            if not stats.get("cancelled"):
                if audio_s < 0.35 * exp_s or audio_s < 0.2:
                    stats["anomalies"].append("too_short")
                if audio_s > 2.3 * exp_s + 1.0:
                    stats["anomalies"].append("too_long")
                if chunks and trimmer.lead_limit_reached:
                    stats["anomalies"].append("long_leading_silence")
                if audio_s > 0.5:
                    self.rtf.update(audio_s / max(gen_ms / 1000, 1e-3))
                if first_ms:
                    self.ttfa.update(first_ms)
            self.served += 1
        except Exception as e:  # noqa: BLE001
            self.failed += 1
            log.exception("job failed")
            emit(jframe(F_ERR, {"error": f"{type(e).__name__}: {e}", "gpu": ARGS.gpu}))
            stats["failed"] = True
        finally:
            if trimmer is not None:
                trimmer.finish(cancelled=True)  # exception/cancel cleanup; completed finish is idempotent
                stats["trim"] = trimmer.snapshot()
            if acquired:
                self.busy = False
                self.last_progress = time.time()
                self.lock.release()
                self.after_job()
            stats["diagnostics"] = {"id": monitor_id, "session": monitor_session,
                                    "segment": monitor_segment, **probe.finish()}
            stats["diagnostic_journal_saved"] = diagnostic_save(f"worker{ARGS.gpu}", {
                "id": monitor_id, "session": monitor_session, "segment": monitor_segment,
                "kind": "synthesis", "status": "failed" if stats.get("failed") else "cancelled" if cancel.is_set() else "done",
                "gpu": ARGS.gpu, "engine":stats.get("engine"),"dtype":stats.get("dtype"),"rt":stats.get("rt"),
                "queue_ms":stats.get("queue_ms"),"lock_wait_ms":stats.get("lock_wait_ms"),"profile_prepare_ms":stats.get("profile_prepare_ms"),"model_stages":stats.get("model_stages"), "seed": stats.get("seed"), "voice_binding": stats.get("voice_binding"),
                "gen_ms": stats.get("gen_ms"), "audio_s": stats.get("audio_s"), "rtf": stats.get("rtf"),
                "first_chunk_ms": stats.get("first_chunk_ms"), "model_first_chunk_ms": stats.get("model_first_chunk_ms"),
                "quality_policy": stats.get("quality_policy"), "codec_policy": stats.get("codec_policy"),
                "soft_limited_samples": stats.get("soft_limited_samples"), "soft_limited_fraction": stats.get("soft_limited_fraction"),
                "soft_limiter_peak_reduction_db": stats.get("soft_limiter_peak_reduction_db"),
                "soft_limiter_ceiling_dbfs": stats.get("soft_limiter_ceiling_dbfs"),
                "linear_peak_limited": stats.get("linear_peak_limited"),
                "dsp_ms": stats.get("dsp_ms"), "gain_db": stats.get("gain_db"), "diagnostics": stats["diagnostics"],
                "request_mode": stats.get("request_mode"), "content_source": stats.get("content_source"),
                "source_build_id": SOURCE_BUILD_ID, "source_build_attested": False,
                "voice_conditioning": stats.get("voice_conditioning"), "reference_pcm_splicing": stats.get("reference_pcm_splicing"),
                "extra_breath_requested": stats.get("extra_breath_requested"),
                "extra_breath_available": stats.get("extra_breath_available"),
                "acoustic_text_verified": False, "quality_verified": False})
            stats["worker_wall_ms"] = round(now_ms()-t_req,3)
            emit(jframe(F_STATS, stats))
            emit(None)

    def after_job(self):
        if MOCK:
            return
        try:
            import torch
            if self.served % 25 == 0:
                gc.collect()
                torch.cuda.empty_cache()
            v = self.engine.vram()
            max_served = int(os.environ.get("QTTS_RESTART_AFTER", "600"))
            if os.environ.get("QTTS_RESIDENT","1")=="1":
                if v["alloc_mb"]>13500:log.warning("resident model: high allocated VRAM %dMB; inspect actual headroom",v["alloc_mb"])
                return
            if v["alloc_mb"] > 13500 or self.served >= max_served:
                log.warning("requesting graceful restart (alloc=%dMB served=%d)", v["alloc_mb"], self.served)
                self.restart_requested = True
        except Exception:  # noqa: BLE001
            pass


W = Worker()

# --------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402

app = FastAPI(title=f"qtts-worker-{ARGS.gpu}")


@app.on_event("startup")
async def _startup():
    threading.Thread(target=W.boot, daemon=True, name="boot").start()
    threading.Thread(target=_restart_watch, daemon=True, name="restart-watch").start()


def _restart_watch():
    """Exit with a dedicated code when idle and a restart was requested (supervisor restarts us)."""
    while True:
        time.sleep(1.0)
        if W.restart_requested and not W.busy:
            log.warning("graceful restart now")
            os._exit(RESTART_EXIT_CODE)


@app.get("/health")
async def health():
    d = {
        "gpu": ARGS.gpu, "ready": W.ready, "error": W.error, "busy": W.busy, "engine": W.engine.name,
        "dtype": W.engine.dtype_name, "rt": audio_rt.BACKEND, "served": W.served, "failed": W.failed,
        "rtf_x": round(W.rtf.get(0.0), 3), "first_chunk_ms": round(W.ttfa.get(0.0), 1),
        "idle_for_s": round(time.time() - W.last_progress, 1), "uptime_s": round(time.time() - W.started, 1),
        "profiles": list(W.profiles.keys()), "voice_bindings": dict(W.voice_bindings),
        "voice_conditioning": voice_conditioning(W.engine),
        "codec_policy": "generated-only-25-left-optional-right", "rtf_target_verified": False,
        "fatal_error": W.fatal_error, "requested_model": MODEL_ID,
        "model_loaded": W.ready and not MOCK and getattr(W.engine,"model",None) is not None,
        "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        "residency_policy": "session-resident" if os.environ.get("QTTS_RESIDENT","1")=="1" else "periodic-recycle",
        "stalled_s": round(time.time() - W.last_progress, 1) if W.busy else 0.0,
    }
    if getattr(W.engine,"supports_trained",False):
        d["model_output_mode"]="sentence-buffered"
        d["quality_verified"]=False
    if W.ready and not MOCK:
        try:
            d["vram"] = W.engine.vram()
        except Exception:  # noqa: BLE001
            pass
    return d


@app.post("/profile/load")
async def profile_load(req: Request):
    body = await req.json()
    loop = asyncio.get_running_loop()
    try:
        info = await loop.run_in_executor(None, W.load_profile, str(body["profile"]))
        return {"ok": True, **info}
    except Exception as e:  # noqa: BLE001
        log.exception("profile load failed")
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"}, status_code=500)


@app.post("/synth")
async def synth(req: Request):
    body = await req.json()
    t_req = now_ms()
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    cancel = threading.Event()

    def emit(item):
        loop.call_soon_threadsafe(q.put_nowait, item)

    threading.Thread(target=W.run_job, args=(body, emit, cancel, t_req), daemon=True, name="job").start()

    async def gen():
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                yield item
        finally:
            cancel.set()

    return StreamingResponse(gen(), media_type="application/octet-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    import uvicorn
    log.info("starting worker gpu=%d port=%d mock=%s rt=%s", ARGS.gpu, ARGS.port, MOCK, audio_rt.BACKEND)
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="warning", access_log=False)
