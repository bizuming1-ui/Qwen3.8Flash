"""Cross-language reference-content pin. It is not authentication or a quality score."""
from __future__ import annotations
import hashlib
import math
import os
from pathlib import Path
import stat
import struct

DOMAIN = b'qtts-voice-v2\0'
MAX_REFERENCE_BYTES = 64 * 1024 * 1024


def generation_bytes(prof):
    g = prof.get('gen', {})
    if g is None:g = {}
    if not isinstance(g, dict):raise ValueError('gen must be an object')
    values=[]
    for key, default in [('temperature',.8),('top_k',50),('top_p',1.),('repetition_penalty',1.05)]:
        raw=g.get(key,default)
        if isinstance(raw,bool) or not isinstance(raw,(int,float)):
            raise ValueError('invalid generation parameter: '+key)
        value=float(raw)
        if not math.isfinite(value):raise ValueError('non-finite generation parameter: '+key)
        if key=='temperature' and not 0 < value <= 2:raise ValueError('temperature must be 0..2 (exclusive0)')
        if key=='top_k' and not (value.is_integer() and 0 <= value <= 4096):raise ValueError('top_k must be integer0..4096')
        if key=='top_p' and not 0 < value <= 1:raise ValueError('top_p must be 0..1 (exclusive0)')
        if key=='repetition_penalty' and not 0 < value <= 4:raise ValueError('invalid repetition_penalty')
        values.append(0. if value==0 else value)
    return struct.pack('<4d',*values)


def reference_binding(directory: Path, prof: dict, *, allow_missing: bool = False) -> str:
    name = prof.get('anchor', '')
    if not name:
        if allow_missing:
            return ''
        raise ValueError('voice anchor missing')
    if not isinstance(name, str) or Path(name).name != name or name in ('.', '..') or '\\' in name:
        raise ValueError('voice anchor must be a single safe filename')
    path = directory / name
    try:
        # O_NOFOLLOW closes the symlink swap between lstat/open on Linux/Kaggle.
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except FileNotFoundError:
        if allow_missing:
            return ''
        raise
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(f.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_size <= 0 or s.st_size > MAX_REFERENCE_BYTES:
            raise ValueError('invalid reference file size/type')
        raw = f.read(MAX_REFERENCE_BYTES + 1)
        if len(raw) != s.st_size:
            raise ValueError('reference file changed while reading')
    h = hashlib.sha256(DOMAIN)
    for value in (raw, str(prof.get('ref_text') or '').encode('utf-8'), str(prof.get('language') or '').encode('utf-8'), generation_bytes(prof)):
        h.update(struct.pack('<Q', len(value)))
        h.update(value)
    return h.hexdigest()
