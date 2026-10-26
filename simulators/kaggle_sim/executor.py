"""
Stateful Kaggle Notebook & Voice Cloning Code Executor.

Supports persistent Python kernel namespace across cells, IPython magics (`!nvidia-smi`,
`!pip`, `%cd`, `%%writefile`, `%matplotlib inline`), inline Matplotlib figure capture,
`IPython.display.Audio` capture, Virtual Torch/CUDA injection, and automatic syncing of
generated code files into the project repository.
"""

from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import soundfile as sf

from .magic_parser import KaggleCell, WRITEFILE_RE, split_shell_args, transform_cell_magics_to_valid_python
from .runtime import PROJECT_ROOT, KaggleRuntimeSimulator, get_kaggle_runtime
from .torch_cuda_mock import install_torch_cuda_simulator


SIMULATED_HEAVY_GPU_PACKAGES = {
    "torch",
    "torchaudio",
    "torchvision",
    "xformers",
    "flash-attn",
    "flash_attn",
    "bitsandbytes",
    "triton",
    "deepspeed",
    "nvidia-cublas-cu12",
    "onnxruntime-gpu",
}

_ACTIVE_DISPLAY_COLLECTOR: Optional[List[Dict[str, Any]]] = None


def writefile_inline(target: str, content: str, append: bool = False) -> str:
    """Writes a `%%writefile` target and mirrors code files into `src/voice_cloning/`."""
    rt = get_kaggle_runtime()
    resolved = Path(rt.translate_kaggle_path(target))
    if not resolved.is_absolute():
        resolved = Path.cwd() / resolved
    resolved.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if append else "w"
    with open(resolved, mode, encoding="utf-8") as fp:
        fp.write(content)
        if not content.endswith("\n"):
            fp.write("\n")

    msg = f"Writing {resolved}"
    # Also ensure code files are saved inside the real project `src/voice_cloning/`
    try:
        resolved.relative_to(PROJECT_ROOT)
        inside_project = True
    except ValueError:
        inside_project = False

    in_kaggle_working = str(resolved).startswith(str(rt.working_dir)) or str(target).startswith("/kaggle/working")
    if (not inside_project or in_kaggle_working) and resolved.suffix.lower() in {".py", ".yaml", ".yml", ".json", ".toml", ".sh"}:
        mirror_path = PROJECT_ROOT / "src" / "voice_cloning" / resolved.name
        mirror_path.parent.mkdir(parents=True, exist_ok=True)
        with open(mirror_path, mode, encoding="utf-8") as mfp:
            mfp.write(content)
            if not content.endswith("\n"):
                mfp.write("\n")
        msg += f" (Mirrored to project: {mirror_path.relative_to(PROJECT_ROOT)})"

    print(msg)
    return str(resolved)


def run_magic_inline(raw_magic: str, allow_real_pip: bool = False) -> str:
    """Executes `!shell` or `%magic` commands inside the Kaggle Simulator environment."""
    rt = get_kaggle_runtime()
    s = raw_magic.strip()
    if not s:
        return ""

    # Line / cell magics starting with %
    if s.startswith("%"):
        if s.startswith("%cd "):
            dest_raw = s[4:].strip()
            dest = Path(rt.translate_kaggle_path(dest_raw)).expanduser()
            dest.mkdir(parents=True, exist_ok=True)
            os.chdir(dest)
            out = str(Path.cwd())
            print(out)
            return out
        if s.startswith(("%matplotlib", "%load_ext", "%autoreload", "%time", "%%time")):
            return ""
        if s.startswith("%pip "):
            s = "!" + s[1:]
        else:
            msg = f"[Kaggle Simulator] Magic `{s}` acknowledged."
            print(msg)
            return msg

    # Shell commands starting with !
    if s.startswith("!"):
        cmd = s[1:].strip()
        args = split_shell_args(cmd)
        if not args:
            return ""

        # Intercept nvidia-smi with Virtual Kaggle GPU telemetry
        if args[0] == "nvidia-smi":
            out = rt.format_nvidia_smi(args[1:])
            print(out)
            return out

        # Intercept pip install safely
        if args[0] in ("pip", "pip3") and len(args) >= 2 and args[1] == "install":
            pkg_tokens = [a for a in args[2:] if not a.startswith("-")]
            lines = []
            to_install_real = []
            for tok in pkg_tokens:
                base_pkg = tok.split("==")[0].split(">=")[0].split("<=")[0].split("[")[0].strip().lower()
                if base_pkg in SIMULATED_HEAVY_GPU_PACKAGES:
                    lines.append(
                        f"Requirement satisfied via Kaggle GPU Simulator Shim: {tok} (Virtual CUDA {rt.get_accelerator_spec().cuda_version})"
                    )
                elif importlib.util.find_spec(base_pkg.replace("-", "_")) is not None:
                    lines.append(f"Requirement already satisfied: {tok}")
                elif allow_real_pip:
                    to_install_real.append(tok)
                else:
                    lines.append(
                        f"[Kaggle Simulator Dry-Run] Simulated package `{tok}` (enable Real Pip in settings if needed)."
                    )
            if to_install_real:
                proc = subprocess.run(
                    [sys.executable, "-m", "pip", "install", "--break-system-packages", "-q", *to_install_real],
                    capture_output=True,
                    text=True,
                    timeout=90,
                )
                if proc.stdout:
                    lines.append(proc.stdout.strip())
                if proc.returncode != 0 and proc.stderr:
                    lines.append(proc.stderr.strip())
            out = "\n".join(lines)
            if out:
                print(out)
            return out

        # Run standard shell command with Kaggle environment variables
        env = rt.build_env_vars()
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=str(Path.cwd()),
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        combined = ""
        if proc.stdout:
            combined += proc.stdout
        if proc.stderr:
            combined += proc.stderr
        if combined:
            print(combined, end="" if combined.endswith("\n") else "\n")
        return combined

    return ""


class KaggleCodeExecutor:
    """Interactive stateful Kaggle Notebook kernel simulator."""

    def __init__(self, runtime: Optional[KaggleRuntimeSimulator] = None) -> None:
        self.runtime = runtime or get_kaggle_runtime()
        self.execution_counter: int = 0
        self.namespace: Dict[str, Any] = {}
        self.reset_kernel()

    def reset_kernel(self) -> None:
        self.execution_counter = 0
        self.runtime.ensure_directories()
        state = self.runtime.get_state()
        for k, v in self.runtime.build_env_vars().items():
            os.environ[k] = v

        self.runtime.install_kaggle_secrets_module()
        if state.get("enable_torch_shim", True):
            install_torch_cuda_simulator(force=False)

        self._install_display_hooks()
        self.namespace = {
            "__name__": "__main__",
            "__builtins__": __builtins__,
            "_kaggle_magic": run_magic_inline,
            "_kaggle_writefile": writefile_inline,
            "display": self._custom_display,
        }

    def _install_display_hooks(self) -> None:
        """Hooks IPython.display.Audio & display so audio/HTML outputs appear in Browser Simulator."""
        try:
            import IPython.display as ipd

            orig_audio = ipd.Audio
            executor_ref = self

            class SimulatorAudio(orig_audio):  # type: ignore[misc]
                def __init__(self, data: Any = None, filename: Optional[str] = None, rate: Optional[int] = None, **kw: Any) -> None:
                    executor_ref._capture_audio_object(data=data, filename=filename, rate=rate)
                    try:
                        super().__init__(data=data, filename=filename, rate=rate, **kw)
                    except Exception:
                        pass

            ipd.Audio = SimulatorAudio  # type: ignore[misc]
            ipd.display = self._custom_display  # type: ignore[assignment]
        except Exception:
            pass

    def _capture_audio_object(
        self, data: Any = None, filename: Optional[str] = None, rate: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        global _ACTIVE_DISPLAY_COLLECTOR
        if _ACTIVE_DISPLAY_COLLECTOR is None:
            return None

        out_dir = self.runtime.working_dir / "_inline_audio"
        out_dir.mkdir(parents=True, exist_ok=True)

        if filename is not None:
            resolved = Path(self.runtime.translate_kaggle_path(str(filename)))
            if resolved.exists():
                rel_url = self._path_to_media_url(resolved)
                item = {"type": "audio", "label": resolved.name, "url": rel_url, "sample_rate": rate or 24000}
                _ACTIVE_DISPLAY_COLLECTOR.append(item)
                return item

        if data is not None:
            if isinstance(data, (str, Path)) and Path(self.runtime.translate_kaggle_path(str(data))).exists():
                resolved = Path(self.runtime.translate_kaggle_path(str(data)))
                item = {"type": "audio", "label": resolved.name, "url": self._path_to_media_url(resolved), "sample_rate": rate or 24000}
                _ACTIVE_DISPLAY_COLLECTOR.append(item)
                return item
            arr = data.numpy() if hasattr(data, "numpy") else data
            sr = int(rate or 24000)
            fname = f"inline_{int(time.time() * 1000)}.wav"
            dest = out_dir / fname
            import numpy as np
            np_arr = np.asarray(arr, dtype=np.float32)
            if np_arr.ndim == 2 and np_arr.shape[0] <= 2 and np_arr.shape[1] > np_arr.shape[0]:
                np_arr = np_arr.T
            sf.write(str(dest), np.clip(np_arr, -1.0, 1.0), sr)
            item = {"type": "audio", "label": fname, "url": self._path_to_media_url(dest), "sample_rate": sr}
            _ACTIVE_DISPLAY_COLLECTOR.append(item)
            return item
        return None

    def _path_to_media_url(self, path: Path) -> str:
        resolved = path.resolve()
        try:
            rel = resolved.relative_to(PROJECT_ROOT.resolve())
            return f"/api/media?path={rel.as_posix()}"
        except ValueError:
            return f"/api/media?path={resolved.as_posix()}"

    def _custom_display(self, *objs: Any, **kwargs: Any) -> None:
        global _ACTIVE_DISPLAY_COLLECTOR
        for obj in objs:
            cls_name = type(obj).__name__
            if cls_name in ("Audio", "SimulatorAudio"):
                # Already captured in SimulatorAudio.__init__ if constructed via IPython.display.Audio
                continue
            if _ACTIVE_DISPLAY_COLLECTOR is not None:
                _ACTIVE_DISPLAY_COLLECTOR.append({"type": "text", "text": repr(obj)})
            else:
                print(repr(obj))

    def execute_cell(self, cell: KaggleCell) -> Dict[str, Any]:
        """Executes a single KaggleCell in the stateful simulator kernel."""
        if cell.cell_type == "markdown":
            return {
                "cell_id": cell.id,
                "status": "ok",
                "execution_count": None,
                "duration_ms": 0,
                "stdout": "",
                "stderr": "",
                "rich_outputs": [],
                "synced_project_files": [],
            }

        self.execution_counter += 1
        exec_count = self.execution_counter
        state = self.runtime.get_state()
        for k, v in self.runtime.build_env_vars().items():
            os.environ[k] = v
        if state.get("enable_torch_shim", True):
            install_torch_cuda_simulator(force=False)

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        rich_outputs: List[Dict[str, Any]] = []

        global _ACTIVE_DISPLAY_COLLECTOR
        _ACTIVE_DISPLAY_COLLECTOR = rich_outputs

        # Snapshot existing audio files in working_dir to detect newly generated audio
        before_audio = {
            p.resolve(): p.stat().st_mtime_ns
            for p in self.runtime.working_dir.rglob("*")
            if p.is_file() and p.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"} and "_inline_audio" not in p.parts
        }

        transformed_py = transform_cell_magics_to_valid_python(cell.source)
        prev_cwd = Path.cwd()
        start_t = time.perf_counter()
        status = "ok"

        try:
            plt.close("all")
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                compiled = compile(transformed_py, f"<kaggle-{cell.id}>", "exec")
                exec(compiled, self.namespace)

                # Capture any open matplotlib figures
                fig_nums = plt.get_fignums()
                for fnum in fig_nums:
                    fig = plt.figure(fnum)
                    img_buf = io.BytesIO()
                    fig.savefig(img_buf, format="png", bbox_inches="tight", dpi=110)
                    b64 = base64.b64encode(img_buf.getvalue()).decode("ascii")
                    rich_outputs.append({"type": "image", "mime": "image/png", "data_b64": b64})
                plt.close("all")
        except Exception:
            status = "error"
            stderr_buf.write(traceback.format_exc())
        finally:
            _ACTIVE_DISPLAY_COLLECTOR = None
            os.chdir(prev_cwd)

        duration_ms = round((time.perf_counter() - start_t) * 1000, 1)

        # Detect newly created/modified audio files in /kaggle/working
        already_urls = {item.get("url") for item in rich_outputs if item.get("type") == "audio"}
        for p in sorted(self.runtime.working_dir.rglob("*")):
            if p.is_file() and p.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"} and "_inline_audio" not in p.parts:
                rp = p.resolve()
                if rp not in before_audio or p.stat().st_mtime_ns != before_audio[rp]:
                    url = self._path_to_media_url(rp)
                    if url not in already_urls:
                        rich_outputs.append(
                            {
                                "type": "audio",
                                "label": f"/kaggle/working/{p.relative_to(self.runtime.working_dir)}",
                                "url": url,
                            }
                        )

        synced_files: List[str] = []
        if state.get("auto_sync_working_code", True):
            synced_files = self.runtime.sync_working_code_to_project()

        return {
            "cell_id": cell.id,
            "status": status,
            "execution_count": exec_count,
            "duration_ms": duration_ms,
            "stdout": stdout_buf.getvalue(),
            "stderr": stderr_buf.getvalue(),
            "rich_outputs": rich_outputs,
            "synced_project_files": synced_files,
        }

    def execute_all(self, cells: List[KaggleCell], stop_on_error: bool = True) -> Dict[str, Any]:
        results = []
        overall = "ok"
        t0 = time.perf_counter()
        for cell in cells:
            res = self.execute_cell(cell)
            results.append(res)
            if res["status"] == "error":
                overall = "error"
                if stop_on_error:
                    break
        return {
            "status": overall,
            "total_duration_ms": round((time.perf_counter() - t0) * 1000, 1),
            "accelerator": self.runtime.get_state()["accelerator"],
            "results": results,
        }
