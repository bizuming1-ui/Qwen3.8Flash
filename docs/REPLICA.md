# QTTS 网站复刻 · 代码研究报告

> 研究对象：`kaggle_workspace/notebooks/kaggle.ipynb`（你粘贴的完整 Kaggle 代码）
> 研究方式：**不执行**这份代码，只用 `ast.literal_eval` 解出其内嵌的 `FILES` 字面量，
> 逐个校验 `bytes` 与 `sha256`，然后静态阅读解包后的 70 个源码文件。
> 复现命令：`python3 scripts/extract-kaggle-assets.py`

---

## 1. 你的 Kaggle 代码到底是什么

- 是 **一个 cell 的 paste-and-run 候选**：`kaggle.ipynb` 只有 1 个 code cell，
  347,551 字符 / 449 行；其中绝大部分是 70 个被 `zlib` 压缩 + `base64` 编码的源码资产。
- 文件头自述：*"re-packed from the user's SHA-verified 70-asset upload"*，
  并声明审计增量：profile/synthesis 绑定回执、手动文本/锚点审计标记、
  诚实的 envelope-spread proxy 标签、额外呼吸效果明确为禁用状态。
- **安全设计（值得保留）**：
  - `safe_name()` 拒绝绝对路径、`..`、反斜杠、冒号；
  - `decode_files()` 逐项校验 `bytes` == 实际解压长度、`sha256` == 声明值，
    累计 16 MiB 上限，单项 2 MiB；
  - `extract_new()` 用 `O_EXCL | O_NOFOLLOW` 在**全新随机目录**创建文件，
    不覆盖、不杀已有服务；
  - `start_kaggle()` 四步：`--check` → 确认 `/kaggle/working` →
    探测端口 `{7001,7002,7010,7860}`（`_probe_startup_ports`）→
    `doctor()` 检查**两块物理 T4** → 随机目录 `--run`。
  - 明确写着 `REAL_OPT_IN`、`release:false`、`real_model_executed:false`、
    `training_verified:false`、`quality_or_speed_verified:false`。

## 2. 70 个资产的组成（全部已落盘到 `replica/source/`）

| 组 | 数量 | 关键文件 |
| --- | --- | --- |
| `go/gateway/` | 16 | `main.go`(15 KB), `session.go`(19.5 KB), `scheduler.go`, `security.go`, `autoentry.go`, `segmenter.go`, `monitor.go`, `llm.go`, 6 个 `_test.go`, `go.mod`, `runtime_build.go` |
| `py/` | 37 | `analyst.py`(63 KB), `worker.py`(38 KB), `bootstrap.py`(20 KB), `training_data.py`, `voice_library.py`, `library_api.py`, `diagnostic_store.py`, `diagnostic_pair.py`, `step18_*` 等 |
| `tools/` | 9 | `backend_probe.py`, `e2e_check.py`, `selftest.py`, `voice_benchmark.py`, `watermark_check.py`, `encode_training.py`, `train_tts.py`, `trained_voice.py`, `resource_control.py` |
| `web/` | 4 | **`index.html`(28 KB) + `app.js`(84 KB) + `recorder.js`(12 KB) + `diagnostic-trace.js`(6 KB)** |
| `rust/audio_rt/` | 2 | `Cargo.toml`, `src/lib.rs` |
| 根目录 | 2 | `LICENSE-QWEN-DERIVED.txt`, `MEMO.md` |

合计 **723,119 字节**，70/70 SHA-256 校验通过；记录见 `replica/asset-manifest.json`。

## 3. 原始系统架构

```
浏览器 (web/*, 同源)
   │  /api/*            Bearer 或 HttpOnly 私有会话
   ▼
Go gateway :7860  ──── /api/prep/* 反向代理 ────► Python FastAPI analyst :7010
   │  /api/speak 二进制帧流                          │  参考处理 / 声音库 / 训练输入 / 诊断
   │  Scheduler 双卡调度                             ▼
   └──────────────────► worker :7001 / :7002 (GPU, /synth, /profile/load)
                              │
                     Rust audio_rt (可选实时音频)
```

- `main.go routes()` 注册 15 个 gateway 端点；`guard.middleware()` 做 Bearer/Cookie 认证、
  速率限制、请求体上限、并发槽位。
- `autoentry.go`：Notebook 用 Bearer 调 `/api/session/issue` 得到 **43 字符一次性 grant**
  （10 分钟、8 个上限）；浏览器用 grant 换 `qtts_private_session` HttpOnly Cookie
  （SameSite=Strict、8 小时、32 个会话上限）。
- `analyst.py` / `library_api.py` / `diagnostic_pair.py` 共 24 个 FastAPI 端点，
  被 gateway 以 `TrimPrefix("/api/prep")` 代理。

## 4. 网站本身有哪些功能（`web/index.html` 静态分析）

- **两个主视图**：「语音对话」（DeepSeek→克隆语音 / 直接朗读）、「录制参考语音」。
- **语音对话**：模式/档案/语言/DeepSeek Key、5 种质量策略（整句线性、legacy 流式、
  AGC、headroom、windowed）、对照 seed、仅本页 PCM 捕获与 WAV 下载、
  播放缓冲水位表（已缓冲/生产速度/预测欠载/欠载次数/启动阈值）、流式回答文本框。
- **录制参考语音**：MediaRecorder 录音（波形只取自 AnalyserNode，禁止合成波形）、
  多文件上传（16 段 / 64 MiB / 127 MiB 限额）、16/24 秒参考窗口、已知参考文本、
  额外 GPU 校准候选、创建声音档案的进度任务。
- **声音库与样本**（`<dialog>`）：命名空库、原始样本增删、同内容去重、
  仅处理勾选参考（不是训练）、训练输入快照（逐条转写 + 声音权声明 + 单说话人声明）、
  固定哈希校验与删除。
- **诊断**（`<dialog>`）：后端兼容探针、双 worker（显存/引擎/RTF/首包）、
  各阶段中位耗时、最近运行表、本次分段与调度、各阶段耗时时间线、
  同源网关只读显示；顶部还有「下载脱敏诊断 JSON」与「双卡同文短测」。
- 全文反复强调：参考缓存 ≠ 训练；探针未加载权重；首声/RTF≤0.3/音色相似度需实机验收。

## 5. 二进制语音流协议（精确复刻）

`go/gateway/session.go writeFrame()`：

```
byte 0        : type  1=PCM 2=SEG 3=TEXT 4=STATS 5=END 6=ERROR 7=POLICY
bytes 1..4    : uint32 LITTLE endian segment index
bytes 5..8    : uint32 LITTLE endian payload length
bytes 9..     : PCM = int16 LE 24000 Hz mono；其它 = UTF-8 JSON
```

浏览器 `web/app.js` 的 `M` 类用 `DataView.getUint32(1, true)` 解析（`true` = 小端），
单帧上限 32 MiB。顺序：`POLICY → TEXT* / SEG → PCM* → STATS → … → END(运行汇总)`。
`X-Session-Id` 响应头必须是 12–64 位 hex，否则诊断追踪不接受。

## 6. 本项目的复刻方案（精准 + 诚实）

| 层 | 做法 | 是否一致 |
| --- | --- | --- |
| 网站静态文件 | 直接把解包出的 4 个文件放到 `replica/web/`，在 `/site/` 提供；**SHA-256 与 Kaggle 内嵌资源完全相同** | ✅ 字节级一致 |
| API 契约 | `server/replica/` 用 Node 实现 Go gateway 14 个 + Python analyst 24 个 = **38 个端点**（另有 `/api/prep/` 通配代理），路径/方法/JSON 字段/错误码/二进制帧全部对齐 | ✅ 契约级一致 |
| 认证 | 一次性 grant → HttpOnly Cookie → `/api/session/status` → 所有 API；同时保留 Bearer 手动口令入口 | ✅ 行为一致 |
| 数据落盘 | 声音档案、原始样本、训练输入快照、运行记录写入 `kaggle_workspace/replica_state/` 真实文件 | ✅ 真实文件 |
| 音频 | 生成确定性**合成音**（调幅谐波 + 音节包络），不是人声；聊天回复带「本地模拟回复」标记 | ⚠️ 明确模拟 |
| 模型/训练 | 不加载 Qwen-TTS 权重、不调用 Whisper/DeepSeek、不启动双 rank 训练 | ❌ 无法在此沙箱实现 |

因此：`/site/` 打开后你看到的是**一模一样的网站**，每个按钮、弹窗、表格、录音、
上传、诊断导出都能真实工作；但所有音频与质量数值都带 `simulated:true`、
`quality_verified:false`、`acoustic_text_verified:false` 标记。

> 沙箱没有 `go` / `rustc` / `ffmpeg` / GPU，也没有模型权重；
> 即使装 Go 编译 `gateway`，缺 worker/analyst/权重也无法产出真实语音，
> 所以选择「原站字节 + 契约级兼容后端」这条最精确、可运行的路线。

## 7. 如何验证复刻精度

```bash
npm run extract          # 从 kaggle.ipynb 重新解包 + 校验 70 个资产
npm run check            # 24 个服务端/脚本 JS 文件语法检查
npm test                 # 86 项自动化验证（需 npm start 正在运行）
  # ├─ scripts/test-replica.js : 63 项 HTTP 契约测试
  # │    · /site/ 四个文件字节一致、70/70 SHA-256
  # │    · 私有入口 grant → Cookie → 会话 → 登出
  # │    · 14 个 Go gateway 端点 + 24 个 Python analyst 端点
  # │    · /api/speak 二进制帧（1/2/3/4/5/7 全类型 + int16 24kHz PCM）
  # │    · multipart 上传 → 档案任务 → 声音库 → 训练输入快照 → 哈希校验
  # └─ scripts/test-browser.js : 23 项 jsdom 浏览器级测试
  #      · 实验室 5 个视图 / 源码资产 / API 矩阵 / 精准对照 / 私有入口
  #      · 原始未修改的 web/app.js 自动解锁、流式语音、诊断、声音库弹窗
curl -s -X POST localhost:3000/lab/api/replica/verify   # 在线重算 SHA-256
curl -s localhost:3000/lab/api/replica/status | jq .    # 网站文件哈希 / 会话 / 端点数
```

浏览器里：「🧬 源码资产」页可逐个查看 Go/Python/Rust/JS 源码；
「🔌 API 兼容矩阵」页列出 38 个端点及其原始来源文件；
「🌐 网站复刻」页一键生成私有入口并在 iframe 中打开原站；
「🔬 精准对照」页可在线运行分段器 / DSP / 双层帧 / worker 四组探针。

> **继续精准开发**：Go 分段器、Python 五种音量策略、Guard 限流、诊断脱敏、
> worker HTTP 面与原始 `state/` 磁盘布局已逐算法移植，详见 [docs/PRECISION.md](PRECISION.md)。

## 8. 仍然只能在 Kaggle 上做的事

1. 真实双 T4 推理、首声 < 3 秒、RTF ≤ 0.3 的测量；
2. 真实 Qwen-TTS / adapter 权重加载与音色相似度试听；
3. Whisper 转写、说话人嵌入、声码器的实际音质；
4. 真正的 LoRA/adapter 训练（本项目只生成训练**输入快照**，不训练）；
5. 物理扬声器是否发声的验证（原站自己都写明「首采样消费 ≠ 物理发声」）。

要继续真训练：把 `kaggle_workspace/notebooks/kaggle.ipynb` 上传回 Kaggle，
开启 GPU T4 ×2，运行那唯一的 cell，然后从它自动生成的私有入口进入原站。
本项目负责把这套代码**真实保存在 Git 里**、可复现地解包、并让整个网站在本地可操作。
