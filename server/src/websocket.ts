import type { Server } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import type { Board, BoardUpdate } from './board';

interface ClientMeta {
  id: number;
  alive: boolean;
}

/**
 * 实时推送层（"不需要手动刷新"的核心）：
 * 任何一次状态变更都会立刻推给所有在线设备，单程延迟在局域网内 < 5ms。
 */
export class Hub {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientMeta>();
  private seq = 1;
  private heartbeat: NodeJS.Timeout;

  constructor(server: Server, private readonly board: Board) {
    this.wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.board.on('update', (u: BoardUpdate) => this.broadcastState(u));

    this.heartbeat = setInterval(() => {
      for (const [ws, meta] of this.clients) {
        if (!meta.alive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        meta.alive = false;
        try {
          ws.ping();
        } catch {
          this.clients.delete(ws);
        }
      }
      this.broadcastPeers();
    }, 20_000);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  private onConnection(ws: WebSocket): void {
    const meta: ClientMeta = { id: this.seq++, alive: true };
    this.clients.set(ws, meta);
    ws.on('pong', () => {
      meta.alive = true;
    });

    const snap = this.board.snapshot();
    this.send(ws, { t: 'hello', id: meta.id, rev: snap.rev, state: snap.state, peers: this.clients.size });
    this.broadcastPeers();

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.handle(ws, meta, msg);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.broadcastPeers();
    });
    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  private async handle(ws: WebSocket, meta: ClientMeta, msg: Record<string, unknown>): Promise<void> {
    const t = String(msg.t ?? '');
    try {
      if (t === 'set') {
        const field = String(msg.field ?? '');
        if (!['order_no', 'product', 'current', 'now', 'total'].includes(field)) {
          this.send(ws, { t: 'error', message: 'BAD_FIELD' });
          return;
        }
        const value = msg.value as string | number;
        const update = await this.board.setField(
          field as 'order_no' | 'product' | 'current' | 'now' | 'total',
          value,
        );
        // setField 内部已通过 board 'update' 广播；此处只回执版本号给发起方
        this.send(ws, { t: 'ack', rev: update.rev, field });
      } else if (t === 'confirm') {
        const amount = Number(msg.amount ?? 0);
        if (!Number.isFinite(amount) || amount < 0) {
          this.send(ws, { t: 'error', message: 'BAD_AMOUNT' });
          return;
        }
        // board.confirm 内部已经通过 'update' 事件广播给所有设备
        const update = await this.board.confirm(Math.trunc(amount), `#${meta.id}`);
        this.send(ws, { t: 'ack', rev: update.rev, action: 'confirm', delta: update.commit?.delta ?? 0 });
      } else if (t === 'ping') {
        this.send(ws, { t: 'pong', at: Date.now() });
      } else if (t === 'sync') {
        const snap = this.board.snapshot();
        this.send(ws, { t: 'state', rev: snap.rev, state: snap.state });
      }
    } catch (err) {
      this.send(ws, { t: 'error', message: (err as Error).message });
    }
  }

  private broadcastState(u: BoardUpdate): void {
    this.broadcast({ t: 'state', rev: u.rev, state: u.state, commit: u.commit ?? null });
  }

  private broadcastPeers(): void {
    this.broadcast({ t: 'peers', n: this.clients.size });
  }

  broadcast(payload: unknown, except?: WebSocket): void {
    const data = JSON.stringify(payload);
    for (const ws of this.clients.keys()) {
      if (ws === except) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
}
