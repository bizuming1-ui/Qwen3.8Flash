import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createStore, FIELDS, isNumberText, MAX_FIELD_LENGTH } from './store.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDirectory = join(projectRoot, 'public');
const fontDirectory = join(projectRoot, 'node_modules', '@fontsource-variable', 'noto-serif-sc');
const maxBodyBytes = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizePublicUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_URL 必须是完整的 http:// 或 https:// 地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_URL 必须是没有路径、查询参数或用户名密码的 HTTP(S) 根地址。');
  }
  return `${url.origin}/`;
}

function findLanAddress() {
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries || [])
    .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => !address.startsWith('169.254.'));
  const score = (address) => {
    if (address.startsWith('192.168.')) return 0;
    if (address.startsWith('10.')) return 1;
    const parts = address.split('.').map(Number);
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 2;
    return 3;
  };
  return addresses.sort((a, b) => score(a) - score(b))[0] || null;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] || '')) {
    request.resume();
    return Promise.reject(new HttpError(415, '请求必须使用 JSON。'));
  }
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    request.resume();
    return Promise.reject(new HttpError(413, '请求内容过长。'));
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) tooLarge = true;
      else if (!tooLarge) chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new HttpError(400, '请求已中断。')));
    request.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, '请求内容过长。'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(new HttpError(400, 'JSON 内容无效。'));
      }
    });
  });
}

function validVersion(version) {
  return Number.isSafeInteger(version) && version >= 0;
}

function staticPath(pathname) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  if (Object.hasOwn(files, pathname)) {
    return { path: join(publicDirectory, files[pathname][0]), type: files[pathname][1] };
  }
  if (pathname === '/fonts/index.css') {
    return { path: join(fontDirectory, 'index.css'), type: 'text/css; charset=utf-8', cache: true };
  }
  const font = pathname.match(/^\/fonts\/files\/(noto-serif-sc-[a-z0-9-]+\.woff2)$/);
  if (font) {
    return { path: join(fontDirectory, 'files', font[1]), type: 'font/woff2', cache: true };
  }
  return null;
}

/** A single server process owns the live event stream for this shared interface. */
export function createInterfaceServer({
  databasePath = join(projectRoot, 'data', 'interface.sqlite'),
  publicUrl = process.env.PUBLIC_URL,
  lanAddress = findLanAddress(),
  heartbeatMs = 15_000,
} = {}) {
  const normalizedPublicUrl = normalizePublicUrl(publicUrl);
  const store = createStore(databasePath);
  const subscribers = new Set();

  function writeState(response, state) {
    response.write(`id: ${state.revision}\nevent: state\ndata: ${JSON.stringify(state)}\n\n`);
  }

  function broadcast(state) {
    for (const response of subscribers) {
      try {
        // A stalled connection must not accumulate unlimited queued updates.
        // EventSource reconnects automatically and receives the latest snapshot.
        if (response.writableLength > 256 * 1024) {
          subscribers.delete(response);
          response.destroy();
          continue;
        }
        writeState(response, state);
      } catch {
        subscribers.delete(response);
        response.destroy();
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const response of subscribers) {
      try {
        response.write(': heartbeat\n\n');
      } catch {
        subscribers.delete(response);
        response.destroy();
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    // No frame-ancestors restriction: the live preview embeds this page.
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'");

    try {
      const url = new URL(request.url, 'http://internal.invalid');
      const { pathname } = url;

      if (request.method === 'GET' && pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write('retry: 1000\n\n');
        subscribers.add(response);
        response.on('close', () => subscribers.delete(response));
        writeState(response, store.getState());
        return;
      }

      if (request.method === 'GET' && pathname === '/api/state') {
        return sendJson(response, 200, store.getState());
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        return sendJson(response, 200, { publicUrl: normalizedPublicUrl, lanAddress });
      }

      if (request.method === 'GET' && pathname === '/api/qr') {
        const text = url.searchParams.get('url');
        let shareUrl;
        try {
          if (!text || text.length > 512) throw new Error();
          shareUrl = new URL(text);
          if (!['http:', 'https:'].includes(shareUrl.protocol) || shareUrl.username || shareUrl.password) {
            throw new Error();
          }
        } catch {
          throw new HttpError(400, '二维码地址必须是有效的 HTTP(S) 地址。');
        }
        const svg = await QRCode.toString(shareUrl.href, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 4,
        });
        response.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(svg);
        return;
      }

      if (request.method === 'PATCH' && pathname === '/api/state') {
        const { field, value, expectedVersion } = await readJson(request);
        if (!FIELDS.includes(field) || typeof value !== 'string' || value.length > MAX_FIELD_LENGTH ||
            !validVersion(expectedVersion)) {
          throw new HttpError(400, '字段、内容或版本无效。');
        }
        const result = store.updateField(field, value, expectedVersion);
        if (result.conflict) {
          return sendJson(response, 409, { error: 'CONFLICT', message: '此项已被其他设备修改。', state: result.state });
        }
        if (result.changed) broadcast(result.state);
        return sendJson(response, 200, { state: result.state });
      }

      if (request.method === 'POST' && pathname === '/api/confirm') {
        const { id, value, expectedVersion } = await readJson(request);
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(id) ||
            !validVersion(expectedVersion)) {
          throw new HttpError(400, '确认请求或版本无效。');
        }
        if (!isNumberText(value)) {
          throw new HttpError(422, '请在“现在”输入有效数字。');
        }
        const result = store.confirm(id, value, expectedVersion);
        if (result.invalidReceipt) {
          return sendJson(response, 409, { error: 'INVALID_REQUEST_ID', message: '确认请求编号已被使用。', state: result.state });
        }
        if (result.conflict) {
          return sendJson(response, 409, { error: 'CONFLICT', message: '“现在”已被其他设备修改。', state: result.state });
        }
        if (result.changed) broadcast(result.state);
        return sendJson(response, 200, { state: result.state, duplicate: Boolean(result.duplicate) });
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const file = staticPath(pathname);
        if (file) {
          let contents;
          try {
            contents = await readFile(file.path);
          } catch (error) {
            if (error.code === 'ENOENT') throw new HttpError(404, '未找到文件。');
            throw error;
          }
          response.writeHead(200, {
            'Content-Type': file.type,
            'Content-Length': contents.length,
            'Cache-Control': file.cache ? 'public, max-age=31536000, immutable' : 'no-cache',
          });
          response.end(request.method === 'HEAD' ? undefined : contents);
          return;
        }
      }

      throw new HttpError(404, '未找到页面。');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('请求处理失败:', error);
      sendJson(response, status, { message: status === 500 ? '服务器发生错误。' : error.message });
    }
  });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const response of subscribers) response.end();
    subscribers.clear();
    await new Promise((resolve, reject) => {
      server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    store.close();
  }

  return { server, close };
}
