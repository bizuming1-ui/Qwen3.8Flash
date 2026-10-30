import { EventEmitter } from 'node:events';

import { NUM_CAP, TEXT_CAP } from './config';
import type { BoardState, CoreClient, CoreResult } from './core';

export interface BoardUpdate {
  rev: number;
  state: BoardState;
  commit?: { delta: number; at: number; by: string };
}

/**
 * 看板业务层。
 * 注意：这里不维护「真相」，只是 C 内核的缓存 + 广播入口，
 * 任何并发写入都由内核串行化，保证「确认」的原子性。
 */
export class Board extends EventEmitter {
  private state: BoardState = { order_no: '', product: '', total: 0, current: 0, now: 0 };
  private rev = 0;
  private readyOnce = false;

  constructor(private readonly core: CoreClient) {
    super();
    this.core.on('unsolicited', (r: CoreResult) => this.apply(r));
    this.core.on('ready', () => {
      void this.resync();
    });
  }

  snapshot(): { rev: number; state: BoardState } {
    return { rev: this.rev, state: { ...this.state } };
  }

  private apply(result: CoreResult): BoardUpdate | null {
    if (!result || !result.state) return null;
    if (result.rev < this.rev) return null;
    const changed = result.rev > this.rev || !this.readyOnce;
    this.state = result.state;
    this.rev = result.rev;
    this.readyOnce = true;
    if (!changed) return null;
    const update: BoardUpdate = {
      rev: this.rev,
      state: { ...this.state },
      commit: result.kind === 'commit' ? { delta: result.delta, at: Date.now(), by: '' } : undefined,
    };
    this.emit('update', update);
    return update;
  }

  async resync(): Promise<void> {
    try {
      const r = await this.core.get();
      this.apply(r);
    } catch {
      /* 内核未就绪，等下一次 ready */
    }
  }

  async setField(
    field: 'order_no' | 'product' | 'current' | 'now',
    value: string | number,
  ): Promise<BoardUpdate> {
    let v: string | number = value;
    if (field === 'order_no' || field === 'product') {
      v = String(value).slice(0, TEXT_CAP);
    } else {
      const n = Number(value);
      v = Number.isFinite(n) ? Math.min(NUM_CAP, Math.max(0, Math.trunc(n))) : 0;
    }
    const r = await this.core.set(field, v);
    const u = this.apply(r);
    return u ?? { rev: this.rev, state: { ...this.state } };
  }

  async confirm(amount: number, by = ''): Promise<BoardUpdate> {
    const r = await this.core.confirm(amount);
    const u = this.apply(r);
    const update: BoardUpdate = u ?? { rev: this.rev, state: { ...this.state } };
    update.commit = { delta: r.delta, at: Date.now(), by };
    return update;
  }

  async reset(): Promise<BoardUpdate> {
    const r = await this.core.reset();
    return this.apply(r) ?? { rev: this.rev, state: { ...this.state } };
  }
}
