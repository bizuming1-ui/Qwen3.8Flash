import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { Board } from './board';
import {
  ANALYTICS_PORT,
  CORE_SOCK,
  DATA_DIR,
  HOST,
  JOURNAL_SOCK,
  PORT,
  ROOT,
  SOCK_DIR,
} from './config';
import { CoreClient } from './core';
import { createHttpServer } from './httpServer';
import { buildServiceSpecs, sleep, Supervisor, waitForSocket, waitForTcp } from './supervisor';
import { Hub } from './websocket';

const startedAt = Date.now();

function ensureDirs(): void {
  for (const dir of [DATA_DIR, SOCK_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.chmodSync(dir, 0o777);
    } catch {
      /* ignore */
    }
  }
  // 清理上次残留的 socket 文件
  for (const s of [CORE_SOCK, JOURNAL_SOCK]) {
    try {
      fs.unlinkSync(s);
    } catch {
      /* ignore */
    }
  }
}

function assertBinaries(): void {
  const missing = ['engine', 'journald'].filter((n) => !fs.existsSync(`${ROOT}/bin/${n}`));
  if (missing.length) {
    console.error(
      `[boot] 缺少二进制: ${missing.join(', ')}；请先执行 npm run build（或 bash scripts/build.sh）`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  ensureDirs();
  assertBinaries();

  const supervisor = new Supervisor();
  for (const spec of buildServiceSpecs()) supervisor.add(spec);

  // 1) 日志服务（C++）先起，因为它保管历史
  supervisor.start('journal');
  const journalOk = await waitForSocket(JOURNAL_SOCK);
  console.log(`[boot] journal ${journalOk ? 'ok' : '未就绪（降级运行）'}`);

  // 2) 状态内核（C）
  supervisor.start('engine');
  const coreOk = await waitForSocket(CORE_SOCK);
  if (!coreOk) console.error('[boot] engine 未就绪，服务将以只读降级模式启动');
  console.log(`[boot] engine ${coreOk ? 'ok' : 'fail'}`);

  // 3) 审计统计（Python）
  supervisor.start('analytics');
  const pyOk = await waitForTcp(ANALYTICS_PORT);
  console.log(`[boot] analytics ${pyOk ? 'ok' : '未就绪（历史接口不可用）'}`);

  // 4) 网关（TypeScript）
  const core = new CoreClient(CORE_SOCK);
  core.start();
  await sleep(120);

  const board = new Board(core);
  await board.resync();

  // http 服务与 ws 服务互相依赖，用惰性引用解环
  let hub: Hub | null = null;
  const hubRef = {
    get size() {
      return hub?.size ?? 0;
    },
  };

  const server = createHttpServer({
    board,
    core,
    hub: hubRef,
    startedAt,
    children: () =>
      supervisor.status().map((s) => ({ name: s.name, pid: s.pid, running: s.running })),
  });

  hub = new Hub(server, board);

  server.listen(PORT, HOST, () => {
    console.log(`[boot] 看板已就绪 http://${HOST}:${PORT}  rev=${board.snapshot().rev}`);
  });

  try {
    const url = execFileSync('sh', ['-c', `hostname -I 2>/dev/null | awk '{print $1}'`], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    if (url) console.log(`[boot] 局域网地址 http://${url}:${PORT}`);
  } catch {
    /* 忽略 */
  }

  const shutdown = (sig: string) => {
    console.log(`[boot] 收到 ${sig}，正在关闭…`);
    supervisor.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => console.error('[boot] 未捕获异常', err));
  process.on('unhandledRejection', (err) => console.error('[boot] 未处理的 Promise 拒绝', err));
}

void main();
