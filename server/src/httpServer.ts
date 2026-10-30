import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { ANALYTICS_URL, DATA_DIR, PORT, WEB_DIR } from './config';
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
  hub: HubLike;
  startedAt: number;
  children: () => Array<{ name: string; pid: number | undefined; running: boolean }>;
}

/** 平台（E2B）访问令牌参数名：私有沙盒要求每个请求都带它 */
const AUTH_PARAM = 'e2b-traffic-access-token';

export function createHttpServer(deps: ServerDeps): http.Server {
  let logged = 0;
  /**
   * 自愈式令牌捕获：如果平台/代理把令牌以查询参数透传到本服务（有些会，
   * 因为 iframe 的 URL 可能带上它），我们就记住它，并把二维码改成带令牌的
   * 可直接访问链接。拿不到时二维码仍是裸链接（并给出明确说明）。
   */
  let trafficToken: string | null = process.env.E2B_TRAFFIC_ACCESS_TOKEN || null;

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
    const base = customBase ?? autoBase;
    if (!trafficToken) return `${base}/`;
    return `${base}/?${AUTH_PARAM}=${encodeURIComponent(trafficToken)}`;
  };

  const debugReq = process.env.DEBUG_REQ === '1';

  const server = http.createServer((req, res) => {
    const raw = req.url ?? '/';
    if (raw.includes(AUTH_PARAM)) {
      try {
        const v = new URL(raw, 'http://placeholder').searchParams.get(AUTH_PARAM);
        if (v && v !== trafficToken) {
          trafficToken = v;
          console.log('[share] 已捕获平台访问令牌，二维码将改为可直接扫码访问的链接');
        }
      } catch {
        /* ignore */
      }
    }
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
          // 是否已带上平台令牌（false 表示裸链接，手机直接扫会被平台 403 拦截）
          token_embedded: Boolean(trafficToken),
        });
      }

      if (url === '/api/health') {
        return sendJson(res, {
          ok: true,
          uptime_sec: Math.round((Date.now() - deps.startedAt) / 1000),
          rev: deps.board.snapshot().rev,
          peers: deps.hub.size,
          share_link_ready: Boolean(trafficToken),
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
            const u = await deps.board.setField(
              field as 'order_no' | 'product' | 'current' | 'now' | 'total',
              body.value as string | number,
            );
            sendJson(res, { ok: true, rev: u.rev, state: u.state });
          } else {
            const amount = Number(body.amount ?? 0);
            if (!Number.isFinite(amount) || amount < 0) {
              sendJson(res, { ok: false, error: 'BAD_AMOUNT' }, 400);
              return;
            }
            const u = await deps.board.confirm(Math.trunc(amount), 'http');
            sendJson(res, { ok: true, rev: u.rev, state: u.state, delta: u.commit?.delta ?? 0 });
          }
        } catch (err) {
          sendJson(res, { ok: false, error: (err as Error).message }, 500);
        }
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/share') {
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
