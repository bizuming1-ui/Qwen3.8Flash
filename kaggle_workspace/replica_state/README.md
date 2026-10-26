# replica_state/ — 网站复刻的运行时真实文件

这个目录由 `server/replica/` 管理，保存「QTTS 声音台」复刻网站产生的**真实文件**：

| 文件 / 目录 | 内容 |
| --- | --- |
| `state.json` | 访问口令、声音档案、声音库索引、训练输入快照索引、任务、运行记录、worker 快照 |
| `profiles/<id>/` | 上传的参考音频原文件 + `profile.json` |
| `libraries/<id>/<sid>.audio` | 声音库里的原始样本（按 SHA-256 去重） |
| `training_data/<id>/` | `manifest.json`、`train_raw.jsonl`、`rank_plan.json`、`audio/*.wav` 训练输入快照 |
| `backend_probe.json` | 诊断面板读取的探针报告 |

这些文件**真实存在于项目磁盘上**，但整体被 `.gitignore` 排除（它们会随每次操作变化，
且可能包含用户上传的音频）。需要永久留存时，在 Git 面板提交前把它们移入版本库，
或改用 Git LFS / 外部存储。

> ⚠️ 所有音频都是**合成正弦或用户自己上传的原始文件**；本环境没有模型权重，
> 不会生成真实克隆语音。`state.json` 里的口令是本地演示口令，不要当作生产凭据。
