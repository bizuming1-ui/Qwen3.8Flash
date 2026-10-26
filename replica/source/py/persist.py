"""Dataset persistence: freeze voice profiles (anchors, transcripts, breath banks, centroids)
into a private Kaggle Dataset and restore them in a fresh session.

Restore order: (1) an attached dataset under /kaggle/input/*qtts-state*  (2) kaggle CLI download.
Snapshot needs KAGGLE_USERNAME + KAGGLE_KEY (Kaggle -> Settings -> API -> Create New Token,
then add both as Notebook Secrets). Everything is best-effort and never raises.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qtts_common import PROFILES_DIR, STATE, get_logger, extract_tar_safely  # noqa: E402

log = get_logger("persist")
SLUG = "qtts-state"
WORK = Path("/kaggle/working/qtts_dataset") if Path("/kaggle/working").exists() else STATE / "dataset_out"


def _pack(dst: Path) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(dst, "w:gz") as tf:
        if PROFILES_DIR.exists():
            for p in PROFILES_DIR.iterdir():
                if p.is_dir() and not p.name.startswith("_cal_"):
                    tf.add(p, arcname=f"profiles/{p.name}")
        if (STATE / "active.json").exists():
            tf.add(STATE / "active.json", arcname="active.json")
    return dst


def extract_state_members(tf: tarfile.TarFile, destination: Path) -> None:
    """Reject the entire archive before extraction if any member escapes its scope."""
    members = tf.getmembers()
    for m in members:
        name = Path(m.name)
        if (name.is_absolute() or ".." in name.parts or m.issym() or m.islnk()
                or not (m.isfile() or m.isdir())
                or not (m.name == "active.json" or name.parts and name.parts[0] == "profiles")):
            raise ValueError(f"unsafe state archive entry: {m.name}")
    extract_tar_safely(tf, destination)


def restore() -> bool:
    cands = list(Path("/kaggle/input").glob(f"**/{SLUG}.tar.gz")) if Path("/kaggle/input").exists() else []
    if not cands and os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY"):
        try:
            out = WORK / "dl"
            out.mkdir(parents=True, exist_ok=True)
            subprocess.run(["kaggle", "datasets", "download", "-d", f"{os.environ['KAGGLE_USERNAME']}/{SLUG}", "-p", str(out),
                            "--unzip"], check=True, capture_output=True, timeout=300)
            cands = list(out.glob(f"**/{SLUG}.tar.gz"))
        except Exception as e:  # noqa: BLE001
            log.info("no remote dataset to restore (%s)", str(e)[:120])
    if not cands:
        return False
    newest = max(cands, key=lambda p: p.stat().st_mtime)
    try:
        with tarfile.open(newest) as tf:
            extract_state_members(tf, STATE)
        log.info("restored state from %s", newest)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("restore failed: %s", e)
        return False


def snapshot() -> bool:
    user, key = os.environ.get("KAGGLE_USERNAME"), os.environ.get("KAGGLE_KEY")
    if not (user and key):
        log.info("snapshot skipped: KAGGLE_USERNAME/KAGGLE_KEY not set")
        return False
    try:
        WORK.mkdir(parents=True, exist_ok=True)
        _pack(WORK / f"{SLUG}.tar.gz")
        meta = {"title": SLUG, "id": f"{user}/{SLUG}", "licenses": [{"name": "CC0-1.0"}]}
        (WORK / "dataset-metadata.json").write_text(json.dumps(meta))
        msg = f"qtts state {time.strftime('%Y-%m-%d %H:%M:%S')}"
        r = subprocess.run(["kaggle", "datasets", "version", "-p", str(WORK), "-m", msg], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            r = subprocess.run(["kaggle", "datasets", "create", "-p", str(WORK)], capture_output=True, text=True, timeout=600)
        ok = r.returncode == 0
        log.info("dataset snapshot %s: %s", "ok" if ok else "FAILED", (r.stdout + r.stderr).strip()[:200])
        return ok
    except Exception as e:  # noqa: BLE001
        log.warning("snapshot failed: %s", e)
        return False


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    sys.exit(0 if (restore() if cmd == "restore" else snapshot()) else 1)
