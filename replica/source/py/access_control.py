"""Local single-user access token provisioning. Tokens never enter URLs or logs."""
from __future__ import annotations

import fcntl
import hashlib
import tempfile
import os
from pathlib import Path
import secrets
import stat
from urllib.parse import urlparse

TOKEN_FILE = ".access-token"


def auth_directory(state: Path) -> Path:
    """Never default to /kaggle/working: saved notebook outputs must not contain tokens."""
    digest=hashlib.sha256(str(state.resolve()).encode()).hexdigest()[:16]
    return Path(os.environ.get("QTTS_AUTH_DIR") or Path(tempfile.gettempdir()) / f"qtts-auth-{os.getuid()}-{digest}")


def validate_token(value: str) -> str:
    if not 32 <= len(value) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ValueError("QTTS_ACCESS_TOKEN must contain 32..256 printable non-space ASCII characters")
    return value


def _read_file(state: Path) -> str:
    fd = os.open(state / TOKEN_FILE, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="ascii") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 256:
            raise ValueError("unsafe local access-token file")
        os.fchmod(f.fileno(), 0o600)
        return validate_token(f.read(257))


def load_access_token(state: Path) -> str:
    if "QTTS_ACCESS_TOKEN" in os.environ:
        return validate_token(os.environ["QTTS_ACCESS_TOKEN"])
    return _read_file(state)


def ensure_access_token(state: Path) -> str:
    if "QTTS_ACCESS_TOKEN" in os.environ:
        return validate_token(os.environ["QTTS_ACCESS_TOKEN"])
    state.mkdir(parents=True, exist_ok=True,mode=0o700)
    info=state.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid():
        raise ValueError("unsafe authentication directory")
    state.chmod(0o700)
    lock_fd = os.open(state / ".access-token.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (state / TOKEN_FILE).exists():
            value = secrets.token_urlsafe(32)
            fd = os.open(state / TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w", encoding="ascii") as f:
                f.write(value)
                f.flush()
                os.fsync(f.fileno())
        return _read_file(state)


def gateway_headers(url: str, state: Path, gateway_port: int) -> dict[str, str]:
    """Only attach the shared token to the local gateway, never model workers."""
    u = urlparse(url)
    if u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost") and u.port == gateway_port:
        return {"Authorization": "Bearer " + load_access_token(auth_directory(state))}
    return {}
