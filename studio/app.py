"""
FastAPI Backend for Qwen3.8Flash Kaggle & Voice Cloning Browser Simulator Studio.

Designed for Arena Live Preview:
- Binds 0.0.0.0
- Accepts all proxy Hosts/Origins & allows iframe embedding
- Persists all code directly to real project repository files and syncs to GitHub
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from simulators.experiment_tracker import get_experiment_tracker
from simulators.kaggle_sim import (
    ACCELERATOR_PROFILES,
    KaggleCell,
    KaggleCodeExecutor,
    get_kaggle_runtime,
    parse_kaggle_paste,
)
from simulators.kaggle_sim.magic_parser import detect_kaggle_references, extract_writefiles
from simulators.kaggle_sim.runtime import PROJECT_ROOT
from simulators.voice_clone_sim import (
    ARCHITECTURES,
    analyze_voice_file,
    ensure_sample_voice_dataset,
    run_voice_cloning_simulation,
    simulate_kaggle_training_experiment,
)
from .git_manager import GitSyncManager
from .project_store import ProjectStore
from .seed_template import get_starter_kaggle_cells


STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(
    title="Qwen3.8Flash Kaggle & Voice Cloning Simulator Studio",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

runtime = get_kaggle_runtime()
executor = KaggleCodeExecutor(runtime=runtime)
project_store = ProjectStore(project_root=PROJECT_ROOT)
git_manager = GitSyncManager(repo_root=PROJECT_ROOT)
tracker = get_experiment_tracker()


def ensure_initial_seed() -> None:
    ensure_sample_voice_dataset()
    nb_file = PROJECT_ROOT / project_store.default_ipynb_rel
    py_file = PROJECT_ROOT / project_store.default_py_rel
    if not nb_file.exists() or not py_file.exists():
        starter = [c.to_dict() for c in get_starter_kaggle_cells()]
        project_store.save_kaggle_workspace_bundle(
            cells_payload=starter,
            py_rel_path=project_store.default_py_rel,
            ipynb_rel_path=project_store.default_ipynb_rel,
            extract_submodules=True,
        )


ensure_initial_seed()


# ---- Request Schemas ----
class SaveWorkspaceRequest(BaseModel):
    raw_code: Optional[str] = None
    cells: Optional[List[Dict[str, Any]]] = None
    py_rel_path: str = "src/voice_cloning/kaggle_main.py"
    ipynb_rel_path: str = "notebooks/kaggle_voice_cloning.ipynb"
    extract_submodules: bool = True
    auto_split_sections: bool = True
    push_to_github: bool = False
    commit_message: Optional[str] = None


class ParsePreviewRequest(BaseModel):
    raw_code: str
    auto_split_sections: bool = True


class RunCellRequest(BaseModel):
    id: str = "cell-1"
    cell_type: str = "code"
    title: str = "Cell"
    source: str = ""


class RunAllRequest(BaseModel):
    cells: List[Dict[str, Any]]
    stop_on_error: bool = True
    save_before_run: bool = True
    py_rel_path: str = "src/voice_cloning/kaggle_main.py"
    ipynb_rel_path: str = "notebooks/kaggle_voice_cloning.ipynb"


class KaggleConfigRequest(BaseModel):
    accelerator: Optional[str] = None
    enable_torch_shim: Optional[bool] = None
    auto_sync_working_code: Optional[bool] = None


class SecretRequest(BaseModel):
    key: str
    value: str


class VoiceAnalyzeRequest(BaseModel):
    audio_path: str


class VoiceCloneRequest(BaseModel):
    ref_audio_path: str
    target_text: str = "你好，这是在项目模拟器中合成的零样本克隆语音测试音频。"
    architecture_id: str = "qwen_cosyvoice_codec"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch_shift_semitones: float = Field(default=0.0, ge=-8.0, le=8.0)
    temperature: float = Field(default=0.7, ge=0.1, le=1.5)
    nfe_steps: int = Field(default=24, ge=4, le=64)
    log_experiment: bool = True


class TrainingSimRequest(BaseModel):
    architecture_id: str = "qwen_cosyvoice_codec"
    accelerator_id: str = "T4x2"
    finetune_mode: str = "lora"
    precision: str = "fp16"
    batch_size: int = Field(default=4, ge=1, le=64)
    grad_accum_steps: int = Field(default=4, ge=1, le=32)
    max_audio_sec: float = Field(default=10.0, ge=2.0, le=30.0)
    learning_rate: float = 1e-4
    epochs: int = Field(default=12, ge=2, le=100)
    dataset_hours: float = Field(default=2.0, ge=0.1, le=200.0)
    log_experiment: bool = True


class WriteFileRequest(BaseModel):
    path: str
    content: str
    push_to_github: bool = False
    commit_message: Optional[str] = None


class GitSyncRequest(BaseModel):
    message: str = "feat: update Kaggle voice cloning code in project repository"
    push: bool = True


# ---- Routes ----
@app.get("/", response_class=HTMLResponse)
def serve_index() -> HTMLResponse:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(content=html)


@app.get("/api/overview")
def api_overview() -> Dict[str, Any]:
    ds_dir = ensure_sample_voice_dataset()
    ref_audios = []
    for wav in sorted(ds_dir.glob("*.wav")):
        rel = wav.relative_to(PROJECT_ROOT).as_posix()
        ref_audios.append(
            {
                "name": wav.name,
                "kaggle_path": f"/kaggle/input/sample-voice-dataset/{wav.name}",
                "project_path": rel,
                "url": f"/api/media?path={rel}",
            }
        )
    # Include any custom uploaded dataset wavs
    for wav in sorted(runtime.input_dir.rglob("*.wav")):
        if wav.parent == ds_dir:
            continue
        rel = wav.relative_to(PROJECT_ROOT).as_posix()
        k_rel = wav.relative_to(runtime.input_dir).as_posix()
        ref_audios.append(
            {
                "name": f"{wav.parent.name}/{wav.name}",
                "kaggle_path": f"/kaggle/input/{k_rel}",
                "project_path": rel,
                "url": f"/api/media?path={rel}",
            }
        )

    return {
        "project_root": str(PROJECT_ROOT),
        "kaggle": runtime.status_summary(),
        "accelerators": [
            {"id": k, "label": v.label, "gpu_name": v.gpu_name, "device_count": v.device_count, "vram_mib": v.vram_mib_per_gpu}
            for k, v in ACCELERATOR_PROFILES.items()
        ],
        "architectures": list(ARCHITECTURES.values()),
        "reference_audios": ref_audios,
        "git": git_manager.get_status(),
        "experiments_count": len(tracker.list_runs(limit=100)),
    }


@app.get("/api/workspace/load")
def api_workspace_load(
    ipynb_rel_path: str = "notebooks/kaggle_voice_cloning.ipynb",
    py_rel_path: str = "src/voice_cloning/kaggle_main.py",
) -> Dict[str, Any]:
    return project_store.load_workspace_cells(ipynb_rel_path=ipynb_rel_path, py_rel_path=py_rel_path)


@app.post("/api/workspace/parse-preview")
def api_parse_preview(req: ParsePreviewRequest) -> Dict[str, Any]:
    cells = parse_kaggle_paste(req.raw_code, auto_split_sections=req.auto_split_sections)
    wfs = extract_writefiles(cells)
    refs = detect_kaggle_references(req.raw_code)
    return {
        "cell_count": len(cells),
        "cells": [c.to_dict() for c in cells],
        "extracted_writefiles": [
            {"raw_target": w.raw_target, "project_rel_path": w.project_rel_path, "size": len(w.content)}
            for w in wfs
        ],
        "kaggle_references": refs,
    }


@app.post("/api/workspace/save")
def api_workspace_save(req: SaveWorkspaceRequest) -> Dict[str, Any]:
    try:
        saved = project_store.save_kaggle_workspace_bundle(
            raw_code=req.raw_code,
            cells_payload=req.cells,
            py_rel_path=req.py_rel_path,
            ipynb_rel_path=req.ipynb_rel_path,
            extract_submodules=req.extract_submodules,
            auto_split_sections=req.auto_split_sections,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    git_result = None
    if req.push_to_github:
        msg = req.commit_message or f"feat: save Kaggle voice cloning code to {saved['py_rel_path']} & {saved['ipynb_rel_path']}"
        git_result = git_manager.commit_and_push(message=msg, push=True)

    return {
        "ok": True,
        "workspace": saved,
        "git_sync": git_result,
        "git_status": git_manager.get_status(),
    }


@app.post("/api/workspace/reset-starter")
def api_reset_starter() -> Dict[str, Any]:
    starter = [c.to_dict() for c in get_starter_kaggle_cells()]
    saved = project_store.save_kaggle_workspace_bundle(cells_payload=starter)
    return {"ok": True, "workspace": saved, "git_status": git_manager.get_status()}


@app.post("/api/kaggle/run-cell")
def api_run_cell(req: RunCellRequest) -> Dict[str, Any]:
    cell = KaggleCell(id=req.id, cell_type=req.cell_type, title=req.title, source=req.source)
    return executor.execute_cell(cell)


@app.post("/api/kaggle/run-all")
def api_run_all(req: RunAllRequest) -> Dict[str, Any]:
    saved = None
    if req.save_before_run:
        saved = project_store.save_kaggle_workspace_bundle(
            cells_payload=req.cells,
            py_rel_path=req.py_rel_path,
            ipynb_rel_path=req.ipynb_rel_path,
            extract_submodules=True,
        )
    cells = [
        KaggleCell(
            id=str(c.get("id") or f"cell-{i + 1}"),
            cell_type=str(c.get("cell_type") or "code"),
            title=str(c.get("title") or f"Cell {i + 1}"),
            source=str(c.get("source") or ""),
        )
        for i, c in enumerate(req.cells)
    ]
    exec_res = executor.execute_all(cells, stop_on_error=req.stop_on_error)
    return {"execution": exec_res, "saved": saved, "kaggle": runtime.status_summary()}


@app.post("/api/kaggle/reset-kernel")
def api_reset_kernel() -> Dict[str, Any]:
    executor.reset_kernel()
    return {"ok": True, "message": "Kaggle Simulator Kernel 已重置。"}


@app.post("/api/kaggle/config")
def api_kaggle_config(req: KaggleConfigRequest) -> Dict[str, Any]:
    state = runtime.update_state(
        accelerator=req.accelerator,
        enable_torch_shim=req.enable_torch_shim,
        auto_sync_working_code=req.auto_sync_working_code,
    )
    executor.reset_kernel()
    return {"ok": True, "state": state, "kaggle": runtime.status_summary()}


@app.post("/api/kaggle/secrets")
def api_set_secret(req: SecretRequest) -> Dict[str, Any]:
    if not req.key.strip():
        raise HTTPException(status_code=400, detail="Secret key cannot be empty.")
    runtime.set_secret(req.key, req.value)
    return {"ok": True, "secret_keys": runtime.list_secret_keys()}


@app.delete("/api/kaggle/secrets/{key}")
def api_delete_secret(key: str) -> Dict[str, Any]:
    runtime.delete_secret(key)
    return {"ok": True, "secret_keys": runtime.list_secret_keys()}


@app.post("/api/kaggle/upload")
async def api_upload_file(
    dataset_name: str = Form("custom-voice-data"),
    target_area: str = Form("kaggle_input"),  # "kaggle_input" | "project_src"
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    safe_name = Path(file.filename or "uploaded_file").name
    raw_bytes = await file.read()
    if len(raw_bytes) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File exceeds 50MB upload limit.")

    if target_area == "project_src":
        sub = "notebooks" if safe_name.endswith(".ipynb") else "src/voice_cloning"
        dest = project_store.resolve_safe_project_path(f"{sub}/{safe_name}")
    else:
        clean_ds = "".join(ch for ch in dataset_name if ch.isalnum() or ch in ("-", "_")).strip("-_") or "custom-voice-data"
        dest = runtime.input_dir / clean_ds / safe_name

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(raw_bytes)
    rel = dest.relative_to(PROJECT_ROOT).as_posix()
    return {
        "ok": True,
        "filename": safe_name,
        "project_path": rel,
        "kaggle_path": f"/kaggle/input/{dest.relative_to(runtime.input_dir).as_posix()}" if dest.is_relative_to(runtime.input_dir) else rel,
        "size_bytes": len(raw_bytes),
    }


# ---- Voice Cloning & Training Simulators ----
@app.post("/api/sim/voice-analyze")
def api_voice_analyze(req: VoiceAnalyzeRequest) -> Dict[str, Any]:
    p = Path(runtime.translate_kaggle_path(req.audio_path))
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Audio file not found: {req.audio_path}")
    return analyze_voice_file(p)


@app.post("/api/sim/voice-clone")
def api_voice_clone(req: VoiceCloneRequest) -> Dict[str, Any]:
    p = Path(runtime.translate_kaggle_path(req.ref_audio_path))
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Reference audio not found: {req.ref_audio_path}")

    res = run_voice_cloning_simulation(
        ref_audio_path=p,
        target_text=req.target_text,
        architecture_id=req.architecture_id,
        speed=req.speed,
        pitch_shift_semitones=req.pitch_shift_semitones,
        temperature=req.temperature,
        nfe_steps=req.nfe_steps,
    )
    if req.log_experiment:
        tracker.log_run(
            run_type="voice_cloning_synthesis",
            name=f"Clone [{res['architecture']['id']}] <- {p.name}",
            params={
                "ref_audio": p.name,
                "architecture": req.architecture_id,
                "speed": req.speed,
                "pitch_shift": req.pitch_shift_semitones,
                "nfe_steps": req.nfe_steps,
            },
            metrics=res["metrics"],
            notes=req.target_text[:80],
        )
    return res


@app.post("/api/sim/training-benchmark")
def api_training_benchmark(req: TrainingSimRequest) -> Dict[str, Any]:
    res = simulate_kaggle_training_experiment(
        architecture_id=req.architecture_id,
        accelerator_id=req.accelerator_id,
        finetune_mode=req.finetune_mode,
        precision=req.precision,
        batch_size=req.batch_size,
        grad_accum_steps=req.grad_accum_steps,
        max_audio_sec=req.max_audio_sec,
        learning_rate=req.learning_rate,
        epochs=req.epochs,
        dataset_hours=req.dataset_hours,
    )
    if req.log_experiment:
        tracker.log_run(
            run_type="kaggle_training_sim",
            name=f"TrainSim [{req.architecture_id}] on {req.accelerator_id} ({req.finetune_mode}/{req.precision})",
            params=res["config"],
            metrics={**res["final_metrics"], "peak_vram_gb": res["vram_breakdown_gb"]["peak_per_gpu_gb"]},
            notes=f"{req.epochs} epochs, {req.dataset_hours}h audio",
        )
    return res


@app.get("/api/experiments")
def api_list_experiments() -> Dict[str, Any]:
    return {"runs": tracker.list_runs(limit=50)}


@app.delete("/api/experiments")
def api_clear_experiments() -> Dict[str, Any]:
    tracker.clear_runs()
    return {"ok": True, "runs": []}


# ---- Real Project File Explorer & GitHub Sync ----
@app.get("/api/files/tree")
def api_files_tree() -> Dict[str, Any]:
    return {"project_root": str(PROJECT_ROOT), "files": project_store.list_project_tree()}


@app.get("/api/files/read")
def api_files_read(path: str = Query(...)) -> Dict[str, Any]:
    try:
        return project_store.read_text_file(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/files/write")
def api_files_write(req: WriteFileRequest) -> Dict[str, Any]:
    try:
        receipt = project_store.write_text_file(req.path, req.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    git_res = None
    if req.push_to_github:
        msg = req.commit_message or f"feat: update {receipt['project_rel_path']}"
        git_res = git_manager.commit_and_push(message=msg, push=True)

    return {"ok": True, "receipt": receipt, "git_sync": git_res, "git_status": git_manager.get_status()}


@app.delete("/api/files/delete")
def api_files_delete(path: str = Query(...)) -> Dict[str, Any]:
    try:
        res = project_store.delete_file(path)
        return {"ok": True, **res, "git_status": git_manager.get_status()}
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/git/status")
def api_git_status() -> Dict[str, Any]:
    return git_manager.get_status()


@app.post("/api/git/sync")
def api_git_sync(req: GitSyncRequest) -> Dict[str, Any]:
    return git_manager.commit_and_push(message=req.message, push=req.push)


@app.get("/api/media")
def api_serve_media(path: str = Query(...)) -> FileResponse:
    p = Path(runtime.translate_kaggle_path(path))
    if not p.is_absolute():
        p = (PROJECT_ROOT / p).resolve()
    else:
        p = p.resolve()

    if not p.is_relative_to(PROJECT_ROOT.resolve()):
        raise HTTPException(status_code=403, detail="Access denied outside project root.")
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail=f"Media file not found: {path}")

    mime, _ = mimetypes.guess_type(str(p))
    return FileResponse(str(p), media_type=mime or "audio/wav")
