#!/usr/bin/env node
/* 在临时目录及随机端口启动完整本地栈，绝不触碰正在使用的看板数据。 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-test-'));
const password = 'temporary-isolated-test-password';
let child;
let failures = '';
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function start(port, analyticsPort, cloudApi = '', publicPage = '') {
  return new Promise((resolve, reject) => {
    const data = path.join(dir, 'data');
    const sock = path.join(dir, 'sock');
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), ANALYTICS_PORT: String(analyticsPort), DATA_DIR: data, SOCK_DIR: sock, BOARD_ADMIN_PASSWORD: password, CLOUD_BOARD_URL: cloudApi, CLOUD_PUBLIC_URL: publicPage };
    child = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const timeout = setTimeout(() => reject(new Error(`服务器启动超时: ${log}`)), 15000);
    const onData = (chunk) => {
      log += chunk.toString();
      if (log.includes('看板已就绪')) { clearTimeout(timeout); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timeout); if (!log.includes('看板已就绪')) reject(new Error(`服务器退出 ${code}: ${log}`)); });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('服务未退出')), 5000))]);
  child = null;
}
function wsOpen(base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function wsWait(ws, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('WebSocket 等待超时')); }, timeout);
    function handler(raw) {
      const data = JSON.parse(raw.toString());
      if (predicate(data)) { clearTimeout(timer); ws.off('message', handler); resolve(data); }
    }
    ws.on('message', handler);
  });
}
function coreCommand(line) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(dir, 'sock', 'core.sock'));
    let data = '';
    s.on('connect', () => s.write(line + '\n'));
    // 首帧是内核连接时主动推送的 STATE，第二帧才是本次命令的响应。
    s.on('data', (chunk) => { data += chunk; const lines = data.split('\n'); if (lines.length >= 3) { s.destroy(); resolve(lines[1]); } });
    s.on('error', reject);
  });
}
async function main() {
  let port = await freePort();
  let analyticsPort = await freePort();
  while (analyticsPort === port) analyticsPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const get = async (route) => { const r = await fetch(base + route); return { status: r.status, data: await r.json() }; };
  const post = async (route, body, token = '') => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json() };
  };
  try {
    await start(port, analyticsPort);
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /id="current"[^>]*readonly/);
    assert.equal((await get('/api/health')).data.core.ready, true);
    assert.equal((await post('/api/set', { field: 'current', value: 5 })).data.error, 'READ_ONLY');
    assert.equal((await post('/api/set', { field: 'total', value: 63 })).data.error, 'ADMIN_REQUIRED');
    assert.equal((await post('/api/reset', {})).data.error, 'ADMIN_REQUIRED');
    assert.equal((await post('/api/share', { url: 'https://example.com' })).data.error, 'ADMIN_REQUIRED');
    assert.equal((await post('/api/admin/login', { password: 'wrong' })).data.error, 'BAD_CREDENTIALS');
    const login = await post('/api/admin/login', { password });
    assert.equal(login.status, 200);
    const token = login.data.token;
    assert.ok(token);
    const customUrl = 'https://example.com/board/?x=123';
    assert.equal((await post('/api/share', { url: customUrl }, token)).data.url, customUrl);
    assert.equal((await get('/api/join-url')).data.url, customUrl);
    assert.equal((await post('/api/share', { url: 'https://user:pass@example.com/' }, token)).data.error, 'BAD_URL');
    assert.equal((await post('/api/share', { url: '' }, token)).status, 200);
    const a = await wsOpen(base);
    const b = await wsOpen(base);
    const seen = wsWait(b, (m) => m.t === 'state' && m.state.order_no === 'PO-双端-🚀');
    a.send(JSON.stringify({ t: 'set', field: 'order_no', value: 'PO-双端-🚀' }));
    await seen;
    const denied = wsWait(a, (m) => m.t === 'error' && m.message === 'ADMIN_REQUIRED');
    a.send(JSON.stringify({ t: 'set', field: 'total', value: 63 }));
    await denied;
    assert.equal((await post('/api/set', { field: 'total', value: 63 }, token)).status, 200);
    assert.equal((await post('/api/set', { field: 'now', value: 5 })).status, 200);
    const commitBroadcast = wsWait(b, (m) => m.t === 'state' && m.commit?.delta === 5);
    assert.equal((await post('/api/confirm', { amount: 5 })).status, 200);
    await commitBroadcast;
    let state = (await get('/api/state')).data;
    assert.deepEqual([state.state.total, state.state.current, state.state.now], [63, 5, 0]);
    assert.equal(await coreCommand('SET current 9'), 'ERR READ_ONLY');
    assert.equal(await coreCommand('SET total 4'), 'ERR TOTAL_TOO_SMALL');
    assert.equal(await coreCommand('CONFIRM 59'), 'ERR EXCEEDS_TOTAL');
    assert.equal((await post('/api/set', { field: 'now', value: 59 })).status, 200);
    const before = (await get('/api/state')).data;
    assert.equal(before.state.now, 59);
    const tooLarge = await post('/api/confirm', { amount: 59 });
    assert.equal(tooLarge.status, 409);
    assert.equal(tooLarge.data.error, 'EXCEEDS_TOTAL');
    assert.deepEqual((await get('/api/state')).data, before, '超额不得修改状态或版本');
    assert.equal((await post('/api/set', { field: 'total', value: 4 }, token)).data.error, 'TOTAL_TOO_SMALL');
    const race = await Promise.all([post('/api/confirm', { amount: 40 }), post('/api/confirm', { amount: 25 })]);
    assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
    state = (await get('/api/state')).data;
    assert.ok(state.state.current <= state.state.total);
    assert.ok([30, 45].includes(state.state.current));
    assert.equal(state.state.total, 63);
    assert.equal((await post('/api/confirm', { amount: 63 - state.state.current })).status, 200, '恰好达到总数应允许');
    state = (await get('/api/state')).data;
    assert.equal(state.state.current, 63);
    assert.equal((await post('/api/confirm', { amount: 1 })).data.error, 'EXCEEDS_TOTAL');
    const stats = (await get('/api/stats')).data;
    assert.equal(stats.ok, true);
    assert.equal(stats.commits, 3);
    assert.ok((await get('/api/history?limit=5')).data.items.length >= 2);
    assert.match(await (await fetch(base + '/api/export.csv')).text(), /本次数量/);
    a.close(); b.close();
    const beforeRestart = state;
    await new Promise((r) => setTimeout(r, 500)); // 等待 C++ 日志的 fsync 周期
    await stop();
    await start(port, analyticsPort);
    const afterRestart = (await get('/api/state')).data;
    assert.deepEqual(afterRestart.state, beforeRestart.state, '重启必须恢复状态');
    assert.equal(afterRestart.rev, beforeRestart.rev);
    const loginAgain = await post('/api/admin/login', { password });
    const reset = await post('/api/reset', {}, loginAgain.data.token);
    assert.equal(reset.status, 200);
    assert.ok(reset.data.rev > afterRestart.rev, '清空后的版本必须递增');
    assert.deepEqual([reset.data.state.total, reset.data.state.current, reset.data.state.now], [0, 0, 0]);
    await stop();
    const cloudApi = 'https://example.test/functions/v1/qwen-board';
    const publicPage = 'https://example.test/board/?version=1';
    await start(port, analyticsPort, cloudApi, publicPage);
    assert.equal((await get('/api/config')).data.cloud_url, cloudApi);
    assert.equal((await get('/api/join-url')).data.url, publicPage, '二维码必须指向公网网页而不是 API 函数');
    const qr = await fetch(base + '/api/qr.svg');
    assert.equal(qr.headers.get('x-join-url'), publicPage);
    console.log('✔ 本地隔离回归通过：权限、只读、超额、并发、多端、日志、重启和云端二维码');
  } catch (e) { failures = String(e.stack || e); }
  finally { try { await stop(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  if (failures) throw new Error(failures);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
