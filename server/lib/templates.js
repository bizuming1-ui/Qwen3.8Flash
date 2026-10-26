'use strict';
/**
 * templates.js — seed content for the lab: a voice-cloning Kaggle notebook
 * skeleton, a simulated /kaggle/input dataset catalogue and a simulated
 * Kaggle runtime description. All clearly marked as templates/simulations.
 */

const C = (source) => ({ type: 'code', source: source.trim() + '\n' });
const M = (source) => ({ type: 'markdown', source: source.trim() + '\n' });

const VOICE_CLONE_CELLS = [
  M(`
# 🎙️ 语音克隆实验 · Kaggle Notebook 模板

> **这是模板 / 模拟器**，不是可直接训练的完整模型。
> 把你在 Kaggle 里写的完整代码通过顶部 **「导入完整 Kaggle 代码」** 粘贴进来；
> 粘贴的内容会 **真实写入** \`kaggle_workspace/notebooks/*.ipynb\` 和 \`*.py\`，
> 然后可以一键 **commit + push 到 GitHub**。

目录结构对应关系：

| 本项目真实路径 | Kaggle 路径 |
| --- | --- |
| \`kaggle_workspace/input/\` | \`/kaggle/input/\` |
| \`kaggle_workspace/working/\` | \`/kaggle/working/\` |
| \`kaggle_workspace/notebooks/\` | 你的 Notebook 代码 |
  `),
  C(`
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
  `),
  C(`
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
  `),
  C(`
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
  `),
  C(`
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
  `),
  C(`
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
  `),
  C(`
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
  `),
  M(`
## ✅ 下一步

1. **导入你的完整 Kaggle 代码**：顶部「导入完整 Kaggle 代码」→ 粘贴 \`.ipynb\` JSON 或 \`.py\` 全文。
2. 代码会被保存为项目里的真实文件，左侧文件树可以点开查看。
3. 点「提交到 GitHub」把改动 commit + push 到当前分支。
4. 也可以直接把 \`kaggle_workspace/notebooks/*.ipynb\` 上传回 Kaggle 继续训练。

> ⚠️ 模拟器里的日志、loss 曲线、GPU 指标都是 **模拟数据**，不代表真实训练结果。
  `),
];

/** Simulated dataset catalogue (mounting creates REAL metadata files, no download). */
const DATASET_CATALOG = [
  {
    id: 'my-voice', name: '我的参考语音 (自定义)', subtitle: 'ref audio · 10 wav / 3 分钟',
    license: 'private', bytes: '18.4 MB',
    files: ['reference.wav', 'sample_001.wav', 'sample_002.wav', 'transcript.txt', 'metadata.csv'],
    description: '用于 few-shot 语音克隆的目标说话人参考音频。请把自己的音频放到 /kaggle/input/my-voice/。',
  },
  {
    id: 'ljspeech', name: 'LJSpeech-1.1', subtitle: '13,100 clips · 24 h · 22.05 kHz',
    license: 'public domain', bytes: '2.6 GB',
    files: ['metadata.csv', 'wavs/LJ001-0001.wav', 'wavs/LJ001-0002.wav', 'README'],
    description: '单人英文语音数据集，常用于 TTS / 声码器预训练。',
  },
  {
    id: 'vctk-corpus', name: 'VCTK Corpus', subtitle: '110 speakers · 44 h · 48 kHz',
    license: 'CC BY 4.0', bytes: '11.2 GB',
    files: ['speaker-info.txt', 'txt/p225/p225_001.txt', 'wav48/p225/p225_001.wav'],
    description: '多说话人数据集，适合训练说话人编码器 / 多说话人 TTS。',
  },
  {
    id: 'libritts', name: 'LibriTTS train-clean-100', subtitle: '247 speakers · 100 h',
    license: 'CC BY 4.0', bytes: '6.3 GB',
    files: ['100/121/121_000001_000000.flac', '100/121/121_000001_000000.normalized.txt'],
    description: '从 LibriSpeech 派生的多说话人 TTS 语料。',
  },
  {
    id: 'hifigan-vocoder', name: 'HiFi-GAN 预训练权重', subtitle: 'universal vocoder · 24 kHz',
    license: 'MIT', bytes: '54 MB',
    files: ['generator_v1', 'generator_v2', 'config.json', 'checkpoint.pth.tar'],
    description: '声码器权重占位；本项目只保存元数据，不下载真实权重。',
  },
];

/** Simulated Kaggle runtime shown in the right-hand environment panel. */
const KAGGLE_ENV = {
  platform: 'Kaggle Notebooks (simulated)',
  accelerator: '2 × NVIDIA Tesla T4 · 16 GB GDDR6 each',
  cpu: 'Intel Xeon 2.30 GHz · 4 vCPU',
  ram: '29.3 GB',
  disk: '19.4 GB free / 20 GB',
  python: '3.11.2',
  os: 'Debian 12 (container)',
  internet: 'off (Kaggle default)',
  maxSession: '12 h',
  packages: [
    'torch 2.5.1+cu121', 'torchaudio 2.5.1', 'librosa 0.10.2', 'soundfile 0.12.1',
    'numpy 2.1.3', 'scipy 1.14.1', 'transformers 4.46.3', 'speechbrain 1.0.2',
    'matplotlib 3.9.2', 'pandas 2.2.3', 'tqdm 4.67.0', 'ffmpeg 6.1',
  ],
  note: '以上硬件/包信息为模拟器展示值，不是本沙箱的真实硬件。真实 Node/Python 版本见「关于」页。',
};

module.exports = { VOICE_CLONE_CELLS, DATASET_CATALOG, KAGGLE_ENV };
