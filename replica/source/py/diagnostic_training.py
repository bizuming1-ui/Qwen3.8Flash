"""Read-only, bounded training receipts. Logs/paths/transcripts never leave the runtime."""
import json
import math
import re
import time
from pathlib import Path


def _json(path, limit=16384):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        return {}
    value = json.loads(path.read_bytes())
    return value if isinstance(value, dict) else {}


def _numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value) <= 1e15


def _rank(path, rank):
    if path.is_symlink() or not path.is_file():
        return {"rank": rank, "progress_observed": False}
    with path.open("rb") as stream:
        size = path.stat().st_size
        stream.seek(max(0, size-32768))
        if size > 32768:
            stream.readline()
        data = stream.read(32768)
    result = {"rank": rank, "progress_observed": False}
    for line in data.splitlines()[-128:]:
        if len(line) > 8192:
            continue
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(row, dict) or row.get("rank") != rank:
            continue
        allowed = {k: v for k, v in row.items() if k in {"epoch", "loss_mean", "loss", "optimizer_steps", "overflow_steps", "micro_step", "elapsed_s"} and _numeric(v)}
        if any(k in row and not _numeric(row[k]) for k in ("loss","loss_mean")):
            result["invalid_loss_observed"]=True
            result["loss_finite"]=False
            result["progress_observed"]=True
            continue
        if "loss" not in allowed and "loss_mean" not in allowed:
            continue
        result.update(allowed)
        result["progress_observed"] = True
        result["loss_finite"] = True
    result["last_log_age_s"] = max(0, time.time()-path.stat().st_mtime)
    return result


def snapshot_training(state):
    root = Path(state)/"training_runs"
    if root.is_symlink() or not root.is_dir():
        return {"runs": [], "training_completed_verified": False}
    runs = []
    # The existing controller admits at most 32 runs. Do not follow foreign paths.
    for directory in sorted(root.iterdir())[:32]:
        if directory.is_symlink() or not directory.is_dir() or not re.fullmatch(r"[0-9a-f]{32}", directory.name):
            continue
        entry = {"id": directory.name, "ranks": [], "status": "no_terminal_receipt", "quality_verified": False}
        try:
            entry["ranks"] = [_rank(directory/("rank%d.log" % rank), rank) for rank in (0, 1)]
            terminal = _json(directory/"result.json")
            if terminal.get("status") in {"completed", "failed", "cancelled", "timeout"}:
                entry["status"] = terminal["status"]
                # Controller evidence only; this does not establish speech quality or reload.
                entry["optimizer_execution_observed"] = terminal.get("optimizer_execution_observed") is True
            entry["checkpoint_manifest_present"] = (directory/"adapter/manifest.json").is_file() and not (directory/"adapter").is_symlink()
        except Exception:
            entry["diagnostics_unavailable"] = True
        runs.append(entry)
    return {"runs": runs, "training_completed_verified": False, "speech_quality_verified": False,
            "note": "optimizer_receipts_not_acoustic_validation"}
