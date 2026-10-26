"""
Real Project File Persistence Store for Kaggle Code, Notebooks, and Source Modules.

Guarantees that code pasted or edited in the Browser Simulator is written directly
into `/home/user/Qwen3.8Flash` (`src/voice_cloning/`, `notebooks/`, etc.) on real disk,
never stranded in browser localStorage or `/kaggle/working`.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from simulators.kaggle_sim.magic_parser import (
    KaggleCell,
    cells_to_ipynb,
    cells_to_python_module,
    detect_kaggle_references,
    extract_writefiles,
    ipynb_to_cells,
    parse_kaggle_paste,
)
from simulators.kaggle_sim.runtime import PROJECT_ROOT, get_kaggle_runtime


EXCLUDED_DIRS = {
    ".git",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "node_modules",
    "_inline_audio",
}


class ProjectStore:
    def __init__(self, project_root: Path = PROJECT_ROOT) -> None:
        self.project_root = project_root.resolve()
        self.default_py_rel = "src/voice_cloning/kaggle_main.py"
        self.default_ipynb_rel = "notebooks/kaggle_voice_cloning.ipynb"

    def resolve_safe_project_path(self, rel_path: str) -> Path:
        cleaned = rel_path.strip().lstrip("/")
        # Prevent saving code solely into `/kaggle/...` — redirect `/kaggle/working/*.py` to `src/voice_cloning/`
        for kp in ("kaggle/working/", "kaggle_workspace/working/"):
            if cleaned.startswith(kp) and cleaned.endswith((".py", ".ipynb")):
                fname = Path(cleaned).name
                cleaned = f"notebooks/{fname}" if fname.endswith(".ipynb") else f"src/voice_cloning/{fname}"

        if not cleaned:
            raise ValueError("File path cannot be empty.")

        candidate = (self.project_root / cleaned).resolve()
        if candidate == self.project_root or not candidate.is_relative_to(self.project_root):
            raise ValueError(f"Path `{rel_path}` resolves outside project root `{self.project_root}`.")

        rel_parts = candidate.relative_to(self.project_root).parts
        if rel_parts and rel_parts[0] == ".git":
            raise ValueError("Cannot modify `.git` internals directly.")
        return candidate

    def _file_receipt(self, path: Path) -> Dict[str, Any]:
        raw = path.read_bytes()
        return {
            "project_rel_path": path.relative_to(self.project_root).as_posix(),
            "absolute_path": str(path),
            "size_bytes": len(raw),
            "sha256_short": hashlib.sha256(raw).hexdigest()[:12],
            "saved_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        }

    def save_kaggle_workspace_bundle(
        self,
        raw_code: Optional[str] = None,
        cells_payload: Optional[List[Dict[str, Any]]] = None,
        py_rel_path: Optional[str] = None,
        ipynb_rel_path: Optional[str] = None,
        extract_submodules: bool = True,
        auto_split_sections: bool = True,
    ) -> Dict[str, Any]:
        """
        Persists Kaggle code into BOTH:
        1. A real runnable Python file inside `src/voice_cloning/...`
        2. A real Kaggle-compatible `.ipynb` file inside `notebooks/...`
        3. Any `%%writefile` modules extracted into real project files!
        """
        if cells_payload is not None:
            cells = [
                KaggleCell(
                    id=str(c.get("id") or f"cell-{i + 1}"),
                    cell_type=str(c.get("cell_type") or "code"),
                    source=str(c.get("source") or ""),
                    title=str(c.get("title") or f"Cell {i + 1}"),
                    execution_count=c.get("execution_count"),
                )
                for i, c in enumerate(cells_payload)
            ]
        elif raw_code is not None:
            cells = parse_kaggle_paste(raw_code, auto_split_sections=auto_split_sections)
        else:
            raise ValueError("Either `raw_code` or `cells_payload` must be provided.")

        target_py = self.resolve_safe_project_path(py_rel_path or self.default_py_rel)
        target_ipynb = self.resolve_safe_project_path(ipynb_rel_path or self.default_ipynb_rel)

        if target_py.suffix.lower() != ".py":
            target_py = target_py.with_suffix(".py")
        if target_ipynb.suffix.lower() != ".ipynb":
            target_ipynb = target_ipynb.with_suffix(".ipynb")

        target_py.parent.mkdir(parents=True, exist_ok=True)
        target_ipynb.parent.mkdir(parents=True, exist_ok=True)

        accel = get_kaggle_runtime().get_state().get("accelerator", "T4x2")
        py_text = cells_to_python_module(cells)
        ipynb_text = cells_to_ipynb(cells, accelerator=accel)

        target_py.write_text(py_text, encoding="utf-8")
        target_ipynb.write_text(ipynb_text, encoding="utf-8")

        saved_files = [self._file_receipt(target_py), self._file_receipt(target_ipynb)]

        if extract_submodules:
            pkg_dir = target_py.parent.relative_to(self.project_root).as_posix()
            for wf in extract_writefiles(cells, default_pkg_dir=pkg_dir):
                try:
                    wf_dest = self.resolve_safe_project_path(wf.project_rel_path)
                    wf_dest.parent.mkdir(parents=True, exist_ok=True)
                    mode = "a" if wf.append else "w"
                    with open(wf_dest, mode, encoding="utf-8") as fp:
                        fp.write(wf.content)
                    saved_files.append(self._file_receipt(wf_dest))
                except ValueError:
                    continue

        full_source = "\n\n".join(c.source for c in cells)
        refs = detect_kaggle_references(full_source)

        return {
            "cells": [c.to_dict() for c in cells],
            "py_rel_path": target_py.relative_to(self.project_root).as_posix(),
            "ipynb_rel_path": target_ipynb.relative_to(self.project_root).as_posix(),
            "saved_files": saved_files,
            "kaggle_references": refs,
        }

    def load_workspace_cells(self, ipynb_rel_path: Optional[str] = None, py_rel_path: Optional[str] = None) -> Dict[str, Any]:
        nb_path = self.resolve_safe_project_path(ipynb_rel_path or self.default_ipynb_rel)
        py_path = self.resolve_safe_project_path(py_rel_path or self.default_py_rel)

        if nb_path.exists():
            cells = ipynb_to_cells(nb_path)
        elif py_path.exists():
            cells = parse_kaggle_paste(py_path.read_text(encoding="utf-8"))
        else:
            cells = [KaggleCell(id="cell-1", cell_type="code", source="", title="Cell 1")]

        full_source = "\n\n".join(c.source for c in cells)
        return {
            "py_rel_path": py_path.relative_to(self.project_root).as_posix(),
            "ipynb_rel_path": nb_path.relative_to(self.project_root).as_posix(),
            "cells": [c.to_dict() for c in cells],
            "kaggle_references": detect_kaggle_references(full_source),
        }

    def list_project_tree(self) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        for path in sorted(self.project_root.rglob("*")):
            rel_parts = path.relative_to(self.project_root).parts
            if any(part in EXCLUDED_DIRS for part in rel_parts):
                continue
            if path.name == ".gitkeep":
                continue
            if path.is_file():
                rel = path.relative_to(self.project_root).as_posix()
                entries.append(
                    {
                        "path": rel,
                        "category": rel_parts[0] if len(rel_parts) > 1 else "root",
                        "size_bytes": path.stat().st_size,
                        "is_audio": path.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"},
                        "is_text": path.suffix.lower()
                        in {".py", ".ipynb", ".md", ".json", ".yaml", ".yml", ".toml", ".txt", ".sh", ".csv", ".html", ".css", ".js", ".gitignore"}
                        or path.name == ".gitignore",
                    }
                )
        return entries

    def read_text_file(self, rel_path: str) -> Dict[str, Any]:
        p = self.resolve_safe_project_path(rel_path)
        if not p.exists() or not p.is_file():
            raise FileNotFoundError(f"File not found: {rel_path}")
        if p.stat().st_size > 5 * 1024 * 1024:
            raise ValueError("File exceeds 5MB text viewer limit.")
        content = p.read_text(encoding="utf-8", errors="replace")
        return {
            "path": p.relative_to(self.project_root).as_posix(),
            "absolute_path": str(p),
            "size_bytes": p.stat().st_size,
            "content": content,
        }

    def write_text_file(self, rel_path: str, content: str) -> Dict[str, Any]:
        p = self.resolve_safe_project_path(rel_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return self._file_receipt(p)

    def delete_file(self, rel_path: str) -> Dict[str, Any]:
        p = self.resolve_safe_project_path(rel_path)
        if not p.exists() or not p.is_file():
            raise FileNotFoundError(f"File not found: {rel_path}")
        p.unlink()
        return {"deleted": rel_path}
