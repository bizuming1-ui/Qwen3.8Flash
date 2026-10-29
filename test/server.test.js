'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('../server');

test('shared state, live events, confirmation conflicts and persistence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-interface-'));
  const dataFile = path.join(dir, 'state.json');
  let server = createApp({ dataFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  t.after(async () => { if (server.listening) await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const controller = new AbortController();
  const stream = await fetch(base + '/api/events', { signal: controller.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(JSON.parse(first.slice(6)).revision, 0);
  assert.equal((await post('/api/field', { field: 'order', value: 'PO-01' })).status, 200);
  const pushed = new TextDecoder().decode((await reader.read()).value);
  assert.equal(JSON.parse(pushed.slice(6)).order, 'PO-01');
  assert.equal((await post('/api/field', { field: 'product', value: '产品A' })).status, 200);
  assert.equal((await post('/api/field', { field: 'total', value: '100' })).status, 200);
  assert.equal((await post('/api/field', { field: 'now', value: '25', nowEpoch: 0 })).status, 200);
  const results = await Promise.all([
    post('/api/confirm', { value: '25', nowEpoch: 0 }),
    post('/api/confirm', { value: '25', nowEpoch: 0 })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await post('/api/field', { field: 'now', value: '25', nowEpoch: 0 })).status, 409);
  assert.equal((await post('/api/field', { field: 'current', value: '99', nowEpoch: 0 })).status, 409);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.now, '');
  assert.equal(state.current, '25');
  assert.equal(state.nowEpoch, 1);
  assert.equal((await post('/api/confirm', { value: '5', nowEpoch: 1 })).body.current, '5');
  assert.equal((await post('/api/confirm', { value: '', nowEpoch: 2 })).status, 400);
  assert.equal((await post('/api/field', { field: 'total', value: '-1' })).status, 400);
  const qr = await fetch(base + '/api/qr?url=' + encodeURIComponent('https://example.com/'));
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /<svg/);
  assert.equal((await fetch(base + '/api/qr?url=javascript:alert(1)')).status, 400);
  controller.abort();
  await close();
  server = createApp({ dataFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const restored = await (await fetch(base + '/api/state')).json();
  assert.equal(restored.order, 'PO-01');
  assert.equal(restored.product, '产品A');
  assert.equal(restored.total, '100');
  assert.equal(restored.current, '5');
  assert.equal(restored.now, '');
  assert.equal(restored.nowEpoch, 2);
});

test('corrupt persisted data fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-interface-'));
  const dataFile = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(dataFile, '{not json');
    assert.throws(() => createApp({ dataFile }), /Cannot read saved data/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
