# notebooks/

你在浏览器里粘贴或编辑的 Kaggle 代码，会以两种格式**真实保存**在这里：

- `<名称>.ipynb` — 标准 `nbformat 4.5`，带 `kernelspec` / `language_info` / `kaggle` metadata。
  可直接用 Kaggle 的 `File → Import Notebook` 或 Jupyter 打开。
- `<名称>.py` — 使用 `# %%` 和 `# %% [markdown]` 分隔符的 cell 导出，可重新导入本系统，
  也可以用 Jupytext / VS Code / PyCharm 的 cell 模式打开。

`metadata.kaggle_lab` 里记录来源、创建/更新时间、`simulatedOutputs` 标记。
来自模拟运行的输出会带 `[SIMULATED]` 前缀，避免和真实 Kaggle 运行结果混淆。
