'use strict';
/**
 * store.js — persistent state for the QTTS website replica.
 *
 * Everything the replica website creates (voice profiles, raw sample libraries,
 * training-input snapshots, run records) is written to REAL files under
 * kaggle_workspace/replica_state/. Nothing lives only in browser memory.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(ROOT, 'kaggle_workspace', 'replica_state');
const LIB_DIR = path.join(STATE_DIR, 'libraries');
const TRAIN_DIR = path.join(STATE_DIR, 'training_data');
const PROFILE_DIR = path.join(STATE_DIR, 'profiles');
const RUNS_DIR = path.join(STATE_DIR, 'runs');
const ACTIVE_FILE = path.join(STATE_DIR, 'active.json');
const URL_FILE = path.join(STATE_DIR, 'url.txt');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SAMPLE_RATE = 24000;

for (const d of [STATE_DIR, LIB_DIR, TRAIN_DIR, PROFILE_DIR, RUNS_DIR]) fs.mkdirSync(d, { recursive: true });

const now = () => new Date().toISOString();
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function seedRand(seed) {
  let a = (typeof seed === 'string' ? [...seed].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261) : seed) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 16-bit PCM mono WAV bytes. Used for seed samples and training snapshots. */
function wavBytes(pcm, sampleRate = SAMPLE_RATE) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * Deterministic synthetic PCM — an amplitude-modulated harmonic tone.
 * It is deliberately NOT a human voice: the replica has no model weights/GPU.
 * All produced audio is labelled SIMULATED in the UI/receipts.
 */
function synthPcm(seed, seconds, { sampleRate = SAMPLE_RATE, amplitude = 0.18, baseHz = 165 } = {}) {
  const n = Math.max(1, Math.floor(seconds * sampleRate));
  const out = Buffer.allocUnsafe(n * 2);
  const rnd = seedRand(seed);
  const f0 = baseHz + (rnd() * 60 - 30);
  const f1 = f0 * (1.9 + rnd() * 0.3);
  const f2 = f0 * (3.1 + rnd() * 0.5);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const syllable = 0.55 + 0.45 * Math.pow(Math.sin(2 * Math.PI * 3.1 * t), 2);
    const envelope = Math.min(1, t / 0.03) * Math.min(1, (seconds - t) / 0.05);
    const v = (Math.sin(2 * Math.PI * f0 * t) * 0.55 +
      Math.sin(2 * Math.PI * f1 * t) * 0.26 +
      Math.sin(2 * Math.PI * f2 * t) * 0.12) * syllable * envelope * amplitude;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return out;
}

function workerSnapshot(i) {
  return {
    id: i,
    healthy: true,
    simulated: true,
    busy: false,
    served: 0,
    failed: 0,
    rtf_x: 2.4,
    first_chunk_ms: 118,
    last_error: '',
    worker: {
      engine: 'qwen-tts-replica (simulated)',
      dtype: 'float32',
      rt: 'nodejs',
      model_output_mode: 'sentence-buffered',
      vram: { used_mb: 0, total_mb: 16384 },
    },
  };
}

function demoProfile() {
  return {
    id: 'demo-voice-001',
    name: '演示声音（模拟）',
    language: 'Chinese',
    units_per_sec: 4.8,
    pause_clause_ms: 180,
    pause_sentence_ms: 320,
    pause_para_ms: 480,
    breath_level_db: -32,
    breath_files: [],
    ref_text: '这是一个模拟参考文本，仅用于本地复刻环境演示，不代表真实克隆音色。',
    anchor: 'reference.wav',
    anchor_candidate: 0,
    candidates: [],
    quality: { build_s: 0.2, stage_ms: { extract: 40, anchor: 60, simulate: 100 }, files: [] },
    gen: { temperature: 0.7, top_k: 20 },
    trained_adapter: false,
    simulated: true,
    created: now(),
  };
}

function demoLibrary() {
  const id = hex(16);
  const samples = [];
  for (let i = 0; i < 2; i++) {
    const sid = hex(16);
    const pcm = synthPcm(`demo-sample-${i}`, 1.2 + i * 0.4, { amplitude: 0.12 });
    const raw = wavBytes(pcm);
    fs.mkdirSync(path.join(LIB_DIR, id), { recursive: true });
    fs.writeFileSync(path.join(LIB_DIR, id, `${sid}.audio`), raw);
    samples.push({
      id: sid, name: `示例音频${i + 1}（合成正弦·非人声）.wav`,
      bytes: raw.length, sha256: digest(raw), created: now(),
      seconds: Number((1.2 + i * 0.4).toFixed(3)),
    });
  }
  return {
    id, name: '示例参考库（模拟）', language: 'auto',
    revision: 1, created: now(), updated: now(),
    samples, bytes: samples.reduce((n, s) => n + s.bytes, 0),
    state: 'samples_unverified', busy: false, last_build: null,
    prepared_profile: null, training_verified: false,
    inference_verified: false, decoded_duration_verified: false,
    simulated: true,
  };
}

function freshState() {
  const profile = demoProfile();
  const library = demoLibrary();
  const state = {
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    accessToken: 'qtvs-local-replica-' + hex(24),
    activeProfile: profile.id,
    profiles: [profile],
    libraries: [library],
    trainingDatasets: [],
    jobs: {},
    runs: [],
    pairs: [],
    totalRuns: 0,
    workers: [workerSnapshot(0), workerSnapshot(1)],
    llmModel: 'deepseek-chat (simulated)',
    llmKeySet: false,
    seq: 1,
    simulated: true,
  };
  // Seed the original on-disk layout so it is inspectable from the first boot.
  try {
    writeProfileDisk(profile);
    writeLibraryDisk(library);
    atomicJson(ACTIVE_FILE, { id: profile.id });
    writeUrl('http://127.0.0.1:7860');
  } catch (e) { console.error('[replica] seed layout:', e.message); }
  return state;
}

let state;
function load() {
  if (state) return state;   // idempotent: never split the singleton object
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state || !Array.isArray(state.profiles)) throw new Error('bad state');
  } catch {
    state = freshState();
    save();
  }
  // Migrate pre-layout state files: the original Go/Python tools read
  // state/active.json and state/{profiles,libraries}/<id>/{profile,library}.json.
  // Create only what is missing; never overwrite a user's on-disk edits.
  try {
    if (!fs.existsSync(ACTIVE_FILE)) atomicJson(ACTIVE_FILE, { id: state.activeProfile || state.profiles[0]?.id || '' });
    if (!fs.existsSync(URL_FILE)) writeUrl('http://127.0.0.1:7860');
    for (const p of state.profiles || []) {
      if (!fs.existsSync(path.join(PROFILE_DIR, p.id, 'profile.json'))) writeProfileDisk(p);
    }
    for (const l of state.libraries || []) {
      if (!fs.existsSync(path.join(LIB_DIR, l.id, 'library.json'))) writeLibraryDisk(l);
    }
    for (const r of state.runs || []) {
      if (r.session && !fs.existsSync(path.join(RUNS_DIR, `${r.session}.json`))) writeRunDisk(r);
    }
  } catch (e) { console.error('[replica] layout migration:', e.message); }
  return state;
}
function save() {
  state.updatedAt = now();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}
function get() { return state || load(); }
function nextSeq() { get().seq = (get().seq || 1) + 1; return get().seq; }

/* --- original-style on-disk layout ----------------------------------------
   The Go gateway reads state/profiles/<id>/profile.json and state/active.json;
   the Python library service keeps state/libraries/<id>/library.json. We write
   the same files so the replica's disk is inspectable with the original tools. */
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function writeActive(id) { atomicJson(ACTIVE_FILE, { id }); get().activeProfile = id; save(); }
function readActive() {
  try { const v = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8')); if (v && typeof v.id === 'string') return v.id; } catch {}
  return get().activeProfile || null;
}
function writeProfileDisk(profile) {
  const dir = path.join(PROFILE_DIR, profile.id);
  fs.mkdirSync(dir, { recursive: true });
  atomicJson(path.join(dir, 'profile.json'), profile);
}
function listProfilesFromDisk() {
  const out = [];
  try {
    for (const e of fs.readdirSync(PROFILE_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('_cal_')) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, e.name, 'profile.json'), 'utf8'));
        if (p && p.id) out.push(p);
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
}
function writeLibraryDisk(library) {
  atomicJson(path.join(LIB_DIR, library.id, 'library.json'), library);
}
function writeRunDisk(run) {
  if (run && run.session) atomicJson(path.join(RUNS_DIR, `${run.session}.json`), run);
}
function writeUrl(url) { fs.writeFileSync(URL_FILE, url + '\n'); }
function layout() {
  const files = [];
  const walk = (dir, prefix = '') => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else {
        const st = fs.statSync(path.join(dir, e.name));
        files.push({ path: rel, bytes: st.size, mtime: st.mtime.toISOString() });
      }
    }
  };
  walk(STATE_DIR);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function publicLibrary(row) {
  if (!row) return null;
  const { ...pub } = row;
  return pub;
}
function findLibrary(id) { return get().libraries.find((l) => l.id === id); }
function findProfile(id) { return get().profiles.find((p) => p.id === id); }
function findDataset(id) { return get().trainingDatasets.find((d) => d.id === id); }

function samplePath(lid, sid) { return path.join(LIB_DIR, lid, `${sid}.audio`); }
function safeId(id, re = /^[a-zA-Z0-9_-]{1,64}$/) {
  if (typeof id !== 'string' || !re.test(id)) throw Object.assign(new Error('invalid id'), { status: 400 });
  return id;
}

function recordRun(run) {
  const s = get();
  s.runs.push(run);
  if (s.runs.length > 100) s.runs = s.runs.slice(-100);
  s.totalRuns += 1;
  s.workers.forEach((w) => { w.served += 1; });
  save();
  writeRunDisk(run);
}

module.exports = {
  ROOT, STATE_DIR, LIB_DIR, TRAIN_DIR, PROFILE_DIR, RUNS_DIR, ACTIVE_FILE, URL_FILE, STATE_FILE, SAMPLE_RATE,
  now, hex, digest, seedRand, wavBytes, synthPcm,
  load, save, get, nextSeq, freshState,
  atomicJson, writeActive, readActive, writeProfileDisk, listProfilesFromDisk,
  writeLibraryDisk, writeRunDisk, writeUrl, layout,
  publicLibrary, findLibrary, findProfile, findDataset,
  samplePath, safeId, recordRun, workerSnapshot,
};
