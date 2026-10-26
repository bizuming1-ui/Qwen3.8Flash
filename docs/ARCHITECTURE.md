# 架构与 API 设计

## 1. 设计目标

1. **单一事实来源在磁盘**：浏览器只是视图。所有 notebook、数据集元数据、实验产物都写到
   `<repo>/kaggle_workspace/` 的普通文件里，刷新页面、重启服务、换浏览器都不会丢。
2. **真实 GitHub 同步**：`git add / commit / push` 由服务端调用本地 `git` 完成，不是模拟。
3. **模拟与真实严格区分**：不执行用户的训练代码；所有生成的指标都标注 `SIMULATED`。
4. **离线可运行**：无 CDN、无运行时 npm 依赖（CodeMirror 5 已 vendor 到仓库）。

```
┌──────────────────────── 浏览器（纯视图）─────────────────────────┐
│  CodeMirror cells  │  文件树  │  环境/分析/Git 面板  │  控制台/SSE  │
└───────────┬──────────────────────────┬───────────────────┬────────┘
            │ REST /api/* (JSON)        │ SSE /api/simulate/stream
            ▼                           ▼
┌──────────────────────── Node.js HTTP 服务 ────────────────────────┐
│ server/index.js                                                     │
│   ├─ workspace.js   路径校验 + 原子写（所有磁盘写入的唯一入口）      │
│   ├─ notebook.js    .ipynb ⇄ cells ⇄ .py                             │
│   ├─ datasets.js    模拟数据集挂载                                   │
│   ├─ simulator.js   静态分析 + 事件时间线 + 产物落盘                 │
│   ├─ templates.js   模板 / 目录 / 环境描述                          │
│   └─ git.js         spawnSync('git', ...) 真实版本控制               │
└───────────┬──────────────────────────────────────┬─────────────────┘
            ▼                                      ▼
   kaggle_workspace/**（真实文件）          GitHub origin/当前分支
```

## 2. 持久化模型

| 目录 | 内容 | 写入时机 |
| --- | --- | --- |
| `notebooks/<id>.ipynb` | nbformat 4.5，含 `kernelspec` / `language_info` / `kaggle` / `kaggle_lab` metadata，cell 输出带 `[SIMULATED]` 前缀 | 导入、自动保存、手动保存、结构变更 |
| `notebooks/<id>.py` | `# %%` / `# %% [markdown]` cell 导出，可被本系统重新导入 | 与 `.ipynb` 同步写入 |
| `input/<dataset>/` | `dataset-metadata.json`、`README.md`、`files.txt`、`.gitkeep.json` | 数据集挂载 |
| `working/runs/<runId>/` | `run.log`、`metrics.json`、`config.json`、`README.md` | 模拟运行结束时 |
| `working/latest_metrics.json` | 最近一次曲线 | 模拟运行结束时 |
| `experiments/<runId>.json` | 分析摘要 + 指标 + 产物清单 | 模拟运行结束时 |
| `settings.json` | 当前笔记本、自动保存间隔、模拟速度、`autoSyncOnImport` | 用户切换设置 / 勾选自动同步 |

所有写操作走 `workspace.writeText/writeJson/writeBase64`：

- 路径必须是相对路径，`path.resolve` 后必须落在 `kaggle_workspace/` 内（拒绝 `..` 与绝对路径）；
- 采用 `临时文件 + rename` 的原子写，避免半截文件；
- 上传限制 3 MB / 单文件，请求体限制 12 MB（足够放下超长 Notebook）。

`.gitignore` 会把 `*.pt / *.wav / *.mp3 / *.zip / *.npy …` 等大文件排除在版本库之外
（它们仍然真实存在于沙箱磁盘上），但保留所有 JSON / MD / PY / IPYNB / LOG 文本。

## 3. 导入管线（`POST /api/import`）

```
粘贴文本
  ├─ 以 { 开头且能解析出 cells[]  → .ipynb：逐 cell 恢复 source / outputs / markdown
  ├─ 含 # %% / # In[] / # ==== 分隔符 → Python：按分隔符切 cell（分隔符本身不进代码）
  └─ 其它 → 完整保留为 1 个 cell（不做任何“智能”改写）
       ↓
  createNotebook() → saveNotebook() → 写 .ipynb + .py
       ↓
  sync=true（按钮或 settings.autoSyncOnImport）→ git.commit() → git.push()
```

自动同步开关存在 `kaggle_workspace/settings.json`，因此重启服务后仍然生效；
它只作用于**导入**，普通 cell 编辑仍然由你决定何时提交（避免产生大量琐碎 commit）。

`cellsToPy()` 生成的可往返格式（Kaggle / Jupytext 风格）：

```python
# %%
<代码原样>

# %% [markdown]
# <Markdown 每行>
```

IPython 魔法命令（`!pip install …`、`%time`）在 `.py` 中**原样保留**，因为需要 Notebook 内核才能运行。

## 4. 模拟运行（SSE）

1. `POST /api/simulate/run` → `simulator.buildRun()`：
   - 静态分析代码：import、框架、`epochs/batch_size/lr/sample_rate…`（支持 `epochs=30` 与 `"epochs": 30` 两种写法）、
     `/kaggle/input` 与 `/kaggle/working` 路径、class/def、运行阶段、提示；
   - 用代码哈希做种子生成**可复现的**伪随机 loss 曲线；
   - 产出事件数组：`stage` / `log` / `metric` / `done`，每个事件带 `delay`（ms）。
2. 服务端用 `setTimeout` 逐条广播到 `EventSource` 客户端；晚连接的客户端会**重放已发出的事件**。
3. 结束时 `finalizeRun()` 把日志、指标、配置、实验记录写成真实文件。
4. 前端把事件渲染成流式日志、进度条、Canvas loss 曲线、KPI 卡片；单 cell 运行时输出到该 cell 的输出区。

> 事件里的 `at` 时间戳、显存占用、epoch 耗时都是模拟值。

## 5. Git 同步

`server/lib/git.js` 用 `spawnSync('git', args)`（**参数数组，不经过 shell**，避免命令注入）：

```
commit: git add -A → git diff --cached --quiet → git commit -m <message>
push:   git push origin HEAD     # 永远推送当前分支到同名远端分支，不会推 main
sync:   commit + push
```

- 提交信息会过滤控制字符并限制 240 字符；
- push 超时 120 秒；`GIT_TERMINAL_PROMPT=0` 防止卡在交互式认证；
- 状态解析 `git status --porcelain=v1 -uall`，区分 `untracked / added / modified / deleted / renamed`；
- 前端展示 `ahead / behind`、改动文件、最近提交、`diff --stat`。

## 6. 安全说明

| 风险 | 处理 |
| --- | --- |
| 路径穿越 | `workspace.safePath()` 强制相对路径 + `startsWith(WS + sep)` |
| 命令注入 | git 全部使用参数数组；提交信息过滤控制字符 |
| 任意代码执行 | **默认不执行用户代码**。`/api/execute` 需 `ENABLE_LOCAL_PYTHON=1` 显式开启，且 15 秒超时、独立 cwd、最小 env、输出上限 512 KB |
| 超大文件 | 请求体 12 MB / 上传 3 MB / 预览 8 MB 限制；大二进制被 `.gitignore` 排除 |
| 静态资源越权 | `serveStatic()` 同样做 `startsWith(PUBLIC + sep)` 校验，未知路径 404 |
| 误以为真的训练了 | UI、日志、`.ipynb` metadata、文档四处标注 `SIMULATED` |

## 7. API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` `/api/bootstrap` `/api/environment` | 服务状态 / 全量初始数据 / 环境信息 |
| PUT | `/api/settings` | 更新自动保存间隔、模拟速度、当前笔记本 |
| GET/POST | `/api/notebooks` | 列表 / 新建 |
| GET/PUT/DELETE | `/api/notebooks/:id` | 读取 / **保存** / 删除笔记本 |
| POST | `/api/import` | **导入完整 Kaggle 代码**（可选同步 GitHub） |
| GET | `/api/files` | 四棵文件树 + 最近写入记录 |
| GET/PUT/DELETE | `/api/file` | 读取 / 新建 / 删除任意工作区文件（`?download=1` 下载） |
| POST | `/api/upload` | base64 上传（3 MB 限制） |
| GET | `/api/datasets` | 目录 + 已挂载数据集 |
| POST | `/api/datasets/mount` `/api/datasets/unmount` | 挂载 / 卸载 |
| POST | `/api/analyze` | 代码静态分析 |
| POST | `/api/simulate/run` | 创建模拟运行 |
| GET | `/api/simulate/stream?runId=` | SSE 事件流 |
| GET | `/api/simulate/runs` `/api/experiments` `/api/experiments/:id` | 运行状态 / 实验记录 |
| GET | `/api/git` `/api/git/diff` | 状态 + 提交历史 + diff |
| POST | `/api/git/commit` `/api/git/push` `/api/git/sync` | **真实 git 操作** |
| POST | `/api/execute` | 可选的真实本地 Python（默认 403） |
| POST | `/api/seed` | 生成模板 notebook 副本 |

## 8. 扩展方向

- 想要真实训练：在 `/api/execute` 基础上加一个任务队列 + Docker/子进程隔离 + 资源限额，
  把 `ENABLE_LOCAL_PYTHON` 换成一个真正的 runner，并把 `run.log` 换成真实 stdout。
- 想接 Kaggle API：可以在 `datasets.js` 里增加 `kaggle datasets download` 的真实下载（需要凭据与网络），
  目前刻意只做占位，避免把 GB 级数据塞进 Git。
- 想多人协作：把 `workspace.js` 换成带锁的存储或数据库，其余 API 不变。
