#!/usr/bin/env python3
"""One-click bootstrap for Kaggle (Accelerator: GPU T4 x2, Internet: On).

  1 detect GPUs           2 pip deps            3 model pre-download (background)
  4 Go gateway build      5 Rust runtime build  6 restore state (Dataset)
  7 start supervisor      8 wait for both GPUs  9 public tunnel

Every step is timed. Re-run only after explicitly stopping existing services;
never kill a process based on a stale PID marker or a broad name match.
"""
from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ["QTTS_ROOT"] = str(ROOT)
STATE = Path(os.environ.setdefault("QTTS_STATE", str(ROOT / "state")))
TOOLS = ROOT / "tools_bin"
LOGS = STATE / "logs"
for d in (STATE, TOOLS, LOGS):
    d.mkdir(parents=True, exist_ok=True)
GATEWAY_PORT = int(os.environ.get("QTTS_GATEWAY_PORT", "7860"))
MODEL = os.environ.get("QTTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
T0 = time.time()
TIMES: dict[str, float] = {}
STARTUP_ID=uuid.uuid4().hex

sys.path.insert(0,str(ROOT / "py"))
from qtts_common import extract_tar_safely,read_json
from access_control import ensure_access_token, gateway_headers, auth_directory
from gpu_ownership import status as ownership_status
from resource_limits import UploadRejected
from qwen_compat import PINS,installed_version
sys.path.insert(0,str(ROOT / "tools"))
from backend_probe import collect as collect_probe, add as add_probe, finalize as finalize_probe, write_report as write_probe_report


def step(name: str):
    class _S:
        def __enter__(self_):
            self_.t = time.time()
            print(f"\n━━ [{time.time() - T0:6.1f}s] {name}", flush=True)

        def __exit__(self_, *a):
            TIMES[name] = time.time() - self_.t
            print(f"   ↳ {name}: {TIMES[name]:.1f}s", flush=True)
    return _S()


def sh(cmd, check=True, env=None, cwd=None, quiet=False, timeout=None) -> int:
    e = {**os.environ, **(env or {})}
    p = subprocess.Popen(cmd, env=e, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1, start_new_session=True)
    tail: list[str] = []
    timed_out = threading.Event()
    def expire():
        if p.poll() is None:
            timed_out.set()
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    timer = threading.Timer(timeout, expire) if timeout else None
    if timer:
        timer.daemon = True
        timer.start()
    try:
        assert p.stdout
        for line in p.stdout:
            tail.append(line)
            tail = tail[-40:]
            if not quiet:
                print("   " + line.rstrip()[:200], flush=True)
        rc = p.wait()
    finally:
        if timer:
            timer.cancel()
        p.stdout.close()
    if timed_out.is_set():
        raise TimeoutError(f"command exceeded {timeout}s: {str(cmd[0])}")
    if rc != 0 and check:
        print("".join(tail))
        raise RuntimeError(f"command failed ({rc}): {' '.join(map(str, cmd))[:160]}")
    return rc


def detect_gpus() -> int:
    try:
        out = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True, timeout=20).stdout
    except Exception:  # noqa: BLE001
        out = ""
    gpus = [l for l in out.splitlines() if l.startswith("GPU ")]
    for g in gpus:
        print("   " + g)
    return len(gpus)


def can_import(mod: str) -> bool:
    # Dependency detection must not bypass the runtime probe's bounded/no-log policy.
    try:
        process=subprocess.Popen([sys.executable,"-c",f"import {mod}"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:return process.wait(timeout=60)==0
        except subprocess.TimeoutExpired:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            process.wait();return False
    except OSError:return False


def pip(*pkgs: str):
    sh([sys.executable, "-m", "pip", "install", "-q", "--no-input", "--disable-pip-version-check", *pkgs], quiet=True)


def install_reviewed_faster():
    torch_version=installed_version('torch')
    if torch_version is None:raise RuntimeError('keep Kaggle platform Torch installed; refusing automatic CUDA/PyTorch replacement')
    with tempfile.TemporaryDirectory(prefix='runtime-constraints-',dir=STATE) as directory:
        constraints=Path(directory)/'constraints.txt'
        lines=['torch=='+torch_version]
        for name in ('torchaudio','torchvision'):
            version=installed_version(name)
            if version is not None:lines.append(name+'=='+version)
        constraints.write_text('\n'.join(lines)+'\n');constraints.chmod(0o600)
        pip(*(name+'=='+version for name,version in PINS.items()),'--constraint',str(constraints))
    if installed_version('torch')!=torch_version:raise RuntimeError('platform Torch changed unexpectedly; stop and recreate the runtime')


def ensure_go() -> str:
    g = shutil.which("go")
    if g:
        return g
    goroot = TOOLS / "go"
    exe = goroot / "bin" / "go"
    if exe.exists():
        return str(exe)
    ver = "go1.23.4"
    tgz = TOOLS / f"{ver}.tgz"
    for url in (f"https://go.dev/dl/{ver}.linux-amd64.tar.gz", f"https://dl.google.com/go/{ver}.linux-amd64.tar.gz",
                f"https://mirrors.aliyun.com/golang/{ver}.linux-amd64.tar.gz"):
        try:
            print(f"   downloading {url}")
            urllib.request.urlretrieve(url, tgz)
            with tarfile.open(tgz) as tf:
                extract_tar_safely(tf, TOOLS)
            tgz.unlink(missing_ok=True)
            if exe.exists():
                return str(exe)
        except Exception as e:  # noqa: BLE001
            print(f"   failed: {e}")
    raise RuntimeError("could not install Go (is Internet enabled in the notebook settings?)")


def build_gateway():
    go = ensure_go()
    env = {"GOCACHE": "/tmp/qtts-gocache", "GOPATH": "/tmp/qtts-gopath", "GOFLAGS": "-mod=mod", "CGO_ENABLED": "0"}
    gdir = ROOT / "go" / "gateway"
    sh([go, "build", "-trimpath", "-ldflags", "-s -w", "-o", "gateway", "."], cwd=str(gdir), env=env)
    print("   gateway binary:", (gdir / "gateway").stat().st_size // 1024, "KB")


def build_rust() -> bool:
    print('Candidate uses numpy-causal-v1; Rust install/build deliberately disabled.')
    return False


def preload_models(err: list):
    try:
        if os.environ.get('QTTS_TTS_ENGINE','faster')=='qwen-adapter-buffered':
            from training_job import base_fingerprint
            if base_fingerprint(MODEL)!=os.environ.get('QTTS_BASE_SHA256'):raise RuntimeError('native adapter inference requires a pinned materialized local Base')
            print('   [bg] pinned local Base reused; no model/ASR/speaker download in trained-only mode',flush=True)
            return
        from huggingface_hub import snapshot_download
        tok = os.environ.get("HF_TOKEN") or None
        t = time.time()
        snapshot_download(MODEL, token=tok)
        print(f"   [bg] TTS model ready ({time.time() - t:.0f}s)", flush=True)
        try:
            snapshot_download("Systran/faster-whisper-large-v3", token=tok)
            print("   [bg] Whisper large-v3 ready", flush=True)
        except Exception as e:  # noqa: BLE001
            print("   [bg] whisper download failed (will fall back to a smaller model):", str(e)[:120], flush=True)
        try:
            snapshot_download("speechbrain/spkrec-ecapa-voxceleb", local_dir=str(STATE / "models" / "ecapa"), token=tok)
        except Exception as e:  # noqa: BLE001
            print("   [bg] ECAPA download failed (MFCC proxy will be used):", str(e)[:120], flush=True)
    except Exception as e:  # noqa: BLE001
        err.append(str(e))


def cuda_lib_paths() -> str:
    """ctranslate2 (faster-whisper) needs cuDNN/cuBLAS on LD_LIBRARY_PATH; torch ships them in site-packages."""
    code = ("import os,sys\nps=[]\n"
            "for m in ('nvidia.cudnn','nvidia.cublas'):\n"
            "  try:\n    mod=__import__(m,fromlist=['x']); ps.append(os.path.join(list(mod.__path__)[0],'lib'))\n  except Exception: pass\n"
            "print(os.pathsep.join(ps))")
    try:
        return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def stop_old():
    """Legacy name retained, but no PID/name-based process killing anymore."""
    if ownership_status()['busy']:
        raise UploadRejected('GPU ownership is busy; explicitly stop managed holders before bootstrapping',409)
    if (STATE/'supervisor.pid').exists():
        raise UploadRejected('legacy supervisor PID marker exists; verify old services stopped and clear only the stale runtime marker',409)


def http_json(url: str, timeout=3):
    import json
    request=urllib.request.Request(url,headers=gateway_headers(url,STATE,GATEWAY_PORT))
    with urllib.request.urlopen(request, timeout=timeout) as r:
        return json.loads(r.read().decode())


def wait_ready(n_workers: int, timeout_s: int = 1800, supervisor_process=None) -> bool:
    t_end = time.time() + timeout_s
    last = 0.0
    while time.time() < t_end:
        if supervisor_process is not None and supervisor_process.poll() is not None:return False
        failure=read_json(STATE/"startup-failure.json",{}) or {}
        if supervisor_process is not None and failure.get("startup_id")==STARTUP_ID:
            print("✗ supervisor recorded fatal worker configuration error; stopping startup",flush=True)
            return False
        try:
            h = http_json(f"http://127.0.0.1:{GATEWAY_PORT}/api/health")
            if any((w.get("worker") or {}).get("fatal_error") for w in h.get("workers",[])):
                print("✗ fatal worker configuration error; stopping startup (see worker logs)",flush=True)
                return False
            if h.get("workers_healthy", 0) >= n_workers:
                return supervisor_process is None or supervisor_process.poll() is None
            if time.time() - last > 15:
                last = time.time()
                st = [(w["id"], "ready" if w.get("ready") else ((w.get("worker") or {}).get("error") or w.get("last_error") or "loading"))
                      for w in h.get("workers", [])]
                print(f"   [{time.time() - T0:6.0f}s] workers: {st}", flush=True)
        except Exception:  # noqa: BLE001
            if time.time() - last > 15:
                last = time.time()
                print(f"   [{time.time() - T0:6.0f}s] waiting for gateway…", flush=True)
        time.sleep(3)
    return False


def stop_created_supervisor(process):
    """Only the Popen we created, never a PID from a file or prior log."""
    if process.poll() is not None:return
    process.terminate()
    try:process.wait(timeout=45)
    except subprocess.TimeoutExpired:
        print('✗ owned supervisor did not confirm shutdown; do not remove GPU lock; stop the complete Kaggle session')


def start_tunnel() -> str | None:
    ensure_access_token(auth_directory(STATE))  # Fail closed before opening a public tunnel.
    if os.environ.get("QTTS_TUNNEL", "cloudflared") == "none":
        return None
    exe = TOOLS / "cloudflared"
    if not exe.exists():
        urllib.request.urlretrieve("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", exe)
        exe.chmod(0o755)
    logp = LOGS / "tunnel.log"
    logf = open(logp, "wb")
    # write straight to a file: the process must outlive this bootstrap (a pipe would SIGPIPE it)
    subprocess.Popen([str(exe), "tunnel", "--url", f"http://127.0.0.1:{GATEWAY_PORT}", "--no-autoupdate"],
                     stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(90):
        try:
            m = re.search(rb"https://[-a-z0-9]+\.trycloudflare\.com", logp.read_bytes())
        except OSError:
            m = None
        if m:
            return m.group(0).decode()
        time.sleep(1)
    return None


def private_entry_url(base_url):
    from private_entry import make_private_entry
    return make_private_entry(base_url, STATE, GATEWAY_PORT)


def print_memo():
    """Read the memo (never guess): print its verified-facts and unverified-risks sections."""
    memo = ROOT / "MEMO.md"
    if not memo.exists():
        return
    txt = memo.read_text(encoding="utf-8")
    for title in ("## 当前版本修复", "## 1. ", "## 7. "):
        i = txt.find(title)
        if i >= 0:
            j = txt.find("\n## ", i + 5)
            block = txt[i: j if j > 0 else None].strip().splitlines()
            print("   " + block[0])
            for line in block[1:8]:
                print("   " + line[:170])
            if len(block) > 8:
                print("   … (full text: %s)" % memo)


def main() -> int:
    try:stop_old()
    except (UploadRejected,OSError):
        print("GPU ownership admission blocked; explicitly stop existing services and inspect the runtime PID marker before retry")
        return 2
    print("QTTS bootstrap  root=%s" % ROOT)
    print_memo()
    with step("1/9 detect GPUs"):
        n = detect_gpus()
        preliminary=collect_probe()
        required=1 if os.environ.get("QTTS_ALLOW_SINGLE_GPU")=="1" else 2
        add_probe(preliminary,"bootstrap_gpu_detection","pass" if n>=required else "blocked",
            f"nvidia-smi visible={n}, required={required}; CUDA/runtime not yet checked")
        write_probe_report(STATE / "backend_probe.json",finalize_probe(preliminary))
        if n == 0:
            print("✗ No GPU visible. Notebook → Settings → Accelerator → GPU T4 x2, then restart the session.")
            return 2
        n_workers = min(n, 2)
        ports = ",".join(str(7001 + i) for i in range(n_workers))
        os.environ["QTTS_WORKER_PORTS"] = ports
        if n < 2 and os.environ.get("QTTS_ALLOW_SINGLE_GPU", "0") != "1":
            print("✗ Two GPUs required. Select T4 x2; QTTS_ALLOW_SINGLE_GPU=1 is only for explicit limited tests.")
            return 2
        if n < 2:
            print("   ⚠ only 1 GPU: explicit single-worker test; throughput/latency unmeasured. Select 'GPU T4 x2'.")
    os.environ["QTTS_ACCESS_TOKEN"] = ensure_access_token(auth_directory(STATE))
    print(f"   Access control enabled. Use QTTS_ACCESS_TOKEN Secret or privately read {auth_directory(STATE) / '.access-token'}; never share it.")

    with step("2/9 python dependencies"):
        kind=os.environ.get('QTTS_TTS_ENGINE','faster')
        if kind not in ('faster','qwen-adapter-buffered'):raise RuntimeError('unknown QTTS_TTS_ENGINE')
        if kind=='qwen-adapter-buffered':
            if not can_import('qwen_tts') or not can_import('safetensors'):raise RuntimeError('install reviewed qwen-tts/safetensors dependencies before native adapter boot; no automatic backend replacement')
        else:
            if installed_version('qwen-tts') is not None:raise RuntimeError('qwen-tts namespace conflict: use a fresh Kaggle runtime for reviewed faster/HF5 stack')
            if any(installed_version(name)!=version for name,version in PINS.items()):
                print('   installing reviewed faster/Qwen-HF/Transformers pins; platform Torch/CUDA is not pinned or force-upgraded')
                install_reviewed_faster()
            if not can_import('faster_qwen3_tts'):raise RuntimeError('reviewed faster backend import failed; no model load')
        pip("fastapi", "uvicorn", "python-multipart", "soundfile", "librosa", "noisereduce", "requests", "kaggle", "huggingface_hub")
        for mod, pkgs in (("faster_whisper", ["faster-whisper"]), ("speechbrain", ["speechbrain"])):
            if not can_import(mod):
                try:
                    pip(*pkgs)
                except Exception as e:  # noqa: BLE001
                    print(f"   ⚠ optional {mod} not installed: {str(e)[:100]}")
        ld = cuda_lib_paths()
        if ld:
            os.environ["LD_LIBRARY_PATH"] = ld + os.pathsep + os.environ.get("LD_LIBRARY_PATH", "")

    with step("2a/9 runtime compatibility preflight (no model load)"):
        sh([sys.executable,str(ROOT / "tools" / "backend_probe.py"),"--runtime","--expected-gpus",str(n_workers),
            "--dtype",os.environ.get("QTTS_DTYPE","fp16"),"--output",str(STATE / "backend_probe.json")],timeout=150)

    err: list[str] = []
    with step("3/9 start model download (background)"):
        th = threading.Thread(target=preload_models, args=(err,), daemon=True)
        th.start()

    with step("4/9 build Go gateway"):
        build_gateway()
    with step("5/9 build Rust audio runtime"):
        rust_ok = build_rust()
    with step("6/9 restore voice profiles (Dataset)"):
        sys.path.insert(0, str(ROOT / "py"))
        try:
            import persist
            print("   restored:" , persist.restore())
        except Exception as e:  # noqa: BLE001
            print("   restore skipped:", e)
    with step("   wait for model download"):
        th.join()
        if err:
            raise RuntimeError("model download failed: " + err[0])

    with step("7/9 start supervisor (workers, analyst, gateway)"):
        with open(LOGS / "supervisor.out", "ab") as supervisor_log:
            sup = subprocess.Popen([sys.executable, str(ROOT / "py" / "supervisor.py")], stdout=supervisor_log,
                                   stderr=subprocess.STDOUT, start_new_session=True, env={**os.environ,"QTTS_STARTUP_ID":STARTUP_ID})
        print("   supervisor pid", sup.pid, "workers:", ports)
    with step("8/9 wait for GPUs (model load (default faster: CUDA-graph capture; native adapter: eager))"):
        try:ok = wait_ready(n_workers,supervisor_process=sup)
        except BaseException:
            stop_created_supervisor(sup)
            raise
        if not ok:
            for f in ("worker0.out", "worker1.out", "analyst.out", "gateway.out", "supervisor.out"):
                p = LOGS / f
                if p.exists():
                    print(f"--- {f} (tail)\n" + "\n".join(p.read_text(errors='ignore').splitlines()[-25:]))
            print("✗ workers failed to become ready; stopping supervisor created by this bootstrap")
            stop_created_supervisor(sup)
            return 3
    url = None
    with step("9/9 public tunnel"):
        try:
            url = start_tunnel()
        except Exception as e:  # noqa: BLE001
            print("   tunnel failed:", e)
    local = f"http://127.0.0.1:{GATEWAY_PORT}"
    (STATE / "url.txt").write_text(url or local)
    print("\n" + "═" * 70)
    print(f"✓ QTTS ready in {time.time() - T0:.0f}s   GPUs: {n_workers}   Rust runtime: {'on' if rust_ok else 'numpy fallback'}")
    entry_url = None
    if url:
        try:
            entry_url = private_entry_url(url)
        except Exception:
            print("  私有入口生成未完成；模型服务保留运行，不要重复 --run。可稍后在 Notebook 重新生成入口。")
    else:
        print("  未取得HTTPS公网隧道；模型服务保留运行，不要在本地浏览器打开Kaggle的127.0.0.1地址。")
    if entry_url:
        print("  私有入口已生成：请点下方链接，无需输入口令。10分钟有效、一次性使用；不要分享或公开保存输出。")
    print(f"  Gateway base (not the private entry): {url or local}")
    if os.environ.get('QTTS_TTS_ENGINE','faster')=='qwen-adapter-buffered':
        print('  训练adapter模式：先用trained_voice.py显式发布，再在现有声音选择器启用；句级缓冲/非声学流式，质量未验收。')
    else:print("  1) 声音实验室: 上传参考音频 → 自动处理 → 启用   2) 语音合成: 打字 → 边生成边播放")
    print("  Monitor: python {}/tools/selftest.py   |   logs: {}".format(ROOT, LOGS))
    print("═" * 70)
    try:
        from IPython.display import HTML, display  # type: ignore
        if entry_url:
            from html import escape
            display(HTML(f'<a href="{escape(entry_url, quote=True)}" target="_blank" rel="noopener noreferrer" style="font-size:18px">▶ 打开 QTTS 控制台（自动进入，无需解锁）</a>'))
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print("\n✗ bootstrap failed:", e)
        sys.exit(1)
