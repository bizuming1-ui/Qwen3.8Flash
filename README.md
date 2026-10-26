# Kaggle Voice Lab · 语音克隆实验模拟器 + QTTS 网站复刻

> 在浏览器里粘贴**完整的 Kaggle 代码**，它会立刻变成这个 Git 仓库里的**真实文件**，
> 并且可以一键 **commit + push 到 GitHub**。
> 运行时的日志 / loss 曲线 / GPU 指标是**模拟器生成**的，但你的代码、笔记本、实验记录都是**真实落盘**的。

> 🆕 **已从你粘贴的 `kaggle.ipynb` 中解包出 70 个 SHA-256 校验过的源码资产**，
> 并把其中 4 个网站文件**字节级原样**复刻到 `/site/`（QTTS · 双 T4 声音台），
> 配上 Node 实现的 **38 个兼容 API**，网站所有功能在本地都能操作。
> 详见 [网站复刻研究报告](docs/REPLICA.md)。
>
> 🔬 **继续精准开发**：已把 `go/gateway/segmenter.go`（呼吸组分段）、
> `py/step18_audio_rt.py` + `py/worker.py`（五种音量 DSP）、`go/gateway/security.go`
> （准入限流）、`go/gateway/monitor.go`（诊断脱敏）逐行移植到 Node，
> 并补齐 worker → gateway → 浏览器的**双层二进制帧**与原始 `state/` 磁盘布局。
> 浏览器新增「🔬 精准对照」视图可在线运行 4 组探针，详见 [精准开发报告](docs/PRECISION.md)。

[![branch](https://img.shields.io/badge/branch-arena%2F3de266c9--qwen3--8flash-blue)](#) [![runtime](https://img.shields.io/badge/node-%E2%89%A518-339933)](#)

---

## 为什么做这个

你在 Kaggle 里开发语音克隆系统，代码只存在于 Kaggle 的 Notebook 里 —— 一旦会话丢失、notebook 被覆盖、
或者想做版本管理 / 本地检视，就很麻烦。这个项目提供一个**本地 Kaggle 浏览器模拟器**：

- ✅ 把 `.ipynb` JSON、`.py` 全文或任意代码文本粘贴进来 → 保存为标准 `nbformat 4` 的 `.ipynb` + 可往返的 `.py`
- ✅ 每次编辑自动保存（默认 1.2 秒）到仓库磁盘，**不是 localStorage，不是只存在 Kaggle**
- ✅ 一键 `git add -A && git commit && git push origin HEAD`，真实更新 GitHub
- ✅ 提供 Kaggle 笔记本单元格编辑、环境/数据集/训练实验三类模拟器
- ✅ 「复制 Kaggle」会从仓库读取并复制完整单 cell `kaggle.py`（剪贴板受限时可全选或下载）；网站复刻不要求手填 DeepSeek API key
- ✅ 参考音频处理结果提供一个完整转写文本框；模拟器生成的占位文本明确标示为模拟，内部锚点片段默认收起
- ⚠️ 但**不会**假装真的训练模型：所有 loss、显存、epoch 日志都明确标注 `SIMULATED`

---

## 快速开始

```bash
cd Qwen3.8Flash
npm install        # 只有 1 个依赖：CodeMirror 5；postinstall 会把编辑器文件复制到 server/public/vendor/
npm start          # 监听 0.0.0.0:3000
```

然后打开 `http://localhost:3000`（在 Arena 里会直接显示 live preview）。
**运行时不需要 npm 依赖、不需要 CDN、不需要联网** —— 编辑器文件已随仓库一起提交。

```bash
PORT=8080 npm start                    # 换端口
ENABLE_LOCAL_PYTHON=1 npm start        # 可选：允许真实执行轻量 Python 片段（默认关闭，见安全说明）
npm run extract                         # 从 kaggle.ipynb 重新解包 + SHA-256 校验 70 个源码资产
npm run check                           # 语法检查所有服务端 JS
npm test                                # 86 项：语法 + HTTP 契约 + 浏览器(jsdom) 端到端
npm run seed                            # 从命令行再生成一份语音克隆模板 notebook
```

---

## 三步把 Kaggle 代码搬进项目

1. 在 Kaggle 里打开你的 Notebook，`File → Download` 得到 `.ipynb`（或者直接全选代码复制）。
2. 在模拟器顶部点 **「⬇ 导入完整 Kaggle 代码」**，粘贴内容（也可以拖入 `.ipynb` / `.py` 文件）。
   - 粘贴 `.ipynb` JSON → 恢复全部 cell（含 Markdown 与已有输出）
   - 粘贴 `.py` → 按 `# %%` / `# In[]` 分隔符拆成 cell
   - 没有分隔符 → **完整保留为 1 个 cell**，绝不静默改写你的代码
3. 点 **「只保存到项目」** 或 **「保存并提交到 GitHub」**。
   如果希望**以后每次粘贴代码都自动更新 GitHub**，勾选导入窗口里的
   「以后每次导入都自动 commit + push 到 GitHub」（设置保存在 `kaggle_workspace/settings.json`）。

生成的文件：

```
kaggle_workspace/notebooks/<名称>.ipynb   ← 可直接上传回 Kaggle / Jupyter 打开
kaggle_workspace/notebooks/<名称>.py      ← "# %%" cell 导出，可重新导入本系统
```

> 💡 想回到 Kaggle 继续真训练：左侧「项目文件」点 `.ipynb` 下载，然后在 Kaggle
> `File → Upload Notebook` 或新建 Notebook 后 `File → Import Notebook` 上传即可。

---

## 五个模拟器

| 模拟器 | 作用 | 是否真实 |
| --- | --- | --- |
| **Kaggle 笔记本模拟器** | cell 编辑（CodeMirror）、Markdown 渲染、运行按钮、输出区、`/kaggle/input` 与 `/kaggle/working` 文件树、自动保存 | 文件与编辑**真实** |
| **环境模拟器** | 模拟 T4×2 GPU、CPU/RAM/磁盘仪表、会话计时、预装包清单、代码静态分析（框架 / 超参 / 数据路径 / 提示） | 硬件数值**模拟**，静态分析**真实** |
| **数据集模拟器** | 挂载 LJSpeech / VCTK / LibriTTS / 自定义参考语音，在 `input/` 下创建 `dataset-metadata.json`、`README.md`、`files.txt` | 只创建**占位元数据**，不下载 GB 级音频 |
| **训练实验模拟器** | 基于你的代码静态分析结果，流式（SSE）产生日志、loss 曲线、lr、产物清单，并写入 `working/runs/<id>/` 和 `experiments/<id>.json` | 日志 / 指标**模拟**，产物文件**真实** |
| **QTTS 网站复刻** | `/site/` = 你 Kaggle 代码内嵌网站的**原始字节**；`/lab/` 的「🌐 网站复刻」页一键签发私有入口、内嵌原站；后端 38 个接口全部可用 | 前端**字节一致**，后端契约一致，音频/模型为模拟 |

右侧「Git 状态」和顶部「提交到 GitHub」不是模拟器 —— 它们调用真实的 `git`。

### 网站复刻的四个新页面

在实验室顶部切换：

- **🌐 网站复刻** — 生成一次性私有入口（grant → HttpOnly 会话），iframe 内直接跑原站；
  也支持新标签打开和 Bearer 手动口令。
- **🧬 源码资产** — 浏览 `replica/source/` 全部 70 个 Go/Python/Rust/JS 文件，
  在线重算 SHA-256 校验。
- **🔌 API 兼容矩阵** — 列出 38 个端点的原始来源（Go gateway / Python analyst /
  library_api / diagnostic_pair）与实现状态。
- **🔬 精准对照** — 在线运行 Go 分段器、5 种 Python DSP 策略、双层帧检视器、
  worker/Guard/落盘快照；结果与原始源码算法逐项对照（见 `docs/PRECISION.md`）。

---

## 目录结构

```
Qwen3.8Flash/
├── server/
│   ├── index.js                 # HTTP 服务：静态资源 + REST API + SSE 流
│   ├── lib/
│   │   ├── workspace.js         # 唯一的磁盘写入口（路径越权防护、原子写）
│   │   ├── notebook.js          # .ipynb ⇄ cells ⇄ .py 转换 / 导入 / CRUD
│   │   ├── templates.js         # 语音克隆模板 + 数据集目录 + Kaggle 环境描述
│   │   ├── datasets.js          # /kaggle/input 数据集挂载
│   │   ├── simulator.js         # 静态分析 + 模拟运行事件 + 产物落盘
│   │   └── git.js               # 真实 git status / commit / push
│   └── public/                  # 浏览器 UI（index.html / styles.css / app.js）
│       └── vendor/              # 本地 CodeMirror 5（无 CDN）
│   ├── replica/                 # ★ Node 版 Go gateway + Python worker 精确移植
│   │   ├── segmenter.js         #   go/gateway/segmenter.go 呼吸组分段
│   │   ├── dsp.js               #   step18_audio_rt.py + worker.py 五种音量策略
│   │   ├── limits.js            #   security.go 令牌桶 / 并发槽 / validateSpeak
│   │   ├── diagnostics.js       #   monitor.go 字段白名单脱敏
│   │   ├── workers.js           #   worker.py 的 /health /profile/load /synth
│   │   ├── protocol.js          #   worker(5B) → gateway → browser(9B) 双层帧
│   │   └── store.js             #   active.json / profiles / libraries / runs 落盘
├── scripts/                     # extract-kaggle-assets / check / test-* / seed
├── kaggle_workspace/            # ★ 你的所有真实数据都在这里，会被提交到 GitHub
│   ├── notebooks/               # 你的 Kaggle 代码（.ipynb + .py）
│   ├── input/                   # 模拟 /kaggle/input
│   ├── working/                 # 模拟 /kaggle/working（日志、指标、配置）
│   └── experiments/             # 每次模拟运行的记录
├── replica/                     # ★ 从 Kaggle 代码解包的真实源码（70 个已校验资产）
│   ├── asset-manifest.json      #   路径 / 字节 / SHA-256 / 校验结果
│   ├── source/                  #   go/ py/ rust/ tools/ web/ 全部原始文件
│   └── web/                     #   4 个网站文件（与 Kaggle 内嵌资源字节一致）
├── docs/
│   ├── REPLICA.md               # ★ QTTS 网站复刻 · 代码研究报告
│   ├── PRECISION.md             # ★ 精准开发报告 · 逐算法移植对照
│   ├── ARCHITECTURE.md          # 架构、API、持久化与安全设计
│   ├── USAGE.md                 # 详细使用说明 / 快捷键 / FAQ
│   └── VOICE_CLONE_GUIDE.md     # 语音克隆在 Kaggle 上的工程建议
└── README.md
```

---

## 诚实声明（重要）

- 这里的 GPU（Tesla T4 ×2）、显存、loss 曲线、epoch 时间、预装包版本都是**模拟展示值**，
  本沙箱没有 GPU，也不会执行你的训练代码。日志里全部带 `SIMULATED` 标识。
- `/site/` 的网站文件是**原样字节**，但它调用的后端是本地兼容实现：
  语音是**合成音**、聊天回复是**本地模拟文本**、双卡 worker 是**模拟快照**，
  所有回执都标注 `simulated:true` / `quality_verified:false`。真实音质必须回 Kaggle 双 T4 验证。
- `.ipynb` 中的输出如果来自模拟运行，会带有 `[SIMULATED]` 前缀，metadata 里
  `kaggle_lab.simulatedOutputs = true`。
- `ENABLE_LOCAL_PYTHON=1` 才会启用「真实本地 Python 执行」接口，默认关闭。
  即使开启也**只适合无副作用的小片段**（15 秒超时、独立工作目录、无模型权重）。
- 「复制 Kaggle」只负责复制仓库中的完整单 cell 脚本，不代表训练已启动或成功。本次实现尚未把“录音/上传 → ASR 全文 → 一键真实训练”接成 Kaggle 端到端流程；CPU + 双 T4 实际训练也尚未在 Kaggle 验证。训练代码/模型质量不能用本地模拟器的结果代替。

---

## 文档

- 🌐 [QTTS 网站复刻 · 代码研究报告](docs/REPLICA.md) ← 你的 Kaggle 代码到底做了什么
- 🔬 [精准开发报告](docs/PRECISION.md) ← 分段 / DSP / 限流 / 脱敏 / 双层帧如何逐行移植
- 📘 [使用说明（含快捷键与 FAQ）](docs/USAGE.md)
- 🏗 [架构与 API 设计](docs/ARCHITECTURE.md)
- 🎙 [语音克隆 Kaggle 工程建议](docs/VOICE_CLONE_GUIDE.md)

---

**分支**：`arena/3de266c9-qwen3-8flash` · **更新 GitHub**：界面右上角「☁ 提交到 GitHub」→「🚀 提交并推送」。
