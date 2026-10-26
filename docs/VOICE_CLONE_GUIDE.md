# 语音克隆 · Kaggle 工程建议

> 这份文档是给**你正在做的 Kaggle 语音克隆系统**的工程参考，不是本模拟器的功能说明。
> 本仓库只负责把你的 Kaggle 代码**真实保存 + 版本管理 + 可视化**，不负责训练模型。

## 1. 典型语音克隆流水线

```
参考音频 (3–30 s)
      │
      ├─► 说话人编码器 (Speaker Encoder) ─► d-vector / x-vector (256-d)
      │                                          │
文本 ─► 文本前端 (音素/韵律) ─► 声学模型 (TTS / VC) ─┤─► mel 频谱
                                                     │
                                          声码器 (Vocoder) ─► 波形 .wav
```

三类主流路线（按你的目标选择）：

| 路线 | 代表方案 | 适合 | Kaggle 上要注意 |
| --- | --- | --- | --- |
| **Zero-shot TTS** | XTTS (Coqui)、CosyVoice、Fish Speech、VALL-E 类 | 几秒参考音频就能克隆音色 | 预训练权重通常几百 MB～数 GB，需 `Add Data` 挂载；T4 16 GB 一般够推理，训练要小 batch / 混合精度 |
| **歌声/语音转换 (SVC)** | so-vits-svc、RVC | 把已有语音的音色换成目标说话人 | 需要先做特征提取（Hubert / Whisper content vec），训练时长较长 |
| **音色嵌入 + 声码器** | OpenVoice、YourTTS、自定义 SpeakerEncoder + HiFi-GAN | 想自己掌控结构、做实验对比 | 便于在 Kaggle Notebook 里逐 cell 调试，适合本项目的 cell 结构 |

> 具体版本、许可和权重请在对应 GitHub 仓库确认后再用；本仓库模板里的 `SpeakerEncoder` / `AcousticModel`
> 只是**结构示意**，不是可直接训练的模型。

## 2. Kaggle 环境注意事项

- **会话限制**：Kaggle GPU 会话通常有总时长/单次运行时长上限，训练要能断点续训：
  每个 N epoch 把 `model.state_dict()` + `optimizer.state_dict()` + `epoch` 存到 `/kaggle/working/checkpoints/`。
- **持久化**：只有 `/kaggle/working` 会随 Notebook 版本保存；`/kaggle/input` 只读。
  这正是本项目把 `working/` 与 `input/` 分开建模的原因。
- **显存**：T4 16 GB。用 `torch.cuda.amp` / `bfloat16`、梯度累积、小 `batch_size`、定期 `torch.cuda.empty_cache()`。
- **日志**：把 `loss / val_loss / lr` 每个 epoch 写入 `/kaggle/working/metrics.json`，
  这样即使会话断开也能拿到曲线。本项目的模拟器就是照这个格式产出 `metrics.json`。
- **数据集**：把你的 `.wav` 打成 `Add Data` 数据集，路径固定成 `/kaggle/input/<slug>/`；
  在 Notebook 顶部用变量集中管理所有路径，方便粘贴到本项目后用静态分析自动识别。

## 3. 推荐的 Notebook 结构（与本模拟器的 cell 对应）

```python
# %% [1] 环境与依赖
# !pip install -q ...   ← Kaggle 内核魔法命令，本项目会原样保存
import os, json, torch, torchaudio, librosa, soundfile as sf

# %% [2] 配置（字面量超参，方便静态分析提取）
CONFIG = {"sample_rate": 24000, "n_mels": 80, "batch_size": 16,
          "epochs": 30, "lr": 2e-4, "seed": 42}
INPUT_DIR = "/kaggle/input/my-voice"
OUTPUT_DIR = "/kaggle/working"

# %% [3] 数据集检查 + 音频预处理
# 重采样 → 去静音 → 音量归一 → mel 频谱 → 划分 train/val

# %% [4] 模型定义
class SpeakerEncoder(torch.nn.Module): ...
class AcousticModel(torch.nn.Module): ...
# vocoder = load_hifigan(...)

# %% [5] 训练循环
# for epoch in ...: loss.backward(); optimizer.step(); 写 metrics.json / checkpoint

# %% [6] 推理与导出
# 文本前端 → speaker embedding → mel → 声码器 → torchaudio.save(cloned.wav)
```

在 Kaggle 里用 `# %%` 分段后，把整份 `.py` 粘贴进本模拟器，就能自动还原成多个 cell；
反过来在本项目里编辑后下载 `.ipynb` 也能直接在 Kaggle 跑。

## 4. 数据与评估

- **参考音频**：建议 10–30 秒、干净、单人、无背景音乐，24 kHz / 16-bit 以上。
- **客观指标**：mel 重建误差、MCD、F0 RMSE、说话人嵌入余弦相似度（衡量音色相似度）、
  WER/CER（用 Whisper 等 ASR 检查可懂度）。
- **主观**：MOS 评分、A/B 偏好测试。
- **复现**：固定 `seed`，记录 `git commit`、数据集版本、依赖版本与完整 `CONFIG`。

## 5. 合规与伦理（重要）

语音克隆技术很容易被滥用。请务必：

- 只克隆**你本人或已获得明确书面授权**的说话人的声音；
- 在合成音频/产品里明确标注「AI 生成」；
- 不要用于冒充、诈骗、绕过声纹验证或传播虚假信息；
- 遵守所在司法辖区关于声音权、人格权、深度合成标识的规定，以及所用数据集/模型的许可证
  （例如 VCTK、LibriTTS 的 CC BY 4.0，部分预训练模型的非商业条款）。

## 6. 本项目能帮到你的部分

| 痛点 | 本项目做法 |
| --- | --- |
| Kaggle 代码没有版本历史 | 每次导入/编辑都落盘，一键 commit + push 到 GitHub |
| 想对比不同实验配置 | 每个 notebook 一个 `.ipynb`，`working/runs/<id>/config.json` 记录静态分析出的超参 |
| 想检查代码引用了哪些数据集 | 静态分析自动列出 `/kaggle/input/...` 路径 |
| 想快速看训练流程长什么样 | 模拟运行产出 SSE 日志 + loss 曲线（**注意是模拟值**） |
| 想回到 Kaggle 继续训练 | 下载标准 `.ipynb` 直接导入 Kaggle |
