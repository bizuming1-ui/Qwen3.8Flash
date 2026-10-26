# experiments/

每次模拟运行生成一条 `<runId>.json` 记录，包含：

- `id` / `createdAt` / `notebookId` / `notebookName`
- `epochs` / `finalLoss` / `finalValLoss` / `codeChars`
- `metrics`（完整曲线）
- `analysis`（静态分析：框架、超参、数据路径、阶段、提示）
- `artifacts`（真实落盘的文件列表）
- `simulated: true` —— 永远为 true，防止与真实实验结果混淆

左侧「🧪 实验记录」面板会列出它们，点击可查看对应 `run.log`。
