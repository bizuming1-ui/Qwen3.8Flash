'use strict';
/**
 * workers.js — HTTP surface of py/worker.py, proxied under /worker/{0,1}/.
 *
 * In Kaggle the Go scheduler talks to two uvicorn processes on 127.0.0.1:7001
 * and :7002. There are no GPUs / torch / model weights in this sandbox, so both
 * "workers" run in-process and emit the REAL 5-byte worker wire format:
 *
 *   [type u8][len u32 LE][payload]   type 1 PCM int16 LE 24 kHz, 2 JSON stats,
 *                                    3 JSON error
 *
 * The gain/limiter math is the exact Python port (dsp.js); the waveform is a
 * deterministic synthetic tone and is always advertised as simulated.
 */
const store = require('./store');
const SEG = require('./segmenter');
const DSP = require('./dsp');
const U = require('./http-utils');

const SR = store.SAMPLE_RATE;
const MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const WORKER_ROUTE = /^\/worker\/([01])\/([a-z/]+)$/;

function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.allocUnsafe(5);
  head[0] = type;
  head.writeUInt32LE(body.length, 1);
  return Buffer.concat([head, body]);
}

const workers = [0, 1].map((gpu) => ({
  gpu,
  started: Date.now(),
  lastProgress: Date.now(),
  served: 0,
  failed: 0,
  busy: false,
  rtf: 2.4,
  ttfa: 118,
  profiles: new Map(),
  bindings: new Map(),
}));

function health(w) {
  return {
    gpu: w.gpu,
    ready: true,
    error: null,
    busy: w.busy,
    engine: 'simulated-mock-engine',
    dtype: 'float32',
    rt: 'numpy-causal-v1',
    served: w.served,
    failed: w.failed,
    rtf_x: Number(w.rtf.toFixed(3)),
    first_chunk_ms: Number(w.ttfa.toFixed(1)),
    idle_for_s: Number(((Date.now() - w.lastProgress) / 1000).toFixed(1)),
    uptime_s: Number(((Date.now() - w.started) / 1000).toFixed(1)),
    profiles: [...w.profiles.keys()],
    voice_bindings: Object.fromEntries(w.bindings),
    voice_conditioning: 'speaker-vector-only',
    codec_policy: 'generated-only-25-left-optional-right',
    rtf_target_verified: false,
    fatal_error: null,
    requested_model: MODEL_ID,
    model_loaded: false,
    cuda_visible_devices: 'none (browser replica)',
    residency_policy: 'session-resident',
    stalled_s: 0.0,
    model_output_mode: 'sentence-buffered',
    quality_verified: false,
    simulated: true,
    note: '本地复刻 worker：无 torch / CUDA / 模型权重；仅保证线协议与 DSP 数学一致。',
  };
}

function findProfile(id) {
  return store.findProfile(id) || store.listProfilesFromDisk().find((p) => p.id === id);
}
function bindingOf(pid) {
  return store.digest(Buffer.from(`worker-binding|${pid}`, 'utf8')).slice(0, 16);
}

async function synth(w, req, res, body) {
  const policy = body.quality_policy || 'legacy-stream';
  if (!DSP.POLICIES.includes(policy)) {
    return U.json(res, 400, { error: 'unsupported quality policy' });
  }
  const pid = String(body.profile || '');
  const text = String(body.text || '').trim();
  if (!text) return U.json(res, 400, { error: 'empty text' });
  const profile = findProfile(pid);
  if (!profile) return U.json(res, 500, { ok: false, error: `FileNotFoundError: profile ${pid} not found` });
  const binding = bindingOf(pid);
  if (body.voice_binding !== undefined && body.voice_binding !== binding) {
    return U.json(res, 500, { ok: false, error: 'RuntimeError: voice reference changed; start a new session (no mixed-voice fallback)' });
  }
  w.profiles.set(pid, profile);
  w.bindings.set(pid, binding);
  w.busy = true;
  const t0 = Date.now();
  const seed = Number.isInteger(body.seed) ? body.seed : 42;
  const chunkSize = Math.max(2, Math.min(Number(body.chunk_size) || 8, 16));
  const units = Math.max(SEG.units(text), 1);
  const expectedS = Number((units / (Number(profile.units_per_sec) || 4.5)).toFixed(2));
  const seconds = Math.min(30.72, Math.max(0.4, expectedS));
  const raw = store.synthPcm(`${text}|${pid}|${seed}|${policy}|w${w.gpu}`, seconds, { amplitude: 0.16 });
  const { pcm, stats } = DSP.applyPolicy(raw, policy, {
    seed, expectedS, breath: !!body.breath, firstChunkMs: 118,
  });
  const leadMs = Math.min(600, Number(body.lead_pause_ms) || 0);
  const leadSamples = Math.floor(SR * leadMs / 1000);
  const sentenceCodec = DSP.SENTENCE_CODEC.has(policy);
  const qualityLinear = DSP.QUALITY_LINEAR.has(policy);
  const emitLead = leadSamples > 0 && !qualityLinear && !sentenceCodec;

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });

  let chunks = 0;
  if (emitLead) {
    res.write(frame(1, Buffer.alloc(leadSamples * 2)));
    chunks++;
  }
  const step = Math.floor(SR * 0.12) * 2;
  for (let off = 0; off < pcm.length && !res.destroyed; off += step) {
    res.write(frame(1, pcm.subarray(off, off + step)));
    chunks++;
  }
  const tailMs = Math.min(1500, Number(body.tail_pause_ms) || 0);
  if (tailMs > 0) res.write(frame(1, Buffer.alloc(Math.floor(SR * tailMs / 1000) * 2)));

  const anomalies = ['simulated_tone_not_human_voice'];
  if (stats.audio_s < 0.35 * expectedS || stats.audio_s < 0.2) anomalies.push('too_short');
  if (stats.audio_s > 2.3 * expectedS + 1) anomalies.push('too_long');
  const out = {
    gpu: w.gpu,
    profile: pid,
    ...stats,
    chunks,
    chunk_size: chunkSize,
    seed,
    text_units: units,
    lead_ms: leadMs,
    lead_pcm_emitted: emitLead,
    tail_pause_ms: tailMs,
    voice_binding: binding,
    lock_wait_ms: 0.1,
    profile_prepare_ms: 0.4,
    queue_ms: 0,
    model_first_chunk_ms: 118,
    model_stages: {},
    diagnostic_session: body.diagnostic_session || '',
    diagnostic_segment: Number(body.diagnostic_segment) || 0,
    anomalies,
    trim: { lead_trimmed_ms: 0, tail_trimmed_ms: 0, lead_limit_reached: false },
    failed: false,
  };
  res.write(frame(2, out));
  res.end();
  w.served++;
  w.busy = false;
  w.lastProgress = Date.now();
  w.rtf = w.rtf * 0.9 + stats.rtf_x * 0.1;
  w.ttfa = w.ttfa * 0.9 + 118 * 0.1;
  void t0;
}

/** Returns true when the URL belonged to a worker. */
async function handle(req, res, url) {
  const m = WORKER_ROUTE.exec(url.pathname);
  if (!m) return false;
  const w = workers[Number(m[1])];
  const route = m[2].replace(/\/$/, '');
  const method = req.method.toUpperCase();
  if (route === 'health' && method === 'GET') {
    U.json(res, 200, health(w));
    return true;
  }
  if (route === 'profile/load' && method === 'POST') {
    const body = await U.readJson(req);
    const pid = String(body.profile || '');
    const profile = findProfile(pid);
    if (!profile) {
      U.json(res, 500, { ok: false, error: `FileNotFoundError: profile ${pid} not found` });
      return true;
    }
    const binding = bindingOf(pid);
    w.profiles.set(pid, profile);
    w.bindings.set(pid, binding);
    U.json(res, 200, {
      ok: true, id: pid, voice_binding: binding,
      voice_conditioning: 'speaker-vector-only',
      model_output_mode: 'sentence-buffered', units_per_sec: profile.units_per_sec || 4.5,
      mock: true, simulated: true,
    });
    return true;
  }
  if (route === 'synth' && method === 'POST') {
    const body = await U.readJson(req);
    await synth(w, req, res, body);
    return true;
  }
  U.json(res, 404, { error: 'unknown worker endpoint: ' + url.pathname });
  return true;
}

/** Mirrors the Go activate() fan-out: POST /profile/load on both GPUs. */
function loadOnBoth(pid) {
  const profile = findProfile(pid);
  if (!profile) return { ok: false, error: `profile ${pid} not found` };
  const binding = bindingOf(pid);
  for (const w of workers) { w.profiles.set(pid, profile); w.bindings.set(pid, binding); w.served++; }
  return { ok: true, profile: pid, voice_binding: binding, workers: workers.length, simulated: true };
}

function snapshots() {
  return workers.map((w) => ({
    id: w.gpu, url: `/worker/${w.gpu}`, healthy: true, ready: true, busy: w.busy,
    rtf_x: Number(w.rtf.toFixed(3)), first_chunk_ms: Number(w.ttfa.toFixed(1)),
    served: w.served, failed: w.failed, last_error: '', audio_s: 0,
    worker: health(w), simulated: true,
  }));
}

module.exports = { handle, snapshots, health, frame, WORKER_ROUTE, workers, loadOnBoth };
