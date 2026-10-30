import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { ANALYTICS_URL, PORT, WEB_DIR } from './config';
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

export function createHttpServer(deps: ServerDeps): http.Server {
  const server = http.createServer((req, res) => {
    const raw = req.url ?? '/';
    const url = raw.split('?')[0];

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url === '/' || url === '/index.html') return serveStatic(res, 'index.html');
      const staticName = url.replace(/^\//, '');
      if (ALLOW.has(staticName)) return serveStatic(res, staticName);

      if (url === '/api/qr.svg') {
        const base = publicBaseUrl(req.headers as Record<string, string | string[] | undefined>, PORT);
        const joinUrl = `${base}/`;
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
        return sendJson(res, { ok: true, url: `${base}/` });
      }

      if (url === '/api/health') {
        return sendJson(res, {
          ok: true,
          uptime_sec: Math.round((Date.now() - deps.startedAt) / 1000),
          rev: deps.board.snapshot().rev,
          peers: deps.hub.size,
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
