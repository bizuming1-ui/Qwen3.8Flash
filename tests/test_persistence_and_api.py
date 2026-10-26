"""Tests for Real Project File Persistence, Path Guards, and Studio FastAPI Endpoints."""

from __future__ import annotations

from pathlib import Path
from fastapi.testclient import TestClient

from simulators.kaggle_sim.runtime import PROJECT_ROOT
from studio.app import app


client = TestClient(app)


def test_overview_and_git_status_endpoints() -> None:
    r = client.get("/api/overview")
    assert r.status_code == 200
    body = r.json()
    assert body["project_root"] == str(PROJECT_ROOT)
    assert len(body["accelerators"]) >= 4
    assert len(body["reference_audios"]) >= 3
    assert "branch" in body["git"]


def test_save_pasted_kaggle_code_writes_real_project_files() -> None:
    test_py_rel = "src/voice_cloning/_test_pasted_kaggle.py"
    test_nb_rel = "notebooks/_test_pasted_kaggle.ipynb"
    test_sub_rel = "src/voice_cloning/_test_sub_vocoder.py"

    pasted_kaggle_code = f"""
# %% Kaggle Voice Cloning Test
!nvidia-smi
import torch
x = torch.ones(2, 4)
print("Sum:", x.sum().item())

# %%
%%writefile /kaggle/working/_test_sub_vocoder.py
def vocode_gain(val: float) -> float:
    return val * 1.5
"""
    try:
        resp = client.post(
            "/api/workspace/save",
            json={
                "raw_code": pasted_kaggle_code,
                "py_rel_path": test_py_rel,
                "ipynb_rel_path": test_nb_rel,
                "extract_submodules": True,
                "auto_split_sections": True,
                "push_to_github": False,
            },
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["ok"] is True

        # Verify all 3 files exist FOR REAL on repository disk!
        py_disk = PROJECT_ROOT / test_py_rel
        nb_disk = PROJECT_ROOT / test_nb_rel
        sub_disk = PROJECT_ROOT / test_sub_rel

        assert py_disk.exists(), "Python module must be saved on real project disk"
        assert nb_disk.exists(), "Notebook must be saved on real project disk"
        assert sub_disk.exists(), "%%writefile submodule must be extracted to real project src/"

        # Verify generated Python file is 100% syntactically valid Python
        compile(py_disk.read_text(encoding="utf-8"), str(py_disk), "exec")
        assert "def vocode_gain" in sub_disk.read_text(encoding="utf-8")

        # Execute starter cells via /api/kaggle/run-all
        run_resp = client.post(
            "/api/kaggle/run-all",
            json={
                "cells": payload["workspace"]["cells"],
                "stop_on_error": True,
                "save_before_run": False,
            },
        )
        assert run_resp.status_code == 200
        assert run_resp.json()["execution"]["status"] == "ok"
    finally:
        # Clean up temporary test files so working tree stays clean
        for rel in (
            test_py_rel,
            test_nb_rel,
            test_sub_rel,
            "src/voice_cloning/kaggle_synced/_test_sub_vocoder.py",
            "kaggle_workspace/working/_test_sub_vocoder.py",
        ):
            fp = PROJECT_ROOT / rel
            if fp.exists():
                fp.unlink()


def test_kaggle_working_path_redirected_into_real_project() -> None:
    """If a user mistakenly types `/kaggle/working/only_in_kaggle.py`, store redirects to `src/voice_cloning/`."""
    redirected_target = PROJECT_ROOT / "src" / "voice_cloning" / "only_in_kaggle.py"
    nb_target = PROJECT_ROOT / "notebooks" / "_temp_redirect.ipynb"
    try:
        resp = client.post(
            "/api/workspace/save",
            json={
                "raw_code": "print('saved in real project!')\n",
                "py_rel_path": "/kaggle/working/only_in_kaggle.py",
                "ipynb_rel_path": "notebooks/_temp_redirect.ipynb",
                "push_to_github": False,
            },
        )
        assert resp.status_code == 200
        assert redirected_target.exists()
    finally:
        for p in (redirected_target, nb_target):
            if p.exists():
                p.unlink()


def test_path_traversal_blocked() -> None:
    resp = client.get("/api/files/read?path=../../etc/passwd")
    assert resp.status_code == 400
