# input/ — 模拟 `/kaggle/input`

这里的目录对应 Kaggle 的 `/kaggle/input/<dataset-id>/`。

⚠️ **它们只包含占位元数据，不是真实数据集。** 每个数据集目录包含：

- `dataset-metadata.json` — id、Kaggle 路径、本地路径、许可证、标称大小、文件清单、挂载时间
- `README.md` — 人类可读说明
- `files.txt` — 占位文件清单
- `.gitkeep.json` — 保证目录能被 Git 追踪

真实音频 / 权重请在 Kaggle 上通过 `Add Data` 挂载，或自行把小文件放进对应目录
（大文件类型已在 `.gitignore` 中排除）。
