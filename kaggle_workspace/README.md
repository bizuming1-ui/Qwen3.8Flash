# kaggle_workspace/ — 真实数据目录

> 这个目录下的**所有内容都是真实文件**，会被 `git add -A` 提交到 GitHub。
> 浏览器只是它的视图；刷新页面、重启服务、换浏览器都不会丢数据。

## Kaggle 路径映射

| Kaggle | 本仓库 | 内容 |
| --- | --- | --- |
| Notebook 代码 | `notebooks/` | `*.ipynb`（nbformat 4，可上传回 Kaggle）+ `*.py`（`# %%` 导出） |
| `/kaggle/input` | `input/` | 模拟数据集的元数据、README、文件清单（**不是真实音频**） |
| `/kaggle/working` | `working/` | 模拟运行日志、`metrics.json`、`config.json`、`latest_metrics.json` |
| — | `experiments/` | 每次模拟运行的 JSON 记录 |
| — | `settings.json` | 当前笔记本、自动保存间隔、模拟速度 |

## 重要

- `*.wav / *.mp3 / *.pt / *.pth / *.ckpt / *.zip / *.npy` 等大文件被 `.gitignore` 排除，
  仍可在磁盘上使用，但不会推到 GitHub（避免仓库过大）。
- `run.log`、`metrics.json` 等文本产物会被提交，方便你在 GitHub 上查看实验历史。
- 所有 `run.log` 与 notebook 输出里的数值都带 `SIMULATED` 标识，不代表真实训练结果。
