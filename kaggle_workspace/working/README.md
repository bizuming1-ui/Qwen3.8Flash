# working/ — 模拟 `/kaggle/working`

每次「模拟运行」结束后，会在这里创建真实文件：

```
working/runs/<runId>/run.log        # 模拟 stdout 日志（头部明确标注 SIMULATED）
working/runs/<runId>/metrics.json   # loss / val_loss / mel_loss / lr / psnr 曲线
working/runs/<runId>/config.json    # 从你的代码静态分析出的超参与依赖
working/runs/<runId>/README.md      # 说明与注意事项
working/latest_metrics.json         # 最近一次曲线
experiments/<runId>.json            # 实验记录（另见 experiments/）
```

这些文件是**真实落盘**的，会被 git 提交；但里面的数值是**模拟数据**，
不代表真实 GPU 训练结果。真实训练请在 Kaggle 上运行 `.ipynb`。
