"""Bounded content snapshots and in-process optimistic calibration coordination.
Not a multi-process lock or an authentication/quality proof.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import threading
from step18_profile_inputs import candidates, candidate, text_value, safe_name, regular_bytes
from resource_limits import UploadRejected
from voice_binding import MAX_REFERENCE_BYTES

MAX_CANDIDATES = 24
MAX_SNAPSHOT_BYTES = MAX_REFERENCE_BYTES
_ACTIVE_LOCK = threading.Lock()
_ACTIVE = set()

@contextmanager
def exclusive_calibration(directory):
    key = str(directory.absolute())
    with _ACTIVE_LOCK:
        if key in _ACTIVE:
            raise UploadRejected('calibration already in progress for this profile', 409)
        _ACTIVE.add(key)
    try:
        yield
    finally:
        with _ACTIVE_LOCK:
            _ACTIVE.remove(key)

@dataclass(frozen=True)
class Snapshot:
    profile: dict
    files: dict
    directory_identity: tuple
    version: str

def snapshot(directory, profile):
    rows = candidates(profile)
    if len(rows) > MAX_CANDIDATES:
        raise UploadRejected('too many calibration candidates', 413)
    names = []
    for k in range(len(rows)):
        row = candidate(profile, k)
        text_value(row.get('text'))
        names.append(safe_name(row.get('file')))
    names.append(safe_name(profile.get('anchor')))
    # The centroid is an evaluation input too; a symlink must not silently substitute it.
    if (directory/'centroid.npy').exists() or (directory/'centroid.npy').is_symlink():
        names.append('centroid.npy')
    try:
        metadata = json.dumps(profile, sort_keys=True, ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        raise UploadRejected('invalid calibration profile metadata', 400) from None
    files = {}; total = 0
    for name in sorted(set(names)):
        raw = regular_bytes(directory/name)
        total += len(raw)
        if total > MAX_SNAPSHOT_BYTES:
            raise UploadRejected('calibration snapshot exceeds byte budget', 413)
        files[name] = raw
    info = directory.stat()
    version = hashlib.sha256(metadata)
    for name, raw in files.items():
        for value in (name.encode('utf-8'), raw):
            version.update(len(value).to_bytes(8, 'little')); version.update(value)
    return Snapshot(json.loads(metadata), files, (info.st_dev, info.st_ino), version.hexdigest())

def confirm_snapshot(directory, current_profile, expected):
    try:
        if not current_profile or 'trained_adapter' in current_profile:
            raise UploadRejected('changed', 409)
        current = snapshot(directory, current_profile)
        if current.directory_identity != expected.directory_identity or current.version != expected.version:
            raise UploadRejected('changed', 409)
    except (UploadRejected, OSError, ValueError, TypeError):
        raise UploadRejected('profile inputs changed or were deleted during calibration; retry', 409) from None
