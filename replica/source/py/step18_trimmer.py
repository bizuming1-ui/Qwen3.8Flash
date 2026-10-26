"""Partition-invariant, bounded synthetic/generated PCM edge trimmer.

A threshold is not a speech detector: leading subthreshold history may be removed.
Normal finish never removes nonzero samples that remain buffered. No reference PCM.
"""
from collections import deque
import math
import operator
import numpy as np


class _Queue:
    def __init__(self):
        self.parts = deque()
        self.size = 0

    def append(self, a):
        if a.size:
            self.parts.append(a.copy())  # never retain a whole incoming array via a view
            self.size += a.size

    def pop(self, n, output=None):
        n = min(n, self.size)
        self.size -= n
        while n:
            a = self.parts.popleft()
            take = min(n, a.size)
            if output is not None:
                output.append(a[:take])
            if take < a.size:
                self.parts.appendleft(a[take:])
            n -= take

    def clear(self):
        self.parts.clear()
        self.size = 0


class EdgeTrimmer:
    BLOCK = 120  # fixed sample grid, 5ms at worker's 24kHz

    def __init__(self, sr=24000, thr_db=-46., keep_ms=35,
                 max_lead_ms=900, max_held_ms=1800):
        if isinstance(sr, (bool, np.bool_)):
            raise ValueError('invalid sample rate')
        try:
            self.sr = operator.index(sr)
        except TypeError as exc:
            raise ValueError('invalid sample rate') from exc
        if not 8000 <= self.sr <= 384000:
            raise ValueError('invalid sample rate')
        def finite(value, low, high):
            if isinstance(value, (bool, np.bool_)):
                raise ValueError('invalid trimmer configuration')
            try:
                v = float(value)
            except (ValueError, TypeError, OverflowError) as exc:
                raise ValueError('invalid trimmer configuration') from exc
            if not math.isfinite(v) or not low <= v <= high:
                raise ValueError('invalid trimmer configuration')
            return v
        self.thr = 10 ** (finite(thr_db, -120, 0) / 20)
        self.keep = int(self.sr * finite(keep_ms, 0, 2000) / 1000)
        self.max_lead = int(self.sr * finite(max_lead_ms, 0, 10000) / 1000)
        self.max_held = int(self.sr * finite(max_held_ms, 0, 10000) / 1000)
        self.started = self.closed = self.lead_limit_reached = False
        self.lead_dropped = self.lead_seen = 0
        self.input_samples = self.emitted_samples = 0
        self.trailing_zero_dropped = self.cancel_discarded = 0
        self._pending = np.empty(0, np.float32)
        self._lead, self._held = _Queue(), _Queue()
        self._tail_kept = 0

    def _voiced(self, a):
        # Float64 square prevents overflow for finite float32 extrema.
        return float(np.sqrt(np.mean(a.astype(np.float64) ** 2))) > self.thr

    def _consume(self, a, output):
        voiced = self._voiced(a)
        if not self.started:
            self.lead_seen += a.size
            forced = self.lead_seen > self.max_lead
            if voiced or forced:
                self.started = True
                self.lead_limit_reached = forced and not voiced
                self._lead.pop(self._lead.size, output)
            else:
                self._lead.append(a)
                excess = max(0, self._lead.size - self.keep)
                self._lead.pop(excess)
                self.lead_dropped += excess
                return
        if voiced:
            self._held.pop(self._held.size, output)
            output.append(a)
            self._tail_kept = 0
        else:
            keep = min(a.size, max(0, self.keep - self._tail_kept))
            if keep:
                output.append(a[:keep])
                self._tail_kept += keep
            self._held.append(a[keep:])
            # Bounded latency/storage: spill in order, NEVER delete middle silence.
            self._held.pop(max(0, self._held.size - self.max_held), output)

    def _result(self, parts):
        a = np.concatenate(parts) if parts else np.empty(0, np.float32)
        self.emitted_samples += a.size
        return a

    def push(self, x):
        if self.closed:
            raise RuntimeError('trimmer is closed')
        a = np.ascontiguousarray(np.asarray(x, dtype=np.float32).reshape(-1))
        if not a.size:
            return np.empty(0, np.float32)
        # Standalone API follows worker sanitization; never mutate input.
        if not np.isfinite(a).all():
            a = np.nan_to_num(a, nan=0., posinf=0., neginf=0.)
        self.input_samples += a.size
        data = np.concatenate((self._pending, a)) if self._pending.size else a
        end = data.size // self.BLOCK * self.BLOCK
        self._pending = data[end:].copy()
        output = []
        for at in range(0, end, self.BLOCK):
            self._consume(data[at:at+self.BLOCK], output)
        return self._result(output)

    def finish(self, cancelled=False):
        if self.closed:
            return np.empty(0, np.float32)
        output = []
        if cancelled:
            self.cancel_discarded += self._pending.size + self._lead.size + self._held.size
        else:
            if self._pending.size:
                self._consume(self._pending, output)
            # Before onset only retained preroll remains. After onset only held tail
            # remains. Preserve nonzero bytes including all subthreshold remnants.
            queue = self._held if self.started else self._lead
            parts = []
            queue.pop(queue.size, parts)
            tail = np.concatenate(parts) if parts else np.empty(0, np.float32)
            nonzero = np.flatnonzero(tail)
            end = min(tail.size, int(nonzero[-1]) + 1 + self.keep) if nonzero.size else 0
            if end:
                output.append(tail[:end])
            self.trailing_zero_dropped += tail.size - end
        self._pending = np.empty(0, np.float32)
        self._lead.clear()
        self._held.clear()
        self.closed = True
        return self._result(output)

    def snapshot(self):
        buffered = self._pending.size + self._lead.size + self._held.size
        return {'input_samples': int(self.input_samples), 'returned_samples': int(self.emitted_samples),
                'leading_dropped_samples': int(self.lead_dropped),
                'trailing_zero_dropped_samples': int(self.trailing_zero_dropped),
                'cancel_discarded_samples': int(self.cancel_discarded),
                'buffered_samples': int(buffered), 'pending_samples': int(self._pending.size),
                'preroll_samples': int(self._lead.size), 'held_samples': int(self._held.size),
                'lead_limit_reached': bool(self.lead_limit_reached), 'closed': bool(self.closed),
                'sample_accounting_ok': self.input_samples == self.emitted_samples + self.lead_dropped + self.trailing_zero_dropped + self.cancel_discarded + buffered,
                'policy': 'fixed-grid-preserve-buffered-nonzero-tail-v1', 'quality_verified': False}
