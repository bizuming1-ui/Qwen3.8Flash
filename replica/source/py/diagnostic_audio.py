"""Bounded, observational PCM features. Never denoise, normalize, or mutate audio.

RMS is not LUFS. Spectral ratios/flatness are clues, not hiss or speaker-identity
classifiers. Fixed windows make statistics independent of transport chunking.
"""
from __future__ import annotations
import math
import time
import numpy as np


class AudioProbe:
    def __init__(self, sample_rate=24000, frame_size=1024):
        if sample_rate != 24000 or frame_size != 1024:
            raise ValueError("unsupported diagnostic geometry")
        self.sr, self.n = sample_rate, frame_size
        self.tail = np.empty(0, np.float64)
        self.window = np.hanning(self.n)
        freq = np.fft.rfftfreq(self.n, 1 / self.sr)
        self.band = (freq >= 150) & (freq <= 10000)
        self.high = (freq >= 4000) & (freq <= 10000)
        self.hist = np.zeros(241, np.int64)  # -120..0 dB, 0.5 dB bins
        self.clamped = 0
        self.count = self.bad = self.clipped = self.frames = self.active = 0
        self.energy = self.peak = self.dc = self.cpu_ms = 0.0
        self.hf_sum = self.flat_sum = self.max_jump = 0.0
        self.jump_count = self.spectral_frames = self.noise_clue_frames = 0
        self.last_db = self.last_sample = None
        self.max_sample_step = 0.0
        self.closed = False

    def feed(self, audio, *, pcm16=False):
        if self.closed:
            raise RuntimeError("probe already finalized")
        t = time.perf_counter()
        a = np.asarray(audio, dtype=np.float64).reshape(-1).copy()
        if pcm16:
            a /= 32768.0
        if not a.size:
            return
        good = np.isfinite(a)
        self.bad += int(a.size - np.count_nonzero(good))
        a[~good] = 0
        # Analysis only; pathological model values must not overflow reductions.
        self.clamped += int(np.count_nonzero(np.abs(a)>16))
        np.clip(a, -16.0, 16.0, out=a)
        self.count += int(a.size)
        self.energy += float(np.dot(a, a))
        self.dc += float(np.sum(a))
        self.peak = max(self.peak, float(np.max(np.abs(a))))
        self.clipped += int(np.count_nonzero(np.abs(a) >= 0.9997))
        if self.last_sample is not None:
            self.max_sample_step = max(self.max_sample_step, abs(float(a[0]) - self.last_sample))
        if a.size > 1:
            self.max_sample_step = max(self.max_sample_step, float(np.max(np.abs(np.diff(a)))))
        self.last_sample = float(a[-1])
        joined = np.concatenate((self.tail, a))
        end = len(joined) // self.n * self.n
        for start in range(0, end, self.n):
            self._frame(joined[start:start + self.n])
        self.tail = joined[end:].copy()
        self.cpu_ms += (time.perf_counter() - t) * 1000

    def _frame(self, a):
        rms = math.sqrt(float(np.dot(a, a)) / len(a))
        db = 20 * math.log10(max(rms, 1e-6))
        self.hist[int(np.clip(round((db + 120) * 2), 0, 240))] += 1
        self.frames += 1
        if db > -55:
            self.active += 1
            if self.last_db is not None and self.last_db > -55:
                jump = abs(db - self.last_db)
                self.max_jump = max(self.max_jump, jump)
                self.jump_count += int(jump >= 6)
        self.last_db = db
        # Incomplete last windows contribute energy/envelope, not a padded FFT.
        if len(a) != self.n or rms <= 1e-6:
            return
        power = np.abs(np.fft.rfft(a * self.window)) ** 2
        total = float(np.sum(power[self.band]))
        if total <= 1e-16:
            return
        hf = float(np.sum(power[self.high]) / total)
        p = power[self.band]
        flat = float(np.exp(np.mean(np.log(np.maximum(p, 1e-20)))) / max(float(np.mean(p)), 1e-20))
        self.hf_sum += hf
        self.flat_sum += flat
        self.spectral_frames += 1
        # Sibilants, fricatives and recording acoustics can trigger this too.
        self.noise_clue_frames += int(hf > 0.3 and flat > 0.25 and -65 < db < -20)

    def finish(self):
        if not self.closed:
            t = time.perf_counter()
            if self.tail.size:
                self._frame(self.tail)
            self.tail = np.empty(0, np.float64)
            self.closed = True
            self.cpu_ms += (time.perf_counter() - t) * 1000
        cumulative = np.cumsum(self.hist)
        def percentile(p):
            if not self.frames:
                return None
            i = int(np.searchsorted(cumulative, max(1, math.ceil(self.frames * p))))
            return round(i * 0.5 - 120, 1)
        p10, p50, p90 = (percentile(x) for x in (0.1, 0.5, 0.9))
        return {
            "samples": self.count, "audio_s": self.count / self.sr,
            "sample_rate": self.sr, "frame_samples": self.n,
            "frames": self.frames, "active_frames": self.active,
            "nonfinite_samples": self.bad, "analysis_clamped_samples":self.clamped,
            "rms_dbfs": 20 * math.log10(max(math.sqrt(self.energy / max(self.count, 1)), 1e-6)),
            "peak": self.peak, "dc_offset": self.dc / max(self.count, 1),
            "clip_fraction": self.clipped / max(self.count, 1),
            "envelope_p10_dbfs": p10, "envelope_p50_dbfs": p50, "envelope_p90_dbfs": p90,
            "envelope_spread_db": None if p10 is None else p90 - p10,
            "max_active_jump_db": self.max_jump, "active_jumps_ge6db": self.jump_count,
            "max_sample_step": self.max_sample_step,
            "spectral_frames": self.spectral_frames,
            "high_band_fraction_mean": self.hf_sum / self.spectral_frames if self.spectral_frames else None,
            "spectral_flatness_mean": self.flat_sum / self.spectral_frames if self.spectral_frames else None,
            "noise_clue_frame_fraction": self.noise_clue_frames / self.spectral_frames if self.spectral_frames else None,
            "observer_cpu_ms": self.cpu_ms,
            "measured": bool(self.count), "hiss_verified": False,
            "naturalness_verified": False, "speaker_identity_verified": False,
        }


def observe(audio):
    probe = AudioProbe()
    # Bound transient memory even for recordings longer than ten minutes.
    for start in range(0, len(audio), 65536):
        probe.feed(audio[start:start + 65536])
    return probe.finish()


class JobProbe:
    """Diagnostics failure must be visible, but must not fail an otherwise valid voice."""
    def __init__(self):
        self.raw, self.output = AudioProbe(), AudioProbe()
        self.failed = False

    def feed(self, data, *, output=False):
        if self.failed:
            return
        try:
            (self.output if output else self.raw).feed(data, pcm16=output)
        except Exception:
            self.failed = True

    def finish(self):
        if self.failed:
            return {"available": False, "observer_failed": True, "quality_verified": False}
        try:
            raw, output = self.raw.finish(), self.output.finish()
            return {"available": True, "observer_failed": False,
                    "raw_pretrim": raw, "emitted_pcm_including_pause_tail": output,
                    "observer_cpu_ms": raw["observer_cpu_ms"] + output["observer_cpu_ms"],
                    "quality_verified": False}
        except Exception:
            self.failed = True
            return {"available": False, "observer_failed": True, "quality_verified": False}


def safe_observe(audio):
    try:
        return observe(audio)
    except Exception:
        return {"available": False, "observer_failed": True, "quality_verified": False}
