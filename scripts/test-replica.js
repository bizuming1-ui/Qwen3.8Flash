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

  // 4. binary speak stream (exact Go gateway frame contract)
  const speak = await req('/api/speak', {
    method: 'POST',
    body: { text: '这是复刻环境的二进制帧测试。第二句。', mode: 'chat', quality_policy: 'sentence-linear' },
  });
  const sid = speak.headers.get('x-session-id') || '';
  check('POST /api/speak returns octet-stream', speak.status === 200 && speak.headers.get('content-type').includes('octet-stream'));
  check('X-Session-Id is 12+ hex', /^[0-9a-f]{12,64}$/.test(sid), sid);
  const frames = [];
  let pos = 0;
  while (pos + 9 <= speak.buf.length) {
    const type = speak.buf[pos], seg = speak.buf.readUInt32LE(pos + 1), len = speak.buf.readUInt32LE(pos + 5);
    pos += 9;
    frames.push({ type, seg, payload: speak.buf.subarray(pos, pos + len) });
    pos += len;
  }
  check('9-byte framing consumes the full stream', pos === speak.buf.length, `${pos}/${speak.buf.length}`);
  const types = new Set(frames.map((f) => f.type));
  check('frame types 1,2,3,4,5,7 all present', [1, 2, 3, 4, 5, 7].every((t) => types.has(t)), [...types].sort().join(','));
  const pcmBytes = frames.filter((f) => f.type === 1).reduce((n, f) => n + f.payload.length, 0);
  check('24 kHz int16 PCM payload', pcmBytes > 10000 && pcmBytes % 2 === 0, pcmBytes + ' bytes');
  const segFrames = frames.filter((f) => f.type === 2).map((f) => JSON.parse(f.payload.toString()));
  check('SEG frames carry Go segmenter fields', segFrames.length > 0 && segFrames.every((g) =>
    Number.isInteger(g.index) && typeof g.text === 'string' && Number.isFinite(g.units) &&
    Number.isFinite(g.pause_ms) && typeof g.boundary === 'string' && typeof g.breath === 'boolean'),
    segFrames.length + ' segments');
  const statFrames = frames.filter((f) => f.type === 4).map((f) => JSON.parse(f.payload.toString()));
  check('STATS frames carry exact worker DSP fields', statFrames.length === segFrames.length && statFrames.every((g) =>
    g.quality_policy === 'sentence-linear' && g.codec_policy === 'sentence' &&
    Number.isFinite(g.gain_db) && Number.isFinite(g.rtf_x) && g.acoustic_text_verified === false &&
    g.quality_verified === false && Array.isArray(g.anomalies) && g.simulated === true),
    statFrames.length + ' stats');
  const end = frames.find((f) => f.type === 5);
  const receipt = end ? JSON.parse(end.payload.toString()) : {};
  check('END receipt marks simulated', receipt.simulated === true && receipt.quality_verified === false);
  check('END receipt has per-GPU + timeline + diagnostics', !!(receipt.per_gpu && receipt.timeline_ms &&
    Array.isArray(receipt.diagnostic_segments) && receipt.content_source === 'llm_output'));
  check('run persisted to state/runs/<session>.json',
    !!sid && fs.existsSync(path.join(ROOT, 'kaggle_workspace/replica_state/runs', sid + '.json')));

  // 4b. read mode: the Go gateway feeds the segmenter but does NOT push TEXT frames.
  const readSpeak = await req('/api/speak', {
    method: 'POST', body: { text: '直接朗读只推送分段与音频。', mode: 'read', quality_policy: 'legacy-stream' },
  });
  const readTypes = new Set();
  let rp = 0;
  while (rp + 9 <= readSpeak.buf.length) {
    readTypes.add(readSpeak.buf[rp]);
    rp += 9 + readSpeak.buf.readUInt32LE(rp + 5);
  }
  check('read mode sends SEG/PCM/STATS but no TEXT', readSpeak.status === 200 &&
    readTypes.has(1) && readTypes.has(2) && readTypes.has(4) && !readTypes.has(3), [...readTypes].sort().join(','));

  // 4c. precision-development probes, exact original ports and on-disk layout.
  const health = (await req('/api/health')).json;
  check('health exposes 5 quality policies + Go segmenter config',
    health.quality_policies?.length === 5 && health.segmentation?.FirstMin === 7 && health.limits?.TextChars === 20000);
  check('original-style on-disk layout seeded', (health.on_disk_layout || []).some((f) => f.path === 'active.json') &&
    (health.on_disk_layout || []).some((f) => /^profiles\/.*\/profile\.json$/.test(f.path)) &&
    (health.on_disk_layout || []).some((f) => /^libraries\/.*\/library\.json$/.test(f.path)));
  const wSnap = (await req('/api/workers')).json;
  check('/api/workers returns 2 scheduler snapshots', Array.isArray(wSnap) && wSnap.length === 2 && wSnap[0].worker?.engine);
  for (const gpu of [0, 1]) {
    const r = await req(`/worker/${gpu}/health`);
    check(`GET /worker/${gpu}/health (py/worker.py)`, r.status === 200 && r.json.gpu === gpu &&
      r.json.model_loaded === false && r.json.codec_policy === 'generated-only-25-left-optional-right');
  }
  const pl = await req('/worker/0/profile/load', { method: 'POST', body: { profile: health.active_profile || '' } });
  check('POST /worker/0/profile/load', pl.status === 200 && pl.json.ok === true && !!pl.json.voice_binding);
  const ws = await req('/worker/0/synth', { method: 'POST', body: {
    text: 'worker 五字节线协议测试。', profile: health.active_profile || '', quality_policy: 'windowed-linear', seed: 7,
  } });
  const wTypes = new Set();
  let wp = 0;
  while (wp + 5 <= ws.buf.length) { wTypes.add(ws.buf[wp]); wp += 5 + ws.buf.readUInt32LE(wp + 1); }
  check('POST /worker/0/synth emits 5-byte PCM+STATS frames',
    ws.status === 200 && wTypes.has(1) && wTypes.has(2) && wp === ws.buf.length, [...wTypes].sort().join(','));
  const segProbe = await req('/lab/api/replica/segment', { method: 'POST', body: {
    text: '这是第一句，包含中文逗号；这是第二句！还有省略号……最后一段。', mode: 'read', seed: 42,
  } });
  check('segmenter probe matches Go boundary/pause model', segProbe.status === 200 &&
    segProbe.json.count >= 1 && segProbe.json.segments.every((x) =>
      ['none', 'clause', 'sentence', 'para', 'ellipsis'].includes(x.boundary) && Number.isFinite(x.pause_ms)),
    segProbe.json.count + ' segments');
  const dspProbe = await req('/lab/api/replica/dsp', { method: 'POST', body: { seed: 42 } });
  check('DSP probe compares all 5 exact Python leveler policies', dspProbe.status === 200 &&
    dspProbe.json.policies.length === 5 && dspProbe.json.policies.every((x) => Number.isFinite(x.stats.gain_db)) &&
    new Set(dspProbe.json.policies.map((x) => x.output.sha256)).size >= 2);
  const frameProbe = await req('/lab/api/replica/frames', { method: 'POST', body: {
    text: '帧协议检查文本。', mode: 'chat', quality_policy: 'legacy-stream', profile: health.active_profile,
  } });
  check('frame inspector captures both client and worker layers', frameProbe.status === 200 &&
    frameProbe.json.frames.length > 10 && frameProbe.json.workerFrames.length > 5 &&
    frameProbe.json.frames.some((f) => f.name === 'POLICY'));
  const limits = require(path.join(ROOT, 'server', 'replica', 'limits.js'));
  let validateThrew = false;
  try { limits.validateSpeak({ text: 'x'.repeat(20001) }); } catch (e) { validateThrew = e.status === 400; }
  check('Guard.validateSpeak enforces 20000-char budget', validateThrew && limits.L.SpeakConcurrent === 2);
  const tooBig = await req('/api/report', { method: 'POST', body: Buffer.alloc(1024 * 1024 + 64, 0x78) });
  check('Guard.middleware rejects >1 MiB JSON with 413', tooBig.status === 413);

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
  const report = await req('/api/report', { method: 'POST', body: {
    session: sid, report_sequence: 1, phase: 'playing', first_played_ms: 123,
    secret_user_text: 'THIS MUST BE REDACTED', quality_verified: true, request_mode: 'chat',
  } });
  check('POST /api/report merges only whitelisted fields', report.status === 200 && report.json.merged === true);
  check('POST /api/telemetry', (await req('/api/telemetry', { method: 'POST', body: { session: sid, buffered_s: 1 } })).status === 204);
  const diag = await req('/api/diagnostics');
  check('diagnostics never echoes browser free text', diag.status === 200 &&
    !JSON.stringify(diag.json).includes('THIS MUST BE REDACTED') &&
    Array.isArray(diag.json.runs) && Array.isArray(diag.json.active));
  check('POST /api/session/logout', (await req('/api/session/logout', { method: 'POST', body: {} })).status === 200);
  check('session locked after logout', (await req('/api/session/status')).status === 401);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e); process.exit(1); });
