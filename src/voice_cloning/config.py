"""Core Configuration for Voice Cloning System (Kaggle & Local Project Compatible)."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Any


@dataclass
class VoiceCloningConfig:
    project_name: str = "Qwen3.8Flash-VoiceCloning"
    architecture: str = "qwen_cosyvoice_codec"
    sample_rate: int = 24000
    n_fft: int = 1024
    hop_length: int = 256
    win_length: int = 1024
    n_mels: int = 80
    speaker_embed_dim: int = 256
    hidden_dim: int = 512
    kaggle_input_dir: str = "/kaggle/input/sample-voice-dataset"
    kaggle_working_dir: str = "/kaggle/working"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @property
    def resolved_input_dir(self) -> Path:
        p = Path(self.kaggle_input_dir)
        if p.exists():
            return p
        return Path(__file__).resolve().parents[2] / "kaggle_workspace" / "input" / "sample-voice-dataset"
