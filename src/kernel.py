"""极简 Jupyter/Kaggle 风格 Python 内核(纯标准库实现)。

能力:
  - 按会话保持变量命名空间(和 Notebook 一样, 上一个格子定义的变量下一个格子能用)
  - 捕获 print / stderr / 异常
  - 支持 `!shell 命令`(如 !pip install ..., !ls /kaggle/working)
  - 支持常见 %magic 的兼容 stub(%pip / %cd / %ls / %%writefile 等)
  - 相对路径默认落在 kaggle/working 里, 与真实 Kaggle 行为一致

注意: 这是本地开发模拟器, 不是沙箱。执行的代码拥有本进程同等权限,
请只运行你自己信任的代码(和你在 Kaggle 上运行自己代码一样)。
"""
from __future__ import annotations

import io
import os
import subprocess
import sys
import threading
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout

from . import kaggle_compat as kc

_LOCK = threading.Lock()
_SESSIONS: dict[str, dict] = {}


def _new_namespace() -> dict:
    kc.ensure_dirs()
    ns: dict = {"__name__": "__main__", "__builtins__": __builtins__}
    # 注入 Kaggle 兼容辅助, 让粘贴的代码开箱可用
    ns["kpath"] = kc.kpath
    ns["KAGGLE_INPUT"] = str(kc.KAGGLE_INPUT)
    ns["KAGGLE_WORKING"] = str(kc.KAGGLE_WORKING)
    ns["KAGGLE_OUTPUT"] = str(kc.KAGGLE_OUTPUT)
    ns["PROJECT_ROOT"] = str(kc.PROJECT_ROOT)
    return ns


def get_session(session_id: str) -> dict:
    with _LOCK:
        if session_id not in _SESSIONS:
            _SESSIONS[session_id] = {"ns": _new_namespace(), "count": 0, "created": time.time()}
        return _SESSIONS[session_id]


def reset_session(session_id: str) -> None:
    with _LOCK:
        _SESSIONS.pop(session_id, None)


def session_info() -> list[dict]:
    return [
        {"id": sid, "executions": s["count"], "uptime_sec": round(time.time() - s["created"], 1)}
        for sid, s in _SESSIONS.items()
    ]


def _run_shell(cmd: str, timeout: int = 600) -> tuple[str, str, int]:
    # 翻译 /kaggle/... 到真实路径, 让 !ls /kaggle/working 这类命令直接可用
    # 单趟最长优先替换: 真实路径本身含 kaggle 字样, 顺序 .replace() 会二次命中
    import re as _re
    mapping = {p: str(r) for p, r in kc._PREFIXES}  # noqa: SLF001 - 本包内部复用
    translated = _re.sub(r"/kaggle(?:/input|/working|/output)?(?=/|\s|$|['\";,])",
                         lambda m: mapping[m.group(0)], cmd)
    env = dict(os.environ)
    env["KAGGLE_KERNEL_RUN_TYPE"] = "Interactive"
    env.setdefault("PYTHONUNBUFFERED", "1")
    try:
        p = subprocess.run(
            translated, shell=True, cwd=str(kc.KAGGLE_WORKING), env=env,
            capture_output=True, text=True, timeout=timeout,
        )
        return p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        return (e.stdout or b"").decode(errors="replace"), f"[超时 {timeout}s, 命令已终止]", 124


def _handle_magic(line: str, ns: dict) -> str | None:
    """处理 % 开头的行; 返回输出文本。未识别的 magic 给出兼容提示而非报错。"""
    body = line[1:].strip()
    name, _, rest = body.partition(" ")
    name = name.lower()
    if name == "pip":
        out, err, code = _run_shell(f"{sys.executable} -m pip {rest}")
        return out + err + ("" if code == 0 else f"\n[pip 退出码 {code}]")
    if name == "cd":
        target = str(kc.kpath(rest.strip() or "/kaggle/working"))
        try:
            os.chdir(target)
            return os.getcwd()
        except OSError as e:
            return f"[cd 失败] {e}"
    if name in ("ls", "lsmagic", "pwd"):
        if name == "pwd":
            return os.getcwd()
        out, err, _ = _run_shell(f"ls {rest}".strip())
        return out + err
    if name in ("time", "timeit"):
        return None  # 交回普通执行(去掉 magic 前缀由调用方处理) -> 这里直接执行 rest
    return f"[模拟器] magic %{name} 在 Kaggle 模拟器中暂以兼容模式跳过(真实 Kaggle 上可正常执行)"


def run_cell(code: str, session_id: str = "default") -> dict:
    """执行一个单元格, 返回 {ok, execution_count, duration_ms, outputs:[{kind,text}]}"""
    sess = get_session(session_id)
    sess["count"] += 1
    count = sess["count"]
    ns = sess["ns"]
    outputs: list[dict] = []
    ok = True
    t0 = time.time()

    # %%writefile 整个格子的兼容处理
    stripped = code.lstrip()
    if stripped.startswith("%%writefile"):
        first, _, rest = stripped.partition("\n")
        fname = first.split(None, 1)[1].strip() if len(first.split(None, 1)) > 1 else "out.txt"
        path = kc.kpath(fname)
        if not path.is_absolute():
            path = kc.KAGGLE_WORKING / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rest, encoding="utf-8")
        outputs.append({"kind": "stdout", "text": f"Writing {path} ({len(rest)} bytes)"})
        return {"ok": True, "execution_count": count, "duration_ms": 1, "outputs": outputs}

    py_buf: list[str] = []

    def flush_py():
        nonlocal ok
        if not py_buf:
            return
        src = "\n".join(py_buf)
        py_buf.clear()
        out_io, err_io = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(out_io), redirect_stderr(err_io):
                exec(compile(src, f"<cell-{count}>", "exec"), ns)  # noqa: S102 - 本地内核按设计执行用户代码
        except BaseException:  # noqa: BLE001 - 内核需要捕获一切并回显
            ok = False
            outputs.append({"kind": "error", "text": traceback.format_exc()})
        if out_io.getvalue():
            outputs.append({"kind": "stdout", "text": out_io.getvalue()})
        if err_io.getvalue():
            outputs.append({"kind": "stderr", "text": err_io.getvalue()})

    prev_cwd = os.getcwd()
    try:
        os.chdir(kc.KAGGLE_WORKING)  # 与 Kaggle 一致: 默认 cwd = /kaggle/working
        sys.path.insert(0, str(kc.PROJECT_ROOT)) if str(kc.PROJECT_ROOT) not in sys.path else None
        for raw in code.splitlines():
            line = raw.strip()
            if line.startswith("!") and not line.startswith("!="):
                flush_py()
                out, err, rc = _run_shell(line[1:].strip())
                if out:
                    outputs.append({"kind": "stdout", "text": out})
                if err:
                    outputs.append({"kind": "stderr", "text": err})
                if rc != 0:
                    outputs.append({"kind": "stderr", "text": f"[命令退出码 {rc}]"})
            elif line.startswith("%") and not line.startswith("%%"):
                flush_py()
                res = _handle_magic(line, ns)
                if res is None:  # %time 之类: 直接执行余下部分
                    py_buf.append(line.split(" ", 1)[1] if " " in line else "")
                    flush_py()
                elif res:
                    outputs.append({"kind": "stdout", "text": res})
            else:
                py_buf.append(raw)
        flush_py()
    finally:
        try:
            os.chdir(prev_cwd)
        except OSError:
            pass

    return {
        "ok": ok,
        "execution_count": count,
        "duration_ms": round((time.time() - t0) * 1000),
        "outputs": outputs,
    }
