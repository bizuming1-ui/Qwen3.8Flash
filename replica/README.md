# replica/ — 从你的 Kaggle 代码解包出的真实源码

```
replica/
├── asset-manifest.json   # 70 个资产的路径/字节数/SHA-256/校验结果 + 4 个网站文件哈希
├── source/               # 全部 70 个原始文件（go/ py/ rust/ tools/ web/ 根目录文档）
└── web/                  # 4 个网站文件的字节级副本，由 /site/ 直接提供
```

## 来源与可信度

`kaggle_workspace/notebooks/kaggle.ipynb` 里的那个 cell 定义了 `FILES` 字典：
每个条目是 `{bytes, sha256, data(base64(zlib(原始文件)))}`。
`scripts/extract-kaggle-assets.py` 只做 `ast.literal_eval`（**不执行代码**），
逐项校验长度与 SHA-256 后写出。运行 `npm run extract` 可随时重做。

`replica/web/` 的四个文件与 `replica/source/web/` 的对应文件哈希相同，
也就是说浏览器看到的 `index.html / app.js / recorder.js / diagnostic-trace.js`
就是 Kaggle cell 本来要写到 `/kaggle/working/qtts18-autoentry-*/web/` 的字节。

## 不要在这里改网站源码

`replica/web/` 是**原站快照**，改了就不是「一模一样的复刻」了。
要调整本地行为，请改 `server/replica/`（兼容后端）或 `server/public/`（实验室 UI）。
如果 Kaggle 那边更新了代码，重新 `npm run extract` 会把新的 70 个资产同步过来。
