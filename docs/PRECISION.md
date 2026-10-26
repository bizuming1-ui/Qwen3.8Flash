# 精准开发报告 · 从 Kaggle 源码逐算法移植

> 目标不只是「网站长得一样」，而是把 `replica/source/` 里真正决定行为的算法
> 逐行移植到 Node，让浏览器复刻里的**分段、增益、准入、诊断脱敏、双层线协议、
> 磁盘布局**都与原系统等价。
>
> 波形仍然是**明确标注的合成音**（本沙盒没有 Qwen-TTS 权重 / CUDA / DeepSeek Key）。
> 本文只讨论「算法与协议」的精度，不宣称音质已验证。

---

## 1. 移植清单

| 原始文件 | 移植文件 | 精度 |
| --- | --- | --- |
| `go/gateway/segmenter.go` | `server/replica/segmenter.js` | 呼吸组切分、`units` 计数、边界分类、停顿/呼吸策略、配置覆盖 |
| `py/step18_audio_rt.py` + `py/worker.py` | `server/replica/dsp.js` | `Leveler`（因果 DC 阻断 → 门控 RMS AGC → 软限幅）、`SentenceLinearLeveler`、5 种质量策略 |
| `go/gateway/security.go` | `server/replica/limits.js` | `defaultLimits` / `boundedEnv` / 3 个令牌桶 / 并发槽 / `validateSpeak` / body 上限 |
| `go/gateway/monitor.go` | `server/replica/diagnostics.js` | `diagnosticClean` 字段白名单、枚举白名单、深度 9 / 数组 64 上限、`mergeDiagnosticClient` 服务端字段保护 |
| `py/worker.py` HTTP 面 | `server/replica/workers.js` | `/health`、`/profile/load`、`/synth` + 5 字节 worker 帧 |
| `go/gateway/scheduler.go` + `session.go` | `server/replica/protocol.js` | worker 帧 → gateway 排序 → 9 字节客户端帧、每帧统计与 END 回执 |
| Go/Python 的 `state/` 目录约定 | `server/replica/store.js` | `active.json` / `profiles/<id>/profile.json` / `libraries/<id>/library.json` / `runs/<session>.json` / `url.txt` |
| `go/gateway/autoentry.go` 等 | `server/replica/auth.js` | 一次性 grant → HttpOnly 会话（上一轮已完成） |

浏览器里新增 **「🔬 精准对照」** 视图，可直接运行下面 4 组探针。

---

## 2. 分段器（`segmenter.go`）

`Segmenter` 是流式状态机：LLM 的每个 delta 进 `feed(delta)`，结束后 `flush()`。
移植保留了这些细节：

- **单位计数**：CJK 字符 = 1 unit，拉丁单词 = 1.6 unit（与 `qtts_common.count_text_units` 一致）。
- **边界类型**：`none / clause / sentence / para / ellipsis`，标点与未闭合引号/括号都参与判定。
- **默认配置**：`FirstMin 7 / FirstMax 20 / Min 12 / Target 26 / Max 64`；
  停顿 `clause 150 / sentence 340 / para 560 / ellipsis 460` ms。
- **两种模式**：
  - `readSegCfg`：`PreserveText = true`，`FirstMin 12 / FirstMax 24 / Min 20 / Target 40 / Max 80`。
  - `liveSegCfg`：`PreserveText = true` 且 `ImmediateFirst = true`（拿到第一个完整前缀就派发）。
- **声音档案覆盖**：`pause_clause_ms` 夹到 `[60,400]`、`pause_sentence_ms` 到 `[160,800]`、
  `pause_para_ms` 到 `[260,1200]`，ellipsis = `clamp(int(PauseSent*1.35), 260, 900)`。
- **停顿抖动**：以 seed 决定的伪随机 ±12%，与 Go 的 `rand.New(rand.NewSource(seed))` 对应。

**行为差异已修正**：原 Go 网关在 `read` 模式下只把文本喂给分段器，**不向浏览器推 TEXT 帧**；
只有 `chat` 模式才 `pushText`。本轮之前复刻在 read 模式也推 TEXT，已改为与原版一致
（自动化测试 `read mode sends SEG/PCM/STATS but no TEXT` 会守住这条契约）。

在线探针：

```bash
curl -s -X POST localhost:3000/lab/api/replica/segment \
  -H 'Content-Type: application/json' \
  -d '{"text":"这是第一句，包含中文逗号；这是第二句！还有省略号……最后一段。","mode":"read","seed":42}'
```

返回 `{cfg:'ReadSegCfg', count, units, segments:[{index,text,units,boundary,pause_ms,breath}]}`。

---

## 3. DSP 与 5 种质量策略（`step18_audio_rt.py` + `worker.py`）

输入统一是 **int16 LE / 24000 Hz / 单声道**，先转 `Float32Array` 再走原算法：

| 策略 | 原始实现 | 移植行为 |
| --- | --- | --- |
| `legacy-stream` | 滚动因果 `Leveler`：DC 阻断 → 门控 RMS AGC → 段首淡入 → 软限幅（ceiling 0.99 / knee 0.10） | `Leveler` 完整移植；滚窗 1920 samples |
| `sentence-linear` | `SentenceLinearLeveler`：整句**一次**恒定增益，受 `0.95/peak` 与最大增益约束 | 同公式，输出 `linear_peak_limited` |
| `sentence-agc` | 整句解码 + 原因果 AGC | `Leveler.process()` 一次性处理整句 |
| `sentence-agc-headroom` | AGC + 软峰值保护（ceiling **0.86** ≈ −1.31 dBFS，knee **0.02**） | 同参数构造 `Leveler` |
| `windowed-linear` | 每 1920 samples 独立 `SentenceLinearLeveler`，各窗口一个恒定增益 | 逐窗构造，`gain_db` 取窗口均值 |

常量与 `qtts_common.py` 对齐：`OUTPUT_TARGET_DBFS = -18.0`、`OUTPUT_MAX_GAIN_DB = 6.0`、
`rtf_target = 0.3`、AGC 目标 −21 dBFS / 最大 +9 dB / 最小 −9 dB、
attack 30 ms / release 600 ms / gate −46 dBFS。

`applyPolicy()` 返回的 `stats` 直接复刻 `worker.py` 的 `fStats` 字段：
`gain_db / env_dbfs / peak_dbfs / rms_dbfs / dsp_ms / chunks / chunk_size /
speech_samples / audio_s / gen_ms / expected_s / rtf_x / rtf / first_chunk_ms /
soft_limited_samples / soft_limited_fraction / soft_limiter_peak_reduction_db /
linear_peak_limited / output_target_dbfs / max_gain_db / voice_conditioning /
reference_pcm_splicing / extra_breath_* / acoustic_text_verified / quality_verified`，
另外补上 `model_first_chunk_ms / model_stages / source_build_id / source_build_match / worker_roundtrip_ms`。

**前置停顿也修正为原版语义**：只有 `legacy-stream` 真正发出一段静音 lead PCM；
`sentence-*` / `windowed-linear` 只在 stats 里记录 `lead_ms`，不会拼参考音频
（对应 `worker.py` 的 `if lead.size and not (quality or sentence_codec)`）。

在线探针：

```bash
curl -s -X POST localhost:3000/lab/api/replica/dsp \
  -H 'Content-Type: application/json' -d '{"seed":42}' | jq '.policies[] | {policy, gain:.stats.gain_db, peak:.stats.peak_dbfs, sha:.output.sha256}'
```

同一段 2.00 s 输入跑 5 条路径，输出哈希不同即证明增益/限幅路径真的不同。

---

## 4. 双层二进制线协议

```
worker → gateway   [type u8][len u32 LE][payload]          type 1 PCM / 2 STATS / 3 ERR
gateway → browser  [type u8][seg u32 LE][len u32 LE][payload]
                   type 1 PCM / 2 SEG / 3 TEXT / 4 STATS / 5 END / 6 ERROR / 7 POLICY
PCM = int16 LE 24000 Hz mono；其余 payload = UTF-8 JSON
X-Session-Id = 12–64 位 hex
```

`protocol.js` 现在同时生成两层帧：每一段先合成裸 PCM，经过 `dsp.applyPolicy()`，
按 0.12 s 切片产生 **worker 层 fPCM**，gateway 收到后再按段号顺序转成 **客户端 fPCM**，
段尾发 fSTATS → 客户端 STATS，最后发 END 汇总（含 `per_gpu / timeline_ms /
diagnostic_segments / anomalies / client`）。

浏览器帧检视器：

```bash
curl -s -X POST localhost:3000/lab/api/replica/frames \
  -H 'Content-Type: application/json' \
  -d '{"text":"帧协议检查文本。第二句。","mode":"chat","quality_policy":"legacy-stream"}' \
  | jq '{client:(.frames|length), worker:(.workerFrames|length), segments:(.segments|length), timeline}'
```

`buildStream()` 也被 `/api/speak` 直接使用（真实 HTTP 流式写出），
所以「检视器看到的帧」和「网站真正收到的帧」是同一段代码产生的。

---

## 5. 准入控制（`security.go`）

`LIMITS.admit()` 在每个 `/api/*` 请求前执行（一次性入口 exchange 除外），顺序与 Go 一致：

1. 鉴权失败 → 先消耗 `failed` 桶，桶空返回 `429 too many failed access attempts`（`Retry-After: 5`）。
2. `all` 桶（容量 120 / 20 每秒） → 超限 `429 request rate exceeded`。
3. `Content-Length` 超过上限 → `413`；同时给 `req.maxBodyBytes` 设上限，
   `http-utils.readBody()` 对流式/分块请求也强制同一个限制。
4. 并发槽：`/api/speak` 用 `speakSlots`，其它 `/api/prep/*` 写操作与
   `/api/profiles/activate` 用 `heavySlots`；满则 `429 concurrent operation limit reached`。
5. `speech` 桶（12 次/分，0.2/s 补充） → `429 speech request budget exceeded`。

默认限制（`QTTS_*` 环境变量可用 `boundedEnv` 覆盖，范围与 Go 完全相同）：

```
JSONBytes 1 MiB · UploadBytes 128 MiB · TextChars 20000 · HistoryChars 32000
SpeakConcurrent 2 · HeavyConcurrent 2 · SpeakPerMinute 12 · RequestSeconds 1800
```

`validateSpeak()` 逐项复刻：UTF-8 文本长度、`history ≤ 16`、role 只能是
`user/assistant`、`system ≤ 4096`、历史总字符 ≤ 32000。

---

## 6. 诊断脱敏（`monitor.go`）

`/api/diagnostics` 不再原样回显任意对象。`diagnostics.js` 移植了
`diagnosticClean()` 的**字段白名单 + 枚举白名单**：

- 递归深度 > 9 返回 `null`；数组只保留最后 64 项；非有限数 / `|v|>1e15` 丢弃。
- 普通字符串一律丢弃；只有 `session / id / voice_binding`（hex 12–64）和
  `source_build_id`（64 位 hex）以及枚举白名单内的字符串能通过。
- `/api/report` 的浏览器回执先过 `cleanClientPatch()`：
  删除 `request_mode / content_source / source_build_id / source_build_match /
  source_build_attested / acoustic_text_verified / reference_pcm_splicing /
  diagnostic_segments / diagnostics / timeline_ms / per_gpu` 等服务端字段，
  强制 `quality_verified=false`、`client_untrusted=true`、`speaker_heard=false`，
  并按 `report_sequence` 单调递增合并。

自动化测试会提交一段 `THIS MUST BE REDACTED` 自由文本，并断言诊断响应里不出现它。

---

## 7. 真实磁盘布局

`kaggle_workspace/replica_state/` 现在与原始工具期望的目录一致（老 `state.json` 会在
`load()` 时自动补齐缺失文件，不覆盖用户已有文件）：

```
active.json                             当前启用档案
url.txt                                 对外 URL
profiles/<id>/profile.json              声音档案（Go gateway / worker 读取）
profiles/<id>/ref.wav                   参考音频
libraries/<id>/library.json             原始样本库（library_api.py 读取）
libraries/<id>/<sid>.audio              上传的原始样本字节
training_data/<id>/manifest.json        训练输入快照（不是训练结果）
runs/<session>.json                     每次流式运行的完整回执
state.json                              Node 复刻自身的聚合状态
backend_probe.json                      兼容探针
```

`GET /api/health` 会返回 `on_disk_layout`（全部文件的相对路径 / 字节 / mtime），
浏览器「🔬 精准对照」页也能直接查看。

---

## 8. 两个 worker 的 HTTP 面

原系统里 Go `scheduler.go` 访问 `http://127.0.0.1:7001` 与 `:7002`。
本复刻把它们代理到同一服务的 `/worker/0/*`、`/worker/1/*`：

```bash
curl -s localhost:3000/worker/0/health | jq '{gpu,ready,model_loaded,engine,profiles}'
curl -s -X POST localhost:3000/worker/0/profile/load \
  -H 'Content-Type: application/json' -d '{"profile":"demo-voice-001"}'
curl -s -X POST localhost:3000/worker/0/synth \
  -H 'Content-Type: application/json' \
  -d '{"text":"线协议测试。","profile":"demo-voice-001","quality_policy":"windowed-linear","seed":7}' \
  --output - | xxd -l 16      # 5 字节头 + PCM/STATS
```

`/api/workers` 现在返回 `scheduler.Snapshots()` 等价结构（含 `worker` 子对象），
`/api/profiles/activate` 会同时对两个 worker 执行 `POST /profile/load`（双卡预热）。

---

## 9. 测试

```bash
npm start        # 另一个终端
npm test
# 24/24 files OK
# test:replica  63 passed, 0 failed   （Go/Python 算法与协议级断言）
# test:browser  23 passed, 0 failed   （jsdom 跑原始 web/app.js + 新精准对照视图）
```

新增的关键断言：9 字节帧头耗尽整个响应体、SEG 携带 Go 分段字段、STATS 携带
worker DSP 字段、read 模式无 TEXT、run 落盘到 `runs/<session>.json`、
`/worker/{0,1}/health` 与 5 字节 synth 帧、5 策略哈希不同、
`validateSpeak` 20000 字符上限、>1 MiB 返回 413、诊断不回显自由文本、
浏览器里 4 个探针按钮均可真实调用后端。

---

## 10. 依然无法在这里验证的部分

- 真实 Qwen-TTS / adapter 权重加载、声码器解码、音色相似度；
- 双 T4 的 RTF、首声延迟、显存占用；
- Whisper 转写 / 说话人嵌入 / 真实呼吸音；
- 真实 LoRA 训练（本项目只生成训练**输入快照**）。

这些仍需在 Kaggle 上用 `kaggle_workspace/notebooks/kaggle.ipynb` 验证。
本项目保证的是：**算法、协议、权限、脱敏、落盘都按源码精确复刻**，
并且每一处模拟都有 `simulated:true` / `quality_verified:false` 标记。
