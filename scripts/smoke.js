#!/usr/bin/env node
/*
 * scripts/smoke.js —— 端到端自检
 * 验证：HTTP 静态页 / 二维码 / C 内核状态 / WebSocket 实时同步 / 确认事务 / Python 审计
 * 用法: node scripts/smoke.js [baseUrl]
 */
const http = require('node:http');
const { WebSocket } = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let failures = 0;
function check(name, ok, extra = '') {
  const mark = ok ? '✔' : '✘';
  if (!ok) failures++;
  console.log(`${mark} ${name}${extra ? `  ${extra}` : ''}`);
}

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get(BASE + path, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, pred, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (pred(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`smoke test -> ${BASE}`);

  const page = await get('/');
  check('GET / 返回 200', page.status === 200, `len=${page.body.length}`);
  check('页面包含 生产单/产品/确认/二维码', ['生产单', '产品', '确认', '二维码'].every((s) => page.body.includes(s)));

  const css = await get('/styles.css');
  check('GET /styles.css 返回 200', css.status === 200);

  const js = await get('/app.js');
  check('GET /app.js 返回 200', js.status === 200, `len=${js.body.length}`);

  const qr = await get('/api/qr.svg');
  check('GET /api/qr.svg 返回 SVG', qr.status === 200 && qr.body.startsWith('<svg'), (qr.headers['x-join-url'] || '').toString());

  const health = JSON.parse((await get('/api/health')).body);
  check('C 内核在线', health.core && health.core.ready === true);
  check('三个子服务都在运行', (health.services || []).filter((s) => s.running).length === 3,
    JSON.stringify((health.services || []).map((s) => `${s.name}:${s.running}`)));

  const clientA = await open();
  const clientB = await open();
  const helloB = await waitFor(clientB, (m) => m.t === 'hello');
  check('设备 B 收到初始快照', Boolean(helloB.state));

  const stamp = Date.now().toString().slice(-6);
  const seenOrder = waitFor(
    clientB,
    (m) => m.t === 'state' && m.state.order_no === `PO-${stamp}`,
    3000,
  ).catch(() => null);
  clientA.send(JSON.stringify({ t: 'set', field: 'order_no', value: `PO-${stamp}` }));
  check('B 实时收到 A 填写的生产单', Boolean(await seenOrder));

  const seenProduct = waitFor(clientB, (m) => m.t === 'state' && m.state.product === '齿轮箱', 3000).catch(() => null);
  clientA.send(JSON.stringify({ t: 'set', field: 'product', value: '齿轮箱' }));
  check('B 实时收到 A 填写的产品', Boolean(await seenProduct));

  const before = JSON.parse((await get('/api/state')).body).state;
  const amount = 37;
  const committed = waitFor(clientB, (m) => m.t === 'state' && m.commit && m.commit.delta === amount, 3000);
  clientA.send(JSON.stringify({ t: 'confirm', amount }));
  const commitMsg = await committed.catch(() => null);
  check('确认事件广播到 B', Boolean(commitMsg), commitMsg ? `delta=${commitMsg.commit.delta}` : '');

  const after = JSON.parse((await get('/api/state')).body).state;
  check('现在 清零', after.now === 0, `now=${after.now}`);
  check('当前生产数 累加', after.current === before.current + amount, `${before.current} -> ${after.current}`);
  check('生产总数 累加', after.total === before.total + amount, `${before.total} -> ${after.total}`);

  await sleep(350);
  const stats = JSON.parse((await get('/api/stats')).body);
  check('Python 审计服务可用', stats.ok === true, `commits=${stats.commits}`);
  check('审计记录已落盘', (stats.last_commit && stats.last_commit.delta === amount) === true);

  const hist = JSON.parse((await get('/api/history?limit=5')).body);
  check('历史接口返回记录', hist.ok === true && hist.items.length > 0);

  const csv = await get('/api/export.csv');
  check('CSV 导出可用', csv.status === 200 && csv.body.includes('本次数量'));

  clientA.close();
  clientB.close();

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('smoke 异常:', err);
  process.exit(1);
});
