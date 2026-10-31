import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ANALYTICS_PORT, BIN_DIR, DATA_DIR, JOURNAL_SOCK, ROOT, SOCK_DIR } from './config';

export interface ServiceSpec {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
}

export interface ServiceStatus {
  name: string;
  pid: number | undefined;
  running: boolean;
  restarts: number;
}

/** 极简进程监督器：崩溃自动拉起，日志统一加前缀输出。 */
export class Supervisor {
  private procs = new Map<string, { child: ChildProcess | null; restarts: number; spec: ServiceSpec }>();
  private stopping = false;

  add(spec: ServiceSpec): void {
    this.procs.set(spec.name, { child: null, restarts: 0, spec });
  }

  start(name: string): void {
    const entry = this.procs.get(name);
    if (!entry || this.stopping) return;
    if (entry.child) return;
    const { spec } = entry;
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    entry.child = child;

    const pipe = (stream: NodeJS.ReadableStream | null, level: string) => {
      if (!stream) return;
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) console.log(`[${spec.name}/${level}] ${line}`);
        }
      });
    };
    pipe(child.stdout, 'out');
    pipe(child.stderr, 'err');

    child.on('exit', (code, signal) => {
      entry.child = null;
      if (this.stopping) return;
      entry.restarts += 1;
      const delay = Math.min(5000, 300 * entry.restarts);
      console.warn(`[supervisor] ${spec.name} 退出 (code=${code} signal=${signal})，${delay}ms 后重启`);
      setTimeout(() => this.start(name), delay).unref();
    });
    child.on('error', (err) => {
      console.error(`[supervisor] ${spec.name} 启动失败: ${err.message}`);
    });
  }

  startAll(): void {
    for (const name of this.procs.keys()) this.start(name);
  }

  status(): ServiceStatus[] {
    return [...this.procs.entries()].map(([name, e]) => ({
      name,
      pid: e.child?.pid,
      running: Boolean(e.child && e.child.exitCode === null),
      restarts: e.restarts,
    }));
  }

  stopAll(): void {
    this.stopping = true;
    for (const [, e] of this.procs) {
      if (e.child && e.child.exitCode === null) {
        try {
          e.child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export function buildServiceSpecs(): ServiceSpec[] {
  return [
    {
      name: 'journal',
      command: path.join(BIN_DIR, 'journald'),
      args: ['--sock', JOURNAL_SOCK, '--dir', DATA_DIR],
    },
    {
      name: 'engine',
      command: path.join(BIN_DIR, 'engine'),
      args: ['--sock', path.join(SOCK_DIR, 'core.sock'), '--journal-sock', JOURNAL_SOCK],
    },
    {
      name: 'analytics',
      command: process.env.PYTHON || 'python3',
      args: [path.join(ROOT, 'analytics', 'service.py'), '--port', String(ANALYTICS_PORT), '--dir', DATA_DIR],
    },
  ];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForSocket(sockPath: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath)) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = net.createConnection(sockPath);
        s.once('connect', () => {
          s.destroy();
          resolve(true);
        });
        s.once('error', () => resolve(false));
      });
      if (ok) return true;
    }
    await sleep(80);
  }
  return false;
}

export async function waitForTcp(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}
