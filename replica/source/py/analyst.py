"""QTTS analyst service (port 7010): Voice Lab + quality monitor.

 * builds a voice profile from many noisy, text-less reference recordings
   (decode -> measured denoise -> Whisper ASR -> candidate anchors scored on envelope-spread proxy / ASR confidence /
    speaker typicality / expressiveness -> real breath bank -> prosody statistics)
 * evaluates generated audio against the reference as the single anchor:
   speaker similarity (ECAPA), ASR CER, F0, speaking rate, RMS dynamics, spectrum, pauses
 * checks both GPUs for consistency and calibrates candidate anchors by synthesising on the GPU
"""
from __future__ import annotations

import asyncio
import datetime as dt
import io
import hashlib
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Candidate-only dependency fallback: frozen17 modules remain unchanged.
sys.path.insert(1, str(Path(__file__).resolve().parents[1] / 'source' / 'py'))
from step18_profile_inputs import (profile_body, text_value, index_value, candidate,
    safe_name, regular_bytes, install_anchor, profile_lock)
from step18_calibration_state import exclusive_calibration, snapshot, confirm_snapshot
from step18_calibration_metrics import (CalibrationResult, centroid_value, evaluate_trial,
    failed_trials, summarize, safe_workers, build_summary)
from reference_segments import context_seconds, prepare_segments
from voice_binding import reference_binding
from qtts_common import (  # noqa: E402
    ANALYST_PORT, MOCK, PROFILES_DIR, SAMPLE_RATE, STATE, WORKER_PORTS, count_text_units, get_logger,
    load_profile, profile_dir, read_json, slugify, write_json_atomic, output_target_dbfs,
)

from gpu_ownership import inference_guard
# Must precede any model load, including delayed ASR/speaker initialization.
GPU_RESOURCE_LEASE = inference_guard(mock=MOCK)

log = get_logger("analyst")
from diagnostic_audio import safe_observe as diagnostic_observe
from diagnostic_store import best_effort as diagnostic_save, snapshot as diagnostic_snapshot
WORKERS = [f"http://127.0.0.1:{p}" for p in WORKER_PORTS]
from resource_limits import UploadLimits, UploadRejected, read_upload, BodyBudgetMiddleware, BuildAdmission, HeavyAdmission

LIMITS = UploadLimits.from_env()
ADMISSION = BuildAdmission()
HEAVY = HeavyAdmission()
from voice_library import LibraryStore
LIBRARIES = LibraryStore.configured(STATE,LIMITS)
from training_data import TrainingDataStore
TRAINING_DATA = TrainingDataStore.configured(STATE,LIMITS)

SR = SAMPLE_RATE
LANG_NAME = {"zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German", "fr": "French",
             "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian"}
TARGET_DBFS = -21.0

# ----------------------------------------------------------------------------------------
# DSP helpers
# ----------------------------------------------------------------------------------------

def decode_audio(data: bytes, name: str = "ref") -> np.ndarray:
    """Any container/codec -> mono float32 @ 24 kHz (ffmpeg, falling back to soundfile)."""
    try:
        p = subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0", "-vn", "-sn", "-dn", "-threads", "2", "-t", str(LIMITS.seconds + 1), "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
            input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        if p.returncode == 0 and len(p.stdout) > 4:
            if len(p.stdout) // 4 > SR * LIMITS.seconds:
                raise UploadRejected("decoded audio exceeds configured duration limit")
            return np.frombuffer(p.stdout, dtype=np.float32).copy()
        err = p.stderr.decode("utf-8", "ignore")[:200]
    except (OSError, subprocess.TimeoutExpired) as e:
        err = str(e)
    try:
        import soundfile as sf
        with sf.SoundFile(io.BytesIO(data)) as source:
            if (source.frames / source.samplerate > LIMITS.seconds or source.channels > 8
                    or not 8000 <= source.samplerate <= 192000):
                raise UploadRejected("audio duration/channel/sample-rate limit exceeded")
            sr = source.samplerate
            y = source.read(dtype="float32", always_2d=False)
        if y.ndim > 1:
            y = y.mean(axis=1)
        return resample(y, sr, SR)
    except UploadRejected:
        raise
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"cannot decode {name}: {err or e}") from e


def resample(y: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return y.astype(np.float32)
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(sr_in, sr_out)
    return resample_poly(y, sr_out // g, sr_in // g).astype(np.float32)


def to16k(y24: np.ndarray) -> np.ndarray:
    return resample(y24, SR, 16000)


def highpass(y: np.ndarray, sr: int, fc: float = 55.0) -> np.ndarray:
    from scipy.signal import butter, sosfiltfilt
    sos = butter(4, fc / (sr / 2), btype="high", output="sos")
    return sosfiltfilt(sos, y).astype(np.float32)


def frame_rms_db(y: np.ndarray, sr: int, win_ms: float = 20.0) -> np.ndarray:
    n = max(int(sr * win_ms / 1000), 1)
    m = (len(y) // n) * n
    if m == 0:
        return np.full(1, -90.0)
    r = np.sqrt(np.mean(y[:m].reshape(-1, n).astype(np.float64) ** 2, axis=1))
    return 20 * np.log10(np.maximum(r, 1e-7))


def level_spread_proxy_db(y: np.ndarray, sr: int) -> float:
    """Robust speech-envelope spread proxy; not a measured noise floor or acoustic SNR."""
    db = frame_rms_db(y, sr)
    if db.size < 10:
        return 0.0
    return float(np.percentile(db, 92) - np.percentile(db, 8))


def speech_rms_dbfs(y: np.ndarray, sr: int) -> float:
    db = frame_rms_db(y, sr)
    thr = np.percentile(db, 92) - 25
    sel = db[db > max(thr, -55)]
    if sel.size == 0:
        return float(np.percentile(db, 90))
    return float(10 * np.log10(np.mean(10 ** (sel / 10))))


def normalize_speech(y: np.ndarray, sr: int, target: float = TARGET_DBFS) -> np.ndarray:
    g = float(np.clip(target - speech_rms_dbfs(y, sr), -14, 14))
    out = y * (10 ** (g / 20))
    pk = float(np.max(np.abs(out)) + 1e-9)
    if pk > 0.95:
        out = out * (0.95 / pk)
    return out.astype(np.float32)


def denoise(y: np.ndarray, sr: int, strength: float) -> np.ndarray:
    import noisereduce as nr
    return nr.reduce_noise(y=y, sr=sr, stationary=False, prop_decrease=strength, n_fft=1024,
                           time_mask_smooth_ms=60, freq_mask_smooth_hz=400).astype(np.float32)


def f0_track(y16: np.ndarray, accurate: bool = False) -> np.ndarray:
    """Hz per frame (nan = unvoiced)."""
    import librosa
    if y16.size < 2048:
        return np.zeros(0)
    if accurate:
        f0, vf, _ = librosa.pyin(y16, fmin=60, fmax=450, sr=16000, frame_length=1024, hop_length=320)
        return np.where(vf, f0, np.nan)
    f0 = librosa.yin(y16, fmin=60, fmax=450, sr=16000, frame_length=1024, hop_length=160)
    db = frame_rms_db(y16, 16000, 10.0)
    n = min(len(f0), len(db))
    f0, db = f0[:n], db[:n]
    thr = np.percentile(db, 90) - 28
    out = np.where((db > thr) & (f0 > 65) & (f0 < 420), f0, np.nan)
    return out


def f0_stats(f0: np.ndarray) -> dict:
    v = f0[~np.isnan(f0)] if f0.size else f0
    if v.size < 10:
        return {"median": 0.0, "p10": 0.0, "p90": 0.0, "std_st": 0.0, "voiced_ratio": 0.0}
    st = 12 * np.log2(v / np.median(v))
    return {"median": float(np.median(v)), "p10": float(np.percentile(v, 10)), "p90": float(np.percentile(v, 90)),
            "std_st": float(np.std(st)), "voiced_ratio": float(v.size / max(f0.size, 1))}


def log_mel_profile(y: np.ndarray) -> np.ndarray:
    import librosa
    m = librosa.feature.melspectrogram(y=y, sr=SR, n_fft=1024, hop_length=256, n_mels=64, fmin=50, fmax=11000)
    lm = 10 * np.log10(np.maximum(m, 1e-10))
    db = 10 * np.log10(np.maximum(m.sum(axis=0), 1e-10))
    act = db > (np.percentile(db, 95) - 25)  # speech frames only
    if act.sum() < 5:
        act[:] = True
    return lm[:, act].mean(axis=1)


def edit_distance(a: str, b: str) -> int:
    if not a:
        return len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


_NORM_RE = re.compile(r"[\W_]+", re.UNICODE)


def norm_text(s: str) -> str:
    return _NORM_RE.sub("", s.lower())


def cer(ref: str, hyp: str) -> float:
    r, h = norm_text(ref), norm_text(hyp)
    if not r:
        return 0.0
    return min(edit_distance(r, h) / len(r), 1.0)


# ----------------------------------------------------------------------------------------
# Models (lazy)
# ----------------------------------------------------------------------------------------
class SpeakerModel:
    def __init__(self):
        self.enc = None
        self.method = "unloaded"
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            if self.method != "unloaded":
                return
            if MOCK:
                self.method = "mfcc-proxy"
                return
            try:
                try:
                    from speechbrain.inference.speaker import EncoderClassifier
                except ImportError:
                    from speechbrain.pretrained import EncoderClassifier  # type: ignore
                self.enc = EncoderClassifier.from_hparams(
                    source="speechbrain/spkrec-ecapa-voxceleb", savedir=str(STATE / "models" / "ecapa"),
                    run_opts={"device": "cpu"})
                self.method = "ecapa"
                log.info("speaker model: ECAPA-TDNN (cpu)")
            except Exception as e:  # noqa: BLE001
                self.method = "mfcc-proxy"
                log.warning("ECAPA unavailable (%s); using MFCC proxy (less discriminative!)", e)

    def embed(self, y16: np.ndarray) -> np.ndarray:
        self.load()
        y16 = np.asarray(y16, dtype=np.float32)
        if y16.size < 8000:
            y16 = np.pad(y16, (0, 8000 - y16.size))
        if self.enc is not None:
            import torch
            with torch.no_grad():
                e = self.enc.encode_batch(torch.from_numpy(y16).unsqueeze(0)).squeeze().cpu().numpy()
        else:
            import librosa
            mf = librosa.feature.mfcc(y=y16, sr=16000, n_mfcc=24)
            e = np.concatenate([mf.mean(axis=1), mf.std(axis=1)])
            e = e - 0.0
        e = np.asarray(e, dtype=np.float64).reshape(-1)
        return e / (np.linalg.norm(e) + 1e-9)

    @staticmethod
    def sim(a: np.ndarray, b: np.ndarray) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


class ASRModel:
    def __init__(self):
        self.model = None
        self.name = "none"
        self.lock = threading.RLock()

    def load(self):
        with self.lock:
            if self.model is not None or MOCK:
                return
            from faster_whisper import WhisperModel
            try:
                size = os.environ.get("QTTS_ASR", "large-v3")
                device = os.environ.get("QTTS_ASR_DEVICE", "cpu")
                if device not in ("cpu", "cuda"):
                    raise ValueError("QTTS_ASR_DEVICE must be cpu or cuda")
                compute = "float16" if device == "cuda" else "int8"
                self.model = WhisperModel(size, device=device, device_index=0, compute_type=compute)
                self.name = f"{size}/{device}-{compute}"
            except Exception as e:  # noqa: BLE001
                log.warning("whisper on GPU failed (%s); falling back to CPU small", e)
                self.model = WhisperModel("small", device="cpu", compute_type="int8")
                self.name = "small/cpu-int8"
            log.info("ASR ready: %s", self.name)

    def unload(self):
        with self.lock:
            self.model = None
        import gc
        gc.collect()

    def release_after_use(self):
        # Inspection and release share the full transcription lock, including lazy iteration.
        with self.lock:
            # Keep at most this one CPU model, never park ASR VRAM beside the TTS fleet.
            if (os.environ.get("QTTS_ASR_KEEP_CPU", "1") == "1"
                    and self.model is not None and ("/cpu-" in self.name or self.name == "cpu-int8")):
                return False
            self.unload()
            return True

    def transcribe(self, y16: np.ndarray, language: str | None = None):
        # Both build jobs and diagnostics may use ASR. A lazy iterator still owns the model.
        with self.lock:
            return self._transcribe_locked(y16, language)

    def _transcribe_locked(self, y16: np.ndarray, language: str | None = None):
        """-> (language, [ {start,end,text,logprob,words:[(s,e,w)]} ])"""
        if MOCK:
            dur = len(y16) / 16000
            segs, t = [], 0.3
            while t + 2.0 < dur:
                e = min(t + 3.5, dur - 0.2)
                segs.append({"start": t, "end": e, "text": "这是一段用来测试的参考语音内容，", "logprob": -0.2,
                             "words": [(t + 0.3, t + 0.6, "测试，")]})
                t = e + 0.5
            return "zh", segs
        self.load()
        prompt = "以下是普通话的句子。" if language in (None, "zh") else None

        def run():
            it, info = self.model.transcribe(
                y16, language=language, beam_size=5, vad_filter=True, word_timestamps=True,
                condition_on_previous_text=False, temperature=0.0, initial_prompt=prompt)
            out = []
            for s in it:  # generator is lazy: cuDNN/CUDA errors surface here, not at load time
                words = [(w.start, w.end, w.word) for w in (s.words or [])]
                out.append({"start": float(s.start), "end": float(s.end), "text": s.text.strip(),
                            "logprob": float(s.avg_logprob), "words": words})
            return info.language, out

        try:
            return run()
        except Exception as e:  # noqa: BLE001
            if "cpu" in self.name:
                raise
            log.warning("whisper GPU inference failed (%s); switching to CPU model", str(e)[:160])
            from faster_whisper import WhisperModel
            self.model = WhisperModel(os.environ.get("QTTS_ASR_CPU", "small"), device="cpu", compute_type="int8")
            self.name = "cpu-int8"
            return run()


SPK = SpeakerModel()
ASR = ASRModel()

# ----------------------------------------------------------------------------------------
# Worker helpers
# ----------------------------------------------------------------------------------------

def worker_post(i: int, path: str, body: dict, timeout=600):
    import requests
    return requests.post(WORKERS[i] + path, json=body, timeout=timeout)


def synth_full(i: int, pid: str, text: str, seed: int = 1, language: str = "Auto"):
    """Run one non-interactive synthesis on worker i. Returns (float32 audio @24k, stats)."""
    import requests
    r = requests.post(WORKERS[i] + "/synth", json={"profile": pid, "text": text, "language": language, "seed": seed,
                                                    "chunk_size": 12}, stream=True, timeout=(5, 300))
    buf = bytearray()
    pcm = bytearray()
    stats = {}
    for chunk in r.iter_content(None):
        buf += chunk
        while len(buf) >= 5:
            t, ln = struct.unpack("<BI", buf[:5])
            if len(buf) < 5 + ln:
                break
            payload = bytes(buf[5:5 + ln])
            del buf[:5 + ln]
            if t == 1:
                pcm += payload
            elif t == 2:
                import json
                stats = json.loads(payload)
            elif t == 3:
                import json
                raise RuntimeError(json.loads(payload).get("error", "worker error"))
    return np.frombuffer(bytes(pcm), dtype=np.int16).astype(np.float32) / 32768.0, stats


def load_on_workers(pid: str) -> list[dict]:
    prof = load_profile(pid)
    expected = reference_binding(profile_dir(pid), prof, allow_missing=MOCK) if prof else ""
    out = []
    for i in range(len(WORKERS)):
        try:
            r = worker_post(i, "/profile/load", {"profile": pid}, timeout=900)
            receipt = r.json()
            if r.status_code != 200 or receipt.get("ok") is not True or (expected and receipt.get("voice_binding") != expected):
                receipt = {"ok": False, "error": "worker did not confirm the same reference version"}
            out.append(receipt)
        except Exception as e:  # noqa: BLE001
            out.append({"ok": False, "error": str(e)})
    current = load_profile(pid)
    if current and reference_binding(profile_dir(pid), current, allow_missing=MOCK) != expected:
        return [{"ok": False, "error": "reference changed during worker reload"} for _ in WORKERS]
    return out


def reload_response(results):
    ok = bool(results) and all(r.get("ok") is True for r in results)
    body = {"ok": ok, "reference_saved": True, "workers": results}
    if not ok:
        body["error"] = "reference saved but not ready on every worker; retry activation, do not mix sessions"
    return JSONResponse(body, status_code=200 if ok else 503)


# ----------------------------------------------------------------------------------------
# Evaluation
# ----------------------------------------------------------------------------------------

def _clip01(x: float) -> float:
    return float(min(max(x, 0.0), 1.0))


def load_ref_stats(pid: str) -> dict:
    d = profile_dir(pid)
    prof = load_profile(pid)
    if not prof:
        raise FileNotFoundError(pid)
    cen = None
    if (d / "centroid.npy").exists():
        cen = np.load(d / "centroid.npy")
    ref, _ = _read_wav(d / prof["anchor"])
    return {"prof": prof, "centroid": cen, "ref": ref}


def _read_wav(path: Path):
    import soundfile as sf
    y, sr = sf.read(str(path), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    return resample(y, sr, SR), SR


def evaluate_audio(gen: np.ndarray, pid: str, text: str | None = None, ref=None) -> dict:
    ref = ref or load_ref_stats(pid)
    prof, centroid, refw = ref["prof"], ref["centroid"], ref["ref"]
    gen = np.asarray(gen, dtype=np.float32)
    dur = len(gen) / SR
    m: dict = {"duration_s": round(dur, 2), "speaker_model": SPK.method}
    if dur < 0.5:
        return {**m, "error": "audio too short"}
    g16, r16 = to16k(gen), to16k(refw)
    eg = SPK.embed(g16)
    er = SPK.embed(r16)
    m["speaker_sim_anchor"] = round(SPK.sim(eg, er), 4)
    m["speaker_sim_centroid"] = round(SPK.sim(eg, centroid), 4) if centroid is not None else None
    sim = m["speaker_sim_centroid"] if m["speaker_sim_centroid"] is not None else m["speaker_sim_anchor"]
    # F0
    fg, fr = f0_stats(f0_track(g16, True)), f0_stats(f0_track(r16, True))
    m["f0_gen"], m["f0_ref"] = fg, fr
    cents = 1200 * np.log2(max(fg["median"], 1) / max(fr["median"], 1)) if fg["median"] and fr["median"] else 999.0
    m["f0_median_diff_cents"] = round(float(cents), 1)
    m["f0_range_ratio"] = round(fg["std_st"] / max(fr["std_st"], 0.1), 2)
    # energy dynamics
    def dyn(y):
        db = frame_rms_db(y, SR, 50.0)
        hi = np.percentile(db, 95)
        sp = db[db > hi - 35]
        return {"speech_db": float(speech_rms_dbfs(y, SR)), "range_db": float(np.percentile(sp, 95) - np.percentile(sp, 10)),
                "std_db": float(np.std(sp))}
    dg, drf = dyn(gen), dyn(refw)
    m["energy_gen"], m["energy_ref"] = {k: round(v, 2) for k, v in dg.items()}, {k: round(v, 2) for k, v in drf.items()}
    # spectrum
    sg, sr_ = log_mel_profile(gen), log_mel_profile(refw)
    off = float(np.mean(sg) - np.mean(sr_))
    m["spectral_dist_db"] = round(float(np.mean(np.abs((sg - sg.mean()) - (sr_ - sr_.mean())))), 2)
    m["spectral_level_offset_db"] = round(off, 2)
    # pauses / breath-like
    db = frame_rms_db(gen, SR, 20.0)
    sil = db < (np.percentile(db, 95) - 38)
    m["silence_ratio"] = round(float(sil.mean()), 3)
    # ASR -> CER, speaking rate
    cer_v = None
    if text:
        try:
            lang, segs = ASR.transcribe(g16, None)
            hyp = "".join(s["text"] for s in segs)
            cer_v = cer(text, hyp)
            m["asr_text"] = hyp[:300]
            m["cer"] = round(cer_v, 4)
        except Exception as e:  # noqa: BLE001
            m["cer_error"] = str(e)[:120]
    if text:
        voiced = float((~sil).sum() * 0.02)
        m["rate_units_per_s"] = round(count_text_units(text) / max(voiced, 0.5), 2)
        ref_ups = float(prof.get("units_per_sec", 0) or 0)
        m["rate_ref_units_per_s"] = round(ref_ups, 2)
        rate_ratio = m["rate_units_per_s"] / ref_ups if ref_ups else 1.0
        m["rate_ratio"] = round(rate_ratio, 3)
    else:
        rate_ratio = 1.0
    # transparent internal index (NOT a similarity percentage)
    parts = {
        "speaker": _clip01((sim - 0.45) / 0.4),
        "pronunciation": 1.0 - _clip01((cer_v if cer_v is not None else 0.05) / 0.15),
        "f0": 1.0 - _clip01(abs(cents) / 300.0) * 0.6 - _clip01(abs(m["f0_range_ratio"] - 1) / 1.0) * 0.4,
        "rate": 1.0 - _clip01(abs(rate_ratio - 1.0) / 0.4),
        "spectrum": 1.0 - _clip01(m["spectral_dist_db"] / 8.0),
        "energy": 1.0 - _clip01(abs(dg["range_db"] - drf["range_db"]) / 10.0),
    }
    w = {"speaker": 0.40, "pronunciation": 0.15, "f0": 0.15, "rate": 0.10, "spectrum": 0.10, "energy": 0.10}
    m["index_parts"] = {k: round(v, 3) for k, v in parts.items()}
    m["fidelity_index"] = round(100 * sum(parts[k] * w[k] for k in w), 1)
    flags = []
    if sim < 0.70:
        flags.append("speaker similarity low: improve the reference (cleaner / longer / more typical)")
    if cer_v is not None and cer_v > 0.08:
        flags.append("pronunciation errors: check ref_text accuracy")
    if abs(cents) > 200:
        flags.append("pitch offset > 200 cents")
    if abs(rate_ratio - 1) > 0.25:
        flags.append("speaking rate differs > 25% from reference")
    m["flags"] = flags
    return m


# ----------------------------------------------------------------------------------------
# Profile building
# ----------------------------------------------------------------------------------------
JOBS: dict[str, dict] = {}
BUILD_LOCK = threading.Lock()


def jlog(job: dict, pct: float, msg: str):
    job["pct"] = round(pct, 1)
    if job.get("diagnostic_id"):
        diagnostic_save("reference", {"id": job["diagnostic_id"], "kind": "reference_processing",
            "status": "running", "progress_pct": round(pct,1), "training_started": False})
    job["stage"] = msg
    job["log"].append(f"[{time.strftime('%H:%M:%S')}] {msg}")
    del job["log"][:-200]
    log.info("job %s %5.1f%% %s", job["id"], pct, msg)


def write_wav(path: Path, y: np.ndarray, sr: int = SR):
    import soundfile as sf
    sf.write(str(path), np.clip(y, -1, 1), sr, subtype="PCM_16")


def find_breaths(y: np.ndarray, gaps: list[tuple[float, float]]):
    """Look for real inhales inside the pauses between phrases: noisy, quiet, 120-650 ms."""
    import librosa
    out = []
    hop = 120  # 5 ms
    for (a, b) in gaps:
        s, e = int(max(a - 0.05, 0) * SR), int(min(b + 0.05, len(y) / SR) * SR)
        seg = y[s:e]
        if seg.size < SR * 0.18:
            continue
        flat = librosa.feature.spectral_flatness(y=seg, n_fft=512, hop_length=hop)[0]
        db = frame_rms_db(seg[: (len(seg) // hop) * hop], SR, hop / SR * 1000)
        n = min(len(flat), len(db))
        ok = (db[:n] > -50) & (db[:n] < -27) & (flat[:n] > 0.12)
        i = 0
        while i < n:
            if ok[i]:
                j = i
                while j < n and ok[j]:
                    j += 1
                dur = (j - i) * hop / SR
                if 0.12 <= dur <= 0.65:
                    c0 = max(0, i * hop - int(0.02 * SR))
                    c1 = min(len(seg), j * hop + int(0.03 * SR))
                    clip = seg[c0:c1].copy()
                    score = float(flat[i:j].mean()) * dur
                    out.append((score, clip, float(db[i:j].mean())))
                i = j
            else:
                i += 1
    out.sort(key=lambda t: -t[0])
    return out[:6]


class BuildEmbeddingCache:
    """A build-local cache, not a persistent recording/vector database."""
    def __init__(self, speaker):
        self.speaker = speaker
        self.values = {}
        self.calls = 0
        self.hits = 0

    def embed(self, y16):
        y16 = np.ascontiguousarray(y16, dtype=np.float32).reshape(-1)
        key = hashlib.sha256(y16.tobytes()).digest()
        if key in self.values:
            self.hits += 1
            return self.values[key].copy()
        self.calls += 1
        result = self.speaker.embed(y16)
        if len(self.values) < 64 and result.nbytes <= 16384:
            self.values[key] = result.copy()
        return result

    def report(self):
        return {"calls": self.calls, "hits": self.hits, "entries": len(self.values),
                "scope": "this-profile-build-only", "entry_limit": 64}


def build_profile(job: dict, name: str, files: list[tuple[str, bytes]], language: str, manual_text: str, calibrate: bool, anchor_seconds: int = 16):
    anchor_seconds = context_seconds(anchor_seconds)
    t_start = time.time()
    monitor_id = uuid.uuid4().hex
    job["diagnostic_id"] = monitor_id
    diagnostic_save("reference", {"id": monitor_id, "kind": "reference_processing", "status": "running",
                     "files_count": len(files), "training_started": False})
    quality: dict = {"files": [], "stage_ms": {}, "calibration_requested": bool(calibrate)}
    embeddings = BuildEmbeddingCache(SPK)
    stage_clock = time.perf_counter()
    def stage_done(name):
        nonlocal stage_clock
        now = time.perf_counter()
        quality["stage_ms"][name] = round((now - stage_clock) * 1000, 1)
        stage_clock = now
    pid = f"{slugify(name)}-{uuid.uuid4().hex[:5]}"
    d = profile_dir(pid)
    d.mkdir(parents=True, exist_ok=True)
    try:
        SPK.load()
        quality["speaker_model"] = SPK.method
        stage_done("speaker_load")
        lang_hint = {"chinese": "zh", "english": "en", "japanese": "ja", "korean": "ko"}.get(language.lower())
        # ---- 1. decode + measured cleaning ------------------------------------------------
        cleaned: list[tuple[str, np.ndarray]] = []
        for k, (fn, data) in enumerate(files):
            jlog(job, 3 + 22 * k / max(len(files), 1), f"decode + denoise {fn}")
            raw = decode_audio(data, fn)
            raw_diagnostics = diagnostic_observe(raw)
            if not np.isfinite(raw).all():raise ValueError("reference audio contains non-finite samples")
            if sum(len(item[1]) for item in cleaned) + len(raw) > SR * LIMITS.total_seconds:
                raise UploadRejected("total decoded audio duration limit exceeded")
            if raw.size < SR * 1.5:
                quality["files"].append({"file": fn, "skipped": "shorter than 1.5 s"})
                continue
            source_rms = float(20*np.log10(max(float(np.sqrt(np.mean(raw.astype(np.float64)**2))),1e-12)))
            source_peak = float(np.max(np.abs(raw)))
            raw = highpass(raw, SR)
            spread0 = level_spread_proxy_db(raw, SR)
            info = {"file": fn, "duration_s": round(len(raw) / SR, 1),
                    "level_spread_proxy_db": round(spread0, 1), "snr_db": round(spread0, 1),
                    "peak": round(float(np.max(np.abs(raw))), 3), "source_rms_dbfs": round(source_rms, 1),
                    "source_peak": round(source_peak, 6), "warnings": (["输入电平很低；归一化也会放大底噪，请检查麦克风距离及输入增益"] if source_rms < -40 else [])}
            pick, why = raw, "kept raw (no denoise trigger; noise floor not verified)"
            # Preserve the existing trigger until noise-floor validation is available; this is a level-spread proxy, not SNR.
            if spread0 < 30:
                probe = raw[SR: SR * 11] if raw.size > SR * 12 else raw
                e_raw = embeddings.embed(to16k(probe))
                best = None
                for strength in (0.85, 0.55):
                    try:
                        c = denoise(raw, SR, strength)
                    except Exception as e:  # noqa: BLE001
                        why = f"denoise unavailable ({e})"
                        break
                    cp = c[SR: SR * 11] if c.size > SR * 12 else c
                    s = SPK.sim(e_raw, embeddings.embed(to16k(cp)))
                    spread1 = level_spread_proxy_db(c, SR)
                    info[f"denoise_{strength}"] = {"timbre_sim": round(s, 3),
                        "level_spread_proxy_db": round(spread1, 1), "snr_db": round(spread1, 1)}
                    # Keep the established acceptance gate; its spread delta is not a true noise-floor measurement.
                    if s >= 0.94 and spread1 > spread0 + 2.0:
                        best = (c, f"denoised strength {strength} (timbre kept {s:.3f}, envelope-spread proxy {spread0:.1f}->{spread1:.1f} dB)")
                        break
                if best:
                    pick, why = best
                elif why == "kept raw (no denoise trigger; noise floor not verified)":
                    why = "kept raw (denoise failed timbre/proxy gate; noise floor not verified)"
            info["decision"] = why + ("；" + "；".join(info["warnings"]) if info["warnings"] else "")
            quality["files"].append(info)
            processed = normalize_speech(pick, SR)
            processed_diagnostics = diagnostic_observe(processed)
            diagnostic_save("reference", {"id": uuid.uuid4().hex, "session": monitor_id,
                "kind": "reference_processing", "status": "running", "file_index": k,
                "reference_raw": raw_diagnostics, "reference_processed": processed_diagnostics,
                "training_started": False, "quality_verified": False})
            cleaned.append((fn, processed))
        if not cleaned:
            raise ValueError("no usable audio (every file shorter than 1.5 s or undecodable)")

        stage_done("decode_denoise")
        # ---- 2. transcription -----------------------------------------------------------
        clips = []  # dicts: file idx, y, start, end, text, logprob
        words_all = []
        ref_lang = lang_hint
        try:
            for k, (fn, y) in enumerate(cleaned):
                jlog(job, 28 + 25 * k / len(cleaned), f"ASR {fn}")
                if manual_text and len(cleaned) == 1 and len(y) / SR <= anchor_seconds:
                    segs = [{"start": 0.0, "end": len(y) / SR, "text": manual_text.strip(), "logprob": 0.0, "words": []}]
                    lg = lang_hint or "zh"
                    asr_engine = "manual-aligned-short-clip"
                else:
                    lg, segs = ASR.transcribe(to16k(y), lang_hint)
                    asr_engine = ASR.name
                lg, segs, alignment = prepare_segments(to16k(y), segs, lg,
                    lambda samples, language: ASR.transcribe(samples, language), anchor_seconds,
                    progress=lambda n,a,b: jlog(job, 30 + 20*k/max(len(cleaned),1), f"long reference window {n}: {a:.1f}–{b:.1f}s"))
                ref_lang = ref_lang or lg
                quality.setdefault("asr", []).append({"file": fn, "language": lg, "segments": len(segs),
                    "engine": asr_engine, "alignment": alignment,
                    "manual_text_policy": "direct-matching-short-clip" if asr_engine=="manual-aligned-short-clip" else ("long-manual-not-forced-ASR-timestamps" if manual_text else "ASR-timestamps")})
                for s in segs:
                    if s["text"].strip():
                        clips.append({"f": k, "start": s["start"], "end": s["end"], "text": s["text"],
                                      "logprob": s.get("logprob", -0.5), "words": s.get("words", [])})
                        words_all.extend([(k, a, b, w) for a, b, w in s["words"]])
        finally:
            if not MOCK:
                ASR.release_after_use()
        if not clips:
            raise ValueError("ASR found no speech. Provide cleaner audio or type the transcript manually.")
        ref_lang = ref_lang or "zh"

        stage_done("asr")
        # ---- 3. candidate anchors ----------------------------------------------------------
        jlog(job, 55, "scoring candidate anchors")
        f0_by_file = {}
        for k, (fn, y) in enumerate(cleaned):
            f0_by_file[k] = f0_track(to16k(y))
        cands = []
        preferred_max = 14.0 if anchor_seconds == 16 else float(anchor_seconds)
        for k, (fn, y) in enumerate(cleaned):
            ss = [c for c in clips if c["f"] == k]
            for i in range(len(ss)):
                j, st, en, txt, lps = i, ss[i]["start"], ss[i]["end"], ss[i]["text"], [ss[i]["logprob"]]
                while True:
                    dur = en - st
                    if 5.0 <= dur <= preferred_max:
                        cands.append({"f": k, "start": st, "end": en, "text": txt, "logprob": float(np.mean(lps))})
                    if dur >= preferred_max - 2 or j + 1 >= len(ss) or ss[j + 1]["start"] - en > 1.0 or ss[j + 1]["end"] - st > preferred_max:
                        break
                    j += 1
                    en = ss[j]["end"]
                    txt = txt + (" " if re.search(r"[A-Za-z]$", txt) else "") + ss[j]["text"]
                    lps.append(ss[j]["logprob"])
        if not cands:  # no 5-14 s window: take the longest single segments (>= 2.5 s)
            for c in sorted(clips, key=lambda c: c["start"] - c["end"])[:6]:
                if 2.5 <= c["end"] - c["start"] <= anchor_seconds:
                    # Keep the entire aligned segment; never pair truncated audio with its full text.
                    cands.append({"f": c["f"], "start": c["start"], "end": c["end"],
                                  "text": c["text"], "logprob": c["logprob"]})
        if not cands:
            raise ValueError(f"未找到可信的2.5–{anchor_seconds}秒语音锚点；已尝试词级切分/实际音频窗口重识别。请检查输入电平、单人语音与转写；不会硬截音频配全文 (no aligned 2.5-{anchor_seconds} s speech segment)")
        # embeddings for typicality: cheap pre-rank, then cap (ECAPA on CPU is the slow part)
        cands.sort(key=lambda c: -(0.5 * _clip01(1 - abs((c["end"] - c["start"]) - 10) / 8)
                                   + 0.5 * _clip01(float(np.exp(c["logprob"])))))
        cands = cands[:24]
        for c in cands:
            y = cleaned[c["f"]][1]
            left, right = max(c["start"] - .05, 0), min(c["end"] + .08, len(y)/SR)
            if right-left > anchor_seconds:
                left, right = c["start"], c["end"]
            seg = y[int(round(left*SR)):int(round(right*SR))]
            c["y"] = seg
            c["emb"] = embeddings.embed(to16k(seg))
            c["level_spread_proxy"] = level_spread_proxy_db(seg, SR)
            f0 = f0_by_file[c["f"]][int(c["start"] * 100): int(c["end"] * 100)]
            c["f0std"] = f0_stats(f0)["std_st"]
            c["peak"] = float(np.max(np.abs(seg))) if seg.size else 1.0
        embs = np.stack([c["emb"] for c in cands])
        centroid = embs.mean(axis=0)
        centroid /= np.linalg.norm(centroid) + 1e-9
        for c in cands:
            dur = c["end"] - c["start"]
            units = count_text_units(c["text"])
            rate = units / max(dur, 0.1)
            typical = _clip01((SPK.sim(c["emb"], centroid) - 0.5) / 0.5)
            c["score"] = (0.28 * _clip01(1 - abs(dur - 10) / 8) + 0.20 * _clip01(c["level_spread_proxy"] / 35)
                          + 0.25 * _clip01(np.exp(c["logprob"])) + 0.15 * typical
                          + 0.07 * _clip01(c["f0std"] / 4.0) + 0.05 * (1.0 if 2.0 <= rate <= 9.0 else 0.0))
            if c["peak"] > 0.985:
                c["score"] *= 0.7
        cands.sort(key=lambda c: -c["score"])
        picked = []
        for c in cands:  # top-3 that are not near-duplicates (>40% overlap in same file)
            if all(not (p["f"] == c["f"] and min(p["end"], c["end"]) - max(p["start"], c["start"]) > 0.4 * (c["end"] - c["start"]))
                   for p in picked):
                picked.append(c)
            if len(picked) == 3:
                break
        cand_meta = []
        for k, c in enumerate(picked):
            seg = c["y"].copy()
            w = 120
            seg[:w] *= np.linspace(0, 1, w, dtype=np.float32)
            seg[-w:] *= np.linspace(1, 0, w, dtype=np.float32)
            fn_ = f"cand{k}.wav"
            write_wav(d / fn_, seg)
            cand_meta.append({"file": fn_, "text": c["text"], "start": round(c["start"], 2), "end": round(c["end"], 2),
                              "score": round(float(c["score"]), 3),
                              "level_spread_proxy_db": round(float(c["level_spread_proxy"]), 1),
                              "snr_db": round(float(c["level_spread_proxy"]), 1),
                              "asr_conf": round(float(np.exp(c["logprob"])), 3), "from": cleaned[c["f"]][0]})
        quality["reference_context"] = {"anchor_limit_s": anchor_seconds, "source_total_s": sum(len(y)/SR for _,y in cleaned),
            "candidate_durations_s": [round(len(c["y"])/SR,4) for c in picked],
            "all_audio_used_as_model_prompt": False, "model_trained": False}
        np.save(d / "centroid.npy", centroid.astype(np.float32))

        stage_done("candidate_scoring")
        # ---- 4. breath bank + prosody ------------------------------------------------------
        jlog(job, 70, "extracting real breaths + prosody statistics")
        gaps_by_file: dict[int, list[tuple[float, float]]] = {}
        for k in range(len(cleaned)):
            ss = sorted([c for c in clips if c["f"] == k], key=lambda c: c["start"])
            g = []
            if ss and ss[0]["start"] > 0.3:
                g.append((0.0, ss[0]["start"]))
            for a, b in zip(ss, ss[1:]):
                if b["start"] - a["end"] >= 0.25:
                    g.append((a["end"], b["start"]))
            gaps_by_file[k] = g
        breaths = []
        for k, (fn, y) in enumerate(cleaned):
            breaths += find_breaths(y, gaps_by_file[k])
        breaths.sort(key=lambda t: -t[0])
        breath_files = []
        for i, (_, clip, dbm) in enumerate(breaths[:5]):
            w = 96
            clip[:w] *= np.linspace(0, 1, w, dtype=np.float32)
            clip[-w:] *= np.linspace(1, 0, w, dtype=np.float32)
            write_wav(d / f"breath{i}.wav", clip)
            breath_files.append(f"breath{i}.wav")
        breath_db = float(np.median([b[2] for b in breaths[:5]])) if breaths else -38.0
        # pause statistics from word gaps
        clause_gaps, sent_gaps = [], []
        words_all.sort(key=lambda t: (t[0], t[1]))
        for (f1, a1, b1, w1), (f2, a2, b2, w2) in zip(words_all, words_all[1:]):
            if f1 != f2:
                continue
            gap = a2 - b1
            if 0.10 <= gap <= 1.6:
                end_ch = w1.strip()[-1:] if w1.strip() else ""
                if end_ch in "。！？.!?…":
                    sent_gaps.append(gap)
                elif end_ch in "，,、；;：:":
                    clause_gaps.append(gap)
        ups_num = sum(count_text_units(c["text"]) for c in clips)
        ups_den = sum(c["end"] - c["start"] for c in clips)
        ups = float(np.clip(ups_num / max(ups_den, 1.0), 2.5, 9.0))
        pc = int(np.clip(np.median(clause_gaps) * 1000, 80, 400)) if len(clause_gaps) >= 4 else 150
        ps = int(np.clip(np.median(sent_gaps) * 1000, 180, 800)) if len(sent_gaps) >= 3 else int(max(pc * 2.2, 320))
        best_y = picked[0]["y"]
        f0s = f0_stats(f0_track(to16k(best_y), accurate=True))
        target_db = output_target_dbfs()

        stage_done("prosody_analysis")
        # ---- 5. profile json ----------------------------------------------------------------
        anchor_name = "anchor_0.wav"
        shutil.copy(d / "cand0.wav", d / anchor_name)
        # Keep the complete ASR transcript as one user-facing string. Timestamped
        # clips remain internal alignment metadata; the UI must not present them
        # as a user-facing transcript split.
        transcript_parts = [str(c.get("text", "")).strip() for c in sorted(clips, key=lambda item: (item["f"], item["start"])) if str(c.get("text", "")).strip()]
        full_transcript = ""
        for part in transcript_parts:
            if full_transcript and full_transcript[-1:].isascii() and part[:1].isascii() and (full_transcript[-1:].isalnum() or full_transcript[-1:] in ".!?;:") and part[:1].isalnum():
                full_transcript += " "
            full_transcript += part
        prof = {
            "id": pid, "name": name, "language": LANG_NAME.get(ref_lang, "Auto"), "lang_code": ref_lang,
            "created": dt.datetime.now().isoformat(timespec="seconds"),
            "anchor": anchor_name, "anchor_candidate": 0, "ref_text": cand_meta[0]["text"],
            "full_transcript": full_transcript,
            "candidates": cand_meta, "target_rms_dbfs": target_db, "reference_normalize_dbfs": TARGET_DBFS, "units_per_sec": round(ups, 3),
            "pause_clause_ms": pc, "pause_sentence_ms": ps, "pause_para_ms": int(ps * 1.65),
            "breath_files": breath_files, "breath_level_db": round(breath_db, 1),
            "f0": f0s, "gen": {"temperature": 0.8, "top_k": 50, "top_p": 1.0, "repetition_penalty": 1.05},
            "quality": quality, "speaker_model": SPK.method,
            "stats": {"clips": len(clips), "candidates": len(cands), "clause_gaps": len(clause_gaps),
                      "sentence_gaps": len(sent_gaps), "breaths_found": len(breaths)},
        }
        write_json_atomic(d / "profile.json", prof)
        jlog(job, 82, "loading profile on both GPU workers (voice-clone prompt cache)")
        loads = load_on_workers(pid)
        prof["worker_load"] = loads
        write_json_atomic(d / "profile.json", prof)
        stage_done("worker_load")
        job["profile"] = pid
        if calibrate and any(l.get("ok") for l in loads) and len(cand_meta) > 1 and not MOCK:
            jlog(job, 88, "calibrating candidate anchors on the GPU (speaker sim + CER)")
            try:
                outcome = calibrate_profile(pid, job)
                quality["calibration_outcome"] = build_summary(outcome)
            except Exception as e:  # noqa: BLE001
                quality["calibration_outcome"] = {"http_status":getattr(e,"code",500),
                    "reference_saved":False,"workers_ready":False,"quality_verified":False}
                log.warning("optional calibration did not complete")
                jlog(job, 97, "calibration unavailable; profile creation is not calibration validation")
        stage_done("optional_calibration")
        quality["embedding_cache"] = embeddings.report()
        quality["build_s"] = round(time.time() - t_start, 1)
        # Calibration may have updated anchor/metadata. Merge only the final quality receipt.
        final_profile = load_profile(pid)
        final_profile["quality"] = quality
        write_json_atomic(d / "profile.json", final_profile)
        job["stage_ms"] = dict(quality["stage_ms"])
        jlog(job, 100, f"done in {quality['build_s']} s")
        job["state"] = "done"
        # Link this prepared profile to later synthesis receipts without exporting audio or text.
        try:
            ready_binding = reference_binding(d, final_profile)
        except Exception:  # noqa: BLE001
            ready_binding = None
        manual_text_used = any(
            item.get("manual_text_policy") == "direct-matching-short-clip"
            for item in quality.get("asr", []) if isinstance(item, dict)
        )
        diagnostic_save("reference", {"id": monitor_id, "kind": "reference_processing", "status": "profile_ready",
            "progress_pct": 100, "build_s": quality["build_s"], "stage_ms": quality.get("stage_ms", {}),
            "files_count": len(files), "voice_binding": ready_binding,
            "manual_text_used": manual_text_used,
            "anchor_candidate": final_profile.get("anchor_candidate"),
            "training_started": False, "training_completed": False,
            "quality_verified": False})
    except Exception as e:  # noqa: BLE001
        log.exception("profile build failed")
        job["state"] = "error"
        diagnostic_save("reference", {"id": monitor_id, "kind": "reference_processing", "status": "failed",
            "build_s": round(time.time()-t_start,3), "training_started": False, "quality_verified": False})
        job["error"] = f"{type(e).__name__}: {e}"
        jlog(job, job.get("pct", 0), f"FAILED: {e}")
        shutil.rmtree(d, ignore_errors=True)


CAL_TEXTS = ["今天天气不错，我们一起出去走走吧。", "Sometimes the quiet moments say the most, don't you think?"]


def calibrate_profile(pid: str, job: dict | None = None) -> dict:
    """Evaluate an immutable input snapshot and commit only if it is still current.

    Only complete finite metrics are ranked; committed selection and worker readiness differ.
    """
    d = profile_dir(pid)
    with exclusive_calibration(d):
        with profile_lock(pid):
            prof = editable_profile(pid)
            captured = snapshot(d, prof)
        prof = captured.profile
        run_id = uuid.uuid4().hex
        results = []
        try:
            cen = centroid_value(captured.files.get("centroid.npy"),
                lambda raw: np.load(io.BytesIO(raw), allow_pickle=False))
            for k, c in enumerate(prof["candidates"]):
                tid = f"_cal_{run_id}_{k}"
                td = profile_dir(tid)
                owned = False
                setup_code = "temporary_profile_setup_failed"
                try:
                    td.mkdir(mode=0o700, exist_ok=False)
                    owned = True
                    anchor, _ = install_anchor(td, k, captured.files[c["file"]])
                    p2 = dict(prof)
                    p2.update({"id": tid, "anchor": anchor, "ref_text": c["text"], "breath_files": []})
                    write_json_atomic(td / "profile.json", p2)
                    setup_code = "temporary_worker_not_ready"
                    response = worker_post(0, "/profile/load", {"profile": tid}, timeout=600)
                    receipt = response.json()
                    expected = reference_binding(td, p2)
                    if (response.status_code != 200 or not isinstance(receipt, dict)
                            or receipt.get("ok") is not True or receipt.get("voice_binding") != expected):
                        raise ValueError("temporary worker not ready")
                    trials = [evaluate_trial(ti, txt, tid, cen, synth=synth_full, speaker=SPK,
                        asr=ASR, to16k=to16k, cer=cer, norm_text=norm_text, sample_rate=SR)
                        for ti, txt in enumerate(CAL_TEXTS)]
                except Exception:
                    trials = failed_trials(CAL_TEXTS, setup_code)
                finally:
                    if owned:
                        shutil.rmtree(td, ignore_errors=True)
                results.append(summarize(k, trials))
        finally:
            ASR.release_after_use()
        eligible = [row for row in results if row["eligible"]]
        with profile_lock(pid):
            current = load_profile(pid)
            confirm_snapshot(d, current, captured)
            if not eligible:
                return CalibrationResult({"error":"no candidate has complete valid calibration trials",
                    "ok":False,"reference_saved":False,"ready":False,"selection_valid":False,
                    "quality_verified":False,"results":results,"chosen":None,
                    "input_version":captured.version,"valid_candidates":0}, 422, saved=False, ready=False)
            best = max(eligible, key=lambda row: row["score"])
            receipt = {"results":results,"chosen":best["candidate"],"input_version":captured.version,
                "selection_valid":True,"valid_candidates":len(eligible),"quality_verified":False,
                "selection_policy":"complete-metrics-only-v1"}
            name = None
            created = False
            try:
                c = prof["candidates"][best["candidate"]]
                name, created = install_anchor(d, best["candidate"], captured.files[c["file"]])
                current.update(anchor=name, anchor_candidate=best["candidate"], ref_text=c["text"])
                current["calibration"] = receipt
                current["_s18_revision"] = uuid.uuid4().hex
                committed = snapshot(d, current)
                write_json_atomic(d / "profile.json", current)
            except BaseException:
                saved = load_profile(pid) or {}
                if created and saved.get("anchor") != name:
                    (d / name).unlink(missing_ok=True)
                raise
        # Disk selection is committed. Neither network failure nor later edits imply rollback.
        try:
            workers = safe_workers(load_on_workers(pid), len(WORKERS))
        except Exception:
            workers = safe_workers([], len(WORKERS))
        ready = bool(workers) and all(row["ok"] for row in workers)
        version_current = True
        with profile_lock(pid):
            try:
                confirm_snapshot(d, load_profile(pid), committed)
            except UploadRejected:
                ready = False
                version_current = False
                workers = [{"worker":i,"ok":False,"error_code":"saved_version_no_longer_current"}
                    for i in range(len(WORKERS))]
        if job:
            jlog(job, 97, "calibration selection saved; " + ("workers confirmed" if ready else "workers not ready"))
        if not ready:
            return CalibrationResult({**receipt,"error":"selection saved but not ready on every worker; retry activation",
                "ok":False,"reference_saved":True,"ready":False,"saved_version_current":version_current,"workers":workers},503,saved=True,ready=False)
        return CalibrationResult(receipt,200,saved=True,ready=True)


# ----------------------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------------------
from fastapi import FastAPI, File, Form, UploadFile, Request
from starlette.datastructures import UploadFile as FormUploadFile
from starlette.exceptions import HTTPException as FormError  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

app = FastAPI(title="qtts-analyst")
app.add_middleware(BodyBudgetMiddleware, maximum=LIMITS.request_bytes)


def _err(msg, code=400):
    headers={"Retry-After":"5"} if code==429 else None
    return JSONResponse({"error": msg}, status_code=code,headers=headers)


@app.exception_handler(UploadRejected)
async def resource_error(request,exc):
    return _err(str(exc),exc.code)


@app.get("/health")
async def health():
    return {"ok": True, "speaker_model": SPK.method, "asr": ASR.name, "mock": MOCK, "jobs": len(JOBS),
            "workers": WORKERS}


@app.get("/profiles")
async def profiles():
    out = []
    for p in sorted(PROFILES_DIR.iterdir()) if PROFILES_DIR.exists() else []:
        if p.is_dir() and not p.name.startswith("_cal_"):
            pr = read_json(p / "profile.json")
            if pr:
                pr = {k: v for k, v in pr.items() if k not in ("worker_load",)}
                out.append(pr)
    out.sort(key=lambda x: x.get("created", ""), reverse=True)
    return {"profiles": out}


def _form_text(form, name, default, maximum):
    value=form.get(name,default)
    if not isinstance(value,str) or len(value)>maximum:
        raise UploadRejected(f"{name} is invalid or too long",400)
    return value


@app.post("/profiles")
async def create_profile(request: Request):
    if not ADMISSION.slot.acquire(blocking=False):
        return _err("a voice build is already running; retry after it finishes",429)
    started=False
    try:
        count=sum(p.is_dir() and not p.name.startswith("_cal_") for p in PROFILES_DIR.iterdir())
        if count>=LIMITS.profiles:
            return _err("voice library count limit reached",409)
        if shutil.disk_usage(PROFILES_DIR).free < 256<<20:
            return _err("insufficient free disk space for safe upload processing",507)
        async with request.form(max_files=LIMITS.files,max_fields=8) as form:
            files=form.getlist("files")
            if not files or not all(isinstance(f,FormUploadFile) for f in files):
                return _err("upload at least one audio file")
            if len(files)>LIMITS.files:
                return _err("too many uploaded audio files",413)
            name=_form_text(form,"name","my-voice",64).strip()
            if not name:return _err("voice name is empty")
            language=_form_text(form,"language","auto",32)
            ref_text=_form_text(form,"ref_text","",20000)
            try:anchor_seconds=context_seconds(_form_text(form,"anchor_seconds","16",2))
            except ValueError:return _err("anchor_seconds must be 16 or 24")
            calibrate=_form_text(form,"calibrate","0",1)
            if calibrate not in ("0","1"):return _err("calibrate must be 0 or 1")
            blobs=[];total=0
            for file in files:
                data=await read_upload(file,LIMITS,LIMITS.request_bytes-total)
                total+=len(data)
                filename=Path((file.filename or "audio").replace("\\","/")).name[:128]
                blobs.append((filename or "audio",data))
        job={"id":uuid.uuid4().hex[:12],"state":"running","pct":0,"stage":"queued","log":[],"profile":None}
        def run_build():
            with BUILD_LOCK:
                build_profile(job,name,blobs,language,ref_text,calibrate=="1",**({"anchor_seconds":anchor_seconds} if anchor_seconds!=16 else {}))
        ADMISSION.start(JOBS,job,LIMITS.jobs,run_build)
        started=True
        return {"job":job["id"]}
    except UploadRejected as e:
        return _err(str(e),e.code)
    except FormError as e:
        return _err("multipart field/file limit exceeded or malformed form",413 if "Too many" in str(e.detail) else 400)
    except RuntimeError:
        log.exception("voice job could not be started")
        return _err("could not start voice build; retry later",503)
    finally:
        if not started:ADMISSION.slot.release()


@app.get("/jobs/{jid}")
async def job(jid: str):
    j = JOBS.get(jid)
    return j if j else _err("no such job", 404)


@app.get("/profiles/{pid}")
async def get_profile(pid: str):
    p = load_profile(pid)
    return p if p else _err("not found", 404)


def editable_profile(pid):
    p = load_profile(pid)
    if not p:
        raise UploadRejected("not found", 404)
    if "trained_adapter" in p:
        raise UploadRejected("trained reference is fixed; publish a new training version", 409)
    return p


def commit_text(pid, txt):
    # Admission has already succeeded. Recheck state inside the actual worker.
    with profile_lock(pid):
        p = editable_profile(pid)
        selected = candidate(p, p.get("anchor_candidate", 0))
        changed = selected.get("text") != txt or p.get("ref_text") != txt
        selected["text"] = txt
        p["ref_text"] = txt
        if changed:
            p["_s18_revision"] = uuid.uuid4().hex
        write_json_atomic(profile_dir(pid) / "profile.json", p)
    # Never hold the profile commit lock across worker/network waits.
    return reload_response(load_on_workers(pid))


def commit_candidate(pid, index):
    with profile_lock(pid):
        p = editable_profile(pid)
        c = candidate(p, index)
        txt = text_value(c.get("text"))
        changed_text = c.get("text") != txt
        c["text"] = txt
        d = profile_dir(pid)
        raw = regular_bytes(d / safe_name(c.get("file")))
        name, created = install_anchor(d, index, raw)
        changed = changed_text or p.get("anchor") != name or p.get("anchor_candidate") != index or p.get("ref_text") != txt
        p.update(anchor=name, anchor_candidate=index, ref_text=txt)
        if changed:
            p["_s18_revision"] = uuid.uuid4().hex
        try:
            write_json_atomic(d / "profile.json", p)
        except BaseException:
            # A helper can raise during post-replace cleanup: do not delete a committed anchor.
            current = load_profile(pid) or {}
            if created and current.get("anchor") != name:
                (d / name).unlink(missing_ok=True)
            raise
    return reload_response(load_on_workers(pid))


@app.post("/profiles/{pid}/text")
async def set_text(pid: str, request: Request):
    editable_profile(pid)
    txt = text_value(await profile_body(request, "ref_text"))
    return await HEAVY.run(commit_text, pid, txt)


@app.post("/profiles/{pid}/candidate")
async def set_candidate(pid: str, request: Request):
    editable_profile(pid)
    index = index_value(await profile_body(request, "index"))
    return await HEAVY.run(commit_candidate, pid, index)


@app.post("/profiles/{pid}/calibrate")
async def calibrate(pid: str):
    if "trained_adapter" in (load_profile(pid) or {}):return _err("trained reference is fixed; calibration is not supported",409)
    if not load_profile(pid):
        return _err("not found", 404)
    loop = asyncio.get_running_loop()
    try:
        result = await HEAVY.run(calibrate_profile,pid,None)
        return JSONResponse(dict(result), status_code=result.status_code)
    except UploadRejected as e:
        return _err(str(e),e.code)
    except Exception as e:  # noqa: BLE001
        return _err("calibration failed; no readiness claimed", 500)


def commit_delete(pid):
    with profile_lock(pid):
        shutil.rmtree(profile_dir(pid), ignore_errors=True)
        a = read_json(STATE / "active.json", {})
        if a.get("id") == pid:
            try:
                (STATE / "active.json").unlink()
            except OSError:
                pass
    return {"ok": True}


@app.delete("/profiles/{pid}")
async def delete_profile(pid: str):
    # Coordinate with new executor commits, without blocking the event loop on a lock.
    return await HEAVY.run(commit_delete, pid)


@app.post("/evaluate")
async def evaluate(request: Request):
    try:
        async with request.form(max_files=1,max_fields=2) as form:
            file=form.get("file")
            if not isinstance(file,FormUploadFile):return _err("upload one audio file")
            profile=_form_text(form,"profile","",64)
            text=_form_text(form,"text","",20000)
            data=await read_upload(file,LIMITS,LIMITS.request_bytes)
            filename=Path(file.filename or "gen").name[:128]
        loop=asyncio.get_running_loop()
        def work():
            y=decode_audio(data,filename)
            return evaluate_audio(y,profile,text or None)
        return await HEAVY.run(work)
    except UploadRejected as e:
        return _err(str(e),e.code)
    except FormError as e:
        return _err("multipart field/file limit exceeded or malformed form",413 if "Too many" in str(e.detail) else 400)
    except Exception as e:
        log.exception("evaluate failed")
        return _err(f"{type(e).__name__}: {e}",500)


DEFAULT_CONS_TEXTS = ["你好，很高兴认识你，今天我想和你聊一聊最近发生的一些有趣的事情。",
                      "其实呢，说话的节奏和呼吸是分不开的，对不对？",
                      "Honestly, I think the best part of the day is the quiet hour before everyone wakes up."]


def consistency(pid: str, texts: list[str]) -> dict:
    ref = load_ref_stats(pid)
    per = [{"gpu": i, "items": []} for i in range(len(WORKERS))]
    outs: dict[tuple[int, int], np.ndarray] = {}
    for ti, txt in enumerate(texts):
        for gi in range(len(WORKERS)):
            try:
                y, st = synth_full(gi, pid, txt, seed=100 + 17 * ti + gi)
                outs[(gi, ti)] = y
                m = evaluate_audio(y, pid, txt, ref)
                m["rtf_x"] = st.get("rtf_x")
                m["first_chunk_ms"] = st.get("first_chunk_ms")
                m["gain_db"] = st.get("gain_db")
                per[gi]["items"].append(m)
            except Exception as e:  # noqa: BLE001
                per[gi]["items"].append({"error": f"{type(e).__name__}: {e}"})
    def mean(gi, key):
        v = [it.get(key) for it in per[gi]["items"] if isinstance(it.get(key), (int, float))]
        return float(np.mean(v)) if v else None
    for gi in range(len(WORKERS)):
        per[gi]["mean"] = {k: (round(mean(gi, k), 3) if mean(gi, k) is not None else None)
                           for k in ("speaker_sim_centroid", "speaker_sim_anchor", "cer", "fidelity_index", "rtf_x",
                                     "first_chunk_ms", "f0_median_diff_cents", "rate_ratio", "spectral_dist_db")}
        per[gi]["mean"]["speech_db"] = round(float(np.mean([it["energy_gen"]["speech_db"] for it in per[gi]["items"]
                                                            if "energy_gen" in it] or [0])), 2)
    cross = []
    if len(WORKERS) >= 2:
        for ti in range(len(texts)):
            if (0, ti) in outs and (1, ti) in outs:
                cross.append(SPK.sim(SPK.embed(to16k(outs[(0, ti)])), SPK.embed(to16k(outs[(1, ti)]))))
    res = {"profile": pid, "gpus": per, "cross_gpu_speaker_sim": round(float(np.mean(cross)), 4) if cross else None,
           "speaker_model": SPK.method}
    if len(per) >= 2:
        d_loud = abs(per[0]["mean"]["speech_db"] - per[1]["mean"]["speech_db"])
        a, b = per[0]["mean"].get("speaker_sim_centroid"), per[1]["mean"].get("speaker_sim_centroid")
        d_sim = abs(a - b) if a is not None and b is not None else None
        res["delta"] = {"loudness_db": round(d_loud, 2), "speaker_sim": round(d_sim, 4) if d_sim is not None else None}
        complete=bool(texts) and all(len(g["items"])==len(texts) and all("error" not in item for item in g["items"]) for g in per)
        res["consistent"] = bool(complete and d_loud < 1.5 and (d_sim is None or d_sim < 0.04)
                                 and (res["cross_gpu_speaker_sim"] is None or res["cross_gpu_speaker_sim"] > 0.80))
    if "trained_adapter" in ref["prof"]:
        res.update(model_output_mode="sentence-buffered",quality_verified=False,inference_reload_verified=False)
    return res


@app.post("/consistency")
async def consistency_ep(body: dict):
    pid = body.get("profile") or (read_json(STATE / "active.json", {}) or {}).get("id")
    if not pid or not load_profile(pid):
        return _err("profile not found")
    texts = body.get("texts") or DEFAULT_CONS_TEXTS
    if (not isinstance(texts,list) or len(texts)>6 or not all(isinstance(text,str) and 0<len(text)<=200 for text in texts)
            or sum(map(len,texts))>1000):
        return _err("consistency accepts up to 6 non-empty texts, 200 characters each, 1000 total")
    loop = asyncio.get_running_loop()
    try:
        return await HEAVY.run(consistency,pid,texts)
    except UploadRejected as e:
        return _err(str(e),e.code)
    except Exception as e:  # noqa: BLE001
        log.exception("consistency failed")
        return _err(f"{type(e).__name__}: {e}", 500)


# Kept separate from profiles: raw references never become selectable models.
from library_api import register_library_routes
register_library_routes(app,sys.modules[__name__])

from diagnostic_pair import register_diagnostics
register_diagnostics(app,sys.modules[__name__])

if __name__ == "__main__":
    import uvicorn
    log.info("analyst on :%d mock=%s", ANALYST_PORT, MOCK)
    uvicorn.run(app, host="127.0.0.1", port=ANALYST_PORT, log_level="warning", access_log=False)
