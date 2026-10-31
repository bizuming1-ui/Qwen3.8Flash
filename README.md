# 界面1 · 实时生产看板

## 线上入口

网页：<https://bizuming1-ui.github.io/Qwen3.8Flash/>

网页由 GitHub Pages 发布；数据、实时通知和管理员登录使用 `xingyi` Supabase 项目。电脑和手机必须打开**同一个线上入口**，二维码也指向这个入口。Supabase 默认域名不托管 HTML，因此网页和后端分别部署。

> 二维码对应的网页是公开地址。知道地址的人可以查看看板、填写生产单/产品/现在并提交产量；请只分享给被授权的人员。生产总数、清空看板和修改分享地址需要管理员登录。若需要把普通操作也限制为登录用户，应另行配置身份和权限，当前版本没有假称具备该功能。

## 操作规则

- **生产总数**：管理员登录后手工设置；不能小于当前生产数。
- **当前生产数**：只读，不能手动输入或通过接口直接修改。
- **现在 → 确认**：`当前生产数 += 现在`，成功后 `现在` 清零，生产总数不变。
- 如果本次数量使累计数超过生产总数，拒绝整次提交并显示错误；当前生产数、总数和版本不变，输入不被乐观清空。总数为 0 时不能确认正数。
- 管理员清空看板可开始新单；历史审计记录保留。管理员也不能突破数量上限。
- 桌面端保留设计稿的 1356×834 布局；竖屏手机改用可滚动、可触控的字段布局。
- 云端通过 Supabase Realtime 推送，另有 2 秒轮询兜底；本地通过 WebSocket 推送和轮询兜底。断网恢复后自动重新对齐，无需手动刷新。

点击页面左下角 **管理员登录**，用项目中已授权的 Supabase Auth 用户的邮箱和密码登录；密码只提交给 Supabase Auth，不放入仓库或二维码。点击二维码可放大、复制链接；管理员可设置自定义分享地址。自定义地址必须指向同一个部署，否则扫码设备不一定会连接同一份看板。

## 云端和本地分别运行什么？

Supabase 不支持直接运行此项目的 C/C++ 常驻进程。为避免误导，两个部署模式的权威状态和持久化分别如下：

| 模式 | 权威状态及并发控制 | 审计 | 网页及网关 |
| --- | --- | --- | --- |
| **线上** | Supabase PostgreSQL 行锁、事务、`CHECK`、RLS、受控 RPC；确认请求有幂等 ID | Supabase 的独立 `qwen_board_events` 表 | GitHub Pages + TypeScript + Supabase Edge Function |
| **自托管** | C 状态机（`core/engine.c`）及 Unix socket | C++ WAL（`journal/journald.cpp`）+ Python 统计（`analytics/service.py`） | TypeScript Node 网关和网页 |

线上只新增 `qwen_board_*` 表和函数，不覆盖项目中已有的 `orders`、`production_events`、`app_settings` 等表。线上和本机各自持有独立数据；如果希望本机预览与手机同步，使用下面的 `CLOUD_BOARD_URL`，让浏览器连接同一个线上后端，而不是把本地和云端当成同一份数据。

## 本地启动

需要 Node.js 20+、Python 3、C/C++ 编译器：

```bash
npm ci
npm run build
# 不要把密码写进仓库；生产环境设置足够强的密码并保存在自己的密钥管理器。
read -r -s -p '设置本地管理员密码: ' BOARD_ADMIN_PASSWORD; echo
export BOARD_ADMIN_PASSWORD
npm start
```

打开 <http://localhost:3000/>。本地管理员只使用上述密码；未配置密码时管理操作会拒绝，不能靠默认密码登录。在局域网部署时，手机和主机需要网络互通。Arena 的私有预览地址可能被平台网关拦截，不能当作公网扫码地址。

需要让本地预览**使用同一个线上看板**时：

```bash
CLOUD_BOARD_URL=https://cdaplcswcdjfbkdbabji.supabase.co/functions/v1/qwen-board npm start
```

此时浏览器的读写和二维码使用 Supabase / GitHub Pages；本机 C 状态并不冒充线上状态。

## 更新 GitHub Pages

仓库 Pages 的发布来源为当前工作分支的 `/docs`。修改前端后生成并提交所需的静态文件：

```bash
PUBLIC_CLOUD_URL=https://cdaplcswcdjfbkdbabji.supabase.co/functions/v1/qwen-board npm run build:pages
```

`docs/index.html`、`docs/app.js`、样式等是 Pages 必需的构建产物；不要把其他临时构建或数据文件提交进去。Pages 设置路径：GitHub 仓库 **Settings → Pages → Deploy from a branch**，选择发布分支和 `/docs`。Supabase 迁移位于 `supabase/migrations/`，Edge Function 源码位于 `supabase/functions/qwen-board/`。数据库管理员身份单独配置在 `qwen_board_admins`，不得把密码或 service-role key 写入前端。

## 验证和排障

```bash
npm run build
npm test                    # 隔离临时目录和随机端口，不影响真实看板
# 如需针对已运行的本地服务检查：此命令会修改目标数据
BOARD_ADMIN_PASSWORD='本地密码' npm run smoke
```

`npm test` 覆盖管理员权限、当前数只读、上限拒绝、并发确认、两端广播、审计、重启恢复和清空后的递增版本。二维码弹层显示当前分享地址。`/debug.html` 提供状态、统计、历史和 CSV 导出；线上 CSV 最多导出最近 10000 条记录。管理员操作需先在同一浏览器会话登录。

线上故障排查顺序：确认 GitHub Pages 已发布；再检查 Supabase 数据库、Auth、Realtime 和 Edge Function 的状态。不要把 Supabase service-role key 或管理员密码放进 GitHub、浏览器脚本或二维码。
