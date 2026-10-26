"""Shared configuration, logging and tiny helpers for every QTTS Python process."""
from __future__ import annotations

import json
import math
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(os.environ.get("QTTS_ROOT", Path(__file__).resolve().parent.parent))
STATE = Path(os.environ.get("QTTS_STATE", ROOT / "state"))
PROFILES_DIR = STATE / "profiles"
LOG_DIR = STATE / "logs"

SAMPLE_RATE = 24000
WORKER_PORTS = [int(p) for p in os.environ.get("QTTS_WORKER_PORTS", "7001,7002").split(",")]
ANALYST_PORT = int(os.environ.get("QTTS_ANALYST_PORT", "7010"))
GATEWAY_PORT = int(os.environ.get("QTTS_GATEWAY_PORT", "7860"))
MODEL_ID = os.environ.get("QTTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
MOCK = os.environ.get("QTTS_MOCK", "0") == "1"

for _d in (STATE, PROFILES_DIR, LOG_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def get_logger(name: str) -> logging.Logger:
    log = logging.getLogger(name)
    if log.handlers:
        return log
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(name)s] %(levelname)s %(message)s", "%H:%M:%S")
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)
    try:
        fh = logging.FileHandler(LOG_DIR / f"{name}.log")
        fh.setFormatter(fmt)
        log.addHandler(fh)
    except OSError:
        pass
    log.propagate = False
    return log


def now_ms() -> float:
    return time.perf_counter() * 1000.0


class Ema:
    """Exponential moving average with variance, thread-safe enough for stats."""

    def __init__(self, alpha: float = 0.2):
        self.alpha = alpha
        self.value: float | None = None
        self.var = 0.0
        self.n = 0

    def update(self, x: float) -> float:
        self.n += 1
        if self.value is None:
            self.value = float(x)
        else:
            d = x - self.value
            self.value += self.alpha * d
            self.var = (1 - self.alpha) * (self.var + self.alpha * d * d)
        return self.value

    def get(self, default: float = 0.0) -> float:
        return default if self.value is None else self.value


class StageTimer:
    """Collects per-stage durations (ms) for one request."""

    def __init__(self):
        self.t0 = now_ms()
        self.marks: dict[str, float] = {}
        self._lock = threading.Lock()

    def mark(self, name: str) -> float:
        with self._lock:
            v = now_ms() - self.t0
            self.marks.setdefault(name, round(v, 1))
            return v

    def as_dict(self) -> dict:
        with self._lock:
            return dict(self.marks)


def read_json(path: Path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as f:
            tmp = Path(f.name)
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


_SLUG_RE = re.compile(r"[^a-zA-Z0-9_\-]+")


def slugify(name: str) -> str:
    s = _SLUG_RE.sub("-", name.strip()).strip("-").lower()
    return s[:40] or "voice"


def profile_dir(pid: str) -> Path:
    if not re.fullmatch(r"[a-zA-Z0-9_\-]{1,64}", pid):
        raise ValueError("invalid profile id")
    return PROFILES_DIR / pid


def load_profile(pid: str) -> dict | None:
    return read_json(profile_dir(pid) / "profile.json")


def active_profile_id() -> str | None:
    d = read_json(STATE / "active.json", {})
    return d.get("id") if isinstance(d, dict) else None


def count_text_units(text: str) -> float:
    """CJK chars count 1, latin words count 1.6 (rough spoken-unit estimate)."""
    cjk = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", text))
    words = len(re.findall(r"[A-Za-z0-9']+", text))
    return cjk + 1.6 * words


def detect_language(text: str) -> str:
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    kana = len(re.findall(r"[\u3040-\u30ff]", text))
    hangul = len(re.findall(r"[\uac00-\ud7af]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    if kana > 0 and kana >= cjk * 0.2:
        return "Japanese"
    if hangul > cjk and hangul > 0:
        return "Korean"
    if cjk > 0 and cjk * 1.0 >= latin * 0.35:
        return "Chinese"
    return "English"


def extract_tar_safely(tf, destination: Path) -> None:
    """Portable file/directory-only extraction; never follow archive or existing escape links."""
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    members = tf.getmembers()
    targets = []
    for member in members:
        name = Path(member.name)
        if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
            raise ValueError(f"unsafe archive member: {member.name}")
        target = destination / name
        try:
            target.resolve().relative_to(root)
        except ValueError:
            raise ValueError(f"archive path escapes destination: {member.name}") from None
        targets.append((member, target))
    for member, target in targets:
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        source = tf.extractfile(member)
        if source is None:
            raise ValueError(f"missing archive data: {member.name}")
        temp = None
        try:
            with source, tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                temp = Path(output.name)
                shutil.copyfileobj(source, output)
            os.chmod(temp, member.mode & 0o777)
            os.replace(temp, target)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)


def output_target_dbfs() -> float:
    """One output target for old and new profiles; never normalizes private source audio."""
    try:
        value = float(os.environ.get("QTTS_OUTPUT_DBFS", "-18"))
        if math.isfinite(value) and -24 <= value <= -14:
            return value
    except (ValueError, TypeError):
        pass
    return -18.0


