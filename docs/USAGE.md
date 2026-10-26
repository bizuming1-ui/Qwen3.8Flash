# 使用说明

## 0. 启动

```bash
npm install
npm start
```

打开 `http://localhost:3000`。在 Arena 中，`start_process` 启动的服务会自动显示成 live preview，
绑定在 `0.0.0.0` 并使用相对路径请求，所以浏览器里不会出现 localhost 跨域问题。

首次启动会自动创建（**真实文件**）：

- `kaggle_workspace/notebooks/语音克隆实验-Kaggle-模板.ipynb` + `.py`（8 个 cell 的语音克隆模板）
- `kaggle_workspace/input/my-voice/`（模拟参考语音数据集的元数据）

---

## 1. 把完整 Kaggle 代码放进项目（核心流程）

### 方式 A：粘贴 `.ipynb` JSON（保留全部 cell）

1. Kaggle → 你的 Notebook → `File → Download`（或 `Save Version` 后下载 `.ipynb`）。
2. 用文本编辑器打开，全选复制；或直接把文件拖进导入窗口。
3. 顶部 **「⬇ 导入完整 Kaggle 代码」** → 粘贴 → 模式选「自动识别」或 `.ipynb`。
4. 点 **「💾 只保存到项目」** 或 **「🚀 保存并提交到 GitHub」**。

所有 cell（代码 + Markdown + 已有输出）都会恢复。

### 方式 B：粘贴 `.py` 全文

如果你的 Kaggle 代码是按 `# %%` 或 `# In[1]:` 分段的脚本，勾选「自动拆分」即可恢复成多个 cell。
**没有分隔符时代码会完整保存为 1 个 cell**（不会为了好看而切坏你的代码）。

### 方式 C：逐 cell 编辑

直接在页面里编辑现有 cell；默认 **1.2 秒自动保存** 到磁盘。也可以：

- `Ctrl/⌘ + S` 手动保存
- 每个 cell 工具栏：`▶ 运行`、`⇄ 类型`（代码/Markdown）、`↑`、`↓`、`⧉`、`✕`
- cell 之间的 `＋ 代码` / `＋ Markdown` 插入新 cell
- Markdown cell 用 `✎ 编辑` / `👁 预览` 切换

关闭页面时会尽力用 `fetch(keepalive)` 再写一次，避免最后几秒的编辑丢失。

### 生成的文件

```
kaggle_workspace/notebooks/<名称>.ipynb   ← nbformat 4.5，可直接上传回 Kaggle/Jupyter
kaggle_workspace/notebooks/<名称>.py      ← "# %%" cell 导出，可重新导入本系统
```

左侧「📦 项目文件」可以直接下载这两个文件。

---

## 2. 提交到 GitHub（真实操作）

顶部 **「☁ 提交到 GitHub」** 或右侧 Git 面板的按钮 → 打开 Git 弹窗：

| 按钮 | 实际执行 |
| --- | --- |
| ① 仅 commit | `git add -A && git commit -m "<信息>"` |
| 🚀 提交并推送 | 上面的 commit **加** `git push origin HEAD` |
| ② 仅 push | 只推送已有的本地提交 |

弹窗里可以看到：分支、未提交文件数、ahead/behind、改动文件列表、最近提交、`diff --stat` 和执行输出。
`git push origin HEAD` 只会把**当前分支**推到同名远端分支，不会误推 `main`。

> 也可以在导入时直接点「🚀 保存并提交到 GitHub」，一步完成落盘 + commit + push。
> 想**完全自动**：在导入窗口勾选「以后每次导入都自动 commit + push 到 GitHub」，
> 之后只要粘贴代码点「只保存到项目」，服务端也会自动 commit + push（设置持久化在 `settings.json`）。

---

## 3. 四个模拟器怎么用

### 3.1 Kaggle 笔记本模拟器

- 中央是 cell 编辑区，右侧是输出；顶部有保存状态指示器（已保存 / 未保存 / 保存中）。
- 左侧「📁 /kaggle/input」和「📤 /kaggle/working」是**真实的项目目录树**，点击文件可以在查看器里打开、下载或删除。
- 「＋文件」按钮可以在 `working/` 或 `input/` 下新建真实文件。

### 3.2 环境模拟器

右侧显示模拟的 Kaggle 会话（T4×2、CPU/RAM/磁盘、会话计时、预装包）。
「🔍 代码静态分析」是**真实**的字符串分析，会从你的代码里提取：

- 检测到的框架（torch / torchaudio / librosa / transformers / speechbrain …）
- 超参数字面量（`epochs`、`batch_size`、`lr`、`sample_rate`、`n_mels`…）
- `/kaggle/input` 与 `/kaggle/working` 路径
- class / def 数量、运行阶段、风险提示（魔法命令、无随机种子、动态执行等）

### 3.3 数据集模拟器

左侧「挂载」→ 选择 LJSpeech / VCTK / LibriTTS / HiFi-GAN / 自定义数据集 → 挂载会在
`kaggle_workspace/input/<id>/` 创建 `dataset-metadata.json`、`README.md`、`files.txt`。
**只创建占位元数据，不下载 GB 级音频**；真实数据请在 Kaggle 上挂载，或自己放小文件进来。

### 3.4 训练实验模拟器

点 **「▶ 模拟运行」**（全部代码）或某个 cell 的 **「▶ 运行」**：

- 服务端用 SSE 流式推送 `stage / log / metric / done` 事件；
- 前端显示进度条、流式日志、Canvas loss 曲线（loss / val_loss / mel_loss）、KPI 卡片；
- 结束后生成真实文件：
  ```
  kaggle_workspace/working/runs/<runId>/run.log
  kaggle_workspace/working/runs/<runId>/metrics.json
  kaggle_workspace/working/runs/<runId>/config.json
  kaggle_workspace/working/runs/<runId>/README.md
  kaggle_workspace/experiments/<runId>.json
  kaggle_workspace/working/latest_metrics.json
  ```
- 左侧「🧪 实验记录」可以回看任意一次 `run.log`。

⚠️ 这些数值**全部是模拟的**，用于验证你的代码能被正确解析、流程能跑通、产物能落盘。
真实效果必须回到 Kaggle GPU 上运行 `.ipynb`。

---

## 4. 回到 Kaggle 真训练

1. 左侧「📦 项目文件」下载 `<名称>.ipynb`。
2. Kaggle → `Create → New Notebook` → `File → Import Notebook`（或把文件拖进 `Add Data` 后打开）。
3. `Settings → Accelerator → GPU T4 ×2`，`Internet` 按需开启。
4. 在真实 Notebook 里把 `/kaggle/input` 数据集挂载好，运行全部 cell。
5. 真结果保存在 `/kaggle/working`，需要带回本项目时可以重新粘贴 / 导入。

---

## 5. 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl/⌘ + S` | 立即保存 |
| `Ctrl/⌘ + Enter` | 模拟运行当前 cell |
| `Shift + Enter` | 模拟运行并跳到下一个 cell |
| `Ctrl/⌘ + I` | 打开导入窗口 |
| `Ctrl/⌘ + G` | 打开 Git 面板 |
| `Ctrl/⌘ + /` | 注释/取消注释（编辑器内） |
| `Tab` | 缩进（编辑器内） |
| `Esc` | 关闭所有弹窗 |

---

## 6. FAQ

**Q：我粘贴的代码会不会只存在浏览器里？**
A：不会。`POST /api/import` / `PUT /api/notebooks/:id` 直接写磁盘文件。你可以用 `ls kaggle_workspace/notebooks/` 验证。

**Q：模拟器会不会真的训练我的语音克隆模型？**
A：不会，也不应该。沙箱没有 GPU。所有 loss/显存/耗时都是模拟值，界面和日志都有 `SIMULATED` 标识。
如果你想执行**轻量 Python 片段**，用 `ENABLE_LOCAL_PYTHON=1 npm start`（15 秒超时、独立目录、最小环境变量）。

**Q：`.ipynb` 能直接被 Kaggle 打开吗？**
A：可以。生成的是标准 nbformat 4.5，带 `kernelspec` 与 `language_info`；cell 输出带 `[SIMULATED]` 前缀，
`metadata.kaggle_lab` 里标注了来源，方便你区分。

**Q：大文件（音频 / 权重）会被推到 GitHub 吗？**
A：不会。`.gitignore` 排除了 `*.wav / *.mp3 / *.pt / *.pth / *.ckpt / *.zip / *.npy …`。
它们仍然真实存在于沙箱磁盘上，只是不进版本库（避免仓库爆炸）。需要版本管理请用 Git LFS 或对象存储。

**Q：push 失败怎么办？**
A：文件已经保存在本地并 commit 了，不会丢。检查 Git 弹窗里的执行输出；通常是 GitHub 连接需要重新授权，
在 Arena 里重新连接 GitHub 后再点「② 仅 push」。

**Q：怎么清空测试数据重来？**
A：删除 `kaggle_workspace/notebooks/*.ipynb`（和对应 `.py`），重启服务会自动重新生成模板；
`kaggle_workspace/working/runs/` 与 `experiments/` 可以直接删除。

---

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| 页面显示「无法连接服务」 | 确认 `npm start` 正在运行、端口 3000 未被占用；或 `PORT=8080 npm start` |
| 编辑器没有语法高亮 | 运行 `npm install` 重新生成 `server/public/vendor/`；检查浏览器控制台是否 404 |
| 保存一直转圈 | 看底部「系统消息」页；多半是磁盘写入异常或路径越权被拒 |
| 导入后只有 1 个 cell | 你的 `.py` 没有 `# %%` 分隔符，系统为了保证代码完整性没有拆分；手动加分隔符再导入 |
| 中文文件名乱码 | 文件名保留 Unicode；如果终端/系统编码有问题，可在导入时填一个英文名 |
| `git push` 报认证错误 | 在 Arena 重新连接 GitHub；本地 commit 仍然完好 |
