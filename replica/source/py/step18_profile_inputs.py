"""Stage18 candidate-only profile input/commit primitives; no model or playback changes."""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import threading
from resource_limits import UploadRejected
from voice_binding import MAX_REFERENCE_BYTES

BODY_BYTES = 128 * 1024
# Bounded in-process coordination, not a cross-process profile transaction system.
_LOCKS = tuple(threading.RLock() for _ in range(64))

def profile_lock(pid):
    return _LOCKS[int.from_bytes(hashlib.sha256(pid.encode('utf-8')).digest()[:2], 'little') % len(_LOCKS)]

def reject(message='invalid profile input', code=400):
    raise UploadRejected(message, code)

def _pairs(items):
    out = {}
    for key, value in items:
        if key in out: reject('duplicate JSON keys are not allowed')
        out[key] = value
    return out

def _float(raw):
    value = float(raw)
    if not math.isfinite(value): reject('non-finite JSON numbers are not allowed')
    return value

def _constant(raw):
    reject('non-finite JSON numbers are not allowed')

async def profile_body(request, field):
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > BODY_BYTES: reject('profile request exceeds byte limit', 413)
        raw.extend(chunk)
    try:
        value = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=_pairs,
                           parse_float=_float, parse_constant=_constant)
    except (ValueError, UnicodeError, RecursionError):
        reject('profile request must be valid UTF-8 JSON')
    if not isinstance(value, dict) or set(value) != {field}:
        reject('profile request must contain exactly ' + field)
    return value[field]

def text_value(value):
    if not isinstance(value, str): reject('ref_text must be a string')
    value = value.strip()
    if not 0 < len(value) <= 20000: reject('ref_text must contain 1..20000 characters')
    try: value.encode('utf-8', 'strict')
    except UnicodeError: reject('ref_text must be valid Unicode')
    return value

def index_value(value):
    if type(value) is not int or value < 0: reject('index must be a non-negative integer')
    return value

def candidates(prof):
    value = prof.get('candidates')
    if not isinstance(value, list) or not value: reject('profile has no valid candidates')
    return value

def candidate(prof, index):
    rows = candidates(prof)
    if type(index) is not int or not 0 <= index < len(rows): reject('bad index')
    row = rows[index]
    if not isinstance(row, dict): reject('invalid candidate metadata')
    return row

def safe_name(value):
    if (not isinstance(value, str) or not value or Path(value).name != value
            or value in ('.', '..') or '\\' in value or '\x00' in value):
        reject('candidate must name a single regular file')
    return value

def regular_bytes(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_REFERENCE_BYTES:
                reject('invalid candidate file size/type')
            raw = stream.read(MAX_REFERENCE_BYTES + 1)
            if len(raw) != info.st_size: reject('candidate file changed while reading')
            return raw
    except (OSError, ValueError):
        reject('candidate file unavailable or unsafe')

def install_anchor(directory, index, raw):
    # Content-addressed immutable anchor; identical selections reuse the same bytes.
    name = f'anchor_s18_{index}_{hashlib.sha256(raw).hexdigest()}.wav'
    path = directory / name
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        if regular_bytes(path) != raw: reject('existing anchor content does not match')
        return name, False
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return name, True
