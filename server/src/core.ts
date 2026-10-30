import { EventEmitter } from 'node:events';
import net from 'node:net';

import { CORE_SOCK } from './config';

export interface BoardState {
  order_no: string;
  product: string;
  total: number;
  current: number;
  now: number;
}

export interface CoreResult {
  kind: 'state' | 'commit';
  rev: number;
  delta: number;
  state: BoardState;
}

function b64encode(text: string): string {
  if (!text) return '-';
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(raw: string): string {
  if (!raw || raw === '-') return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * C 内核的进程内客户端。
 * 内核是唯一真相来源：Node 只转发行协议，自己绝不推导业务状态，
 * 因此多设备并发时永远只有一个权威顺序。
 */
export class CoreClient extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = '';
  private pending: Array<{
    resolve: (v: CoreResult) => void;
    reject: (e: Error) => void;
    timer?: NodeJS.Timeout;
  }> = [];
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  private ready = false;
  public lastLatencyMs = 0;

  constructor(private readonly sockPath: string = CORE_SOCK) {
    super();
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.sock) return;
    const sock = net.createConnection(this.sockPath);
    sock.setNoDelay(true);
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      this.sock = sock;
      this.buf = '';
      this.ready = true;
      this.retry = 0;
      this.emit('ready');
    });

    sock.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.trim()) this.onLine(line);
      }
      if (this.buf.length > 1 << 20) this.buf = '';
    });

    const drop = (err?: Error) => {
      if (this.sock === sock) this.sock = null;
      this.ready = false;
      const waiting = this.pending;
      this.pending = [];
      for (const p of waiting) p.reject(err ?? new Error('core disconnected'));
      if (this.timer) return;
      const delay = Math.min(2000, 100 * 2 ** this.retry++);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };

    sock.on('error', () => drop());
    sock.on('close', () => drop());
  }

  private onLine(line: string): void {
    const parts = line.split(' ');
    let result: CoreResult | null = null;

    if (parts[0] === 'STATE' && parts.length >= 7) {
      // STATE rev total current now order_b64 product_b64
      result = {
        kind: 'state',
        rev: Number(parts[1]),
        delta: 0,
        state: {
          total: Number(parts[2]),
          current: Number(parts[3]),
          now: Number(parts[4]),
          order_no: b64decode(parts[5]),
          product: b64decode(parts[6]),
        },
      };
    } else if (parts[0] === 'COMMIT' && parts.length >= 8) {
      // COMMIT rev delta total current now order_b64 product_b64
      result = {
        kind: 'commit',
        rev: Number(parts[1]),
        delta: Number(parts[2]),
        state: {
          total: Number(parts[3]),
          current: Number(parts[4]),
          now: Number(parts[5]),
          order_no: b64decode(parts[6]),
          product: b64decode(parts[7]),
        },
      };
    } else if (parts[0] === 'ERR') {
      const p = this.pending.shift();
      p?.reject(new Error(parts.slice(1).join(' ') || 'core error'));
      return;
    }

    if (!result) return;
    const p = this.pending.shift();
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve(result);
    } else {
      this.emit('unsolicited', result); // 连接建立时内核主动推送的 STATE
    }
  }

  request(line: string, timeoutMs = 5000): Promise<CoreResult> {
    return new Promise<CoreResult>((resolve, reject) => {
      const sock = this.sock;
      if (!sock || !this.ready) {
        reject(new Error('core not ready'));
        return;
      }
      const entry: { resolve: (v: CoreResult) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = {
        resolve,
        reject,
      };
      entry.timer = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error('core timeout'));
      }, timeoutMs);
      entry.timer.unref();

      this.pending.push(entry);
      const started = process.hrtime.bigint();
      sock.write(`${line}\n`, (err) => {
        if (err) {
          const idx = this.pending.indexOf(entry);
          if (idx >= 0) this.pending.splice(idx, 1);
          if (entry.timer) clearTimeout(entry.timer);
          reject(err);
          return;
        }
        this.lastLatencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      });
    });
  }

  set(
    field: 'order_no' | 'product' | 'current' | 'now',
    value: string | number,
  ): Promise<CoreResult> {
    const raw =
      field === 'order_no' || field === 'product'
        ? b64encode(String(value))
        : String(Math.max(0, Math.trunc(Number(value) || 0)));
    return this.request(`SET ${field} ${raw}`);
  }

  confirm(amount: number): Promise<CoreResult> {
    return this.request(`CONFIRM ${Math.max(0, Math.trunc(amount || 0))}`);
  }

  reset(): Promise<CoreResult> {
    return this.request('RESET');
  }

  get(): Promise<CoreResult> {
    return this.request('GET');
  }
}
