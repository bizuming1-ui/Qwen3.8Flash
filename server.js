'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const defaults = () => ({ order: '', product: '', total: '', current: '', now: '', nowEpoch: 0, revision: 0 });
const fields = new Set(['order', 'product', 'total', 'current', 'now']);
const numeric = new Set(['total', 'current', 'now']);
const publicFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

function validValue(field, value) {
  return typeof value === 'string' && (numeric.has(field)
    ? /^(?:\d{0,40})$/.test(value)
    : value.length <= 120);
}

function createApp({ dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json') } = {}) {
  let state = defaults();
  try {
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const field of fields) {
      if (!validValue(field, saved[field])) throw new Error(`Invalid saved field: ${field}`);
    }
    if (!Number.isSafeInteger(saved.nowEpoch) || saved.nowEpoch < 0 || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('Invalid saved revision');
    state = { ...state, ...Object.fromEntries([...fields].map(field => [field, saved[field]])), nowEpoch: saved.nowEpoch, revision: saved.revision };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read saved data: ${error.message}`);
  }
  const clients = new Set();

  function persist(next) {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const temp = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, dataFile);
    state = next;
    const message = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) client.write(message);
  }
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  async function readBody(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 8192) throw new Error('请求内容过大');
    }
    try { return JSON.parse(body); } catch { throw new Error('无效的请求内容'); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && publicFiles[url.pathname]) {
        const [filename, contentType] = publicFiles[url.pathname];
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', filename)));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify(state)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/qr') {
        const value = url.searchParams.get('url') || '';
        let target;
        try { target = new URL(value); } catch { return json(res, 400, { error: '无效的网址' }); }
        if (!['http:', 'https:'].includes(target.protocol) || value.length > 2048) return json(res, 400, { error: '无效的网址' });
        const svg = await QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(svg);
      }
      if (req.method === 'POST' && url.pathname === '/api/field') {
        const input = await readBody(req);
        if (!input || !fields.has(input.field) || !validValue(input.field, input.value)) return json(res, 400, { error: '字段或内容无效' });
        if ((input.field === 'now' || input.field === 'current') && input.nowEpoch !== state.nowEpoch) return json(res, 409, { error: '生产数已被确认，请重新输入', state });
        if (state[input.field] !== input.value) persist({ ...state, [input.field]: input.value, revision: state.revision + 1 });
        return json(res, 200, state);
      }
      if (req.method === 'POST' && url.pathname === '/api/confirm') {
        const input = await readBody(req);
        if (!input || !validValue('now', input.value) || input.value === '') return json(res, 400, { error: '请在“现在”填写非负整数' });
        if (input.nowEpoch !== state.nowEpoch) return json(res, 409, { error: '该数字已被其他设备确认，请重新输入', state });
        persist({ ...state, current: input.value, now: '', nowEpoch: state.nowEpoch + 1, revision: state.revision + 1 });
        return json(res, 200, state);
      }
      return json(res, 404, { error: '未找到' });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) return json(res, 500, { error: '服务器处理失败，请检查服务器日志' });
      res.destroy();
    }
  });
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 20000);
  heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); for (const client of clients) client.end(); });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, '0.0.0.0', () => console.log(`界面1已启动，端口 ${port}`));
}
module.exports = { createApp };
