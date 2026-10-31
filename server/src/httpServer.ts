import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { ANALYTICS_URL, DATA_DIR, NUM_CAP, PORT, WEB_DIR } from './config';
import type { AdminAuth } from './auth';
import type { Board } from './board';
import type { CoreClient } from './core';
import { publicBaseUrl, qrSvg } from './qr';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** 只允许这些文件被静态访问（白名单，杜绝路径穿越） */
const ALLOW = new Set([
  'index.html',
  'styles.css',
  'app.js',
  'debug.html',
  'favicon.svg',
  'manifest.webmanifest',
]);

function sendJson(res: http.ServerResponse, payload: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function proxyAnalytics(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
  const forwardPath = url.replace(/^\/api/, '');
  const target = new URL(forwardPath, ANALYTICS_URL);
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      timeout: 4000,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, {
        'Content-Type': up.headers['content-type'] ?? 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      up.pipe(res);
    },
  );
  upstream.on('timeout', () => {
    upstream.destroy();
    sendJson(res, { ok: false, error: 'analytics timeout' }, 504);
  });
  upstream.on('error', (err) => {
    sendJson(res, { ok: false, error: `analytics unavailable: ${err.message}` }, 502);
  });
  upstream.end();
}

function serveStatic(res: http.ServerResponse, name: string): void {
  if (!ALLOW.has(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const file = path.join(WEB_DIR, name);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)] ?? 'application/octet-stream',
      'Content-Length': String(data.length),
      // 关闭缓存：改完前端立刻生效，不需要用户按刷新
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += chunk.length;
      if (size > 8192) {
        req.destroy();
        resolve({});
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export interface HubLike {
  readonly size: number;
}

export interface ServerDeps {
  board: Board;
  core: CoreClient;
  auth: AdminAuth;
  hub: HubLike;
  startedAt: number;
  children: () => Array<{ name: string; pid: number | undefined; running: boolean }>;
}

export function createHttpServer(deps: ServerDeps): http.Server {
  let logged = 0;
  // 只存公开的云端地址；管理员密码和 service-role key 不进入浏览器或日志。
  const cloudUrl = (process.env.CLOUD_BOARD_URL || '').trim().replace(/\/+$/, '');

  /* 自定义分享地址（例如自托管时的局域网 IP、反向代理域名、隧道地址） */
  const shareFile = path.join(DATA_DIR, 'share.json');
  let customBase: string | null = null;
  try {
    const raw = fs.readFileSync(shareFile, 'utf8');
    const cfg = JSON.parse(raw) as { base_url?: string };
    if (cfg.base_url) customBase = cfg.base_url;
  } catch {
    /* 没有配置文件就是自动推断 */
  }

  const saveCustomBase = (value: string | null): boolean => {
    customBase = value && value.trim() ? value.trim().replace(/\/+$/, '') : null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(shareFile, JSON.stringify({ base_url: customBase }, null, 2));
    } catch (err) {
      console.warn('[share] 保存失败', (err as Error).message);
      return false;
    }
    return true;
  };

  const joinUrlFor = (autoBase: string): string => {
    const base = customBase ?? (cloudUrl || autoBase);
    return `${base.replace(/\/+$/, '')}/`;
  };

  const debugReq = process.env.DEBUG_REQ === '1';

  const server = http.createServer((req, res) => {
    const raw = req.url ?? '/';
    if (debugReq && logged < 30) {
      logged += 1;
      console.log(
        `[req] ${req.method} ${raw} host=${req.headers.host ?? '-'} xfh=${
          req.headers['x-forwarded-host'] ?? '-'
        } xfp=${req.headers['x-forwarded-proto'] ?? '-'} headers=${Object.keys(req.headers).join(',')}`,
      );
    }
    const url = raw.split('?')[0];

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url === '/' || url === '/index.html') return serveStatic(res, 'index.html');
      const staticName = url.replace(/^\//, '');
      if (ALLOW.has(staticName)) return serveStatic(res, staticName);

      if (url === '/api/qr.svg') {
        const base = publicBaseUrl(req.headers as Record<string, string | string[] | undefined>, PORT);
        const joinUrl = joinUrlFor(base);
        qrSvg(joinUrl)
          .then((svg) => {
            res.writeHead(200, {
              'Content-Type': 'image/svg+xml; charset=utf-8',
              'Cache-Control': 'no-cache',
              'X-Join-Url': joinUrl,
            });
            res.end(svg);
          })
          .catch((err: Error) => sendJson(res, { ok: false, error: err.message }, 500));
        return;
      }

      if (url === '/api/config') {
        return sendJson(res, cloudUrl
          ? { ok: true, mode: 'redirect', cloud_url: cloudUrl }
          : { ok: true, mode: 'local', admin_configured: deps.auth.configured });
      }

      if (url === '/api/admin/session') {
        return sendJson(res, { ok: true, authenticated: deps.auth.fromRequest(req), configured: deps.auth.configured });
      }

      if (url === '/api/state') {
        const snap = deps.board.snapshot();
        return sendJson(res, { ok: true, ...snap, peers: deps.hub.size });
      }

      if (url === '/api/join-url') {
        const base = publicBaseUrl(req.headers as Record<string, string | string[] | undefined>, PORT);
        return sendJson(res, {
          ok: true,
          url: joinUrlFor(base),
          auto_url: `${base}/`,
          custom_url: customBase,
          hosting: cloudUrl ? 'supabase' : (process.env.E2B_SANDBOX === 'true' && !customBase ? 'private_sandbox' : 'self_hosted'),
        });
      }

      if (url === '/api/health') {
        return sendJson(res, {
          ok: true,
          uptime_sec: Math.round((Date.now() - deps.startedAt) / 1000),
          rev: deps.board.snapshot().rev,
          peers: deps.hub.size,
          share_link_ready: Boolean(cloudUrl || customBase || process.env.E2B_SANDBOX !== 'true'),
          core: {
            ready: deps.core.isReady,
            last_latency_ms: Number(deps.core.lastLatencyMs.toFixed(3)),
          },
          services: deps.children(),
        });
      }

      if (url === '/api/stats' || url === '/api/history' || url === '/api/export.csv') {
        return proxyAnalytics(req, res, raw);
      }
    }

    if (req.method === 'POST' && url === '/api/admin/login') {
      void readJsonBody(req).then((body) => {
        const password = typeof body.password === 'string' ? body.password.slice(0, 1024) : '';
        const result = deps.auth.login(password, req.socket.remoteAddress || 'unknown');
        if (result.token) sendJson(res, { ok: true, token: result.token });
        else sendJson(res, { ok: false, error: result.error }, result.error === 'ADMIN_NOT_CONFIGURED' ? 503 : 401);
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/admin/logout') {
      deps.auth.logout(req);
      return sendJson(res, { ok: true });
    }

    // ---- HTTP 兜底通道：某些网络会掐掉 WebSocket，此时改用 POST + 轮询 ----
    if (req.method === 'POST' && (url === '/api/set' || url === '/api/confirm')) {
      void readJsonBody(req).then(async (body) => {
        try {
          if (url === '/api/set') {
            const field = String(body.field ?? '');
            if (!['order_no', 'product', 'current', 'now', 'total'].includes(field)) {
              sendJson(res, { ok: false, error: 'BAD_FIELD' }, 400);
              return;
            }
            if (field === 'current') {
              sendJson(res, { ok: false, error: 'READ_ONLY' }, 403);
              return;
            }
            if (field === 'total' && !deps.auth.fromRequest(req)) {
              sendJson(res, { ok: false, error: 'ADMIN_REQUIRED' }, 403);
              return;
            }
            if (field === 'total' || field === 'now') {
              const value = Number(body.value);
              if (!Number.isSafeInteger(value) || value < 0 || value > NUM_CAP) {
                sendJson(res, { ok: false, error: 'BAD_NUMBER' }, 400);
                return;
              }
            }
            const u = await deps.board.setField(
              field as 'order_no' | 'product' | 'current' | 'now' | 'total',
              body.value as string | number,
            );
            sendJson(res, { ok: true, rev: u.rev, state: u.state });
          } else {
            const amount = Number(body.amount ?? 0);
            if (!Number.isSafeInteger(amount) || amount <= 0 || amount > NUM_CAP) {
              sendJson(res, { ok: false, error: 'BAD_AMOUNT' }, 400);
              return;
            }
            const u = await deps.board.confirm(Math.trunc(amount), 'http');
            sendJson(res, { ok: true, rev: u.rev, state: u.state, delta: u.commit?.delta ?? 0 });
          }
        } catch (err) {
          const code = (err as Error).message;
          sendJson(res, { ok: false, error: code }, ['EXCEEDS_TOTAL', 'TOTAL_TOO_SMALL'].includes(code) ? 409 : 500);
        }
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/share') {
      if (!deps.auth.fromRequest(req)) return sendJson(res, { ok: false, error: 'ADMIN_REQUIRED' }, 403);
      void readJsonBody(req).then((body) => {
        const value = body.url === null || body.url === undefined ? '' : String(body.url);
        if (value && !/^https?:\/\/[^\s]+$/i.test(value)) {
          sendJson(res, { ok: false, error: 'BAD_URL' }, 400);
          return;
        }
        const ok = saveCustomBase(value || null);
        const base = publicBaseUrl(
          req.headers as Record<string, string | string[] | undefined>,
          PORT,
        );
        sendJson(res, { ok, url: joinUrlFor(base), custom_url: customBase });
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/reset') {
      if (!deps.auth.fromRequest(req)) return sendJson(res, { ok: false, error: 'ADMIN_REQUIRED' }, 403);
      deps.board
        .reset()
        .then((u) => sendJson(res, { ok: true, rev: u.rev, state: u.state }))
        .catch((err: Error) => sendJson(res, { ok: false, error: err.message }, 500));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return server;
}
