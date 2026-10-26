'use strict';
/**
 * replica/index.js — HTTP API router for the byte-identical QTTS website.
 *
 * It implements the COMPLETE contract of the original system:
 *   go/gateway  -> /api/{health,preflight,workers,metrics,diagnostics,profiles,
 *                  profiles/activate,speak,telemetry,report,session/*}
 *   py/analyst  -> /api/prep/* (profiles, jobs, libraries, training-data,
 *                  diagnostics, consistency, evaluate)
 *
 * No Go binary, no Python workers, no GPU, no model weights: the backend is a
 * deterministic, clearly-labelled simulator with REAL file persistence.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const auth = require('./auth');
const protocol = require('./protocol');
const prep = require('./prep');
const U = require('./http-utils');
const SEG = require('./segmenter');
const DSP = require('./dsp');
const LIMITS = require('./limits');
const WORKERS = require('./workers');
const DIAG = require('./diagnostics');

const st = store.get();   // single shared state object for every replica module

const PROBE_FILE = path.join(store.STATE_DIR, 'backend_probe.json');
if (!fs.existsSync(PROBE_FILE)) {
  fs.writeFileSync(PROBE_FILE, JSON.stringify({
    status: 'simulated_probe', model_loaded: false, inference_verified: false,
    training_verified: false, performance_verified: false,
    gpu: 'none (browser replica)', note: '这是本地复刻环境的探针报告，不代表真实双 T4 验收。',
    generated_at: store.now(),
  }, null, 2) + '\n');
}

const helpers = { json: U.json };

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DeepSeek-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

function noContent(res) { res.writeHead(204); res.end(); }

function medianStages(runs) {
  const groups = {};
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.timeline_ms || {})) {
      (groups[k] || (groups[k] = [])).push(Number(v));
    }
  }
  const out = {};
  for (const [k, values] of Object.entries(groups)) {
    values.sort((a, b) => a - b);
    out[k] = values[Math.floor(values.length / 2)];
  }
  return out;
}

async function handle(req, res, url) {
  cors(req, res);
  const p = url.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return noContent(res);

  // ---- private entry (mirrors go/gateway/autoentry.go) ---------------------
  if (p === '/api/session/exchange' && method === 'POST') {
    const body = await U.readJson(req, 2048);
    return U.json(res, 200, auth.exchange(body, req, res));
  }
  if (p === '/api/session/status' && method === 'GET') {
    if (!auth.authorized(req)) return U.json(res, 401, { error: 'access token required or invalid' });
    return U.json(res, 200, { ready: true, simulated: true });
  }
  if (p === '/api/session/logout' && method === 'POST') {
    return U.json(res, 200, auth.logout(req, res));
  }
  if (p === '/api/session/issue' && method === 'POST') {
    if (!auth.bearerOk(req)) return U.json(res, 403, { error: 'notebook credential required' });
    return U.json(res, 200, auth.issueGrant());
  }

  // ---- everything else needs a valid session / bearer ----------------------
  if (!auth.authorized(req)) {
    if (!LIMITS.failedAllowed()) return U.busy(res, 'too many failed access attempts');
    res.setHeader('WWW-Authenticate', 'Bearer realm="QTTS"');
    return U.json(res, 401, { error: 'access token required or invalid' });
  }

  if (p === '/api/health' && method === 'GET') {
    return U.json(res, 200, {
      ok: true, workers_total: st.workers.length,
      workers_healthy: WORKERS.snapshots().filter((w) => w.healthy).length,
      workers: WORKERS.snapshots(),
      agg_rtf: 2.4, policy: protocol.policyFor(2.4),
      llm_key_set: st.llmKeySet, llm_model: st.llmModel,
      active_profile: store.readActive() || st.activeProfile,
      quality_policies: DSP.POLICIES,
      segmentation: SEG.defaultSegCfg(),
      limits: LIMITS.L,
      admission: LIMITS.snapshot(),
      on_disk_layout: store.layout(),
      simulated: true,
    });
  }
  if (p === '/api/preflight' && method === 'GET') {
    try { return U.json(res, 200, JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'))); }
    catch { return U.json(res, 200, { status: 'not_run', model_loaded: false }); }
  }
  if (p === '/api/workers' && method === 'GET') return U.json(res, 200, WORKERS.snapshots());
  if (p === '/api/metrics' && method === 'GET') {
    return U.json(res, 200, {
      total_runs: st.totalRuns,
      runs: st.runs.slice(-50),
      stage_median_ms: medianStages(st.runs),
      active_sessions: protocol.activeSessions(),
      simulated: true,
    });
  }
  if (p === '/api/diagnostics' && method === 'GET') {
    return U.json(res, 200, {
      schema: 'qtts-diagnostics-v1',
      total_runs: st.totalRuns,
      runs: st.runs.slice(-8).map(DIAG.cleanMap),
      active: protocol.activeSessionSnapshots().map(DIAG.cleanMap),
      quality_verified: false, training_verified: false,
      clock_origin: 'server_request_start',
      client_clock_origin: 'browser_request_start',
      physical_speaker_output_verified: false,
      simulated: true,
    });
  }
  if (p === '/api/profiles' && method === 'GET') {
    const disk = store.listProfilesFromDisk();
    return U.json(res, 200, {
      profiles: disk.length ? disk.map(prep.publicProfile) : st.profiles.map(prep.publicProfile),
      active: store.readActive() || st.activeProfile, simulated: true,
    });
  }
  if (p === '/api/profiles/activate' && method === 'POST') {
    const body = await U.readJson(req);
    const profile = store.findProfile(body.id) || store.listProfilesFromDisk().find((x) => x.id === body.id);
    if (!profile) return U.json(res, 404, { error: 'profile not found' });
    store.writeActive(profile.id);            // state/active.json, same as the Go gateway
    WORKERS.loadOnBoth(profile.id);           // POST /profile/load on both workers
    st.workers.forEach((w) => { w.served += 1; });
    store.save();
    return U.json(res, 200, { active: profile.id, workers: prep.workersList(), simulated: true });
  }
  if (p === '/api/telemetry' && method === 'POST') {
    const body = await U.readJson(req);
    if (!protocol.sessions.has(body.session)) protocol.registerSession(body.session, { late: true });
    protocol.telemetry(body.session, body);
    return noContent(res);
  }
  if (p === '/api/report' && method === 'POST') {
    const body = await U.readJson(req, 256 * 1024);
    if (body.session && !protocol.sessions.has(body.session)) protocol.registerSession(body.session, { late: true });
    const merged = protocol.mergeReport(body.session, body);
    return U.json(res, 200, { merged, simulated: true });
  }
  if (p === '/api/speak' && method === 'POST') {
    const body = await U.readJson(req);      // limit comes from Guard.middleware
    return protocol.speak(req, res, body, helpers);
  }
  if (p.startsWith('/api/prep/') || p === '/api/prep') {
    return prep.handle(req, res, p.slice('/api/prep'.length) || '/', method, helpers);
  }

  return U.json(res, 404, { error: 'unknown replica endpoint: ' + p });
}

async function safeHandle(req, res, url) {
  cors(req, res);
  let release = () => {};
  try {
    if (req.method.toUpperCase() !== 'OPTIONS' && url.pathname !== '/api/session/exchange') {
      release = LIMITS.admit(req, url.pathname);   // Guard.middleware
    }
    await handle(req, res, url);
  } catch (err) {
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    const status = Number(err.status) || 500;
    if (status === 429) { U.busy(res, err.message || 'request rate exceeded'); return; }
    if (status >= 500) console.error('[replica]', err);
    U.json(res, status, { error: err.message || 'internal error', simulated: true });
  } finally {
    release();
  }
}

/** Compare the 5 exact DSP quality policies on one common synthetic waveform. */
function dspProbe({ text = '这是一段用于对比五种质量策略的测试文本。', seed = 42, policy = null } = {}) {
  const raw = store.synthPcm(`dsp-probe|${text}|${seed}`, 2.0, { amplitude: 0.12 });
  const policies = policy ? [policy] : DSP.POLICIES;
  if (policies.some((p) => !DSP.POLICIES.includes(p))) {
    throw Object.assign(new Error('unsupported quality policy'), { status: 400 });
  }
  return {
    input: { samples: raw.length / 2, seconds: 2, sha256: store.digest(raw), simulated: true },
    policies: policies.map((p) => {
      const { pcm, stats } = DSP.applyPolicy(raw, p, { seed, expectedS: 2, firstChunkMs: 118 });
      const preview = [];
      for (let i = 0; i < 32; i++) preview.push(pcm.readInt16LE(i * 2));
      return {
        policy: p, stats, output: {
          samples: pcm.length / 2, sha256: store.digest(pcm),
          peak: Math.max(...preview.map(Math.abs)), first32: preview,
        },
      };
    }),
  };
}

function status() {
  return {
    auth: auth.stats(),
    accessToken: auth.accessToken(),
    profiles: st.profiles.length,
    libraries: st.libraries.length,
    trainingDatasets: st.trainingDatasets.length,
    runs: st.totalRuns,
    activeProfile: store.readActive() || st.activeProfile,
    qualityPolicies: DSP.POLICIES,
    segmentation: SEG.defaultSegCfg(),
    onDiskLayout: store.layout(),
    limits: LIMITS.L,
    workers: WORKERS.snapshots().length,
    simulated: true,
  };
}

module.exports = {
  safeHandle, status, issueGrant: auth.issueGrant, accessToken: auth.accessToken,
  segment: (text, opts) => SEG.segmentAll(text, opts),
  captureStream: protocol.captureStream,
  applyPolicy: DSP.applyPolicy,
  dspProbe,
  workers: WORKERS,
};
