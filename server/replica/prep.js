'use strict';
/**
 * prep.js — compatible re-implementation of the Python "analyst" service that
 * the Go gateway exposes as /api/prep/*. Covers profiles, jobs, raw-sample
 * libraries, training-input snapshots, diagnostics and consistency reports.
 *
 * All writes are REAL files under kaggle_workspace/replica_state/.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const U = require('./http-utils');

const st = store.get();
const now = store.now;

function err(status, message) { return U.fail(status, message); }
function ok(res, value, status = 200) { return U.json(res, status, value); }

function publicProfile(p) {
  if (!p) return null;
  const { worker_load, ...pub } = p;
  return pub;
}
function publicLibrary(l) { return l ? { ...l } : null; }

function workersList() {
  return st.workers.map((w, i) => ({
    id: i, ok: true, simulated: true, worker: w.worker,
    voice_binding: 'simulated', voice_conditioning: 'simulated',
  }));
}

/** Create a background job whose progress is persisted to state.json. */
function createJob(kind, onDone, steps = ['queued', 'decode', 'anchor', 'encode', 'done']) {
  const id = store.hex(6);
  const job = {
    id, state: 'running', pct: 0, stage: 'queued',
    log: [`${kind}：任务已受理（本地模拟，不会加载模型或训练）`],
    profile: null, simulated: true, createdAt: now(),
  };
  st.jobs[id] = job;
  store.save();
  let i = 0;
  const tick = () => {
    const j = st.jobs[id];
    if (!j || j.state !== 'running') return;
    i += 1;
    j.stage = steps[Math.min(i, steps.length - 1)];
    j.pct = Math.min(95, Math.round((i / (steps.length - 1)) * 95));
    j.log.push(`[${new Date().toISOString().slice(11, 19)}] ${j.stage} · 模拟阶段`);
    if (i >= steps.length - 1) {
      try {
        const out = onDone();
        if (out && out.profile) j.profile = out.profile;
        j.state = 'done'; j.pct = 100; j.stage = 'done';
        j.log.push('参考处理完成（模拟）；未加载模型、未训练、未验收音质。');
      } catch (e) {
        j.state = 'error'; j.error = e.message;
        j.log.push('失败：' + e.message);
      }
    }
    store.save();
    if (j.state === 'running') setTimeout(tick, 850);
  };
  setTimeout(tick, 650);
  return job;
}

function buildProfile({ name, language, ref_text, anchor_seconds, calibrate, files }) {
  const pid = 'voice-' + store.hex(6);
  const dir = path.join(store.PROFILE_DIR, pid);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files.slice(0, 16)) {
    const safe = f.filename.replace(/[^\w.\-]/g, '_').slice(0, 100) || 'audio.bin';
    const p = path.join(dir, safe);
    fs.writeFileSync(p, f.data);
    saved.push({ name: safe, bytes: f.data.length, sha256: store.digest(f.data) });
  }
  const candidates = saved.slice(0, 3).map((f, i) => ({
    file: f.name, score: Number((0.9 - i * 0.07).toFixed(3)),
    level_spread_proxy_db: Number((7.2 + i).toFixed(2)),
    asr_conf: Number((0.92 - i * 0.05).toFixed(3)),
    start: 0.4 * i, end: Number((Math.min(anchor_seconds || 16, 2.4 + i)).toFixed(1)),
    text: ref_text || `（模拟转写 ${i + 1}）`,
  }));
  const profile = {
    id: pid,
    name: String(name || '未命名').slice(0, 64),
    language: language === 'auto' || !language ? 'Chinese' : String(language).slice(0, 32),
    units_per_sec: 4.8,
    pause_clause_ms: 180, pause_sentence_ms: 320, pause_para_ms: 480,
    breath_level_db: -32, breath_files: [],
    ref_text: String(ref_text || candidates[0]?.text || '').slice(0, 20000),
    anchor: saved[0]?.name || 'reference.wav',
    anchor_candidate: 0,
    candidates,
    quality: {
      build_s: 0.4,
      stage_ms: { decode: 90, anchor: 120, encode: 130, simulate: 60 },
      files: saved,
      simulated: true,
    },
    gen: { temperature: 0.7, top_k: 20 },
    trained_adapter: false,
    anchor_seconds: Number(anchor_seconds) || 16,
    calibrate: !!calibrate,
    simulated: true,
    created: now(),
  };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
  st.profiles.unshift(profile);
  if (!st.activeProfile) st.activeProfile = pid;
  store.save();
  return profile;
}

function addSamples(library, files) {
  fs.mkdirSync(path.join(store.LIB_DIR, library.id), { recursive: true });
  const known = new Set(library.samples.map((s) => s.sha256));
  let added = 0;
  for (const f of files.slice(0, 16)) {
    if (!f.data.length || f.data.length > 8 * 1024 * 1024) throw err(413, 'empty or oversized raw reference');
    const hash = store.digest(f.data);
    if (known.has(hash)) continue;                 // dedupe, same as voice_library.add
    known.add(hash);
    const sid = store.hex(16);
    fs.writeFileSync(store.samplePath(library.id, sid), f.data);
    library.samples.push({
      id: sid,
      name: f.filename.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 128) || 'audio.bin',
      bytes: f.data.length, sha256: hash, created: now(),
      seconds: estimateSeconds(f.data, f.filename),
    });
    added += 1;
  }
  library.bytes = library.samples.reduce((n, s) => n + s.bytes, 0);
  if (added) {
    library.revision += 1;
    library.updated = now();
    library.state = 'samples_unverified';
  }
  return library;
}

function estimateSeconds(data, name) {
  if (/\.wav$/i.test(name) && data.length > 44) {
    const rate = data.readUInt32LE(24) || 24000;
    const bytes = data.readUInt32LE(40);
    if (rate > 0 && bytes > 0 && bytes <= data.length - 44) return Number((bytes / (rate * 2)).toFixed(3));
  }
  return Number(Math.min(60, Math.max(0.5, data.length / 48000)).toFixed(3));
}

function checkRevision(library, revision) {
  if (String(revision) !== String(library.revision)) throw err(409, 'library changed; refresh before editing');
}

function datasetSummary(meta, verified = false) {
  return {
    id: meta.id, state: meta.state, created: meta.created,
    library_id: meta.library_id, library_name: meta.library_name,
    source_revision: meta.source_revision,
    sample_count: meta.samples.length,
    seconds: Number(meta.samples.reduce((n, s) => n + (s.seconds || 0), 0).toFixed(3)),
    manifest_sha256: meta.manifest_sha256,
    relative_directory: `training_data/${meta.id}`,
    integrity_verified_now: verified,
    checks: { wav_pcm16: true, mono: true, sample_rate_hz: 24000, transcripts: true, simulated: true },
    storage: 'local-session-only; excluded from Dataset backup',
    simulated: true,
  };
}

function prepareTrainingData(body) {
  if (body.voice_rights_confirmed !== true || body.single_speaker_confirmed !== true) {
    throw err(400, 'explicit voice-rights and single-speaker declarations required');
  }
  const library = store.findLibrary(body.library_id);
  if (!library) throw err(404, 'library not found');
  checkRevision(library, body.revision);
  const rows = body.samples;
  if (!Array.isArray(rows) || !rows.length || rows.length > 16) throw err(400, 'select bounded training samples with transcripts');
  const byId = new Map(library.samples.map((s) => [s.id, s]));
  const selected = [];
  for (const r of rows) {
    const s = byId.get(r.id);
    if (!s) throw err(400, 'unknown sample in training selection');
    selected.push({ ...s, text: String(r.text || '').slice(0, 4000) });
  }
  if (selected.some((s) => !s.text.trim())) throw err(400, 'each selected sample needs a transcript');
  if (!byId.has(body.reference_sample_id)) throw err(400, 'reference must belong to selected samples');

  const id = store.hex(16);
  const dir = path.join(store.TRAIN_DIR, id);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  const jsonl = selected.map((s) => JSON.stringify({
    audio: `audio/${s.id}.wav`, text: s.text, ref_audio: `audio/${body.reference_sample_id}.wav`,
  })).join('\n') + '\n';
  const plan = {
    kind: 'assignment_plan_not_execution', world_size: 2, seed: 42, epoch: 0,
    samples: selected.map((s, i) => ({ id: s.id, rank: i % 2 })),
    note: 'rank plan only — no rank/gradient/optimizer was started',
  };
  const manifest = {
    schema: 'qtts-training-input-v1', id, state: 'prepared', created: now(),
    library_id: library.id, library_name: library.name,
    source_revision: library.revision,
    reference_sample_id: body.reference_sample_id,
    samples: selected.map((s) => ({
      id: s.id, bytes: s.bytes, seconds: s.seconds,
      text_sha256: store.digest(Buffer.from(s.text, 'utf8')),
      audio_sha256: s.sha256,
    })),
    jsonl_sha256: store.digest(Buffer.from(jsonl, 'utf8')),
    rank_plan_sha256: store.digest(Buffer.from(JSON.stringify(plan), 'utf8')),
    upstream_commit: 'qvoice-replica-node',
    simulated: true,
    warning: '输入快照不是训练；未提取 audio_codes，未启动 rank/梯度/优化器。',
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(dir, 'train_raw.jsonl'), jsonl);
  fs.writeFileSync(path.join(dir, 'rank_plan.json'), JSON.stringify(plan, null, 2) + '\n');
  for (const s of selected) {
    const src = store.samplePath(library.id, s.id);
    const dst = path.join(dir, 'audio', `${s.id}.wav`);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    else fs.writeFileSync(dst, store.wavBytes(store.synthPcm(s.id, 1.0)));
  }
  const summary = datasetSummary({ ...manifest, manifest_sha256: store.digest(manifestBytes) }, true);
  st.trainingDatasets.unshift({ ...manifest, manifest_sha256: summary.manifest_sha256 });
  store.save();
  return summary;
}

function verifyDataset(id, expectedHash) {
  const meta = store.findDataset(id);
  if (!meta) throw err(404, 'training snapshot not found');
  const dir = path.join(store.TRAIN_DIR, id);
  const raw = fs.readFileSync(path.join(dir, 'manifest.json'));
  const actual = store.digest(raw);
  if (expectedHash && expectedHash !== actual) throw err(409, 'pinned training manifest hash changed');
  const required = ['manifest.json', 'train_raw.jsonl', 'rank_plan.json', 'audio'];
  if (required.some((f) => !fs.existsSync(path.join(dir, f)))) throw err(409, 'training snapshot files changed');
  return datasetSummary({ ...meta, manifest_sha256: actual }, true);
}

function consistencyReport(profile) {
  const mean = (gpu) => ({
    gpu, speech_db: Number((-19.4 + gpu * 0.13).toFixed(2)),
    speaker_sim_centroid: Number((0.862 - gpu * 0.008).toFixed(4)),
    fidelity_index: Number((0.71 - gpu * 0.01).toFixed(3)),
    simulated: true,
  });
  return {
    speaker_model: 'simulated-ecapa', cross_gpu_speaker_sim: 0.854,
    consistent: false, quality_verified: false, simulated: true,
    delta: { loudness_db: 0.13, speaker_sim: 0.008 },
    gpus: [{ gpu: 0, mean: mean(0) }, { gpu: 1, mean: mean(1) }],
    profile: profile ? profile.id : null,
    note: '模拟数值，不代表真实双卡一致性或音色相似度。',
  };
}

/** Main /api/prep/* dispatcher. `sub` begins with '/'. */
async function handle(req, res, sub, method, helpers) {
  const p = sub.split('?')[0];
  const parts = p.split('/').filter(Boolean);
  const head = parts[0] || '';

  if (head === 'health' && method === 'GET') {
    return ok(res, {
      ok: true, speaker_model: 'simulated', asr: 'simulated', mock: true,
      jobs: Object.keys(st.jobs).length, workers: workersList(), simulated: true,
    });
  }

  // ------------------------------- profiles --------------------------------
  if (head === 'profiles' && parts.length === 1 && method === 'GET') {
    return ok(res, { profiles: st.profiles.map(publicProfile) });
  }
  if (head === 'profiles' && parts.length === 1 && method === 'POST') {
    const raw = await U.readBody(req);
    const { fields, files } = U.parseMultipart(raw, req.headers['content-type']);
    if (!files.length) throw err(400, 'upload at least one audio file');
    if (!String(fields.name || '').trim()) throw err(400, 'voice name is empty');
    const job = createJob('快速声音档案', () => {
      const profile = buildProfile({
        name: fields.name, language: fields.language, ref_text: fields.ref_text,
        anchor_seconds: Number(fields.anchor_seconds) || 16,
        calibrate: fields.calibrate === '1', files,
      });
      return { profile: profile.id };
    });
    return ok(res, { job: job.id, simulated: true }, 201);
  }
  if (head === 'profiles' && parts.length === 2 && method === 'GET') {
    const profile = store.findProfile(parts[1]);
    if (!profile) throw err(404, 'not found');
    return ok(res, publicProfile(profile));
  }
  if (head === 'profiles' && parts.length === 2 && method === 'DELETE') {
    const idx = st.profiles.findIndex((x) => x.id === parts[1]);
    if (idx < 0) throw err(404, 'not found');
    st.profiles.splice(idx, 1);
    if (st.activeProfile === parts[1]) st.activeProfile = st.profiles[0]?.id || null;
    try { fs.rmSync(path.join(store.PROFILE_DIR, parts[1]), { recursive: true, force: true }); } catch {}
    store.save();
    return ok(res, { ok: true });
  }
  if (head === 'profiles' && parts.length === 3 && parts[2] === 'text' && method === 'POST') {
    const profile = store.findProfile(parts[1]);
    if (!profile) throw err(404, 'not found');
    const body = await U.readJson(req);
    profile.ref_text = String(body.ref_text || '').slice(0, 20000);
    store.save();
    return ok(res, { ok: true, workers: workersList(), simulated: true });
  }
  if (head === 'profiles' && parts.length === 3 && parts[2] === 'candidate' && method === 'POST') {
    const profile = store.findProfile(parts[1]);
    if (!profile) throw err(404, 'not found');
    const body = await U.readJson(req);
    const i = Math.max(0, Math.min((profile.candidates || []).length - 1, Number(body.index) || 0));
    profile.anchor_candidate = i;
    if (profile.candidates?.[i]) { profile.ref_text = profile.candidates[i].text; profile.anchor = profile.candidates[i].file; }
    store.save();
    return ok(res, { ok: true, workers: workersList(), simulated: true });
  }
  if (head === 'profiles' && parts.length === 3 && parts[2] === 'calibrate' && method === 'POST') {
    const profile = store.findProfile(parts[1]);
    if (!profile) throw err(404, 'not found');
    return ok(res, {
      status: 'simulated_calibration', quality_verified: false, simulated: true,
      candidates: profile.candidates || [], profile: profile.id,
      note: '未加载模型；候选分数为演示值，不代表 GPU 实测。',
    });
  }

  // -------------------------------- jobs -----------------------------------
  if (head === 'jobs' && parts.length === 2 && method === 'GET') {
    const job = st.jobs[parts[1]];
    if (!job) throw err(404, 'no such job');
    return ok(res, job);
  }

  // ------------------------------ libraries ---------------------------------
  if (head === 'libraries' && parts.length === 1 && method === 'GET') {
    return ok(res, {
      libraries: st.libraries.map(publicLibrary),
      storage: 'local-session-only; raw samples excluded from Dataset backup',
      simulated: true,
    });
  }
  if (head === 'libraries' && parts.length === 1 && method === 'POST') {
    const body = await U.readJson(req);
    const name = String(body.name || '').trim();
    if (!name || [...name].length > 64) throw err(400, 'please provide a 1-64 character library name');
    if (st.libraries.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw err(409, 'a library with this name already exists');
    const id = store.hex(16);
    fs.mkdirSync(path.join(store.LIB_DIR, id), { recursive: true });
    const library = {
      id, name, language: String(body.language || 'auto').slice(0, 32),
      revision: 1, created: now(), updated: now(), samples: [], bytes: 0,
      state: 'empty', busy: false, last_build: null, prepared_profile: null,
      training_verified: false, inference_verified: false,
      decoded_duration_verified: false, simulated: true,
    };
    st.libraries.unshift(library);
    store.save();
    return ok(res, { library: publicLibrary(library), simulated: true }, 201);
  }
  if (head === 'libraries' && parts.length === 2 && method === 'GET') {
    const library = store.findLibrary(parts[1]);
    if (!library) throw err(404, 'library not found');
    return ok(res, { library: publicLibrary(library), simulated: true });
  }
  if (head === 'libraries' && parts.length === 2 && method === 'DELETE') {
    const library = store.findLibrary(parts[1]);
    if (!library) throw err(404, 'library not found');
    const body = await U.readJson(req);
    checkRevision(library, body.revision);
    st.libraries = st.libraries.filter((l) => l.id !== library.id);
    try { fs.rmSync(path.join(store.LIB_DIR, library.id), { recursive: true, force: true }); } catch {}
    store.save();
    return ok(res, { deleted: library.id, prepared_profiles_deleted: false });
  }
  if (head === 'libraries' && parts.length === 3 && parts[2] === 'samples' && method === 'POST') {
    const library = store.findLibrary(parts[1]);
    if (!library) throw err(404, 'library not found');
    const raw = await U.readBody(req);
    const { fields, files } = U.parseMultipart(raw, req.headers['content-type']);
    if (!files.length) throw err(400, 'upload at least one audio file');
    checkRevision(library, fields.revision);
    addSamples(library, files);
    store.save();
    return ok(res, { library: publicLibrary(library), simulated: true });
  }
  if (head === 'libraries' && parts.length === 4 && parts[2] === 'samples' && method === 'DELETE') {
    const library = store.findLibrary(parts[1]);
    if (!library) throw err(404, 'library not found');
    const body = await U.readJson(req);
    checkRevision(library, body.revision);
    const before = library.samples.length;
    library.samples = library.samples.filter((s) => s.id !== parts[3]);
    if (library.samples.length === before) throw err(404, 'no such sample');
    try { fs.unlinkSync(store.samplePath(library.id, parts[3])); } catch {}
    library.bytes = library.samples.reduce((n, s) => n + s.bytes, 0);
    library.revision += 1; library.updated = now(); library.state = 'samples_unverified';
    store.save();
    return ok(res, { library: publicLibrary(library), simulated: true });
  }
  if (head === 'libraries' && parts.length === 3 && parts[2] === 'process' && method === 'POST') {
    const library = store.findLibrary(parts[1]);
    if (!library) throw err(404, 'library not found');
    const body = await U.readJson(req);
    checkRevision(library, body.revision);
    if (!Array.isArray(body.sample_ids) || !body.sample_ids.length) throw err(400, 'select at least one reference sample');
    let jobId = null;
    const job = createJob('库参考处理', () => {
      const selected = library.samples.filter((s) => body.sample_ids.includes(s.id));
      const profile = buildProfile({
        name: library.name.slice(0, 48) + ' · 参考', language: library.language,
        ref_text: String(body.ref_text || '').slice(0, 20000),
        anchor_seconds: Number(body.anchor_seconds) || 16,
        calibrate: !!body.calibrate,
        files: selected.map((s) => ({
          filename: s.name,
          data: fs.existsSync(store.samplePath(library.id, s.id))
            ? fs.readFileSync(store.samplePath(library.id, s.id))
            : store.wavBytes(store.synthPcm(s.id, 1.0)),
        })),
      });
      library.last_build = {
        job: jobId, state: 'done', source_revision: library.revision,
        profile: profile.id, at: now(),
      };
      library.state = 'reference_prepared';
      library.prepared_profile = profile.id;
      library.busy = false;
      library.updated = now();
      return { profile: profile.id };
    });
    // the job id is needed inside the closure; assign before the first tick fires
    jobId = job.id;
    library.busy = true;
    library.last_build = { job: job.id, state: 'running', source_revision: library.revision };
    library.state = 'processing';
    store.save();
    return ok(res, { job: job.id, library: library.id, operation: 'reference_processing_not_training', simulated: true }, 202);
  }

  // ---------------------------- training data --------------------------------
  if (head === 'training-data' && parts.length === 1 && method === 'GET') {
    return ok(res, {
      datasets: st.trainingDatasets.map((d) => datasetSummary({ ...d, manifest_sha256: d.manifest_sha256 })),
      operation: 'input_preparation_not_training', simulated: true,
    });
  }
  if (head === 'training-data' && parts.length === 1 && method === 'POST') {
    const body = await U.readJson(req);
    const dataset = prepareTrainingData(body);
    return ok(res, { dataset, operation: 'input_preparation_not_training', simulated: true }, 201);
  }
  if (head === 'training-data' && parts.length === 3 && parts[2] === 'verify' && method === 'POST') {
    const body = await U.readJson(req);
    return ok(res, { dataset: verifyDataset(parts[1], body.manifest_sha256), simulated: true });
  }
  if (head === 'training-data' && parts.length === 2 && method === 'DELETE') {
    const body = await U.readJson(req);
    const meta = store.findDataset(parts[1]);
    if (!meta) throw err(404, 'training snapshot not found');
    if (body.manifest_sha256 !== meta.manifest_sha256) throw err(409, 'pinned training manifest hash changed');
    try { fs.rmSync(path.join(store.TRAIN_DIR, meta.id), { recursive: true, force: true }); } catch {}
    st.trainingDatasets = st.trainingDatasets.filter((d) => d.id !== meta.id);
    store.save();
    return ok(res, { deleted: meta.id, source_library_deleted: false, profiles_deleted: false });
  }

  // ------------------------------ diagnostics --------------------------------
  if (head === 'diagnostics' && parts[1] === 'snapshot' && method === 'GET') {
    return ok(res, {
      schema: 'qtts-diagnostics-v1', quality_verified: false, training_verified: false,
      physical_speaker_output_verified: false, simulated: true,
      generated_at: now(),
      runs: st.runs.slice(-8),
      training: { datasets: st.trainingDatasets.length, executed: false, simulated: true },
      libraries: st.libraries.length, profiles: st.profiles.length,
      note: '本地复刻环境：所有指标均为模拟，不代表真实模型/训练/音质验收。',
    });
  }
  if (head === 'diagnostics' && parts[1] === 'pair' && method === 'POST') {
    const body = await U.readJson(req);
    const profile = store.findProfile(body.profile);
    if (!profile || !String(body.text || '').trim() || [...String(body.text)].length > 200) {
      throw err(400, 'paired test needs an existing profile and 1-200 characters of your text');
    }
    const result = {
      schema: 'qtts-pair-v1', id: store.hex(6), at: now(),
      status: 'simulated_comparison_complete', quality_verified: false,
      physical_speaker_output_verified: false, simulated: true,
      profile: profile.id, language: body.language || 'Auto',
      gpus: [0, 1].map((gpu) => ({
        gpu, mean_speech_db: Number((-19.4 + gpu * 0.11).toFixed(2)),
        speaker_sim: Number((0.861 - gpu * 0.007).toFixed(4)),
        fidelity_index: Number((0.71 - gpu * 0.01).toFixed(3)),
        audio_s: 1.2, gen_ms: 216, rtf: 0.18,
      })),
      delta: { loudness_db: 0.11, speaker_sim: 0.007 },
      note: '双卡同文短测为模拟回执；数值相似不等于音色或真人一致。',
    };
    st.pairs.unshift(result);
    if (st.pairs.length > 20) st.pairs.length = 20;
    store.save();
    return ok(res, result);
  }

  // ------------------------------- consistency ------------------------------
  if (head === 'consistency' && method === 'POST') {
    const body = await U.readJson(req);
    const profile = store.findProfile(body.profile || st.activeProfile);
    if (!profile) throw err(400, 'profile not found');
    return ok(res, consistencyReport(profile));
  }
  if (head === 'evaluate' && method === 'POST') {
    // read multipart, but never claim quality verification
    const raw = await U.readBody(req);
    const { files } = U.parseMultipart(raw, req.headers['content-type']);
    return ok(res, {
      simulated: true, quality_verified: false, bytes: files.reduce((n, f) => n + f.data.length, 0),
      note: '未加载模型；无说话人相似度/音质结论。',
    });
  }

  throw err(404, 'unknown prep endpoint: ' + p);
}

module.exports = { handle, datasetSummary, consistencyReport, workersList };
