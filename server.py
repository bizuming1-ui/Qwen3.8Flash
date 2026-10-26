#!/usr/bin/env python3
"""Qwen3.8Flash 语音克隆 · Kaggle 模拟器服务器(零依赖, 纯 Python 标准库)。

运行:
    python3 server.py                 # 默认 http://0.0.0.0:8000
    python3 server.py --port 7860

在 Kaggle 里运行同样可行(Cell: `!python server.py --port 8000` 后用 Kaggle 的
代理/端口转发访问); 本地运行则是主要用法: 浏览器粘贴 Kaggle 代码 → 运行 →
真实保存到 notebooks/、kaggle/、experiments/ → 一键 git push 到 GitHub。
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from src import audio_sim, kaggle_compat as kc, kernel, store  # noqa: E402

ROOT = kc.PROJECT_ROOT
WEB = ROOT / "web"
MAX_BODY = 64 * 1024 * 1024  # 64MB(含 base64 膨胀)


def git(*args: str, timeout: int = 120) -> tuple[int, str]:
    p = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def git_status() -> dict:
    _, branch = git("branch", "--show-current")
    _, status = git("status", "--short")
    _, head = git("log", "-1", "--oneline")
    dirty = [ln for ln in status.splitlines() if ln.strip()]
    return {"branch": branch or "(detached)", "dirty_files": dirty, "dirty": bool(dirty), "head": head}


class Handler(BaseHTTPRequestHandler):
    server_version = "VoiceLab/1.0"

    # ---------- 工具 ----------
    def log_message(self, fmt, *args):  # 安静一点
        sys.stderr.write(f"[web] {self.address_string()} {fmt % args}\n")

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _err(self, msg: str, code: int = 400):
        self._json({"ok": False, "error": msg}, code)

    def _body_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("请求体过大")
        return json.loads(self.rfile.read(n) or b"{}")

    def _serve_file(self, path: Path):
        if not path.is_file():
            return self._err(f"文件不存在: {path.name}", 404)
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self._send(200, path.read_bytes(), ctype)

    # ---------- 路由 ----------
    def do_GET(self):  # noqa: N802
        try:
            self._get()
        except Exception as e:  # noqa: BLE001
            import traceback; traceback.print_exc()
            self._err(f"服务器错误: {e}", 500)

    def do_POST(self):  # noqa: N802
        try:
            self._post()
        except Exception as e:  # noqa: BLE001
            import traceback; traceback.print_exc()
            self._err(f"服务器错误: {e}", 500)

    def _get(self):
        u = urlparse(self.path)
        path, q = unquote(u.path), parse_qs(u.query)

        if path in ("/", "/index.html"):
            return self._serve_file(WEB / "index.html")
        if path.startswith("/web/"):
            f = (ROOT / path.lstrip("/")).resolve()
            if ROOT.resolve() in f.parents:
                return self._serve_file(f)
            return self._err("禁止访问", 403)

        if path == "/api/status":
            kc.ensure_dirs()
            return self._json({
                "ok": True,
                "python": sys.version.split()[0],
                "runtime": {"simulated_accelerator": "GPU T4 x2 (模拟标签) / 实际: 本地 CPU",
                            "cwd_virtual": "/kaggle/working",
                            "paths": {"input": str(kc.KAGGLE_INPUT), "working": str(kc.KAGGLE_WORKING),
                                      "notebooks": str(kc.NOTEBOOKS_DIR), "experiments": str(kc.EXPERIMENTS_DIR)}},
                "kernel_sessions": kernel.session_info(),
                "git": git_status(),
            })
        if path == "/api/notebooks":
            return self._json({"ok": True, "notebooks": store.list_notebooks()})
        if path.startswith("/api/notebooks/"):
            nb = store.load_notebook(path[len("/api/notebooks/"):])
            return self._json({"ok": True, "notebook": nb}) if nb else self._err("Notebook 不存在", 404)
        if path == "/api/files":
            return self._json({"ok": True, "files": store.list_kaggle_files()})
        if path == "/api/file":
            target = kc.kpath(q.get("path", [""])[0]).resolve()
            allowed = [kc.KAGGLE_DIR.resolve(), kc.NOTEBOOKS_DIR.resolve(), kc.EXPERIMENTS_DIR.resolve()]
            if any(a == target or a in target.parents for a in allowed):
                return self._serve_file(target)
            return self._err("只允许下载 kaggle/、notebooks/、experiments/ 内的文件", 403)
        if path == "/api/experiments":
            return self._json({"ok": True, "experiments": store.list_experiments()})
        if path == "/api/spectrogram":
            target = kc.kpath(q.get("path", [""])[0])
            samples, sr = audio_sim.read_wav(target)
            return self._send(200, audio_sim.spectrogram_png(samples, sr), "image/png")
        return self._err("未找到", 404)

    def _post(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        data = self._body_json() if int(self.headers.get("Content-Length") or 0) else {}

        if path == "/api/kernel/run":
            return self._json({"ok": True, **kernel.run_cell(data.get("code", ""), data.get("session", "default"))})
        if path == "/api/kernel/reset":
            kernel.reset_session(data.get("session", "default"))
            return self._json({"ok": True, "msg": "内核已重启, 变量清空"})
        if path == "/api/kernel/symlink":
            return self._json({"ok": True, "msg": kc.make_kaggle_symlink()})

        if path == "/api/notebooks/save":
            info = store.save_notebook(data.get("notebook") or data)
            return self._json({"ok": True, **info, "msg": f"已真实保存: notebooks/{info['name']}.ipynb + .py"})
        if path == "/api/notebooks/import":
            nb = store.import_any(data.get("text", ""), store.safe_name(data.get("name", "imported")))
            info = store.save_notebook(nb) if data.get("save", True) else {"name": nb["name"]}
            return self._json({"ok": True, **info, "notebook": nb,
                               "msg": f"已拆成 {len(nb['cells'])} 个单元格并保存到 notebooks/"})
        if path == "/api/notebooks/delete":
            return self._json({"ok": store.delete_notebook(data.get("name", ""))})

        if path == "/api/upload":
            name = store.safe_name(Path(data.get("filename", "file")).name)
            suffix = Path(data.get("filename", "")).suffix
            area = data.get("area", "input")
            base = {"input": kc.KAGGLE_INPUT, "working": kc.KAGGLE_WORKING}.get(area, kc.KAGGLE_INPUT)
            dest = base / f"{name}{suffix if not name.endswith(suffix) else ''}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(base64.b64decode(data.get("data_base64", "")))
            return self._json({"ok": True, "virtual_path": kc.to_virtual(dest), "real_path": str(dest),
                               "size": dest.stat().st_size})

        if path == "/api/synth":
            return self._json(self._synth(data))

        if path == "/api/git/commit":
            msg = (data.get("message") or "voice-lab: 保存模拟器工作").strip()
            git("add", "-A", "notebooks", "kaggle", "experiments", "src", "web", "server.py", "README.md",
                "requirements.txt", "requirements-kaggle.txt", "tests", ".gitignore")
            code, out = git("commit", "-m", msg)
            return self._json({"ok": code == 0 or "nothing to commit" in out, "output": out, "git": git_status()})
        if path == "/api/git/push":
            _, branch = git("branch", "--show-current")
            code, out = git("push", "origin", branch, timeout=300)
            return self._json({"ok": code == 0, "output": out, "branch": branch, "git": git_status()})
        return self._err("未找到", 404)

    def _synth(self, data: dict) -> dict:
        text = data.get("text", "").strip()
        params = {
            "language": data.get("language", "zh"),
            "speed": float(data.get("speed", 1.0)),
            "pitch_semitones": float(data.get("pitch_semitones", 0)),
            "temperature": float(data.get("temperature", 0.8)),
            "similarity": float(data.get("similarity", 0.85)),
            "ref_audio": data.get("ref_audio") or None,
            "ref_text": data.get("ref_text", ""),
            "engine": "simulator(dsp) — 真实模型接入点: src/audio_sim.synthesize_with_model()",
        }
        exp = store.new_experiment("voice_clone_sim", {"text": text, **params})
        exp_dir = Path(exp["dir"])
        ref_samples, ref_sr = None, audio_sim.SAMPLE_RATE
        if data.get("ref_data_base64"):
            ref_path = exp_dir / "reference.wav"
            ref_path.write_bytes(base64.b64decode(data["ref_data_base64"]))
            params["ref_audio"] = str(ref_path)
            ref_samples, ref_sr = audio_sim.read_wav(ref_path)
        elif params["ref_audio"]:
            rp = kc.kpath(params["ref_audio"])
            if rp.exists():
                shutil.copy2(rp, exp_dir / "reference.wav")
                ref_samples, ref_sr = audio_sim.read_wav(rp)
        out_wav = exp_dir / "cloned.wav"
        res = audio_sim.synthesize(text, out_wav, ref_samples=ref_samples, ref_sr=ref_sr,
                                   language=params["language"], speed=params["speed"],
                                   pitch_semitones=params["pitch_semitones"],
                                   temperature=params["temperature"], similarity=params["similarity"])
        (exp_dir / "spectrogram.png").write_bytes(
            audio_sim.spectrogram_png(*audio_sim.read_wav(out_wav)))
        metrics = audio_sim.simulator_metrics(text, params, ref_samples is not None)
        rec = store.finish_experiment(exp["id"], {
            "text": text, "audio": {"file": "cloned.wav", **res["stats"], "base_f0_hz": res["base_f0_hz"]},
            "reference": res["ref_stats"], "metrics": metrics, "params": params,
        })
        return {"ok": True, "experiment": rec,
                "audio_url": f"/api/file?path={out_wav}",
                "spectrogram_url": f"/api/spectrogram?path={out_wav}",
                "msg": f"合成完成并已保存实验 {exp['id']} 到 experiments/ (真实文件)"}


def main():
    ap = argparse.ArgumentParser(description="Qwen3.8Flash Voice Lab / Kaggle 模拟器")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    kc.ensure_dirs()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"🎙️ Qwen3.8Flash Voice Lab 已启动: http://{args.host}:{args.port}")
    print(f"   项目根目录: {ROOT}")
    print(f"   /kaggle/input   -> {kc.KAGGLE_INPUT}")
    print(f"   /kaggle/working -> {kc.KAGGLE_WORKING}")
    print("   Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n再见 👋")


if __name__ == "__main__":
    main()
