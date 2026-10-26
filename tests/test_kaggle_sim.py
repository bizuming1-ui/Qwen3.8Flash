"""Tests for Kaggle Runtime, Magic Parser, Virtual Torch/CUDA, and Stateful Executor."""

from __future__ import annotations

from pathlib import Path

from simulators.kaggle_sim import (
    KaggleCell,
    KaggleCodeExecutor,
    cells_to_ipynb,
    cells_to_python_module,
    get_kaggle_runtime,
    parse_kaggle_paste,
)
from simulators.kaggle_sim.magic_parser import extract_writefiles
from simulators.kaggle_sim.torch_cuda_mock import install_torch_cuda_simulator


def test_parse_kaggle_paste_and_writefile_extraction() -> None:
    raw = """
# %% 环境检查
!nvidia-smi
!pip install torch torchaudio einops

# %%
%%writefile /kaggle/working/prosody_net.py
class ProsodyNet:
    def encode(self, x):
        return x * 2
"""
    cells = parse_kaggle_paste(raw)
    assert len(cells) >= 2

    wfs = extract_writefiles(cells, default_pkg_dir="src/voice_cloning")
    assert len(wfs) == 1
    assert wfs[0].project_rel_path == "src/voice_cloning/prosody_net.py"
    assert "class ProsodyNet" in wfs[0].content

    # Round-trip to valid Python and compile check
    py_mod = cells_to_python_module(cells)
    compile(py_mod, "<test_kaggle_module>", "exec")

    # Round-trip to .ipynb and back
    ipynb_str = cells_to_ipynb(cells, accelerator="T4x2")
    parsed_back = parse_kaggle_paste(ipynb_str)
    assert len(parsed_back) == len(cells)
    assert "!nvidia-smi" in parsed_back[0].source


def test_virtual_torch_and_torchaudio_pipeline(tmp_path: Path) -> None:
    rt = get_kaggle_runtime()
    rt.update_state(accelerator="T4x2", enable_torch_shim=True)
    install_torch_cuda_simulator(force=True)

    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    import torchaudio

    assert torch.cuda.is_available() is True
    assert torch.cuda.device_count() == 2
    assert "T4" in torch.cuda.get_device_name(0)

    # Create synthetic waveform, save & reload via torchaudio
    wav_in = torch.sin(torch.linspace(0, 100.0, 24000)).unsqueeze(0)
    wav_file = tmp_path / "test_voice.wav"
    torchaudio.save(str(wav_file), wav_in, 24000)
    assert wav_file.exists()

    loaded, sr = torchaudio.load(str(wav_file))
    assert sr == 24000
    assert loaded.shape[0] == 1

    mel_tf = torchaudio.transforms.MelSpectrogram(sample_rate=24000, n_mels=80)
    mel = mel_tf(loaded).cuda()
    assert mel.shape[0] == 1 and mel.shape[1] == 80

    net = nn.Sequential(
        nn.Conv1d(80, 128, kernel_size=3, padding=1),
        nn.GELU(),
    ).cuda()
    feat = net(mel)
    emb = F.relu(nn.Linear(128, 256).cuda()(feat.mean(dim=-1)))
    assert emb.shape == (1, 256)


def test_executor_stateful_cells_and_secrets() -> None:
    rt = get_kaggle_runtime()
    rt.update_state(accelerator="T4x2", enable_torch_shim=True)
    rt.set_secret("TEST_VOICE_KEY", "secret_ok_123")

    ex = KaggleCodeExecutor(runtime=rt)
    res1 = ex.execute_cell(
        KaggleCell(
            id="c1",
            cell_type="code",
            source="from kaggle_secrets import UserSecretsClient\nval = UserSecretsClient().get_secret('TEST_VOICE_KEY')\nprint('SECRET:', val)",
        )
    )
    assert res1["status"] == "ok"
    assert "SECRET: secret_ok_123" in res1["stdout"]

    res2 = ex.execute_cell(
        KaggleCell(
            id="c2",
            cell_type="code",
            source="print('PERSISTED:', val.upper())",
        )
    )
    assert res2["status"] == "ok"
    assert "PERSISTED: SECRET_OK_123" in res2["stdout"]
    rt.delete_secret("TEST_VOICE_KEY")
