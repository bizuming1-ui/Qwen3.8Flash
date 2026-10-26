# 🎙️ Qwen3.8Flash — Kaggle 克隆语音系统与浏览器实验模拟器工作台

本项目为在 **Kaggle** 中开发**克隆语音系统 (Voice Cloning System)** 提供了一套完整的**浏览器端 Kaggle 模拟器 + 语音声学/合成/显存实验模拟器 + 真实项目仓库持久化与一键 GitHub 同步系统**。

## ✨ 核心特性（解决“不仅保存在 Kaggle，真实落盘项目并更新 GitHub”）

1. **📋 完整 Kaggle 代码一键粘贴与真实落盘 (`Tab 1`)**
   - 直接在浏览器模拟器中粘贴完整的 Kaggle 代码（支持单文件 `.py`、带 `# %%` / `!pip` / `!nvidia-smi` / `%%writefile` 的 Kaggle 多单元格代码、或完整 `.ipynb` JSON）。
   - **真实写入项目仓库磁盘**（绝不局限于浏览器 `localStorage` 或临时 `/kaggle/working`）：
     - 同步生成标准可运行 Python 模块：`src/voice_cloning/kaggle_main.py`（可自定义文件名）
     - 同步生成标准 Kaggle/Jupyter Notebook：`notebooks/kaggle_voice_cloning.ipynb`
     - 自动提取代码中所有 `%%writefile xxx.py` 子模块到 `src/voice_cloning/`
   - **一键同步 GitHub**：点击 **「💾 真实保存到项目并更新 GitHub」**，后台自动执行 `git add`、`git commit` 与 `git push` 更新远程 GitHub 仓库，并实时回显 SHA-256 落盘凭证与 Commit 链接。

2. **📓 Kaggle Notebook 多单元格交互模拟器 (`Tab 2`)**
   - 完整模拟 Kaggle 运行时环境：
     - `/kaggle/input`、`/kaggle/working`、`/kaggle/tmp` 软链映射至项目内 `kaggle_workspace/`
     - 虚拟 Kaggle GPU 硬件切换：`Tesla T4 x2 (2x 16GB)`、`P100 (16GB)`、`H100 (80GB)`、`CPU`
     - 原生支持 `!nvidia-smi`、`!pip install`、`%cd`、`%%writefile`、`kaggle_secrets.UserSecretsClient`
     - 内置 **Virtual PyTorch + Torchaudio + CUDA 模拟器**（基于 NumPy / SciPy / Librosa / SoundFile 真实音频信号处理驱动），在无物理 GPU 的轻量沙箱中也能直接运行 `import torch`、`import torchaudio`、`model.to("cuda")`、`MelSpectrogram`、`IPython.display.Audio`！
     - 运行时若脚本在 `/kaggle/working` 生成了 `.py/.json/.yaml` 代码配置文件，自动镜像同步回项目 `src/voice_cloning/kaggle_synced/`。

3. **🎛️ 克隆语音声学分析与合成实验模拟器 (`Tab 3`)**
   - 内置 3 种主流语音克隆架构流水线模拟与真实 DSP 合成：
     - **Zero-Shot Neural Codec LLM**（Qwen-TTS / CosyVoice 风格）
     - **Zero-Shot Flow-Matching DiT**（F5-TTS / E2-TTS 风格）
     - **Few-Shot Semantic-VITS**（GPT-SoVITS / VITS2 风格）
   - 支持提取参考音频 **256 维归一化声纹向量、F0 基频曲线、VAD 语音占比、80-Band Log-Mel 频谱**，生成可在线播放的 `.wav` 克隆语音，并计算 **SECS（音色余弦相似度）、MCD（梅尔倒谱失真 dB）、RTF（实时率）** 与张量维度追踪表。

4. **⚡ Kaggle GPU 显存预算与微调收敛模拟器 (`Tab 4`)**
   - 在消耗 Kaggle 每周 30 小时免费 GPU 配额前，提前模拟 LoRA / 全量微调、`fp16 / bf16 / fp32`、Batch Size 与最大音频时长下的单卡显存峰值、OOM 风险告警及多轮 Loss / SECS 收敛曲线，实验结果自动持久化至 `experiments/registry.json`。

5. **📁 项目真实文件树与 GitHub 控制中心 (`Tab 5`)**
   - 在浏览器内直接浏览、新建、编辑仓库任意文件并一键推送至 GitHub。

---

## 📂 项目目录结构

```text
Qwen3.8Flash/
├── run_studio.py                      # 浏览器模拟器 Web 服务启动入口 (0.0.0.0:8000)
├── requirements.txt                   # Python 依赖清单
├── pyproject.toml                     # 项目工程与 pytest 配置
├── scripts/
│   ├── bootstrap.sh                   # 一键安装环境、配置 /kaggle 软链与虚拟 nvidia-smi
│   └── sync_github.py                 # 命令行一键 git commit & push 工具
├── src/
│   └── voice_cloning/                 # 【真实保存】从浏览器粘贴同步的克隆语音项目源码
│       ├── config.py
│       └── kaggle_main.py
├── notebooks/                         # 【真实保存】双向同步的 Kaggle/Jupyter Notebook (.ipynb)
│   └── kaggle_voice_cloning.ipynb
├── simulators/                        # 内置实验模拟器与 Kaggle 模拟器核心库
│   ├── kaggle_sim/                    # Kaggle 路径/Secrets/Magic 解析/Virtual Torch+CUDA 执行内核
│   ├── voice_clone_sim/               # 语音克隆 DSP 合成引擎、声纹评估与显存模拟器
│   └── experiment_tracker/            # 本地实验注册表 (experiments/registry.json)
├── studio/                            # FastAPI 后端与浏览器交互工作台前端
├── kaggle_workspace/                  # 映射至 /kaggle/{input,working,tmp} 的本地工作目录
└── tests/                             # 自动化单元测试套件 (pytest)
```

---

## 🚀 快速启动

```bash
# 1. 初始化环境与 /kaggle 映射桥接
bash scripts/bootstrap.sh

# 2. 启动浏览器模拟器工作台 (默认监听 0.0.0.0:8000)
python3 run_studio.py

# 3. 运行全部自动化测试
pytest -v
```
