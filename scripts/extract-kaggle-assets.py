#!/usr/bin/env python3
"""Reproducibly unpack the one-cell Kaggle candidate into REAL project files.

Reads the notebook the user pasted (kaggle_workspace/notebooks/kaggle.ipynb,
falling back to the .py export), parses the embedded ``FILES`` literal with
``ast.literal_eval`` (NO code execution), verifies every SHA-256 + byte length,
then writes:

  replica/source/<70 assets>     - the complete original source tree (Go/Python/Rust/web/tools)
  replica/web/<4 files>          - the exact, byte-identical website assets
  replica/asset-manifest.json    - name / bytes / sha256 / verified record

This is what makes the browser replica *precise*: the site served at /site/ is
literally the same bytes that the Kaggle cell would have written to /kaggle/working.
"""
from __future__ import annotations

import ast
import base64
import hashlib
import json
import shutil
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WS = ROOT / "kaggle_workspace"
NOTEBOOK = WS / "notebooks" / "kaggle.ipynb"
PYEXPORT = WS / "notebooks" / "kaggle.py"
OUT = ROOT / "replica"
SOURCE = OUT / "source"
WEB = OUT / "web"
WEB_FILES = ("index.html", "app.js", "recorder.js", "diagnostic-trace.js")


def notebook_source() -> str:
    if NOTEBOOK.is_file():
        nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
        chunks = []
        for cell in nb.get("cells", []):
            if cell.get("cell_type") != "code":
                continue
            src = cell.get("source", "")
            chunks.append("".join(src) if isinstance(src, list) else str(src))
        text = "\n".join(chunks)
        if text.strip():
            return text
    if PYEXPORT.is_file():
        return PYEXPORT.read_text(encoding="utf-8")
    raise SystemExit("ERROR: neither kaggle.ipynb nor kaggle.py found")


def extract_files(src: str) -> dict:
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "FILES" for t in node.targets
        ):
            return ast.literal_eval(node.value)
    raise SystemExit("ERROR: FILES literal not found in notebook source")


def main() -> int:
    files = extract_files(notebook_source())
    if not isinstance(files, dict) or not (0 < len(files) <= 256):
        raise SystemExit("ERROR: unexpected FILES shape")
    if SOURCE.exists():
        shutil.rmtree(SOURCE)
    SOURCE.mkdir(parents=True)
    WEB.mkdir(parents=True, exist_ok=True)

    manifest = {"source": "kaggle_workspace/notebooks/kaggle.ipynb", "assets": [], "verified": 0}
    for name, entry in sorted(files.items()):
        raw = zlib.decompress(base64.b64decode(entry["data"], validate=True))
        digest = hashlib.sha256(raw).hexdigest()
        ok = len(raw) == entry["bytes"] and digest == entry["sha256"]
        if not ok:
            raise SystemExit(f"ERROR: checksum mismatch for {name}")
        safe = Path(name)
        if safe.is_absolute() or ".." in safe.parts:
            raise SystemExit(f"ERROR: unsafe asset name {name}")
        dest = SOURCE / safe
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        manifest["assets"].append({
            "path": name, "bytes": len(raw), "sha256": digest,
            "verified": True, "group": name.split("/")[0],
        })
        manifest["verified"] += 1

    for filename in WEB_FILES:
        origin = SOURCE / "web" / filename
        if not origin.is_file():
            raise SystemExit(f"ERROR: missing web asset {filename}")
        shutil.copyfile(origin, WEB / filename)

    manifest["total_bytes"] = sum(a["bytes"] for a in manifest["assets"])
    manifest["web"] = [{"file": f, "bytes": (WEB / f).stat().st_size,
                        "sha256": hashlib.sha256((WEB / f).read_bytes()).hexdigest()}
                       for f in WEB_FILES]
    (OUT / "asset-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"verified {manifest['verified']} assets / {manifest['total_bytes']} bytes")
    print(f"copied {len(WEB_FILES)} byte-identical website assets -> replica/web/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
