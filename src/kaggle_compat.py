"""Kaggle 兼容的路径层。

在真实 Kaggle 里代码默认使用:
  - /kaggle/input/<dataset>/...   (只读输入)
  - /kaggle/working/              (可写工作区)
  - /kaggle/output 已废弃, 这里仅作兼容

在本模拟器里, 它们真实映射到项目内目录:
  <project>/kaggle/input, <project>/kaggle/working, <project>/kaggle/output

你从 Kaggle 复制的代码如果写死了 /kaggle/working/xxx.wav,
用 kpath('/kaggle/working/xxx.wav') 即可得到本机真实路径;
或者运行 `make_kaggle_symlink()` 尝试创建 /kaggle 软链(需要权限)。
"""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
KAGGLE_DIR = PROJECT_ROOT / "kaggle"
KAGGLE_INPUT = KAGGLE_DIR / "input"
KAGGLE_WORKING = KAGGLE_DIR / "working"
KAGGLE_OUTPUT = KAGGLE_DIR / "output"
NOTEBOOKS_DIR = PROJECT_ROOT / "notebooks"
EXPERIMENTS_DIR = PROJECT_ROOT / "experiments"

_PREFIXES = (
    ("/kaggle/input", KAGGLE_INPUT),
    ("/kaggle/working", KAGGLE_WORKING),
    ("/kaggle/output", KAGGLE_OUTPUT),
    ("/kaggle", KAGGLE_DIR),
)


def ensure_dirs() -> None:
    for d in (KAGGLE_INPUT, KAGGLE_WORKING, KAGGLE_OUTPUT, NOTEBOOKS_DIR, EXPERIMENTS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def kpath(p: str | os.PathLike) -> Path:
    """把 /kaggle/... 风格的虚拟路径翻译成项目内真实路径; 其它路径原样返回。"""
    s = str(p).replace("\\", "/")
    for prefix, real in _PREFIXES:
        if s == prefix:
            return real
        if s.startswith(prefix + "/"):
            return real / s[len(prefix) + 1:]
    return Path(p)


def to_virtual(p: str | os.PathLike) -> str:
    """把项目内真实路径翻译回 /kaggle/... 虚拟路径(供 UI 展示)。"""
    real = Path(p).resolve()
    for prefix, base in _PREFIXES:
        try:
            rel = real.relative_to(base.resolve())
        except ValueError:
            continue
        return prefix + ("/" + str(rel) if str(rel) != "." else "")
    return str(p)


def make_kaggle_symlink() -> str:
    """尽量创建 /kaggle -> <project>/kaggle 软链, 让写死路径的 Kaggle 代码零改动运行。"""
    target = Path("/kaggle")
    try:
        if target.is_symlink() or target.exists():
            return f"/kaggle 已存在 -> {os.readlink(target) if target.is_symlink() else 'real dir'}"
        target.symlink_to(KAGGLE_DIR, target_is_directory=True)
        return f"已创建 /kaggle -> {KAGGLE_DIR}"
    except OSError as e:
        return f"无法创建 /kaggle 软链({e}); 请改用 kpath() 翻译路径, 功能完全相同。"
