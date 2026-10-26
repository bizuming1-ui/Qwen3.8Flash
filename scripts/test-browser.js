#!/usr/bin/env node
'use strict';
/**
 * Browser-level (jsdom) smoke tests for BOTH frontends.
 * Requires `npm start` running + `npm install` (jsdom is a devDependency).
 *
 *   npm run test:browser
 *
 * This proves the ORIGINAL, unmodified web/app.js boots, auto-unlocks via the
 * private entry, streams the binary audio protocol and renders diagnostics.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';
const ROOT = path.resolve(__dirname, '..');
const LAB = path.join(ROOT, 'server', 'public');
const WEB = path.join(ROOT, 'replica', 'web');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

function ctxStub(w) {
  return {
    setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, save() {}, restore() {},
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set font(v) {},
  };
}
function cmStub(w) {
  return function CodeMirror(container, opts) {
    const ta = w.document.createElement('textarea');
    ta.value = opts.value || '';
    container.appendChild(ta);
    const handlers = {};
    return {
      getValue() { return ta.value; },
      setValue(v) { ta.value = v; handlers.change && handlers.change(); },
      lineCount() { return ta.value.split('\n').length; },
      setSize() {}, focus() {}, refresh() {},
      on(ev, fn) { handlers[ev] = fn; },
      somethingSelected() { return false; },
      indentSelection() {}, replaceSelection(s) { ta.value += s; },
      toggleComment() {}, toTextArea() {},
    };
  };
}
function commonStubs(w, errors) {
  w.confirm = () => true;
  w.alert = () => {};
  w.open = () => ({ focus() {} });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => ctxStub(w);
  w.URL.createObjectURL = () => 'blob:stub';
  w.URL.revokeObjectURL = () => {};
  w.Blob = w.Blob || class { constructor(a) { this.size = String(a[0]).length; } };
  w.Headers = globalThis.Headers;
  w.AbortController = globalThis.AbortController;
  w.AbortSignal = globalThis.AbortSignal;
  w.TextDecoder = globalThis.TextDecoder;
  w.TextEncoder = globalThis.TextEncoder;
  w.ReadableStream = globalThis.ReadableStream;
  w.performance = globalThis.performance;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  if (w.HTMLDialogElement) {
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.open = false; };
  }
  const gain = { connect() { return this; }, gain: { value: 1 } };
  w.AudioContext = class {
    constructor() { this.sampleRate = 24000; this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    createGain() { return gain; }
    async resume() {} async close() {}
  };
  w.AudioWorkletNode = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } connect(n) { return n; } };
  w.MediaRecorder = class {};
  if (!w.navigator.mediaDevices) {
    Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => { throw new Error('no microphone in jsdom'); } } });
  }
}
function virtualConsole(errors) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  return vc;
}

async function labTest() {
  const errors = [];
  let html = fs.readFileSync(path.join(LAB, 'index.html'), 'utf8')
    .replace(/<script src="\/vendor\/[^"]+"><\/script>/g, '')
    .replace(/<script src="\/app\.js"><\/script>/g, '');
  const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: virtualConsole(errors) });
  const w = dom.window;
  commonStubs(w, errors);
  w.CodeMirror = cmStub(w);
  w.fetch = (p, o) => fetch(new URL(p, BASE), o);
  w.EventSource = class { constructor(u) { this.url = u; } close() {} addEventListener() {} };
  w.eval(fs.readFileSync(path.join(LAB, 'app.js'), 'utf8'));
  await wait(2400);
  const d = w.document;
  check('[lab] bootstraps notebooks', d.querySelectorAll('.cell').length > 0, d.querySelector('#nb-title').textContent);
  check('[lab] 5 views present', d.querySelectorAll('.view-tab').length === 5);
  d.querySelector('[data-view="replica"]').click(); await wait(500);
  check('[lab] replica view renders status', /SHA-256/.test(d.querySelector('#replica-status').textContent));
  d.querySelector('#btn-replica-entry').click(); await wait(600);
  check('[lab] private entry sets iframe URL', /qtts-entry=/.test(d.querySelector('#replica-frame').src));
  d.querySelector('[data-view="assets"]').click(); await wait(500);
  check('[lab] asset tree has 70 files', (d.querySelector('#asset-count').textContent) === '70');
  const first = d.querySelector('#asset-tree [data-asset]');
  if (first) { first.click(); await wait(400); }
  check('[lab] asset viewer shows source', d.querySelector('#asset-content').textContent.length > 100);
  d.querySelector('[data-view="api"]').click(); await wait(400);
  check('[lab] API matrix has 38 rows', d.querySelectorAll('.api-row').length === 38);
  d.querySelector('[data-view="precision"]').click(); await wait(900);
  check('[lab] precision view shows ported algorithms', /质量策略/.test(d.querySelector('#precision-summary').textContent));
  d.querySelector('#btn-seg-run').click(); await wait(900);
  check('[lab] segmenter probe renders boundary table', d.querySelectorAll('#seg-result table tr').length > 1);
  d.querySelector('#btn-dsp-run').click(); await wait(900);
  check('[lab] DSP probe renders 5 policy rows', d.querySelectorAll('#dsp-result table tr').length === 6);
  d.querySelector('#btn-frame-run').click(); await wait(1400);
  check('[lab] frame inspector shows both wire layers', /worker → gateway/.test(d.querySelector('#frame-result').textContent));
  d.querySelector('#btn-worker-refresh').click(); await wait(900);
  check('[lab] worker + Guard snapshot renders', /\/worker\/0/.test(d.querySelector('#worker-result').textContent));
  check('[lab] no JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  return errors;
}

async function siteTest() {
  const errors = [];
  let cookie = '';
  const grantRes = await fetch(BASE + '/lab/api/replica/entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const grant = (await grantRes.json()).grant;
  const wrappedFetch = (input, opt = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, BASE).toString();
    const o = { ...opt };
    delete o.signal;
    const h = new Headers(o.headers || {});
    if (cookie) h.set('Cookie', cookie);
    h.set('Origin', BASE);
    h.set('Sec-Fetch-Site', 'same-origin');
    o.headers = h;
    return fetch(url, o).then((res) => {
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const kv = c.split(';')[0].trim();
        if (kv.startsWith('qtts_private_session=') && kv.length > 21) cookie = kv;
      }
      return res;
    });
  };
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url: BASE + '/site/#qtts-entry=' + grant, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: virtualConsole(errors) });
  const w = dom.window;
  commonStubs(w, errors);
  w.fetch = wrappedFetch;
  for (const f of ['recorder.js', 'diagnostic-trace.js', 'app.js']) w.eval(fs.readFileSync(path.join(WEB, f), 'utf8'));
  await wait(2400);
  const d = w.document;
  check('[site] original app.js auto-unlocks', d.body.classList.contains('is-unlocked'), d.querySelector('#access-status').textContent);
  check('[site] gateway connected', /已连接/.test(d.querySelector('#conn').textContent));
  check('[site] profiles loaded', d.querySelectorAll('#profile option').length > 0);
  // Chat mode is the only mode in which the Go gateway pushes TEXT frames; in
  // read mode #llmout is intentionally empty (text only feeds the segmenter).
  d.querySelector('#mode').value = 'chat';
  d.querySelector('#text').value = '浏览器级二进制帧测试。第二句。';
  d.querySelector('#btn-speak').click();
  await wait(6500);
  check('[site] streamed TEXT frames rendered in #llmout', d.querySelector('#llmout').textContent.includes('浏览器级'));
  check('[site] no stream error', d.querySelector('#errbox').textContent.trim() === '');
  check('[site] segment table populated', d.querySelectorAll('#segbody tr').length > 0);
  check('[site] timeline rendered', d.querySelectorAll('#timeline .kv').length > 3);
  d.querySelector('#nav-mon').click(); await wait(1600);
  check('[site] diagnostics dialog works', d.querySelector('#diagnostics').open === true && d.querySelectorAll('#workers .card').length === 2);
  d.querySelector('#nav-lab').click(); await wait(400);
  d.querySelector('#btn-libraries').click(); await wait(1300);
  check('[site] library dialog loads', d.querySelectorAll('#library-select option').length > 0);
  check('[site] no JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  return errors;
}

(async () => {
  console.log('\nBrowser smoke tests (jsdom) — ' + BASE + '\n');
  await labTest();
  await siteTest();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e); process.exit(1); });
