"""Lightweight W&B / MLflow-style Experiment Tracker stored directly in the Git repository."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from simulators.kaggle_sim.runtime import PROJECT_ROOT


class ExperimentTracker:
    def __init__(self, registry_path: Optional[Path] = None) -> None:
        self.registry_path = registry_path or (PROJECT_ROOT / "experiments" / "registry.json")
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.registry_path.exists():
            self._write({"runs": []})

    def _read(self) -> Dict[str, Any]:
        if not self.registry_path.exists():
            return {"runs": []}
        try:
            return json.loads(self.registry_path.read_text(encoding="utf-8"))
        except Exception:
            return {"runs": []}

    def _write(self, payload: Dict[str, Any]) -> None:
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        self.registry_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    def log_run(
        self,
        run_type: str,
        name: str,
        params: Dict[str, Any],
        metrics: Dict[str, Any],
        notes: str = "",
    ) -> Dict[str, Any]:
        data = self._read()
        run_entry = {
            "run_id": f"exp-{uuid.uuid4().hex[:8]}",
            "timestamp_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "run_type": run_type,
            "name": name,
            "params": params,
            "metrics": metrics,
            "notes": notes,
        }
        runs: List[Dict[str, Any]] = data.get("runs", [])
        runs.insert(0, run_entry)
        data["runs"] = runs[:100]
        self._write(data)
        return run_entry

    def list_runs(self, limit: int = 30) -> List[Dict[str, Any]]:
        return self._read().get("runs", [])[:limit]

    def clear_runs(self) -> None:
        self._write({"runs": []})


_TRACKER: Optional[ExperimentTracker] = None


def get_experiment_tracker() -> ExperimentTracker:
    global _TRACKER
    if _TRACKER is None:
        _TRACKER = ExperimentTracker()
    return _TRACKER
