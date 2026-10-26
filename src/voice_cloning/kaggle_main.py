# %% [KAGGLE_STUDIO_RUNTIME_BOOTSTRAP]
"""Auto-synced Kaggle Voice Cloning Project Script (Real Project Persistence)."""
from simulators.kaggle_sim.executor import run_magic_inline as _kaggle_magic, writefile_inline as _kaggle_writefile

# %% [markdown] 项目说明
# # 🎙️ Kaggle 克隆语音系统 (Qwen3.8Flash Studio)
# 提示：点击顶部 **「📋 一键粘贴完整 Kaggle 代码」** 即可将您在 Kaggle 中的完整代码粘贴进来。
# 所有代码都会 **真实写入本项目仓库 (`src/voice_cloning/` 与 `notebooks/`)**，并支持一键 `git commit & push` 同步到 GitHub！

# %% 1. 检查 Kaggle GPU 与输入数据集环境
_kaggle_magic('!nvidia-smi')  # [KAGGLE_MAGIC_RAW] !nvidia-smi
import os
from pathlib import Path
import torch
import torchaudio

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f'Active Device: {device} | GPU Count: {torch.cuda.device_count()}')
input_dir = Path('/kaggle/input/sample-voice-dataset')
print('Kaggle Input Files:', [p.name for p in sorted(input_dir.glob('*'))])

# %% 2. 定义音色编码器与声学克隆网络 (PyTorch + Torchaudio)
import torch.nn as nn
import torch.nn.functional as F

class SpeakerTimbreEncoder(nn.Module):
    def __init__(self, n_mels: int = 80, embed_dim: int = 256):
        super().__init__()
        self.conv1 = nn.Conv1d(n_mels, 256, kernel_size=5, padding=2)
        self.conv2 = nn.Conv1d(256, 256, kernel_size=3, padding=1)
        self.proj = nn.Linear(256, embed_dim)

    def forward(self, mel: torch.Tensor) -> torch.Tensor:
        h = F.gelu(self.conv1(mel))
        h = F.gelu(self.conv2(h))
        pooled = h.mean(dim=-1)
        emb = self.proj(pooled)
        return emb / (emb.norm(dim=-1, keepdim=True) + 1e-8)

encoder = SpeakerTimbreEncoder().to(device)
mel_extractor = torchaudio.transforms.MelSpectrogram(sample_rate=24000, n_mels=80)
print('SpeakerTimbreEncoder ready on:', device)

# %% 3. 提取参考语音特征并运行零样本语音克隆实验
from IPython.display import Audio, display
from simulators.voice_clone_sim import run_voice_cloning_simulation

ref_wav_path = '/kaggle/input/sample-voice-dataset/speaker_female_clear.wav'
waveform, sr = torchaudio.load(ref_wav_path)
mel = mel_extractor(waveform).to(device)
spk_emb = encoder(mel)
print(f'Reference Waveform: {waveform.shape} @ {sr}Hz -> Mel: {mel.shape} -> Speaker Emb: {spk_emb.shape}')

sim_res = run_voice_cloning_simulation(
    ref_audio_path=ref_wav_path,
    target_text='你好，这是在Kaggle模拟器中运行的零样本语音克隆系统，代码已真实保存到项目仓库。',
    architecture_id='qwen_cosyvoice_codec',
)
print('Cloned Output Saved:', sim_res['cloned_kaggle_path'])
print('Metrics:', sim_res['metrics'])
display(Audio(filename=sim_res['cloned_kaggle_path'], rate=sr))
