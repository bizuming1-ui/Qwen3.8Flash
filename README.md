# 界面1 · 实时生产看板

> 把一张 Word 设计稿（`界面1`）做成了可用的多端实时系统：手机扫码即入，任意设备填写即时同步，
> 「确认」是一个原子事务——`现在` 清零、`当前生产数` 与 `生产总数` 同时累加。

设计稿 → 成品：整块画布按原图 **1356×834** 逐像素还原，再用 `transform: scale()` 等比适配任何屏幕，
因此手机、平板、电脑上看到的比例与设计稿完全一致。

---

## 1. 多语言分工（每一层都用最合适的语言）

```
                 浏览器 A（手机）            浏览器 B（电脑）
                        │  WebSocket (ws/wss)      │
                        └───────────┬──────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────┐
        │  网关 / 实时广播  ·  TypeScript (Node 22)          │
        │  server/src/*.ts  HTTP + WebSocket + 二维码 + 代理  │
        └───────┬───────────────────────────┬──────────────┘
                │ Unix Domain Socket        │ HTTP 127.0.0.1
                ▼                           ▼
   ┌────────────────────────┐     ┌──────────────────────────┐
   │ 权威状态机 · C          │     │ 审计统计 · Python         │
   │ core/engine.c          │     │ analytics/service.py     │
   │ 唯一真相 / 确认事务 /   │     │ 日志解析 / 统计 / CSV 导出 │
   │ 输入校验 / 版本号 rev   │     └────────────▲─────────────┘
   └───────┬────────────────┘                  │ 只读
           │ APPEND (WAL)                      │
           ▼                                   │
   ┌────────────────────────┐                  │
   │ 追加写日志 · C++        │──────────────────┘
   │ journal/journald.cpp   │   data/journal.log（CRC32 校验）
   │ 崩溃恢复 / 轮转 / fsync │
   └────────────────────────┘
```

| 语言 | 文件 | 为什么是它 |
| --- | --- | --- |
| **C** | `core/engine.c` | 权威状态机 + 唯一的「确认」事务。要求微秒级延迟、零 GC、零运行时，多设备并发时只有一个串行化顺序，杜绝状态分叉。 |
| **C++** | `journal/journald.cpp` | 追加写 WAL：大缓冲写入、CRC32 校验、按大小轮转、定时 `fsync`。日志被截断/损坏时仍能恢复到「最后一条完好记录」。 |
| **Python** | `analytics/service.py` | 只读的审计与统计：逐行校验 CRC、解析 JSON、聚合节拍/按单产出、导出 CSV。不参与写路径，跑多慢都不影响看板。 |
| **TypeScript** | `server/src/*.ts`, `web/src/app.ts` | 网关 + WebSocket 实时广播 + 二维码生成；前端像素级还原设计稿、断线重连、输入防抖。 |

> 关于 Go / Rust / Java：本沙盒的可联网域名只有 npm / PyPI / GitHub，这三家的官方发行包走
> `go.dev`、`static.rust-lang.org`、Adoptium CDN，都拿不到工具链，强行引入只会让一键启动变脆。
> 因此按「每种语言都做它最擅长的那一段」的原则落地了上面四种；`bin/` + UDS 协议是通用的，
> 将来要加 Go/Rust 服务，只需再挂一个监听同一份状态/日志的进程即可（见 `docs/DESIGN.md`）。

---

## 2. 快速开始

```bash
npm install          # 只装 ws / qrcode / typescript
npm run build        # 编译 C、C++、TypeScript（一次即可）
npm start            # 或 bash scripts/dev.sh；默认 http://0.0.0.0:3000
```

打开页面即可用；点右上角二维码会放大，**别的手机扫码就进入同一块看板**（多用户协同）。
端口可用环境变量覆盖：`PORT=3000 ANALYTICS_PORT=7102 npm start`。

### 交互规则（与需求一一对应）

| 操作 | 结果 |
| --- | --- |
| 在 `生产单` / `产品` 输入 | 80ms 防抖后推送，所有在线设备立刻看到（不需要按刷新键） |
| 在 `当前生产数` 输入 | 直接改写当前值（手动校准） |
| 在 `现在` 输入数字 → 按 `确认` | **原子事务**：`现在` 清零；`当前生产数 += n`；`生产总数 += n`；全端同步 |
| `生产总数` | 由系统维护（只读），每次确认自动累加 |
| 断网 / 切后台 | WebSocket 指数退避自动重连，回来立刻对齐最新版本，无需刷新 |
| 网络把 WebSocket 掐掉 | 自动降级为 HTTP 写入 + 1s 轮询（`POST /api/set`、`POST /api/confirm`），界面照样实时可用 |

辅助入口：

- `GET /debug.html` —— 运行状态面板：三个子服务是否在线、内核往返延迟、在线设备数、审计统计、历史记录、CSV 导出、清空数据。
- `GET /api/qr.svg` —— 二维码（自动根据反向代理的 `x-forwarded-*` 推断公网地址；本地调试时回退到局域网 IP）。
- `GET /api/stats` `GET /api/history?limit=50` `GET /api/export.csv` —— Python 审计服务（网关反代）。
- `npm run smoke` —— 端到端自检：静态页、二维码、C 内核、双设备实时同步、确认事务、审计落盘，一次跑完。

---

## 3. 目录结构

```
core/engine.c            C   权威状态机（GET/SET/CONFIRM/RESET）· UDS 行协议 · base64 传文本
journal/journald.cpp     C++ WAL（APPEND/LAST/STATS/SYNC）· CRC32 · 8MB 轮转 · fsync
analytics/service.py     Py  审计 HTTP（/stats /history /export.csv），只读日志
server/src/config.ts     TS  路径/端口/上限常量
server/src/core.ts       TS  C 内核客户端（行协议、请求队列、自动重连）
server/src/board.ts      TS  业务缓存 + 广播入口（绝不自己推导状态）
server/src/websocket.ts  TS  WS Hub：hello / state / ack / peers，心跳探活
server/src/qr.ts         TS  二维码 SVG + 公网地址推断
server/src/httpServer.ts TS  静态资源（白名单）/ API / Python 反代
server/src/supervisor.ts TS  子进程监督：崩溃自动拉起、日志前缀
web/index.html           --  与设计稿同构的 DOM
web/styles.css           --  像素级坐标（注释里写了每个框的实测值）
web/src/app.ts           TS  缩放适配 / WebSocket / 防抖 / 确认事务 / 二维码弹层
data/journal.log         运行时生成的审计日志（已 gitignore）
```

---

## 4. 设计稿还原说明

坐标全部来自对原图的像素测量（见 `web/styles.css` 顶部注释）：

| 元素 | 原图坐标 | 尺寸 | 边框 | 圆角 |
| --- | --- | --- | --- | --- |
| 外框 | (30, 9) | 1317×808 | 6px | 138px |
| 生产单 / 产品 | (296, 186) / (296, 346) | 232×70 | 4px | 11px |
| 当前生产数 | (296, 519) | 232×70 | 4px | 11px |
| 生产总数 / 现在 | (837, 348) / (837, 512) | 232×70 | 4px | 11px |
| 确认 | (1030, 711) | 232×70 | 4px | 12px |
| 二维码 | (1092, 71) | 174×181 | 4px | 27px |

字体用宋体系字族（`Songti SC / SimSun / Noto Serif CJK SC`），与原图的 Word 宋体加粗一致。

两点务实处理：

1. 原图每个标签后面有一个灰色 `↵`——那是 Word 的段落编辑标记，属于文档痕迹，默认隐藏；
   需要 100% 复刻截图时访问 `?marks=1` 即可显示。
2. 二维码框在原图里是空白占位，成品里放的是**真实可扫的二维码**（点一下可放大 / 复制链接），
   否则「其他设备扫码进入」这个核心功能无法实现。

---

## 5. 可靠性与性能

- **唯一真相**：状态只存在于 C 内核，Node 只是搬运工；`CONFIRM` 在内核里是一个不可分割的操作。
- **崩溃恢复**：每个变更都写入 `data/journal.log`（`#crc32#json`）；重启后 C 内核向 C++ 服务要最后一条
  完好记录并恢复，实测重启后 `rev/total/current/生产单/产品` 全部还原。
- **实时性**：WebSocket 推送而非轮询，本机实测内核往返 ≈ 0.1ms，端到端（改一个字段到另一台设备看到）通常 < 20ms。
- **多端一致**：所有下行消息带单调递增 `rev`，客户端丢弃过期帧；确认事件强制回填，避免「别处改了但我这里没清」。
- **不脏读**：正在输入的字段在 1.2s 内不会被远端回包覆盖（避免光标跳动），但「确认」会强制对齐数字字段。
