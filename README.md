# Kaggle Voice Lab · 语音克隆实验模拟器

> 在浏览器里粘贴**完整的 Kaggle 代码**，它会立刻变成这个 Git 仓库里的**真实文件**，
> 并且可以一键 **commit + push 到 GitHub**。
> 运行时的日志 / loss 曲线 / GPU 指标是**模拟器生成**的，但你的代码、笔记本、实验记录都是**真实落盘**的。

[![branch](https://img.shields.io/badge/branch-arena%2F3de266c9--qwen3--8flash-blue)](#) [![runtime](https://img.shields.io/badge/node-%E2%89%A518-339933)](#)

---

## 为什么做这个

你在 Kaggle 里开发语音克隆系统，代码只存在于 Kaggle 的 Notebook 里 —— 一旦会话丢失、notebook 被覆盖、
或者想做版本管理 / 本地检视，就很麻烦。这个项目提供一个**本地 Kaggle 浏览器模拟器**：

- ✅ 把 `.ipynb` JSON、`.py` 全文或任意代码文本粘贴进来 → 保存为标准 `nbformat 4` 的 `.ipynb` + 可往返的 `.py`
- ✅ 每次编辑自动保存（默认 1.2 秒）到仓库磁盘，**不是 localStorage，不是只存在 Kaggle**
- ✅ 一键 `git add -A && git commit && git push origin HEAD`，真实更新 GitHub
- ✅ 提供 Kaggle 笔记本单元格编辑、环境/数据集/训练实验三类模拟器
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
npm run check                           # 语法检查所有服务端 JS
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

## 四个模拟器

| 模拟器 | 作用 | 是否真实 |
| --- | --- | --- |
| **Kaggle 笔记本模拟器** | cell 编辑（CodeMirror）、Markdown 渲染、运行按钮、输出区、`/kaggle/input` 与 `/kaggle/working` 文件树、自动保存 | 文件与编辑**真实** |
| **环境模拟器** | 模拟 T4×2 GPU、CPU/RAM/磁盘仪表、会话计时、预装包清单、代码静态分析（框架 / 超参 / 数据路径 / 提示） | 硬件数值**模拟**，静态分析**真实** |
| **数据集模拟器** | 挂载 LJSpeech / VCTK / LibriTTS / 自定义参考语音，在 `input/` 下创建 `dataset-metadata.json`、`README.md`、`files.txt` | 只创建**占位元数据**，不下载 GB 级音频 |
| **训练实验模拟器** | 基于你的代码静态分析结果，流式（SSE）产生日志、loss 曲线、lr、产物清单，并写入 `working/runs/<id>/` 和 `experiments/<id>.json` | 日志 / 指标**模拟**，产物文件**真实** |

右侧「Git 状态」和顶部「提交到 GitHub」不是模拟器 —— 它们调用真实的 `git`。

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
├── scripts/                     # vendor-assets / check / seed
├── kaggle_workspace/            # ★ 你的所有真实数据都在这里，会被提交到 GitHub
│   ├── notebooks/               # 你的 Kaggle 代码（.ipynb + .py）
│   ├── input/                   # 模拟 /kaggle/input
│   ├── working/                 # 模拟 /kaggle/working（日志、指标、配置）
│   └── experiments/             # 每次模拟运行的记录
├── docs/
│   ├── ARCHITECTURE.md          # 架构、API、持久化与安全设计
│   ├── USAGE.md                 # 详细使用说明 / 快捷键 / FAQ
│   └── VOICE_CLONE_GUIDE.md     # 语音克隆在 Kaggle 上的工程建议
└── README.md
```

---

## 诚实声明（重要）

- 这里的 GPU（Tesla T4 ×2）、显存、loss 曲线、epoch 时间、预装包版本都是**模拟展示值**，
  本沙箱没有 GPU，也不会执行你的训练代码。日志里全部带 `SIMULATED` 标识。
- `.ipynb` 中的输出如果来自模拟运行，会带有 `[SIMULATED]` 前缀，metadata 里
  `kaggle_lab.simulatedOutputs = true`。
- `ENABLE_LOCAL_PYTHON=1` 才会启用「真实本地 Python 执行」接口，默认关闭。
  即使开启也**只适合无副作用的小片段**（15 秒超时、独立工作目录、无模型权重）。
- 真实训练请在 Kaggle 上传 `.ipynb` 后开启 GPU；本系统负责**保存、版本管理与可视化**。

---

## 文档

- 📘 [使用说明（含快捷键与 FAQ）](docs/USAGE.md)
- 🏗 [架构与 API 设计](docs/ARCHITECTURE.md)
- 🎙 [语音克隆 Kaggle 工程建议](docs/VOICE_CLONE_GUIDE.md)

---

**分支**：`arena/3de266c9-qwen3-8flash` · **更新 GitHub**：界面右上角「☁ 提交到 GitHub」→「🚀 提交并推送」。
