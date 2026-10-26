"""Kaggle environment, path virtualization, secrets, and GPU telemetry simulator."""

from __future__ import annotations

import json
import os
import shutil
import sys
import types
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


PROJECT_ROOT = Path(__file__).resolve().parents[2]
KAGGLE_WORKSPACE = PROJECT_ROOT / "kaggle_workspace"
KAGGLE_INPUT_DIR = KAGGLE_WORKSPACE / "input"
KAGGLE_WORKING_DIR = KAGGLE_WORKSPACE / "working"
KAGGLE_TMP_DIR = KAGGLE_WORKSPACE / "tmp"
SECRETS_FILE = PROJECT_ROOT / ".kaggle_secrets.local.json"
RUNTIME_STATE_FILE = KAGGLE_WORKSPACE / ".simulator_state.json"


@dataclass(frozen=True)
class AcceleratorSpec:
    id: str
    label: str
    gpu_name: str
    device_count: int
    vram_mib_per_gpu: int
    cuda_version: str
    driver_version: str
    compute_capability: tuple[int, int]
    fp16_tflops: float


ACCELERATOR_PROFILES: Dict[str, AcceleratorSpec] = {
    "T4x2": AcceleratorSpec(
        id="T4x2",
        label="Kaggle GPU T4 x2 (2x 16GB)",
        gpu_name="Tesla T4",
        device_count=2,
        vram_mib_per_gpu=15360,
        cuda_version="12.4",
        driver_version="550.90.07",
        compute_capability=(7, 5),
        fp16_tflops=65.0,
    ),
    "P100": AcceleratorSpec(
        id="P100",
        label="Kaggle GPU P100 (1x 16GB)",
        gpu_name="Tesla P100-PCIE-16GB",
        device_count=1,
        vram_mib_per_gpu=16384,
        cuda_version="12.4",
        driver_version="550.90.07",
        compute_capability=(6, 0),
        fp16_tflops=18.7,
    ),
    "H100": AcceleratorSpec(
        id="H100",
        label="High-VRAM Lab H100 (1x 80GB)",
        gpu_name="NVIDIA H100 80GB HBM3",
        device_count=1,
        vram_mib_per_gpu=81920,
        cuda_version="12.4",
        driver_version="550.90.07",
        compute_capability=(9, 0),
        fp16_tflops=989.0,
    ),
    "CPU": AcceleratorSpec(
        id="CPU",
        label="Kaggle CPU Only (No Accelerator)",
        gpu_name="None (CPU)",
        device_count=0,
        vram_mib_per_gpu=0,
        cuda_version="N/A",
        driver_version="N/A",
        compute_capability=(0, 0),
        fp16_tflops=0.5,
    ),
}


class KaggleRuntimeSimulator:
    """Manages local Kaggle workspace directories, virtual GPU profile, and secrets."""

    def __init__(self, project_root: Path = PROJECT_ROOT) -> None:
        self.project_root = project_root
        self.kaggle_root = project_root / "kaggle_workspace"
        self.input_dir = self.kaggle_root / "input"
        self.working_dir = self.kaggle_root / "working"
        self.tmp_dir = self.kaggle_root / "tmp"
        self.ensure_directories()

    def ensure_directories(self) -> None:
        for d in (self.input_dir, self.working_dir, self.tmp_dir):
            d.mkdir(parents=True, exist_ok=True)
            gitkeep = d / ".gitkeep"
            if not gitkeep.exists() and d != self.tmp_dir:
                gitkeep.write_text("", encoding="utf-8")

    def get_state(self) -> Dict[str, Any]:
        default_state = {
            "accelerator": "T4x2",
            "enable_torch_shim": True,
            "auto_sync_working_code": True,
            "internet_enabled": True,
        }
        if RUNTIME_STATE_FILE.exists():
            try:
                loaded = json.loads(RUNTIME_STATE_FILE.read_text(encoding="utf-8"))
                default_state.update(loaded)
            except Exception:
                pass
        if default_state["accelerator"] not in ACCELERATOR_PROFILES:
            default_state["accelerator"] = "T4x2"
        return default_state

    def update_state(self, **kwargs: Any) -> Dict[str, Any]:
        state = self.get_state()
        for k, v in kwargs.items():
            if v is not None and k in state:
                state[k] = v
        if state["accelerator"] not in ACCELERATOR_PROFILES:
            state["accelerator"] = "T4x2"
        self.ensure_directories()
        RUNTIME_STATE_FILE.write_text(
            json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        return state

    def get_accelerator_spec(self, profile_id: Optional[str] = None) -> AcceleratorSpec:
        pid = profile_id or self.get_state()["accelerator"]
        return ACCELERATOR_PROFILES.get(pid, ACCELERATOR_PROFILES["T4x2"])

    def build_env_vars(self, accelerator: Optional[str] = None) -> Dict[str, str]:
        spec = self.get_accelerator_spec(accelerator)
        env = dict(os.environ)
        # Prefer /kaggle if symlinked, otherwise direct project kaggle_workspace
        kaggle_base = Path("/kaggle") if Path("/kaggle/working").exists() else self.kaggle_root
        env.update(
            {
                "KAGGLE_KERNEL_RUN_TYPE": "Interactive",
                "KAGGLE_URL_BASE": "https://www.kaggle.com",
                "KAGGLE_WORKING_DIR": str(kaggle_base / "working"),
                "KAGGLE_INPUT_DIR": str(kaggle_base / "input"),
                "KAGGLE_TMP_DIR": str(kaggle_base / "tmp"),
                "KAGGLE_SIM_PROJECT_ROOT": str(self.project_root),
                "KAGGLE_SIM_ACCELERATOR": spec.id,
                "KAGGLE_SIM_TORCH_SHIM": "1" if self.get_state().get("enable_torch_shim", True) else "0",
                "CUDA_VISIBLE_DEVICES": ",".join(str(i) for i in range(spec.device_count))
                if spec.device_count > 0
                else "",
                "PYTHONUNBUFFERED": "1",
                "MPLBACKEND": "Agg",
            }
        )
        existing_py_path = env.get("PYTHONPATH", "")
        py_paths = [str(self.project_root), str(self.project_root / "src")]
        if existing_py_path:
            py_paths.append(existing_py_path)
        env["PYTHONPATH"] = os.pathsep.join(py_paths)
        return env

    def format_nvidia_smi(self, args: Optional[List[str]] = None, accelerator: Optional[str] = None) -> str:
        spec = self.get_accelerator_spec(accelerator)
        if spec.device_count == 0:
            return "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. (Kaggle Simulator: CPU-Only profile active)"

        args = args or []
        arg_str = " ".join(args)
        if "--query-gpu" in arg_str:
            lines = []
            noheader = "noheader" in arg_str
            if not noheader:
                lines.append("index, name, memory.total [MiB], memory.used [MiB], memory.free [MiB]")
            for idx in range(spec.device_count):
                used = 312 if idx == 0 else 18
                free = spec.vram_mib_per_gpu - used
                lines.append(
                    f"{idx}, {spec.gpu_name}, {spec.vram_mib_per_gpu} MiB, {used} MiB, {free} MiB"
                )
            return "\n".join(lines)

        now_str = datetime.now(timezone.utc).strftime("%a %b %d %H:%M:%S %Y")
        rows = [
            now_str,
            "+-----------------------------------------------------------------------------------------+",
            f"| NVIDIA-SMI {spec.driver_version:<12} Driver Version: {spec.driver_version:<12} CUDA Version: {spec.cuda_version:<12}     |",
            "|-----------------------------------------+------------------------+----------------------+",
            "| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |",
            "| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |",
            "|=========================================+========================+======================|",
        ]
        for idx in range(spec.device_count):
            used = 312 if idx == 0 else 18
            rows.extend(
                [
                    f"|   {idx}  {spec.gpu_name:<22} Off |   00000000:00:0{idx + 4}.0 Off |                    0 |",
                    f"| N/A   38C    P0             28W /  70W |    {used:>5}MiB / {spec.vram_mib_per_gpu:>5}MiB |      4%      Default |",
                    "+-----------------------------------------+------------------------+----------------------+",
                ]
            )
        rows.append("  [Kaggle Simulator Virtual GPU Active — Backed by Qwen3.8Flash Project Workspace]")
        return "\n".join(rows)

    # ---- Secrets Management (Gitignored local file) ----
    def list_secret_keys(self) -> List[str]:
        data = self._read_secrets()
        return sorted(data.keys())

    def set_secret(self, key: str, value: str) -> None:
        data = self._read_secrets()
        data[key.strip()] = value
        SECRETS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def delete_secret(self, key: str) -> None:
        data = self._read_secrets()
        data.pop(key, None)
        SECRETS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def get_secret(self, key: str) -> str:
        data = self._read_secrets()
        if key in data:
            return data[key]
        # Friendly non-crashing mock placeholder for dry-run Kaggle code
        return f"sim_mock_secret_{key.lower()}"

    def _read_secrets(self) -> Dict[str, str]:
        if not SECRETS_FILE.exists():
            return {}
        try:
            return json.loads(SECRETS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def install_kaggle_secrets_module(self) -> None:
        """Registers `kaggle_secrets` in sys.modules for in-process Kaggle compatibility."""
        runtime_ref = self

        class UserSecretsClient:
            def get_secret(self, label: str) -> str:
                return runtime_ref.get_secret(label)

            def get_gcloud_credential(self) -> Dict[str, str]:
                return {"type": "simulated_kaggle_credential"}

        mod = types.ModuleType("kaggle_secrets")
        mod.UserSecretsClient = UserSecretsClient  # type: ignore[attr-defined]
        sys.modules["kaggle_secrets"] = mod

    def translate_kaggle_path(self, raw_path: str) -> str:
        """Maps `/kaggle/...` strings to project's `kaggle_workspace/...` if `/kaggle` symlink is unavailable."""
        if Path("/kaggle/working").exists():
            return raw_path
        for sub, target in (
            ("/kaggle/input", str(self.input_dir)),
            ("/kaggle/working", str(self.working_dir)),
            ("/kaggle/tmp", str(self.tmp_dir)),
            ("/kaggle", str(self.kaggle_root)),
        ):
            if raw_path == sub or raw_path.startswith(sub + "/"):
                return target + raw_path[len(sub) :]
        return raw_path

    def sync_working_code_to_project(
        self, target_subdir: str = "src/voice_cloning/kaggle_synced"
    ) -> List[str]:
        """
        Copies any code/config files written inside `/kaggle/working` during Kaggle code runs
        into real Git-tracked project directories (`src/voice_cloning/kaggle_synced/`) so code is
        NEVER stranded inside `/kaggle/working` alone.
        """
        code_exts = {".py", ".yaml", ".yml", ".json", ".toml", ".sh", ".cfg", ".ini"}
        synced: List[str] = []
        dest_root = self.project_root / target_subdir
        if not self.working_dir.exists():
            return synced

        for file_path in self.working_dir.rglob("*"):
            if not file_path.is_file():
                continue
            if file_path.name.startswith("."):
                continue
            if file_path.suffix.lower() not in code_exts:
                continue
            # Skip oversized data json (>2MB)
            if file_path.stat().st_size > 2 * 1024 * 1024:
                continue
            rel = file_path.relative_to(self.working_dir)
            dest = dest_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file_path, dest)
            synced.append(str(dest.relative_to(self.project_root)))
        return synced

    def status_summary(self) -> Dict[str, Any]:
        state = self.get_state()
        spec = self.get_accelerator_spec(state["accelerator"])
        input_datasets = []
        if self.input_dir.exists():
            for p in sorted(self.input_dir.iterdir()):
                if p.is_dir() and not p.name.startswith("."):
                    files = [f.name for f in sorted(p.rglob("*")) if f.is_file() and not f.name.startswith(".")]
                    input_datasets.append({"name": p.name, "path": f"/kaggle/input/{p.name}", "file_count": len(files), "sample_files": files[:8]})

        working_files = []
        if self.working_dir.exists():
            for p in sorted(self.working_dir.rglob("*")):
                if p.is_file() and not p.name.startswith("."):
                    rel = str(p.relative_to(self.working_dir))
                    working_files.append(
                        {
                            "name": rel,
                            "kaggle_path": f"/kaggle/working/{rel}",
                            "project_path": f"kaggle_workspace/working/{rel}",
                            "size_bytes": p.stat().st_size,
                        }
                    )

        return {
            "state": state,
            "accelerator": asdict(spec),
            "os_kaggle_symlink_active": Path("/kaggle/working").exists(),
            "kaggle_workspace_project_path": str(self.kaggle_root.relative_to(self.project_root)),
            "input_datasets": input_datasets,
            "working_files": working_files,
            "secret_keys": self.list_secret_keys(),
        }


_DEFAULT_RUNTIME: Optional[KaggleRuntimeSimulator] = None


def get_kaggle_runtime() -> KaggleRuntimeSimulator:
    global _DEFAULT_RUNTIME
    if _DEFAULT_RUNTIME is None:
        _DEFAULT_RUNTIME = KaggleRuntimeSimulator()
    return _DEFAULT_RUNTIME
