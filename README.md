# 🎙️ Qwen3.8Flash · 语音克隆 Kaggle 模拟器（Voice Lab）

把你在 **Kaggle 里开发语音克隆系统** 的整套流程，搬进浏览器并**真实保存到本 GitHub 项目**：

- 📓 **Kaggle Notebook 模拟器**：把 Kaggle 的完整代码（`.ipynb` / `.py`）直接粘贴进来 → 自动拆格 → 浏览器里运行 Python（变量跨格、支持 `!pip`、`%cd`、`/kaggle/working` 路径自动翻译）→ 保存为项目内真实的 `notebooks/*.ipynb` + `*.py` 双格式文件。
- 🎙️ **语音克隆实验模拟器**：上传/浏览器录制参考声音 → 调参（语言/相似度/temperature/语速/音高）→ 合成 → 波形 + **真实 STFT 频谱图** + 指标 → 每次实验自动落盘到 `experiments/<时间-编号>/`（`config.json` + `cloned.wav` + `reference.wav` + `spectrogram.png`）。
- ⬆️ **一键进 GitHub**：界面顶部「💾 提交到项目 → ⬆️ 推送 GitHub」直接对当前分支执行 `git add/commit/push`。**成果只存在项目仓库里，Kaggle 会话销毁也不丢。**
- 🧩 **零依赖**：模拟器只用 Python 3.10+ 标准库，本地/Kaggle/任何机器 `python3 server.py` 即跑，不用配环境。

> ⚠️ 关于“克隆音质”：当前内置引擎是 **DSP 管线模拟器**（`src/audio_sim.py`，基频+谐波+共振峰伪合成，分析/频谱是真 DSP），用来在无 GPU 时跑通完整实验链路。真实 Qwen3-TTS 克隆需要 GPU + 模型权重，请在 Kaggle 里运行你的推理代码，或把 `src/audio_sim.py::synthesize_with_model()` 替换为你的模型调用（见 `notebooks/01_qwen3_voice_clone_template.py` 第 6 格 [真实模型区]）。

## ⏱️ 快速开始

```bash
python3 server.py                # 打开 http://localhost:8000
python3 server.py --port 7860    # 自定义端口
python3 -m unittest discover -s tests -v   # 冒烟测试
```

**导入你的 Kaggle 代码（3 步）**：① Kaggle 里 `File → Download Notebook (.ipynb)`；② 打开本界面左上「📥 粘贴我的完整 Kaggle 代码导入」，选文件或整段粘贴；③ 逐个 ▶ 运行格子，最后点顶部「💾 提交到项目 → ⬆️ 推送 GitHub」。

## 📁 目录说明（全部真实进 Git）

| 路径 | 含义 |
|---|---|
| `server.py` | 零依赖模拟器服务器（静态页面 + JSON API） |
| `web/` | 浏览器模拟器界面（Notebook / 语音克隆实验室 / 实验记录） |
| `src/kaggle_compat.py` | `/kaggle/input`、`/kaggle/working` ↔ 项目真实目录映射（`kpath()`） |
| `src/kernel.py` | Jupyter 风格 Python 内核（按会话保持变量、`!shell`、`%magic` 兼容） |
| `src/audio_sim.py` | 语音克隆 DSP 模拟合成 + 真实分析（音高/RMS/STFT 频谱）+ 真实模型接入点 |
| `src/store.py` | Notebook / 实验记录的真实落盘（`.ipynb`+`.py` 双写） |
| `notebooks/` | 你的 Notebook（含开箱模板 `01_qwen3_voice_clone_template`） |
| `kaggle/input/` | 数据集/参考音频（模板附带 `sample-ref.wav` 示例参考音） |
| `kaggle/working/` | 代码产出（和 Kaggle 一样是默认工作目录） |
| `experiments/` | 每次克隆合成的实验记录 |
| `requirements-kaggle.txt` | 真实 Kaggle GPU 环境参考依赖 |

## 🔁 模拟器 ↔ Kaggle 互通约定

| Kaggle 代码习惯 | 本模拟器行为 |
|---|---|
| `/kaggle/input/xxx`、`/kaggle/working/xxx` | `kpath("/kaggle/working/xxx")` 自动翻译；`!ls /kaggle/working` 命令行亦自动翻译；也可点左栏「创建 /kaggle 软链」 |
| `!pip install ...` | 真实执行（装到当前 Python 环境；无网络/权限时会如实报错） |
| 默认 cwd = `/kaggle/working` | 已模拟：每格运行前切到 `kaggle/working/` |
| GPU T4/P100、12h 会话 | 界面有模拟标签与会话计时；实际执行用本机 CPU，torch CUDA 代码请去 Kaggle 跑 |
| Kaggle → 本地持久化 | 下载 `.ipynb`/Output 后导入本界面保存；或在 Kaggle `git clone` 本仓 + Secrets 配 token 直接 push |

## 🔌 API 速查

`GET /api/status` · `GET/POST /api/notebooks(/save|/import|/delete)` · `POST /api/kernel/run|reset` ·
`POST /api/upload`（base64 上载数据集）· `GET /api/files` · `GET /api/file?path=/kaggle/working/cloned.wav` ·
`POST /api/synth` · `GET /api/experiments` · `GET /api/spectrogram?path=...` · `POST /api/git/commit|push`

## 🔒 安全提示

模拟器执行的是**你自己的 Python 代码**（与本地 Jupyter 相同权限）。只在本机/可信网络运行，
不要对公网开放端口。`*.pt/*.safetensors` 等大权重已在 `.gitignore` 排除，权重请用 Kaggle Dataset / GitHub Release / LFS。
