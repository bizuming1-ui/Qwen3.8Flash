import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import chromiumBundle from '@sparticuz/chromium';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createInterfaceServer } from '../src/app.js';

let browser;
let browserLibraries;

before(async () => {
  // The bundled headless Chromium is for Linux. Its NSS libraries are bundled
  // too, but need to be unpacked explicitly on minimal non-Amazon Linux images.
  browserLibraries = await mkdtemp(join(tmpdir(), 'interface-1-chromium-'));
  const bundleDirectory = dirname(dirname(fileURLToPath(import.meta.resolve('@sparticuz/chromium'))));
  const archive = brotliDecompressSync(await readFile(join(bundleDirectory, 'bin', 'al2023.tar.br')));
  const archivePath = join(browserLibraries, 'libraries.tar');
  await writeFile(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', browserLibraries]);
  browser = await chromium.launch({
    executablePath: await chromiumBundle.executablePath(),
    args: [
      ...chromiumBundle.args.filter((argument) => argument !== '--single-process'),
      '--no-proxy-server',
      '--host-resolver-rules=MAP preview.example.test 127.0.0.1',
    ],
    env: {
      ...process.env,
      LD_LIBRARY_PATH: `${join(browserLibraries, 'lib')}:${process.env.LD_LIBRARY_PATH || ''}`,
    },
    headless: true,
  });
});

after(async () => {
  if (browser) await browser.close();
  if (browserLibraries) await rm(browserLibraries, { recursive: true, force: true });
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'interface-1-browser-'));
  const appOptions = {
    databasePath: join(directory, 'state.sqlite'),
    publicUrl: 'https://3000-123456789abc-1234-5678-aaaa-bbbbbbbbbbbb.e2b.app/',
    lanAddress: null,
    ...options,
  };
  let app = createInterfaceServer(appOptions);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  const contexts = [];
  t.after(async () => {
    for (const context of contexts) await context.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      await app.close();
    },
    async start() {
      app = createInterfaceServer(appOptions);
      app.server.listen(port, '127.0.0.1');
      await once(app.server, 'listening');
    },
    async newPage(contextOptions = {}) {
      const context = await browser.newContext(contextOptions);
      contexts.push(context);
      const page = await context.newPage();
      return { page, context };
    },
  };
}

async function open(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('confirm').disabled);
  await page.waitForFunction(() => {
    const image = document.getElementById('share-qr');
    return image.complete && image.naturalWidth > 0;
  });
  await page.evaluate(() => document.fonts.ready);
}

async function waitForValue(page, selector, value) {
  await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value,
    { selector, value }, { timeout: 7000 });
}

async function readQr(page) {
  const screenshot = await page.locator('#share-qr').screenshot();
  const image = PNG.sync.read(screenshot);
  const result = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  assert.ok(result, `QR image could not be decoded at ${image.width}x${image.height}`);
  return result.data;
}

test('desktop layout follows the reference and the displayed QR code decodes', async (t) => {
  const f = await fixture(t);
  const { page } = await f.newPage({ viewport: { width: 1510, height: 957 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, f.base);
  assert.equal(await page.title(), '界面1');
  assert.equal(await page.locator('#status').isHidden(), true);
  assert.equal(await readQr(page), 'https://3000-123456789abc-1234-5678-aaaa-bbbbbbbbbbbb.e2b.app/');

  const reference = [
    ['.interface', 35, 35, 1440, 882],
    ['.qr-box', 1200, 103, 190, 198],
    ['#production-order', 327, 229, 253, 75],
    ['#product', 327, 405, 253, 75],
    ['#production-total', 921, 407, 253, 75],
    ['#current-production', 330, 595, 253, 75],
    ['#now', 924, 588, 253, 75],
    ['#confirm', 1132, 805, 253, 75],
  ];
  for (const [selector, x, y, width, height] of reference) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `${selector} was not visible`);
    for (const [actual, expected, dimension] of [
      [box.x, x, 'x'], [box.y, y, 'y'], [box.width, width, 'width'], [box.height, height, 'height'],
    ]) {
      assert.ok(Math.abs(actual - expected) <= 8,
        `${selector} ${dimension}: expected near ${expected}, got ${actual}`);
    }
  }
  if (process.env.INTERFACE_SCREENSHOT_DIR) {
    await page.screenshot({ path: join(process.env.INTERFACE_SCREENSHOT_DIR, 'desktop.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
});

test('confirmation validates input and copies the exact numeric text before resetting to zero', async (t) => {
  const f = await fixture(t);
  const a = await f.newPage();
  const b = await f.newPage();
  await Promise.all([open(a.page, f.base), open(b.page, f.base)]);

  await a.page.locator('#current-production').fill('17');
  await waitForValue(b.page, '#current-production', '17');
  await a.page.locator('#now').fill('not-a-number');
  await a.page.locator('#confirm').click();
  assert.match(await a.page.locator('#status').textContent(), /有效数字/);
  assert.equal(await a.page.locator('#current-production').inputValue(), '17');
  assert.equal(await a.page.locator('#now').inputValue(), 'not-a-number');

  await a.page.locator('#now').fill('-0000.50');
  await a.page.locator('#confirm').click();
  await Promise.all([
    waitForValue(a.page, '#current-production', '-0000.50'),
    waitForValue(b.page, '#current-production', '-0000.50'),
    waitForValue(a.page, '#now', '0'),
    waitForValue(b.page, '#now', '0'),
  ]);
});

test('two devices edit, confirm immediately, synchronize, and reconnect automatically', async (t) => {
  const f = await fixture(t);
  const a = await f.newPage({ viewport: { width: 1510, height: 957 } });
  const b = await f.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  a.page.on('pageerror', (error) => errors.push(error.message));
  b.page.on('pageerror', (error) => errors.push(error.message));
  await Promise.all([open(a.page, f.base), open(b.page, f.base)]);

  assert.equal(await b.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await readQr(b.page), 'https://3000-123456789abc-1234-5678-aaaa-bbbbbbbbbbbb.e2b.app/');
  if (process.env.INTERFACE_SCREENSHOT_DIR) {
    await b.page.screenshot({ path: join(process.env.INTERFACE_SCREENSHOT_DIR, 'mobile.png'), fullPage: true });
  }

  await a.page.locator('#production-order').fill('PO-001');
  await waitForValue(b.page, '#production-order', 'PO-001');
  await b.page.locator('#product').fill('齿轮');
  await waitForValue(a.page, '#product', '齿轮');
  await a.page.locator('#production-total').fill('1000');
  await waitForValue(b.page, '#production-total', '1000');
  await b.page.locator('#current-production').fill('99');
  await waitForValue(a.page, '#current-production', '99');

  // Submit immediately, before the 120ms edit debounce has elapsed.
  await a.page.locator('#now').fill('00012.50');
  await a.page.locator('#confirm').click();
  await Promise.all([
    waitForValue(a.page, '#current-production', '00012.50'),
    waitForValue(b.page, '#current-production', '00012.50'),
    waitForValue(a.page, '#now', '0'),
    waitForValue(b.page, '#now', '0'),
  ]);

  await b.page.locator('#now').fill('3');
  await waitForValue(a.page, '#now', '3');
  await b.page.locator('#confirm').click();
  await Promise.all([
    waitForValue(a.page, '#current-production', '3'),
    waitForValue(b.page, '#current-production', '3'),
    waitForValue(a.page, '#now', '0'),
    waitForValue(b.page, '#now', '0'),
  ]);

  // A temporary disconnect preserves the local edit and reconnects without reload.
  await a.context.setOffline(true);
  await a.page.locator('#production-order').fill('PO-OFFLINE');
  await a.page.waitForFunction(() => {
    const text = document.getElementById('status').textContent;
    return text.includes('连接已中断') || text.includes('保存暂时失败');
  }, null, { timeout: 10000 });
  assert.equal(await b.page.locator('#production-order').inputValue(), 'PO-001');
  await a.context.setOffline(false);
  await waitForValue(b.page, '#production-order', 'PO-OFFLINE');
  await a.page.waitForFunction(() => document.getElementById('status').hidden, null, { timeout: 10000 });

  await b.page.reload({ waitUntil: 'domcontentloaded' });
  await waitForValue(b.page, '#current-production', '3');
  await waitForValue(b.page, '#production-order', 'PO-OFFLINE');
  assert.deepEqual(errors, []);
});

test('concurrent edits to the same field preserve the losing draft instead of silently overwriting', async (t) => {
  const f = await fixture(t);
  const a = await f.newPage();
  const b = await f.newPage();
  await Promise.all([open(a.page, f.base), open(b.page, f.base)]);

  let release;
  let signalIntercept;
  const blocked = new Promise((resolve) => { release = resolve; });
  const intercepted = new Promise((resolve) => { signalIntercept = resolve; });
  let shouldBlock = true;
  await a.page.route('**/api/state', async (route) => {
    if (shouldBlock && route.request().method() === 'PATCH' && route.request().postDataJSON()?.field === 'product') {
      shouldBlock = false;
      signalIntercept();
      await blocked;
    }
    await route.continue();
  });

  await a.page.locator('#product').fill('设备A的内容');
  await intercepted;
  const bResponse = b.page.waitForResponse((response) =>
    response.url().endsWith('/api/state') && response.request().method() === 'PATCH', { timeout: 10000 });
  await b.page.locator('#product').fill('设备B的内容');
  assert.equal((await bResponse).status(), 200);
  const pendingResponse = a.page.waitForResponse((response) =>
    response.url().endsWith('/api/state') && response.request().method() === 'PATCH', { timeout: 10000 });
  release();
  const response = await pendingResponse;
  assert.equal(response.status(), 409);

  await a.page.waitForFunction(() => document.getElementById('status').textContent.includes('其他设备修改'), null, { timeout: 10000 });
  assert.equal(await a.page.locator('#product').inputValue(), '设备A的内容');
  assert.equal(await b.page.locator('#product').inputValue(), '设备B的内容');
  // Editing a different field must not hide the unresolved conflict warning.
  await a.page.locator('#production-order').fill('另一个字段');
  assert.match(await a.page.locator('#status').textContent(), /其他设备修改/);
  await a.page.locator('#product').fill('最终产品');
  await waitForValue(b.page, '#product', '最终产品');
  assert.equal(await a.page.locator('#status').isHidden(), true);
});

test('a lost confirmation response is retried without clearing a later user input', async (t) => {
  const f = await fixture(t);
  const a = await f.newPage();
  const b = await f.newPage();
  await Promise.all([open(a.page, f.base), open(b.page, f.base)]);

  let release;
  let signalProcessed;
  const blocked = new Promise((resolve) => { release = resolve; });
  const processed = new Promise((resolve) => { signalProcessed = resolve; });
  let first = true;
  const requestIds = [];
  await a.page.route('**/api/confirm', async (route) => {
    requestIds.push(route.request().postDataJSON().id);
    if (first) {
      first = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      signalProcessed();
      await blocked;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await a.page.locator('#now').fill('42');
  await a.page.locator('#confirm').click();
  await processed;
  await waitForValue(b.page, '#current-production', '42');
  await waitForValue(b.page, '#now', '0');

  const bSave = b.page.waitForResponse((response) =>
    response.url().endsWith('/api/state') && response.request().method() === 'PATCH');
  await b.page.locator('#now').fill('99');
  assert.equal((await bSave).status(), 200);
  release();

  await a.page.waitForFunction(() => !document.getElementById('confirm').disabled, null, { timeout: 12000 });
  await waitForValue(a.page, '#now', '99');
  assert.equal(await b.page.locator('#now').inputValue(), '99');
  assert.equal(await a.page.locator('#current-production').inputValue(), '42');
  assert.ok(requestIds.length >= 2);
  assert.equal(new Set(requestIds).size, 1);
});

test('server restart restores data and clients reconnect without refreshing', async (t) => {
  const f = await fixture(t);
  const a = await f.newPage();
  const b = await f.newPage();
  await Promise.all([open(a.page, f.base), open(b.page, f.base)]);
  await a.page.locator('#product').fill('重启后仍在');
  await waitForValue(b.page, '#product', '重启后仍在');

  await f.stop();
  await a.page.waitForFunction(() => document.getElementById('status').textContent.includes('连接已中断'));
  await a.page.locator('#production-order').fill('离线填写');
  assert.equal(await a.page.locator('#production-order').inputValue(), '离线填写');
  await f.start();
  await waitForValue(b.page, '#product', '重启后仍在');
  await waitForValue(b.page, '#production-order', '离线填写');
  await a.page.waitForFunction(() => document.getElementById('status').hidden, null, { timeout: 10000 });
});

test('a temporarily failed QR image is retried automatically', async (t) => {
  const f = await fixture(t);
  const { page } = await f.newPage();
  let attempts = 0;
  await page.route('**/api/qr?*', async (route) => {
    attempts += 1;
    if (attempts === 1) await route.abort('failed');
    else await route.continue();
  });
  await open(page, f.base);
  assert.ok(attempts >= 2);
  assert.equal(await readQr(page), 'https://3000-123456789abc-1234-5678-aaaa-bbbbbbbbbbbb.e2b.app/');
  assert.equal(await page.locator('#status').isHidden(), true);
});

test('QR uses the actual browser origin, or an available LAN address for localhost', async (t) => {
  const f = await fixture(t, { publicUrl: null, lanAddress: '192.168.50.10' });
  const a = await f.newPage();
  await open(a.page, f.base);
  assert.equal(await readQr(a.page), `http://192.168.50.10:${f.port}/`);

  const b = await f.newPage();
  await open(b.page, `http://preview.example.test:${f.port}/`);
  assert.equal(await readQr(b.page), `http://preview.example.test:${f.port}/`);
});
