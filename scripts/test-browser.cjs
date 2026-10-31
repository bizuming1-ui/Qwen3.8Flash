#!/usr/bin/env node
// 可选的真实 Chromium 多设备回归。需要先安装 puppeteer-core 和 @sparticuz/chromium。
// 只在隔离的测试服务上运行：TEST_ADMIN_PASSWORD=... node scripts/test-browser.cjs http://127.0.0.1:3100
const assert = require('node:assert/strict');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const base = process.argv[2] || 'http://127.0.0.1:3100';
const password = process.env.TEST_ADMIN_PASSWORD;
if (!password) throw new Error('请提供隔离测试服务的 TEST_ADMIN_PASSWORD');

async function replace(page, selector, value) {
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
}
async function main() {
  const host = new URL(base).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('浏览器回归会清空数据，只允许连接隔离的本机测试服务');
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const { token } = await login.json();
  if (!token) throw new Error('隔离测试管理员登录失败');
  const reset = await fetch(base + '/api/reset', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!reset.ok) throw new Error('隔离测试看板清空失败');
  const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: 'shell' });
  try {
    const desktop = await browser.newPage();
    const phone = await browser.newPage();
    await desktop.setViewport({ width: 1356, height: 834 });
    await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const errors = [];
    for (const page of [desktop, phone]) page.on('pageerror', (e) => errors.push(e.message));
    await Promise.all([desktop.goto(base, { waitUntil: 'domcontentloaded' }), phone.goto(base, { waitUntil: 'domcontentloaded' })]);
    await Promise.all([desktop, phone].map((p) => p.waitForFunction(() => document.querySelector('#qr')?.getAttribute('src'))));
    assert.equal(await desktop.$eval('#current', (el) => el.readOnly), true, '当前生产数必须只读');
    assert.equal(await phone.$eval('#total', (el) => el.readOnly), true, '未登录时生产总数只读');
    const box = await phone.$eval('#now', (el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
    assert.ok(box.width >= 200 && box.height >= 44, `手机输入框必须可点击: ${JSON.stringify(box)}`);
    await desktop.click('#qrbox');
    await desktop.waitForFunction(() => { const img = document.querySelector('#qrBig'); return img.complete && img.naturalWidth > 0; });
    const pixels = PNG.sync.read(await (await desktop.$('#qrBig')).screenshot());
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    const expected = (await (await fetch(base + '/api/join-url')).json()).url;
    assert.equal(decoded?.data, expected, '二维码必须真实可解码，且与分享地址一致');
    await desktop.click('#closeModal');
    await desktop.click('#adminEntry');
    await desktop.type('#adminPassword', password);
    await desktop.click('#adminLogin');
    await desktop.waitForFunction(() => !document.querySelector('#total').readOnly);
    await desktop.click('#adminDone');
    await replace(desktop, '#total', '63');
    await desktop.waitForFunction(() => document.querySelector('#total').value === '63');
    await phone.waitForFunction(() => document.querySelector('#total').value === '63', { timeout: 5000 });
    await replace(desktop, '#order', 'PO-BROWSER');
    await phone.waitForFunction(() => document.querySelector('#order').value === 'PO-BROWSER', { timeout: 5000 });
    await replace(phone, '#now', '20');
    await phone.click('#confirm');
    await Promise.all([desktop, phone].map((p) => p.waitForFunction(() => document.querySelector('#current').value === '20', { timeout: 5000 })));
    assert.equal(await phone.$eval('#now', (el) => el.value), '', '成功后现在清零');
    await replace(phone, '#now', '44');
    await phone.click('#confirm');
    await phone.waitForFunction(() => document.querySelector('#notice').textContent.includes('超出生产总数'), { timeout: 5000 });
    assert.equal(await phone.$eval('#now', (el) => el.value), '44', '超额失败不能清除输入');
    assert.equal(await phone.$eval('#current', (el) => el.value), '20', '超额不能累计');
    await replace(desktop, '#total', '10');
    await desktop.waitForFunction(() => document.querySelector('#notice').textContent.includes('不能小于当前生产数'), { timeout: 5000 });
    await desktop.waitForFunction(() => document.querySelector('#total').value === '63');
    assert.deepEqual(errors, [], '浏览器不能出现未捕获异常');
    console.log('✔ Chromium 双设备同步、手机可点击、只读、管理员、累计和超额错误全部通过');
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
