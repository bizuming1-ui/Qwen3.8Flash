"""Isolated18 causal NumPy DSP. No PCM buffering and no native backend selection.

This repairs partition dependence; it is NOT acoustic or Rust-equivalence proof.
State uses Python float64 arithmetic, float32 inputs, ties-to-even int16 rounding.
"""
from __future__ import annotations

import math
import operator

import numpy as np

BACKEND = "numpy-causal-v1"


def _f32(x) -> np.ndarray:
    return np.ascontiguousarray(np.asarray(x, dtype=np.float32).reshape(-1))


def rms_dbfs(x) -> float:
    a = _f32(x)
    if not a.size:
        return -90.0
    return float(20 * np.log10(max(float(np.sqrt(np.mean(a.astype(np.float64) ** 2))), 1e-9)))


def peak(x) -> float:
    a = _f32(x)
    return float(np.max(np.abs(a))) if a.size else 0.0


def f32_to_i16(x) -> np.ndarray:
    return np.round(np.clip(_f32(x), -1.0, 1.0) * 32767.0).astype(np.int16)


def _length(value, name: str) -> int:
    if isinstance(value, (bool, np.bool_)):
        raise ValueError(f"{name} must be a nonnegative integer")
    try:
        n = operator.index(value)
    except TypeError as exc:
        raise ValueError(f"{name} must be a nonnegative integer") from exc
    if n < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return n


def _bounded(value, name: str, low: float, high: float) -> float:
    if isinstance(value, (bool, np.bool_)):
        raise ValueError(f"{name} must be finite within [{low}, {high}]")
    value = float(value)
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name} must be finite within [{low}, {high}]")
    return value


class _Stats:
    def __init__(self):
        self.samples = 0
        self.soft_limited_samples = 0
        self.soft_limiter_peak_reduction_db = 0.0


class Leveler:
    """Causal DC blocker -> gated RMS AGC -> segment fade -> soft limiter.

    process emits one sample per input immediately, including incomplete RMS windows.
    start_segment only restarts the fade, never DC/RMS/gain. Positive flush emits an
    explicit tail and resets DC/last only; it is not a hidden RMS-window finalizer.
    """

    def __init__(self, sr: int, target_dbfs: float = -21.0,
                 max_gain_db: float = 9.0, min_gain_db: float = -9.0,
                 peak_ceiling: float = .99, limiter_knee: float = .10):
        self._closed = True
        self.sr = _length(sr, "sample rate")
        if not 8000 <= self.sr <= 384000:
            raise ValueError("sample rate must be within [8000, 384000]")
        self.target_dbfs = _bounded(target_dbfs, "target_dbfs", -40, -6)
        self._target = 10 ** (self.target_dbfs / 20)
        self._max = 10 ** (_bounded(max_gain_db, "max_gain_db", 0, 18) / 20)
        self._min = 10 ** (_bounded(min_gain_db, "min_gain_db", -24, 0) / 20)
        self._limiter_ceiling = _bounded(peak_ceiling, "peak_ceiling", .5, .9999)
        self._limiter_knee = _bounded(limiter_knee, "limiter_knee", .001, .25)
        self._limiter_start = self._limiter_ceiling - self._limiter_knee
        if self._limiter_start <= 0:
            raise ValueError("limiter knee must be lower than peak ceiling")
        self._env = self._target
        self._gain = self._want = 1.0
        self._seen = 0
        self._last = self._prev_x = self._prev_y = 0.0
        self._fade_total = self._fade_left = 0
        # Positive half-up grid length, not Python's ties-to-even duration rounding.
        self._blk_len = max(32, int(self.sr * .01 + .5))
        self._blk_n = 0
        self._blk_sum = 0.0
        self._dc_r = 1.0 - 2.0 * math.pi * 20.0 / self.sr
        self._att = 1.0 - math.exp(-1.0 / (self.sr * .030))
        self._rel = 1.0 - math.exp(-1.0 / (self.sr * .600))
        self._gate = 10 ** (-46.0 / 20.0)
        self._closed = False
        self._stats = _Stats()

    def _open(self):
        if self._closed:
            raise RuntimeError("leveler is closed")

    def close(self):
        self._closed = True

    def start_segment(self, fade_samples: int | None = None):
        self._open()
        n = max(8, int(self.sr * .004)) if fade_samples is None else _length(fade_samples, "fade_samples")
        self._fade_total = self._fade_left = n

    def process(self, x) -> np.ndarray:
        self._open()
        a = _f32(x)
        out = np.empty(a.size, dtype=np.int16)
        if not a.size:
            return out
        px, py = self._prev_x, self._prev_y
        total, left = self._fade_total, self._fade_left
        count, power = self._blk_n, self._blk_sum
        env, gain, want, seen = self._env, self._gain, self._want, self._seen
        dc, block, gate = self._dc_r, self._blk_len, self._gate
        att, rel, target, low, high = self._att, self._rel, self._target, self._min, self._max
        finite, sqrt, cos, tanh, pi = math.isfinite, math.sqrt, math.cos, math.tanh, math.pi
        limiter_start, limiter_knee = self._limiter_start, self._limiter_knee
        for i, sample in enumerate(a):
            value = float(sample)
            if not finite(value):
                value = 0.0
            y = value - px + dc * py
            px, py = value, y
            power += y * y
            count += 1
            if count == block:
                rms = sqrt(power / count)
                count, power = 0, 0.0
                if rms > gate:
                    env += (rms - env) * (.08 if seen < 60 else .012)
                    seen += 1
                    want = min(high, max(low, target / max(env, 1e-4)))
            gain += (want - gain) * (att if want < gain else rel)
            v = y * gain
            if left:
                v *= .5 - .5 * cos(pi * (total - left) / total)
                left -= 1
            magnitude = abs(v)
            if magnitude > limiter_start:
                self._stats.soft_limited_samples += 1
                v = math.copysign(limiter_start + limiter_knee * tanh((magnitude - limiter_start) / limiter_knee), v)
                self._stats.soft_limiter_peak_reduction_db = max(self._stats.soft_limiter_peak_reduction_db, 20 * math.log10(magnitude / abs(v)))
            out[i] = round(v * 32767.0)
        self._prev_x, self._prev_y = px, py
        self._fade_left = left
        self._blk_n, self._blk_sum = count, power
        self._env, self._gain, self._want, self._seen = env, gain, want, seen
        self._last = v
        self._stats.samples += len(out)
        return out

    def flush(self, n: int = 192) -> np.ndarray:
        self._open()
        n = _length(n, "tail length")
        out = np.empty(n, dtype=np.int16)
        if not n:
            return out
        last = self._last
        for i in range(n):
            out[i] = round(last * (.5 + .5 * math.cos(math.pi * (i + 1) / n)) * 32767.0)
        self._last = self._prev_x = self._prev_y = 0.0
        return out

    @property
    def soft_limiter_ceiling_dbfs(self) -> float:
        self._open()
        return 20 * math.log10(self._limiter_ceiling)

    @property
    def gain_db(self) -> float:
        self._open()
        return 20 * math.log10(max(self._gain, 1e-6))

    @property
    def env_dbfs(self) -> float:
        self._open()
        return 20 * math.log10(max(self._env, 1e-6))


class SentenceLinearLeveler:
    """One constant gain per complete trimmed phrase, bounded by its peak.

    No AGC/compressor/denoiser. Does not claim constant LUFS, louder speech or
    better voice identity. Keeping headroom takes precedence over target RMS.
    process() must be called ONCE; reject misuse instead of hidden gain jumps.
    """
    def __init__(self, sr=24000, target_dbfs=-18.0, max_gain_db=6.0):
        if sr < 8000 or not -36 <= target_dbfs <= -14 or not 0 <= max_gain_db <= 18:
            raise ValueError('invalid linear sentence settings')
        self.sr, self.target_dbfs, self.max_gain_db = int(sr), float(target_dbfs), float(max_gain_db)
        self._gain_db = 0.0
        self._env_dbfs = -120.0
        self.closed = self.processed = False
        self._stats = _Stats()
        self.peak_limited = False

    def start_segment(self):
        if self.closed or self.processed:
            raise RuntimeError('sentence linear leveler is single use')

    def process(self, data):
        if self.closed or self.processed:
            raise RuntimeError('sentence linear leveler is single use')
        x = np.asarray(data, dtype=np.float32).reshape(-1)
        if x.size > 384 * 1920 or not np.isfinite(x).all():
            raise ValueError('invalid or over-budget quality sentence')
        self.processed = True
        if not x.size:
            return np.zeros(0, np.int16)
        self._env_dbfs = rms_dbfs(x)
        peak = float(np.max(np.abs(x)))
        if peak <= 1e-12:
            self._stats.samples = len(x)
            return np.zeros(len(x), np.int16)
        desired_db = min(self.max_gain_db, max(-9.0, self.target_dbfs - self._env_dbfs))
        desired = 10 ** (desired_db / 20)
        gain = min(desired, .95 / peak)
        self.peak_limited = gain < desired
        self._gain_db = 20 * math.log10(max(gain, 1e-12))
        y = x.astype(np.float64) * gain
        # Only the phrase edges fade. The interior is one uniform scale factor.
        head = min(len(y) // 2, max(1, int(self.sr * .004)))
        tail = min(len(y) // 2, max(1, int(self.sr * .008)))
        y[:head] *= np.linspace(0, 1, head)
        y[-tail:] *= np.linspace(1, 0, tail)
        self._stats.samples = len(y)
        return f32_to_i16(y)

    def flush(self, samples=192):
        if self.closed:
            raise RuntimeError('leveler closed')
        return np.zeros(0, np.int16)  # the complete phrase already fades to zero

    def close(self):
        self.closed = True

    @property
    def gain_db(self):
        return self._gain_db

    @property
    def env_dbfs(self):
        return self._env_dbfs
