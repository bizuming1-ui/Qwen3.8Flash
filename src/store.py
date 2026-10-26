"""Notebook / 实验记录的真实落盘层。

原则: 一切保存都写进项目目录的真实文件(notebooks/*.ipynb + *.py 双格式,
experiments/<id>/config.json + 音频), 之后 `git commit` 就能进 GitHub,
不依赖任何浏览器缓存或 Kaggle 临时盘。
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from . import kaggle_compat as kc


def safe_name(name: str, default: str = "untitled") -> str:
    name = re.sub(r"[^\w\- ]", "_", (name or "").strip()).strip().replace(" ", "_")
    return name or default


# ---------------- Notebook ----------------

def notebook_to_ipynb(nb: dict) -> dict:
    cells = []
    for c in nb.get("cells", []):
        src = c.get("source", "")
        lines = src.splitlines(keepends=True)
        cell: dict = {"cell_type": c.get("cell_type", "code"), "metadata": {}, "source": lines}
        if cell["cell_type"] == "code":
            cell["execution_count"] = c.get("execution_count")
            cell["outputs"] = [
                {"output_type": "stream", "name": "stderr" if o.get("kind") != "stdout" else "stdout",
                 "text": o.get("text", "")}
                for o in c.get("outputs", [])
            ]
        cells.append(cell)
    return {
        "cells": cells, "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                     "language_info": {"name": "python"}},
    }


def ipynb_to_notebook(data: dict, name: str) -> dict:
    cells = []
    for c in data.get("cells", []):
        src = c.get("source", "")
        if isinstance(src, list):
            src = "".join(src)
        outs = []
        for o in c.get("outputs", []):
            if o.get("output_type") == "stream":
                text = o.get("text", "")
                outs.append({"kind": o.get("name", "stdout"), "text": "".join(text) if isinstance(text, list) else text})
            elif o.get("output_type") == "error":
                outs.append({"kind": "error", "text": "\n".join(o.get("traceback", []))})
        cells.append({"cell_type": c.get("cell_type", "code"), "source": src,
                      "execution_count": c.get("execution_count"), "outputs": outs})
    return {"name": name, "cells": cells}


def notebook_to_py(nb: dict) -> str:
    parts = [f"# {nb.get('name', 'notebook')}  (由 Qwen3.8Flash Kaggle 模拟器导出)",
             "# 在 VS Code / Jupyter 中以 # %% 分格运行; 在 Kaggle 里逐格粘贴即可。", ""]
    for i, c in enumerate(nb.get("cells", []), 1):
        if c.get("cell_type") == "markdown":
            parts.append(f"# %% [markdown] cell {i}")
            parts += ["# " + ln if ln else "#" for ln in c.get("source", "").splitlines()]
        else:
            parts.append(f"# %% cell {i}")
            parts.append(c.get("source", ""))
        parts.append("")
    return "\n".join(parts)


def py_to_notebook(text: str, name: str) -> dict:
    """把粘贴的 .py 代码拆成单元格: 优先按 # %% 分; 没有则按顶格语句块粗拆。"""
    if "# %%" in text:
        # 保留分隔标记, 识别 [markdown] 格并去注释前缀(与导出格式互逆)
        parts = re.split(r"^(# %%.*)$", text, flags=re.M)
        cells = []
        cur_md = False
        pending = parts[0].strip("\n") if parts else ""
        # 分隔标记前的大多是导出头注释; 仅当不是本系统导出头时才保留为首格
        if pending.strip() and "(由 Qwen3.8Flash Kaggle 模拟器导出)" not in pending:
            cells.append({"cell_type": "code", "source": pending, "execution_count": None, "outputs": []})
        for marker, body in zip(parts[1::2], parts[2::2]):
            cur_md = "[markdown]" in marker
            src = body.strip("\n")
            if not src.strip():
                continue
            if cur_md:
                src = "\n".join(ln[2:] if ln.startswith("# ") else (ln[1:] if ln.startswith("#") else ln)
                                  for ln in src.splitlines())
            cells.append({"cell_type": "markdown" if cur_md else "code", "source": src,
                          "execution_count": None, "outputs": []})
        return {"name": name, "cells": cells or [{"cell_type": "code", "source": text, "execution_count": None, "outputs": []}]}
    else:
        # 按空行+下一行顶格非空粗拆, 每块上限 ~40 行, 保证类/函数定义不被从内部切开
        lines = text.splitlines()
        chunks, cur, in_block = [], [], False
        for ln in lines:
            if not ln.strip():
                if cur and not in_block and len(cur) >= 3:
                    chunks.append("\n".join(cur)); cur = []
                elif cur:
                    cur.append(ln)
                continue
            in_block = bool(ln[:1].isspace()) or bool(re.match(r"(def|class|@)", ln))
            if re.match(r"(def|class)\s", ln):
                in_block = True
            cur.append(ln)
            if len(cur) >= 40 and not ln[:1].isspace():
                chunks.append("\n".join(cur)); cur = []
        if cur:
            chunks.append("\n".join(cur))
        md = [c for c in chunks if c.strip().startswith("#") and not re.search(r"^(import|from|!|%)", c.strip()[1:].strip() + "\n")]
        _ = md
    cells = [{"cell_type": "code", "source": c, "execution_count": None, "outputs": []} for c in chunks if c.strip()]
    return {"name": name, "cells": cells or [{"cell_type": "code", "source": text, "execution_count": None, "outputs": []}]}


def import_any(text: str, name: str) -> dict:
    text = text.lstrip("﻿")
    if text.lstrip().startswith("{"):
        try:
            return ipynb_to_notebook(json.loads(text), name)
        except (json.JSONDecodeError, KeyError):
            pass
    return py_to_notebook(text, name)


def save_notebook(nb: dict) -> dict:
    kc.ensure_dirs()
    name = safe_name(nb.get("name", "untitled"))
    nb["name"] = name
    ipynb_path = kc.NOTEBOOKS_DIR / f"{name}.ipynb"
    py_path = kc.NOTEBOOKS_DIR / f"{name}.py"
    ipynb_path.write_text(json.dumps(notebook_to_ipynb(nb), ensure_ascii=False, indent=1), encoding="utf-8")
    py_path.write_text(notebook_to_py(nb), encoding="utf-8")
    return {"name": name, "ipynb": str(ipynb_path), "py": str(py_path),
            "cells": len(nb.get("cells", [])), "saved_at": time.strftime("%Y-%m-%d %H:%M:%S")}


def load_notebook(name: str) -> dict | None:
    name = safe_name(name)
    p = kc.NOTEBOOKS_DIR / f"{name}.ipynb"
    if p.exists():
        return ipynb_to_notebook(json.loads(p.read_text(encoding="utf-8")), name)
    py = kc.NOTEBOOKS_DIR / f"{name}.py"
    if py.exists():
        return py_to_notebook(py.read_text(encoding="utf-8"), name)
    return None


def list_notebooks() -> list[dict]:
    kc.ensure_dirs()
    out = []
    stems = sorted({p.stem for p in list(kc.NOTEBOOKS_DIR.glob("*.ipynb")) + list(kc.NOTEBOOKS_DIR.glob("*.py"))})
    for s in stems:
        f = kc.NOTEBOOKS_DIR / f"{s}.ipynb"
        f = f if f.exists() else kc.NOTEBOOKS_DIR / f"{s}.py"
        out.append({"name": s, "size": f.stat().st_size, "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime))})
    return out


def delete_notebook(name: str) -> bool:
    name = safe_name(name)
    hit = False
    for ext in (".ipynb", ".py"):
        p = kc.NOTEBOOKS_DIR / f"{name}{ext}"
        if p.exists():
            p.unlink(); hit = True
    return hit


# ---------------- 实验记录 ----------------

def new_experiment(kind: str, config: dict) -> dict:
    kc.ensure_dirs()
    exp_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    d = kc.EXPERIMENTS_DIR / exp_id
    d.mkdir(parents=True, exist_ok=True)
    rec = {"id": exp_id, "kind": kind, "created_at": time.strftime("%Y-%m-%d %H:%M:%S"), "config": config}
    (d / "config.json").write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    rec["dir"] = str(d)
    return rec


def finish_experiment(exp_id: str, result: dict) -> dict:
    d = kc.EXPERIMENTS_DIR / exp_id
    p = d / "config.json"
    rec = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"id": exp_id}
    rec.update(result)
    rec["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    p.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    return rec


def list_experiments() -> list[dict]:
    kc.ensure_dirs()
    out = []
    for d in sorted(kc.EXPERIMENTS_DIR.iterdir(), reverse=True):
        p = d / "config.json"
        if d.is_dir() and p.exists():
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
                rec["files"] = sorted(x.name for x in d.iterdir() if x.is_file())
                out.append(rec)
            except json.JSONDecodeError:
                continue
    return out


def list_kaggle_files() -> dict:
    kc.ensure_dirs()
    def walk(base: Path) -> list[dict]:
        items = []
        for p in sorted(base.rglob("*")):
            if p.is_file() and p.name != ".gitkeep":
                items.append({"path": kc.to_virtual(p), "name": p.name,
                              "size": p.stat().st_size, "real": str(p.relative_to(kc.PROJECT_ROOT))})
        return items
    return {"input": walk(kc.KAGGLE_INPUT), "working": walk(kc.KAGGLE_WORKING), "output": walk(kc.KAGGLE_OUTPUT)}
