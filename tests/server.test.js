import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterfaceServer } from '../src/app.js';

async function startServer(databasePath, options = {}) {
  const app = createInterfaceServer({ databasePath, lanAddress: null, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function makeFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'interface-1-test-'));
  const databasePath = join(directory, 'state.sqlite');
  const app = await startServer(databasePath, options);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...app, databasePath };
}

async function jsonRequest(base, path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  return { status: response.status, data: await response.json() };
}

async function patch(base, field, value, expectedVersion) {
  return jsonRequest(base, '/api/state', 'PATCH', { field, value, expectedVersion });
}

async function confirm(base, id, value, expectedVersion) {
  return jsonRequest(base, '/api/confirm', 'POST', { id, value, expectedVersion });
}

async function nextState(reader, bufferObject) {
  for (;;) {
    const boundary = bufferObject.value.indexOf('\n\n');
    if (boundary !== -1) {
      const block = bufferObject.value.slice(0, boundary);
      bufferObject.value = bufferObject.value.slice(boundary + 2);
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
      continue;
    }
    let timeout;
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('state event timed out')), 3000);
        timeout.unref();
      }),
    ]);
    clearTimeout(timeout);
    assert.equal(result.done, false);
    bufferObject.value += new TextDecoder().decode(result.value);
  }
}

test('starts empty and streams changes without polling or a browser refresh', async (t) => {
  const { base } = await makeFixture(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const eventResponse = await fetch(`${base}/api/events`, { signal: abort.signal });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);
  const reader = eventResponse.body.getReader();
  const buffer = { value: '' };
  const first = await nextState(reader, buffer);
  assert.deepEqual(first.values, {
    productionOrder: '', product: '', productionTotal: '', currentProduction: '', now: '',
  });
  assert.equal(first.revision, 0);

  const update = await patch(base, 'productionOrder', 'PO-2026-001', 0);
  assert.equal(update.status, 200);
  const pushed = await nextState(reader, buffer);
  assert.equal(pushed.values.productionOrder, 'PO-2026-001');
  assert.equal(pushed.revision, 1);
  assert.equal(pushed.versions.productionOrder, 1);
  abort.abort();
});

test('merges independent fields and rejects stale same-field edits', async (t) => {
  const { base } = await makeFixture(t);
  assert.equal((await patch(base, 'productionOrder', 'A-123', 0)).status, 200);
  // A different field remains editable with its original field-specific version.
  assert.equal((await patch(base, 'product', '齿轮', 0)).status, 200);

  const [a, b] = await Promise.all([
    patch(base, 'productionTotal', '100', 0),
    patch(base, 'productionTotal', '200', 0),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.data.error, 'CONFLICT');
  const snapshot = (await jsonRequest(base, '/api/state')).data;
  assert.equal(snapshot.values.productionOrder, 'A-123');
  assert.equal(snapshot.values.product, '齿轮');
  assert.ok(['100', '200'].includes(snapshot.values.productionTotal));

  // A lost response may be safely retried if it already has the same value.
  const idempotent = await patch(base, 'productionTotal', snapshot.values.productionTotal, 0);
  assert.equal(idempotent.status, 200);
  assert.equal(idempotent.data.state.revision, snapshot.revision);
});

test('confirmation replaces rather than adds, clears now atomically, and is retry-safe', async (t) => {
  const { base } = await makeFixture(t);
  assert.equal((await patch(base, 'currentProduction', '99', 0)).status, 200);
  assert.equal((await patch(base, 'now', '00012.50', 0)).status, 200);
  const result = await confirm(base, 'confirmation-0001', '00012.50', 1);
  assert.equal(result.status, 200);
  assert.equal(result.data.state.values.currentProduction, '00012.50');
  assert.equal(result.data.state.values.now, '0');
  assert.equal(result.data.state.versions.now, 2);

  // An old pending edit cannot repopulate the value that was just cleared.
  const stale = await patch(base, 'now', '00012.50', 1);
  assert.equal(stale.status, 409);

  // A retry after the server accepted the first confirmation must not clear a
  // new input made by another device, or change the current production number.
  assert.equal((await patch(base, 'now', '37', 2)).status, 200);
  const retry = await confirm(base, 'confirmation-0001', '00012.50', 1);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.state.values.now, '37');
  assert.equal(retry.data.state.values.currentProduction, '00012.50');
  assert.equal((await confirm(base, 'confirmation-0001', '38', 1)).status, 409);

  const next = await confirm(base, 'confirmation-0002', '37', 3);
  assert.equal(next.status, 200);
  assert.equal(next.data.state.values.currentProduction, '37');
  assert.equal(next.data.state.values.now, '0');
});

test('simultaneous confirmations do not overwrite one another and invalid values do not change data', async (t) => {
  const { base } = await makeFixture(t);
  for (const [index, value] of ['', 'abc', '1e5', '1 2'].entries()) {
    assert.equal((await confirm(base, `invalid-value-${index}`, value, 0)).status, 422);
  }
  const value = '+000123456789012345678901234567890.0001';
  const [a, b] = await Promise.all([
    confirm(base, 'concurrent-one', value, 0),
    confirm(base, 'concurrent-two', '2', 0),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const state = (await jsonRequest(base, '/api/state')).data;
  assert.equal(state.values.now, '0');
  assert.ok([value, '2'].includes(state.values.currentProduction));
  assert.equal(state.revision, 1);
});

test('stores data on disk and restores it after a server restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'interface-1-persistence-'));
  const databasePath = join(directory, 'state.sqlite');
  let app = await startServer(databasePath);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await patch(app.base, 'productionOrder', 'PERSIST-01', 0);
  await patch(app.base, 'product', '测试产品', 0);
  await confirm(app.base, 'persist-confirmation', '12345678901234567890', 0);
  await app.close();

  app = await startServer(databasePath);
  const state = (await jsonRequest(app.base, '/api/state')).data;
  assert.equal(state.values.productionOrder, 'PERSIST-01');
  assert.equal(state.values.product, '测试产品');
  assert.equal(state.values.currentProduction, '12345678901234567890');
  assert.equal(state.values.now, '0');
  assert.equal((await confirm(app.base, 'persist-confirmation', '12345678901234567890', 0)).data.duplicate, true);
});

test('serves local assets, a real QR image, and rejects malformed requests', async (t) => {
  const { base } = await makeFixture(t, { publicUrl: 'https://shared.example.com/' });
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /当前生产数/);
  const font = await fetch(`${base}/fonts/index.css`);
  assert.equal(font.status, 200);
  assert.match(await font.text(), /Noto Serif SC Variable/);
  const config = (await jsonRequest(base, '/api/config')).data;
  assert.equal(config.publicUrl, 'https://shared.example.com/');
  const qr = await fetch(`${base}/api/qr?url=${encodeURIComponent(config.publicUrl)}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
  assert.equal((await fetch(`${base}/api/qr?url=javascript%3Aalert(1)`)).status, 400);
  assert.equal((await patch(base, 'notAField', 'x', 0)).status, 400);
  assert.equal((await patch(base, 'product', 'x'.repeat(257), 0)).status, 400);
  assert.equal((await fetch(`${base}/api/state`, { method: 'PATCH', body: '{}' })).status, 415);
});
