# -*- coding: utf-8 -*-
# Kaggle Voice Lab export — 语音克隆实验 · Kaggle 模板
# Notebook id : 语音克隆实验-Kaggle-模板
# Exported at : 2026-10-26T09:09:52.399Z
#
# This is a round-trippable "# %%" cell export of your Kaggle code.
# Copy it back into a Kaggle/Jupyter cell (or re-import it here) at any time.
# IPython magics (!pip, %time ...) are preserved VERBATIM: they need a notebook kernel.

# %% [markdown]
# # 🎙️ 语音克隆实验 · Kaggle Notebook 模板
#
# > **这是模板 / 模拟器**，不是可直接训练的完整模型。
# > 把你在 Kaggle 里写的完整代码通过顶部 **「导入完整 Kaggle 代码」** 粘贴进来；
# > 粘贴的内容会 **真实写入** `kaggle_workspace/notebooks/*.ipynb` 和 `*.py`，
# > 然后可以一键 **commit + push 到 GitHub**。
#
# 目录结构对应关系：
#
# | 本项目真实路径 | Kaggle 路径 |
# | --- | --- |
# | `kaggle_workspace/input/` | `/kaggle/input/` |
# | `kaggle_workspace/working/` | `/kaggle/working/` |
# | `kaggle_workspace/notebooks/` | 你的 Notebook 代码 |
#

# %%
# %% [setup] 环境与依赖
# 在 Kaggle 中运行时请打开 Internet / GPU；本项目的模拟器不会真的安装这些包。
import os, json, time, math, random
from pathlib import Path

INPUT_DIR  = Path("/kaggle/input")
OUTPUT_DIR = Path("/kaggle/working")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# !pip install -q torchaudio librosa soundfile speechbrain transformers
import numpy as np

try:
    import torch, torchaudio
    print("torch:", torch.__version__)
    print("cuda available:", torch.cuda.is_available())
    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
except ImportError:
    torch = None
    DEVICE = "cpu"
    print("[simulator] torch not installed locally — run this cell on Kaggle GPU.")

print("device =", DEVICE)
print("input dir =", INPUT_DIR)


# %%
# %% [config] 超参数
CONFIG = {
    "sample_rate": 24000,
    "n_fft": 1024,
    "hop_length": 256,
    "n_mels": 80,
    "speaker_embed_dim": 256,
    "batch_size": 16,
    "epochs": 30,
    "learning_rate": 2e-4,
    "val_split": 0.1,
    "seed": 42,
    "ref_audio": "/kaggle/input/my-voice/reference.wav",
    "checkpoint_dir": "/kaggle/working/checkpoints",
}
random.seed(CONFIG["seed"]); np.random.seed(CONFIG["seed"])
Path(CONFIG["checkpoint_dir"]).mkdir(parents=True, exist_ok=True)
(OUTPUT_DIR / "config.json").write_text(json.dumps(CONFIG, indent=2, ensure_ascii=False))
print(json.dumps(CONFIG, indent=2, ensure_ascii=False))


# %%
# %% [data] 参考音频 / 数据集检查
# 数据集挂载：左侧「数据集模拟器」可创建 /kaggle/input 的占位目录与元数据。
for p in sorted(INPUT_DIR.glob("*"))[:20]:
    print("dataset:", p.name, "(dir)" if p.is_dir() else "(file)")

wavs = list(INPUT_DIR.rglob("*.wav"))[:10]
print("found wav files:", len(wavs))
for w in wavs:
    print("  ", w)

# 音频预处理（示意）：重采样 -> 去静音 -> mel 频谱
def load_audio(path, sr=CONFIG["sample_rate"]):
    # import soundfile as sf; y, _ = sf.read(path)
    y = np.zeros(sr * 2, dtype=np.float32)   # placeholder
    return y

def mel_spectrogram(y):
    # import librosa
    # return librosa.feature.melspectrogram(y=y, sr=sr, n_mels=CONFIG["n_mels"])
    return np.random.rand(CONFIG["n_mels"], 100).astype(np.float32)

print("mel shape:", mel_spectrogram(load_audio(CONFIG["ref_audio"])).shape)


# %%
# %% [model] 说话人编码器 + 声学模型 + 声码器（结构示意）
# 常见方案：XTTS / OpenVoice / so-vits-svc / YourTTS
# 结构示意，替换为你的真实模型定义即可。
if torch is not None:
    import torch.nn as nn

    class SpeakerEncoder(nn.Module):
        def __init__(self, dim=CONFIG["speaker_embed_dim"]):
            super().__init__()
            self.net = nn.Sequential(nn.Linear(80, 512), nn.ReLU(), nn.Linear(512, dim))
        def forward(self, mel):
            return self.net(mel.mean(dim=-1))

    class AcousticModel(nn.Module):
        def __init__(self, n_mels=CONFIG["n_mels"], spk_dim=CONFIG["speaker_embed_dim"]):
            super().__init__()
            self.encoder = nn.LSTM(n_mels + spk_dim, 512, batch_first=True)
            self.decoder = nn.Linear(512, n_mels)
        def forward(self, mel, spk):
            b, _, t = mel.shape
            x = torch.cat([mel, spk.unsqueeze(-1).expand(-1, -1, t)], dim=1).transpose(1, 2)
            out, _ = self.encoder(x)
            return self.decoder(out).transpose(1, 2)

    print("SpeakerEncoder + AcousticModel defined.")
else:
    print("[simulator] skipping model definition (no torch).")


# %%
# %% [train] 训练循环（占位，真实训练请在 Kaggle GPU 上跑）
from tqdm.auto import tqdm

history = {"loss": [], "val_loss": [], "mel_loss": [], "lr": []}
for epoch in range(1, CONFIG["epochs"] + 1):
    # 你的真实训练步骤：dataloader -> forward -> loss -> backward -> optim.step()
    loss = 2.4 * math.exp(-epoch / 8) + 0.08 * random.random()
    val_loss = loss + 0.12 + 0.05 * random.random()
    history["loss"].append(round(loss, 5))
    history["val_loss"].append(round(val_loss, 5))
    history["mel_loss"].append(round(loss * 0.62, 5))
    history["lr"].append(CONFIG["learning_rate"] * (0.98 ** epoch))
    if epoch % 5 == 0 or epoch == 1:
        print(f"epoch {epoch:3d}/{CONFIG['epochs']}  loss={loss:.4f}  val={val_loss:.4f}")
        # torch.save(model.state_dict(), f"{CONFIG['checkpoint_dir']}/ckpt_{epoch:03d}.pt")

(OUTPUT_DIR / "metrics.json").write_text(json.dumps(history, indent=2))
print("training curve saved to /kaggle/working/metrics.json")


# %%
# %% [inference] 语音克隆推理与导出
text = "你好，这是语音克隆模型的合成示例。"
print("input text:", text)

# 你的真实推理：文本前端 -> 声学模型 -> 声码器 -> 波形
# speaker_embedding = speaker_encoder(mel_spectrogram(load_audio(CONFIG["ref_audio"])))
# waveform = vocoder(acoustic_model(text_features, speaker_embedding))
# torchaudio.save("/kaggle/working/cloned_voice.wav", waveform, CONFIG["sample_rate"])

result = {
    "text": text,
    "reference": CONFIG["ref_audio"],
    "sample_rate": CONFIG["sample_rate"],
    "output": "/kaggle/working/cloned_voice.wav",
    "note": "在 Kaggle GPU 上执行会得到真实音频；本地模拟器只生成日志与指标。",
}
(OUTPUT_DIR / "inference_result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps(result, indent=2, ensure_ascii=False))


# %% [markdown]
# ## ✅ 下一步
#
# 1. **导入你的完整 Kaggle 代码**：顶部「导入完整 Kaggle 代码」→ 粘贴 `.ipynb` JSON 或 `.py` 全文。
# 2. 代码会被保存为项目里的真实文件，左侧文件树可以点开查看。
# 3. 点「提交到 GitHub」把改动 commit + push 到当前分支。
# 4. 也可以直接把 `kaggle_workspace/notebooks/*.ipynb` 上传回 Kaggle 继续训练。
#
# > ⚠️ 模拟器里的日志、loss 曲线、GPU 指标都是 **模拟数据**，不代表真实训练结果。
#
