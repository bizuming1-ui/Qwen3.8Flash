"""
Parser & Bidirectional Converter for Kaggle Code, IPython Magics, .ipynb, and Clean Python Modules.
"""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook


CELL_SPLIT_RE = re.compile(r"^\s*#\s*(?:%%|In\[\d*\]\s*:|<codecell>)(.*)$")
WRITEFILE_RE = re.compile(r"^\s*%%writefile\s+(-a\s+)?(\S+)\s*$")


@dataclass
class KaggleCell:
    id: str
    cell_type: str  # "code" | "markdown"
    source: str
    title: str = ""
    outputs: List[Dict[str, Any]] = field(default_factory=list)
    execution_count: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ExtractedWriteFile:
    raw_target: str
    project_rel_path: str
    content: str
    append: bool = False


def parse_kaggle_paste(raw_text: str, auto_split_sections: bool = True) -> List[KaggleCell]:
    """
    Parses any pasted Kaggle content into structured KaggleCell objects:
    - Full `.ipynb` JSON string
    - `# %%` / `# In[1]:` cell-delimited Python script
    - Raw Python / Kaggle Notebook code (optionally split on `%%writefile` or `# %%`)
    """
    stripped = raw_text.strip()
    if not stripped:
        return [KaggleCell(id="cell-1", cell_type="code", source="", title="Cell 1")]

    # Case 1: Pasted raw .ipynb JSON
    if stripped.startswith("{") and '"cells"' in stripped and '"nbformat"' in stripped:
        try:
            return ipynb_json_to_cells(stripped)
        except Exception:
            pass

    lines = raw_text.splitlines()
    has_explicit_markers = any(CELL_SPLIT_RE.match(line) for line in lines)

    if has_explicit_markers:
        cells: List[KaggleCell] = []
        current_lines: List[str] = []
        current_type = "code"
        current_title = ""

        def flush_cell() -> None:
            nonlocal current_lines, current_type, current_title
            body = "\n".join(current_lines).strip("\n")
            if body or cells:
                if current_type == "markdown":
                    md_lines = []
                    for ln in body.splitlines():
                        if ln.startswith("# "):
                            md_lines.append(ln[2:])
                        elif ln == "#":
                            md_lines.append("")
                        else:
                            md_lines.append(ln)
                    body = "\n".join(md_lines)
                idx = len(cells) + 1
                cells.append(
                    KaggleCell(
                        id=f"cell-{idx}",
                        cell_type=current_type,
                        source=update_restored_magics(body),
                        title=current_title or f"Cell {idx}",
                    )
                )
            current_lines = []
            current_type = "code"
            current_title = ""

        for line in lines:
            m = CELL_SPLIT_RE.match(line)
            if m:
                if current_lines:
                    flush_cell()
                rest = m.group(1).strip()
                if "[markdown]" in rest.lower() or "[md]" in rest.lower():
                    current_type = "markdown"
                    current_title = re.sub(r"\[(?:markdown|md)\]", "", rest, flags=re.I).strip()
                else:
                    current_type = "code"
                    current_title = rest
            else:
                # Skip auto-generated module header lines when round-tripping
                if line.startswith("# [KAGGLE_STUDIO_HEADER]"):
                    continue
                current_lines.append(line)

        if current_lines or not cells:
            flush_cell()

        # Filter out preamble helper cell if round-tripping from generated .py
        filtered = [c for c in cells if "[KAGGLE_STUDIO_RUNTIME_BOOTSTRAP]" not in c.source]
        return filtered or [KaggleCell(id="cell-1", cell_type="code", source=raw_text, title="Kaggle Main")]

    # Case 2: Monolithic pasted Kaggle code — split cleanly on %%writefile if present
    if auto_split_sections and any(WRITEFILE_RE.match(ln) for ln in lines):
        blocks: List[Tuple[str, List[str]]] = []
        buf: List[str] = []
        buf_title = "Kaggle Code"
        for ln in lines:
            wm = WRITEFILE_RE.match(ln)
            if wm:
                if any(x.strip() for x in buf):
                    blocks.append((buf_title, buf))
                buf = [ln]
                buf_title = f"WriteFile: {wm.group(2)}"
            else:
                buf.append(ln)
        if any(x.strip() for x in buf):
            blocks.append((buf_title, buf))
        return [
            KaggleCell(
                id=f"cell-{i + 1}",
                cell_type="code",
                source=update_restored_magics("\n".join(b_lines).strip("\n")),
                title=title,
            )
            for i, (title, b_lines) in enumerate(blocks)
        ]

    return [
        KaggleCell(
            id="cell-1",
            cell_type="code",
            source=update_restored_magics(raw_text.strip("\n")),
            title="Kaggle Voice Cloning Code",
        )
    ]


def update_restored_magics(source: str) -> str:
    """Restores wrapped `_kaggle_magic('!...')` lines back to native Kaggle `!` / `%` lines."""
    restored_lines: List[str] = []
    for line in source.splitlines():
        marker = "# [KAGGLE_MAGIC_RAW] "
        if marker in line:
            raw_magic = line.split(marker, 1)[1]
            indent = line[: len(line) - len(line.lstrip())]
            restored_lines.append(f"{indent}{raw_magic}")
        else:
            restored_lines.append(line)
    return "\n".join(restored_lines)


def extract_writefiles(
    cells: List[KaggleCell], default_pkg_dir: str = "src/voice_cloning"
) -> List[ExtractedWriteFile]:
    """
    Finds any `%%writefile` cells in pasted Kaggle code and maps them to real project paths
    so modules defined inside Kaggle notebooks are persisted directly in the repository.
    """
    extracted: List[ExtractedWriteFile] = []
    for cell in cells:
        if cell.cell_type != "code":
            continue
        lines = cell.source.splitlines()
        if not lines:
            continue
        first_non_empty = next((i for i, ln in enumerate(lines) if ln.strip()), None)
        if first_non_empty is None:
            continue
        m = WRITEFILE_RE.match(lines[first_non_empty])
        if not m:
            continue
        append = bool(m.group(1))
        raw_target = m.group(2).strip()
        content = "\n".join(lines[first_non_empty + 1 :]) + "\n"

        # Normalize `/kaggle/working/...` or bare filenames into real project path
        clean = raw_target
        for prefix in ("/kaggle/working/", "kaggle_workspace/working/", "./"):
            if clean.startswith(prefix):
                clean = clean[len(prefix) :]
                break
        clean = clean.lstrip("/")
        if "/" not in clean and clean.endswith(".py"):
            proj_rel = f"{default_pkg_dir.rstrip('/')}/{clean}"
        elif clean.startswith("kaggle/"):
            proj_rel = f"{default_pkg_dir.rstrip('/')}/{Path(clean).name}"
        else:
            proj_rel = clean

        extracted.append(
            ExtractedWriteFile(
                raw_target=raw_target,
                project_rel_path=proj_rel,
                content=content,
                append=append,
            )
        )
    return extracted


def detect_kaggle_references(source_text: str) -> Dict[str, List[str]]:
    """Scans code for `/kaggle/input/...`, `/kaggle/working/...`, `!pip`, GPU usage, etc."""
    inputs = sorted(set(re.findall(r"/kaggle/input/[A-Za-z0-9_.\-/]+", source_text)))
    workings = sorted(set(re.findall(r"/kaggle/working/[A-Za-z0-9_.\-/]*", source_text)))
    pip_pkgs: List[str] = []
    for ln in source_text.splitlines():
        s = ln.strip()
        if s.startswith("!pip ") or s.startswith("%pip "):
            pip_pkgs.append(s)
    uses_cuda = bool(re.search(r"\b(cuda|torch\.cuda|autocast|GradScaler|nvidia-smi)\b", source_text))
    uses_secrets = "kaggle_secrets" in source_text
    return {
        "input_paths": inputs,
        "working_paths": workings,
        "pip_commands": pip_pkgs,
        "uses_cuda": [str(uses_cuda)],
        "uses_secrets": [str(uses_secrets)],
    }


def cells_to_ipynb(cells: List[KaggleCell], accelerator: str = "T4x2") -> str:
    """Serializes KaggleCells into a Kaggle-compatible Jupyter Notebook (.ipynb v4) JSON string."""
    nb = new_notebook()
    nb.metadata["kernelspec"] = {
        "display_name": "Python 3 (Kaggle Voice Cloning Simulator)",
        "language": "python",
        "name": "python3",
    }
    nb.metadata["kaggle"] = {
        "accelerator": "nvidiaTeslaT4" if accelerator == "T4x2" else accelerator,
        "isGpuEnabled": accelerator != "CPU",
        "isInternetEnabled": True,
        "language": "python",
        "sourceType": "notebook",
    }

    for cell in cells:
        if cell.cell_type == "markdown":
            nb_cell = new_markdown_cell(source=cell.source)
        else:
            nb_cell = new_code_cell(source=cell.source)
            if cell.execution_count is not None:
                nb_cell.execution_count = cell.execution_count
        if cell.title:
            nb_cell.metadata["title"] = cell.title
        nb.cells.append(nb_cell)

    return nbformat.writes(nb)


def ipynb_json_to_cells(ipynb_json: str) -> List[KaggleCell]:
    nb = nbformat.reads(ipynb_json, as_version=4)
    cells: List[KaggleCell] = []
    for idx, c in enumerate(nb.cells):
        title = c.metadata.get("title", f"Cell {idx + 1}")
        cells.append(
            KaggleCell(
                id=f"cell-{idx + 1}",
                cell_type=c.cell_type if c.cell_type in ("code", "markdown") else "code",
                source=str(c.source),
                title=title,
                execution_count=c.get("execution_count"),
            )
        )
    return cells or [KaggleCell(id="cell-1", cell_type="code", source="", title="Cell 1")]


def ipynb_to_cells(path: Path) -> List[KaggleCell]:
    return ipynb_json_to_cells(path.read_text(encoding="utf-8"))


def transform_cell_magics_to_valid_python(source: str) -> str:
    """
    Transforms IPython `!shell`, `%magic`, and `%%writefile` lines into 100% valid Python
    with lossless `# [KAGGLE_MAGIC_RAW]` markers so `src/voice_cloning/*.py` is directly
    importable and runnable via standard `python3` without SyntaxError.
    """
    lines = source.splitlines()
    if not lines:
        return ""

    first_non_empty = next((i for i, ln in enumerate(lines) if ln.strip()), None)
    if first_non_empty is not None:
        wm = WRITEFILE_RE.match(lines[first_non_empty])
        if wm:
            append = bool(wm.group(1))
            target = wm.group(2).strip()
            body = "\n".join(lines[first_non_empty + 1 :])
            header_raw = lines[first_non_empty].strip()
            return (
                f"_kaggle_writefile({target!r}, {body!r}, append={append})  "
                f"# [KAGGLE_MAGIC_RAW] {header_raw}\n"
            )

    out_lines: List[str] = []
    for ln in lines:
        stripped = ln.lstrip()
        indent = ln[: len(ln) - len(stripped)]
        if stripped.startswith("!") and not stripped.startswith("!="):
            out_lines.append(f"{indent}_kaggle_magic({stripped!r})  # [KAGGLE_MAGIC_RAW] {stripped}")
        elif stripped.startswith("%") and not stripped.startswith("%="):
            # Guard against modulo operator continuation on multiline expressions (rare at line start, check word)
            if re.match(r"^%%?[A-Za-z_]", stripped):
                out_lines.append(f"{indent}_kaggle_magic({stripped!r})  # [KAGGLE_MAGIC_RAW] {stripped}")
            else:
                out_lines.append(ln)
        else:
            out_lines.append(ln)
    return "\n".join(out_lines)


def cells_to_python_module(cells: List[KaggleCell]) -> str:
    """
    Converts KaggleCells into a clean, runnable, Git-friendly `.py` file inside the project (`src/`).
    """
    parts: List[str] = [
        "# %% [KAGGLE_STUDIO_RUNTIME_BOOTSTRAP]",
        '"""Auto-synced Kaggle Voice Cloning Project Script (Real Project Persistence)."""',
        "from simulators.kaggle_sim.executor import run_magic_inline as _kaggle_magic, writefile_inline as _kaggle_writefile",
        "",
    ]

    for idx, cell in enumerate(cells):
        title = cell.title or f"Cell {idx + 1}"
        if cell.cell_type == "markdown":
            parts.append(f"# %% [markdown] {title}")
            for ln in cell.source.splitlines() or [""]:
                parts.append(f"# {ln}" if ln else "#")
            parts.append("")
        else:
            parts.append(f"# %% {title}")
            parts.append(transform_cell_magics_to_valid_python(cell.source))
            parts.append("")

    return "\n".join(parts).rstrip() + "\n"


def split_shell_args(cmd: str) -> List[str]:
    try:
        return shlex.split(cmd)
    except ValueError:
        return cmd.split()
