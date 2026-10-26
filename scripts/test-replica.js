#!/usr/bin/env node
'use strict';
/**
 * HTTP-level integration test for the QTTS website replica.
 * Requires `npm start` to be running. Uses only Node built-ins.
 *
 *   npm run test:replica
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.env.BASE || 'http://localhost:3000';
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'replica', 'web');
const FILES = ['index.html', 'app.js', 'recorder.js', 'diagnostic-trace.js'];

let cookie = '';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

async function req(p, { method = 'GET', body, headers = {} } = {}) {
  const h = { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', ...headers };
  if (cookie) h.Cookie = cookie;
  let data;
  if (body !== undefined) {
    data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    if (!Buffer.isBuffer(body)) h['Content-Type'] = 'application/json';
  }
  const r = await fetch(BASE + p, { method, headers: h, body: data });
  for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
    const kv = c.split(';')[0].trim();
    if (kv.startsWith('qtts_private_session=') && kv.length > 'qtts_private_session='.length) cookie = kv;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: r.status, headers: r.headers, buf, json };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function wav(seconds = 0.5) {
  const n = Math.floor(24000 * seconds);
  const pcm = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 220 * i / 24000)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function multipart(fields, files) {
  const b = '----qtts-test-boundary';
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const [field, name, content] of files) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: audio/wav\r\n\r\n`));
    parts.push(content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${b}` };
}

(async () => {
  console.log('\nQTTS replica integration test — ' + BASE + '\n');

  // 1. assets + byte-identical website
  const verify = await req('/lab/api/replica/verify', { method: 'POST', body: {} });
  const v = verify.json.verification;
  check('70/70 source assets SHA-256 verified', v.assetsVerified === v.assetsTotal && v.assetsTotal === 70, `${v.assetsVerified}/${v.assetsTotal}`);
  check('4/4 website files byte-identical', v.webIdentical === 4 && !v.mismatches.length, `${v.webIdentical}/${v.webTotal}`);
  for (const f of FILES) {
    const r = await req('/site/' + f);
    check('/site/' + f + ' served exactly', r.status === 200 && sha(r.buf) === sha(fs.readFileSync(path.join(WEB, f))));
  }
  const map = await req('/lab/api/replica/api-map');
  check('API compatibility matrix', map.json.total === 38, map.json.total + ' endpoints');

  // 2. private entry auth
  const before = await req('/api/session/status');
  check('session locked before entry', before.status === 401);
  const issued = await req('/lab/api/replica/entry', { method: 'POST', body: {} });
  const grant = issued.json.grant;
  check('one-use grant issued', grant && grant.length === 43);
  const ex = await req('/api/session/exchange', { method: 'POST', body: { grant } });
  check('grant exchanged for HttpOnly cookie', ex.status === 200 && cookie.includes('qtts_private_session'));
  const reuse = await req('/api/session/exchange', { method: 'POST', body: { grant } });
  check('grant cannot be reused', reuse.status === 401);
  const status = await req('/api/session/status');
  check('session ready', status.status === 200 && status.json.ready === true);

  // 3. read-only gateway endpoints
  for (const [p, key] of [
    ['/api/health', 'workers'], ['/api/preflight', 'status'], ['/api/workers', null],
    ['/api/metrics', 'total_runs'], ['/api/diagnostics', 'schema'], ['/api/profiles', 'profiles'],
    ['/api/prep/health', 'ok'], ['/api/prep/profiles', 'profiles'], ['/api/prep/libraries', 'libraries'],
    ['/api/prep/training-data', 'datasets'], ['/api/prep/diagnostics/snapshot', 'schema'],
  ]) {
    const r = await req(p);
    check('GET ' + p, r.status === 200 && (!key || r.json[key] !== undefined));
  }

  // 4. binary speak stream
  const speak = await req('/api/speak', {
    method: 'POST',
    body: { text: '这是复刻环境的二进制帧测试。第二句。', mode: 'read', quality_policy: 'sentence-linear' },
  });
  check('POST /api/speak returns octet-stream', speak.status === 200 && speak.headers.get('content-type').includes('octet-stream'));
  check('X-Session-Id is 12+ hex', /^[0-9a-f]{12,64}$/.test(speak.headers.get('x-session-id') || ''));
  const frames = [];
  let pos = 0;
  while (pos + 9 <= speak.buf.length) {
    const type = speak.buf[pos], seg = speak.buf.readUInt32LE(pos + 1), len = speak.buf.readUInt32LE(pos + 5);
    pos += 9;
    frames.push({ type, seg, payload: speak.buf.subarray(pos, pos + len) });
    pos += len;
  }
  const types = new Set(frames.map((f) => f.type));
  check('frame types 1,2,3,4,5,7 all present', [1, 2, 3, 4, 5, 7].every((t) => types.has(t)), [...types].sort().join(','));
  const pcmBytes = frames.filter((f) => f.type === 1).reduce((n, f) => n + f.payload.length, 0);
  check('24 kHz int16 PCM payload', pcmBytes > 10000, pcmBytes + ' bytes');
  const end = frames.find((f) => f.type === 5);
  check('END receipt marks simulated', end && JSON.parse(end.payload.toString()).simulated === true);

  // 5. multipart profile creation + job polling
  const tag = Date.now().toString(36).slice(-6);
  const mp = multipart({ name: '自动化测试档案-' + tag, language: 'Chinese', ref_text: '测试参考文本', anchor_seconds: '16', calibrate: '0' },
    [['files', 'ref.wav', wav()]]);
  const created = await req('/api/prep/profiles', { method: 'POST', body: mp.body, headers: { 'Content-Type': mp.ct } });
  check('POST /api/prep/profiles (multipart)', created.status === 201 && created.json.job);
  let job;
  for (let i = 0; i < 10; i++) {
    await wait(900);
    job = (await req('/api/prep/jobs/' + created.json.job)).json;
    if (job.state !== 'running') break;
  }
  check('profile job completes with profile id', job.state === 'done' && !!job.profile, job.state + ' ' + (job.profile || ''));
  const profiles = (await req('/api/profiles')).json.profiles;
  check('new profile persisted', profiles.some((p) => p.id === job.profile));
  check('POST /api/profiles/activate', (await req('/api/profiles/activate', { method: 'POST', body: { id: job.profile } })).status === 200);
  check('POST /api/prep/profiles/{id}/text', (await req(`/api/prep/profiles/${job.profile}/text`, { method: 'POST', body: { ref_text: '新文本' } })).status === 200);

  // 6. library + training input snapshot
  const libRes = await req('/api/prep/libraries', { method: 'POST', body: { name: '自动化测试库-' + tag, language: 'auto' } });
  const lib = libRes.json.library || {};
  check('POST /api/prep/libraries', libRes.status === 201 && !!lib.id, libRes.status + ' ' + (libRes.json.error || ''));
  const up = multipart({ revision: String(lib.revision) }, [['files', 'a.wav', wav(0.5)], ['files', 'b.wav', wav(0.7)]]);
  const added = await req(`/api/prep/libraries/${lib.id}/samples`, { method: 'POST', body: up.body, headers: { 'Content-Type': up.ct } });
  check('POST /api/prep/libraries/{id}/samples', added.status === 200 && added.json.library?.samples.length === 2,
    added.status + ' ' + (added.json.error || ''));
  const lib2 = added.json.library || lib;
  const td = await req('/api/prep/training-data', {
    method: 'POST',
    body: {
      library_id: lib.id, revision: lib2.revision,
      samples: [{ id: lib2.samples[0].id, text: '这是一条训练转写' }],
      reference_sample_id: lib2.samples[0].id,
      voice_rights_confirmed: true, single_speaker_confirmed: true,
    },
  });
  check('POST /api/prep/training-data', td.status === 201 && !!td.json.dataset?.manifest_sha256,
    td.status + ' ' + (td.json.error || ''));
  const did = td.json.dataset?.id, digest = td.json.dataset?.manifest_sha256;
  check('training snapshot files on disk', !!did && fs.existsSync(path.join(ROOT, 'kaggle_workspace/replica_state/training_data', did, 'manifest.json')));
  const vr = did ? await req(`/api/prep/training-data/${did}/verify`, { method: 'POST', body: { manifest_sha256: digest } }) : { status: 0, json: {} };
  check('POST /api/prep/training-data/{id}/verify', vr.status === 200 && vr.json.dataset?.integrity_verified_now === true);

  // 7. diagnostics + telemetry + report + logout
  check('POST /api/prep/diagnostics/pair', (await req('/api/prep/diagnostics/pair', { method: 'POST', body: { profile: job.profile, text: '短测文本', language: 'Chinese' } })).status === 200);
  check('POST /api/prep/consistency', (await req('/api/prep/consistency', { method: 'POST', body: { profile: job.profile } })).json.simulated === true);
  check('POST /api/report', (await req('/api/report', { method: 'POST', body: { session: 'testSession', report_sequence: 1 } })).json.merged === true);
  check('POST /api/telemetry', (await req('/api/telemetry', { method: 'POST', body: { session: 'testSession', buffered_s: 1 } })).status === 204);
  check('POST /api/session/logout', (await req('/api/session/logout', { method: 'POST', body: {} })).status === 200);
  check('session locked after logout', (await req('/api/session/status')).status === 401);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e); process.exit(1); });
