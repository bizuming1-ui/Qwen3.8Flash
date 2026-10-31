import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** 自托管模式的管理员会话。云端使用 Supabase Auth，不共享这套会话。 */
export class AdminAuth {
  private readonly password = process.env.BOARD_ADMIN_PASSWORD || '';
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly lifetimeMs = 8 * 60 * 60 * 1000;

  get configured(): boolean {
    return this.password.length > 0;
  }

  login(candidate: string, client: string): { token?: string; error?: string } {
    if (!this.configured) return { error: 'ADMIN_NOT_CONFIGURED' };
    const now = Date.now();
    const failure = this.failures.get(client);
    if (failure && failure.until > now && failure.count >= 5) return { error: 'ADMIN_LOCKED' };
    const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest();
    const ok = timingSafeEqual(hash(candidate), hash(this.password));
    if (!ok) {
      const count = failure && failure.until > now ? failure.count + 1 : 1;
      this.failures.set(client, { count, until: now + 15 * 60 * 1000 });
      return { error: count >= 5 ? 'ADMIN_LOCKED' : 'BAD_CREDENTIALS' };
    }
    this.failures.delete(client);
    for (const [key, expiry] of this.sessions) if (expiry <= now) this.sessions.delete(key);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + this.lifetimeMs);
    return { token };
  }

  valid(token: unknown): boolean {
    if (typeof token !== 'string' || !token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  fromRequest(req: IncomingMessage): boolean {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return this.valid(m?.[1]);
  }

  logout(req: IncomingMessage): void {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) this.sessions.delete(m[1]);
  }
}
