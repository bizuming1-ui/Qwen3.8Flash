'use strict';
/**
 * protocol.js — binary streaming protocol of the real Go gateway, re-implemented.
 *
 * Two frame layers are reproduced:
 *   worker -> gateway  (py/worker.py + scheduler.go): type 1 PCM, 2 STATS, 3 ERR;
 *                      5-byte header, uint32 LE length.
 *   gateway -> browser (session.go writeFrame):        type 1 PCM, 2 SEG, 3 TEXT,
 *                      4 STATS, 5 END, 6 ERROR, 7 POLICY; 9-byte header with
 *                      uint32 LE segment index + uint32 LE payload length.
 *   PCM = int16 LE 24000 Hz mono; other payloads = UTF-8 JSON.
 *
 * Segmentation is the exact Go segmenter port; gain/limiting is the exact
 * Python Leveler port. The waveform itself remains a clearly-labelled SYNTHETIC
 * tone: this sandbox has no model weights / GPU / DeepSeek key.
 */
const store = require('./store');
const SEG = require('./segmenter');
const DSP = require('./dsp');
const LIMITS = require('./limits');
const DIAG = require('./diagnostics');

const FRAME = { PCM: 1, SEG: 2, TEXT: 3, STATS: 4, END: 5, ERROR: 6, POLICY: 7 };
const WFRAME = { PCM: 1, STATS: 2, ERR: 3 };
const FRAME_NAMES = { 1: 'PCM', 2: 'SEG', 3: 'TEXT', 4: 'STATS', 5: 'END', 6: 'ERROR', 7: 'POLICY' };
const WFRAME_NAMES = { 1: 'W-PCM', 2: 'W-STATS', 3: 'W-ERR' };
const SR = store.SAMPLE_RATE;

function frame(type, seg, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.allocUnsafe(9);
  head[0] = type;
  head.writeUInt32LE(seg >>> 0, 1);
  head.writeUInt32LE(body.length, 5);
  return Buffer.concat([head, body]);
}
function workerFrame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.allocUnsafe(5);
  head[0] = type;
  head.writeUInt32LE(body.length, 1);
  return Buffer.concat([head, body]);
}
function writeFrame(res, type, seg, payload) {
  if (res.writableEnded || res.destroyed) return false;
  return res.write(frame(type, seg, payload));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- language */
function detectLang(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (kana > 0 && kana >= cjk * 0.2) return 'Japanese';
  if (hangul > cjk && hangul > 0) return 'Korean';
  if (cjk > 0 && cjk >= latin * 0.35) return 'Chinese';
  return 'English';
}

/* ---------------------------------------------------------- session state */
const sessions = new Map();  // session id -> { telemetry, reports, startedAt, meta }
function registerSession(id, meta) {
  sessions.set(id, { telemetry: [], reports: [], startedAt: Date.now(), meta });
  if (sessions.size > 50) sessions.delete(sessions.keys().next().value);
}
function telemetry(id, patch) {
  const s = sessions.get(id);
  if (!s) return false;
  s.telemetry.push({ at: Date.now(), ...patch });
  if (s.telemetry.length > 200) s.telemetry.shift();
  const st = store.get();
  const run = [...st.runs].reverse().find((r) => r.session === id);
  if (run) {
    if (Number.isFinite(patch.first_played_ms)) run.client_first_played_ms = patch.first_played_ms;
    if (Number.isFinite(patch.underruns)) run.underruns = patch.underruns;
    store.writeRunDisk(run);
  }
  return true;
}
function mergeReport(id, patch) {
  const s = sessions.get(id);
  if (!s) return false;
  // go/gateway/monitor.go mergeDiagnosticClient: sanitize + monotonic sequence.
  if (!/^[0-9a-f]{12,64}$/.test(String(id || ''))) return false;
  const safe = DIAG.cleanClientPatch(patch);
  const seq = DIAG.sequence(safe);
  const last = s.reports.length ? DIAG.sequence(s.reports[s.reports.length - 1]) : -1;
  if (seq < last) return true;
  s.reports.push({ ...safe, receivedAt: Date.now() });
  const st = store.get();
  const run = [...st.runs].reverse().find((r) => r.session === id);
  if (run) {
    if (DIAG.sequence(run.client) > seq) return true;
    run.client = safe;
    store.save(); store.writeRunDisk(run);
  }
  return true;
}
function sessionClientReport(id) {
  const s = sessions.get(id);
  return s && s.reports.length ? s.reports[s.reports.length - 1] : null;
}
function activeSessions() { return sessions.size; }
function activeSessionSnapshots() {
  const out = [];
  for (const [id, s] of sessions) {
    out.push({
      session: id, request_mode: s.meta?.mode || 'read',
      timeline_ms: { request: 0, running: Date.now() - s.startedAt },
      client: sessionClientReport(id), simulated: true,
    });
    if (out.length >= 8) break;
  }
  return out;
}

/* ------------------------------------------------------------- scheduling */
function policyFor(agg, underruns = 0) {
  let p;
  if (agg >= 2.2) p = { low_s: 3.5, high_s: 36, start_s: 1.3 };
  else if (agg >= 1.5) p = { low_s: 5, high_s: 42, start_s: 2.0 };
  else if (agg >= 1.0) p = { low_s: 7, high_s: 50, start_s: 3.5 };
  else p = { low_s: 10, high_s: 60, start_s: 6 };
  p.low_s += Math.min(underruns * 1.5, 6);
  p.start_s += Math.min(underruns, 3);
  p.agg_rtf = agg;
  return p;
}

/* ----------------------------------------------------------- LLM stand-in */
function simulatedReply(text, language, history) {
  const lang = language && language !== 'auto' ? language : detectLang(text);
  const note = '[本地模拟回复｜复刻环境无 DeepSeek/模型权重，以下为确定性演示文本] ';
  const context = Array.isArray(history) && history.length
    ? `（承接前 ${history.length} 条对话：${String(history[history.length - 1].content || '').slice(0, 24)}）` : '';
  const body = lang === 'English'
    ? `You said: "${text.slice(0, 120)}". This is a local simulation of the QTTS gateway, not a model answer.`
    : `你刚才说的是：「${text.slice(0, 120)}」。这里是 QTTS 网关的本地复刻，返回文本与音频均为模拟数据，不代表真实模型输出。`;
  return note + context + body;
}

/* ------------------------------------------------------------- generator */
/**
 * Generate the complete client frame stream. `emit(type,seg,payload)` is called
 * in order; `onWorker(type,payload)` receives the worker-layer frames too.
 * Returns { run, headers, clientFrames, workerFrames, stats }.
 */
async function buildStream(body, emit, opts = {}) {
  const fast = !!opts.fast;
  const text = String(body.text || '').trim();
  const mode = body.mode === 'read' ? 'read' : 'chat';
  const policy = body.quality_policy || 'legacy-stream';
  const t0 = performance.now();
  const started = Date.now();
  const timeline = { request: 0 };
  const mark = (name) => { if (timeline[name] === undefined) timeline[name] = Math.round(performance.now() - t0); };
  const workerFrames = [];
  const clientFrames = [];
  const onWorker = (type, payload) => {
    if (!keep) return;
    const f = workerFrame(type, payload);
    workerFrames.push({ type, name: WFRAME_NAMES[type], length: f.length - 5, payload });
  };
  const keep = opts.keepFrames !== false;
  const send = (type, seg, payload) => {
    emit(type, seg, payload);
    if (!keep) return;
    const f = frame(type, seg, payload);
    clientFrames.push({ type, name: FRAME_NAMES[type], seg, length: f.length - 9, payload });
  };

  const st = store.get();
  const pid = body.profile || store.readActive();
  const profile = store.findProfile(pid) || store.listProfilesFromDisk().find((p) => p.id === pid);
  if (!profile) throw Object.assign(new Error('no voice profile selected: create one in the Voice Lab first'), { status: 400 });
  const seed = Number.isInteger(body.test_seed) ? body.test_seed : (Date.now() & 0x3fffffff);
  const lang = body.language && body.language !== 'auto' ? body.language : detectLang(text);
  const sessionId = opts.sessionId || store.hex(6);
  registerSession(sessionId, { mode, profile: pid, quality_policy: policy, language: lang, seed });

  const agg = 2.4;
  send(FRAME.POLICY, 0, policyFor(agg));

  // --- text stream -> segmenter (exact Go Feed/Flush behaviour) --------------
  const cfg = mode === 'read' ? SEG.readSegCfg(profile) : SEG.liveSegCfg(profile);
  const segmenter = new SEG.Segmenter(cfg, seed);
  const segments = [];
  const collect = (list) => {
    for (const s of list) {
      if (!segments.length) mark('first_segment');
      segments.push(s);
    }
  };
  let llmDeltas = 0;
  if (mode === 'chat') {
    mark('llm_request_start');
    const reply = simulatedReply(text, lang, body.history);
    mark('llm_response_headers');
    const deltas = reply.match(/[\s\S]{1,12}/g) || [reply];
    for (const d of deltas.slice(0, 40)) {
      if (!llmDeltas) mark('llm_first_token');
      llmDeltas++;
      send(FRAME.TEXT, 0, { t: d });
      collect(segmenter.feed(d));
      if (!fast) await sleep(12);
    }
  } else {
    mark('read_text_ready');
    const src = String(text).match(/[\s\S]{1,12}/g) || [text];
    for (const d of src) collect(segmenter.feed(d));
  }
  collect(segmenter.flush());
  mark('llm_done');

  // --- per-segment synthesis: worker frames -> gateway -> client ------------
  const qualityStats = [];
  let sentSamples = 0;
  let firstAudioAt = null;
  const maxSamples = SR * 30.72;   // site: 整句模式每个短段最多 30.72 秒
  const ups = Number(profile.units_per_sec) || 4.5;
  const voiceBinding = store.digest(Buffer.from(`${profile.id}|${profile.anchor}|${profile.ref_text}`, 'utf8')).slice(0, 16);
  const runSourceBuild = store.digest(Buffer.from('qvoice-replica-node'));

  for (const seg of segments) {
    if (opts.aborted && opts.aborted()) break;
    if (!qualityStats.length) mark('first_dispatch');
    send(FRAME.SEG, seg.index, seg);

    const expectedS = Number((SEG.units(seg.text) / ups).toFixed(2));
    const seconds = Math.min(30.72, Math.max(0.4, expectedS));
    const raw = store.synthPcm(`${text}|${pid}|${seed}|${policy}|${seg.index}`, seconds, { amplitude: 0.16 });
    const { pcm, stats: dsp } = DSP.applyPolicy(raw, policy, {
      seed, expectedS, breath: seg.breath,
      firstChunkMs: Math.round(firstAudioAt || 118),
    });

    // worker.py: explicit silent lead is emitted ONLY for the windowed legacy path;
    // sentence/linear paths keep lead_ms in stats but do not splice reference audio.
    const leadSamples = Math.floor(SR * Math.min(600, seg.pause_ms || 0) / 1000);
    const leadEmitted = policy === 'legacy-stream' && leadSamples > 0;
    let pcmAll = pcm;
    if (leadEmitted) {
      const silence = Buffer.alloc(leadSamples * 2);
      pcmAll = Buffer.concat([silence, pcm]);
      onWorker(WFRAME.PCM, silence);
    }
    const chunkBytes = Math.floor(SR * 0.12) * 2;
    let offset = 0;
    let firstChunk = true;
    while (offset < pcmAll.length && sentSamples < maxSamples && !(opts.aborted && opts.aborted())) {
      const part = pcmAll.subarray(offset, offset + chunkBytes);
      offset += chunkBytes;
      onWorker(WFRAME.PCM, part);
      if (!firstAudioAt) { firstAudioAt = performance.now() - t0; mark('first_seg_worker_audio'); mark('first_audio_sent'); }
      send(FRAME.PCM, seg.index, part);
      sentSamples += part.length / 2;
      if (firstChunk) { firstChunk = false; dsp.first_chunk_ms = Math.round(firstAudioAt); }
      if (!fast) await sleep(24);
    }

    const anomalies = ['simulated_tone_not_human_voice'];
    if (dsp.audio_s < 0.35 * expectedS || dsp.audio_s < 0.2) anomalies.push('too_short');
    if (dsp.audio_s > 2.3 * expectedS + 1) anomalies.push('too_long');
    const stat = {
      ...dsp,
      gpu: seg.index % 2,
      segment: seg.index,
      diagnostic_session: sessionId,
      diagnostic_segment: seg.index,
      text_units: seg.units,
      lead_ms: Number((leadSamples / SR * 1000).toFixed(1)),
      lead_pcm_emitted: leadEmitted,
      model_first_chunk_ms: dsp.first_chunk_ms,
      model_stages: {},
      source_build_id: runSourceBuild,
      source_build_match: false,
      voice_binding: voiceBinding,
      profile: pid,
      anomalies,
      simulated: true,
    };
    onWorker(WFRAME.STATS, stat);
    qualityStats.push(stat);
    send(FRAME.STATS, seg.index, stat);
  }
  mark('all_audio_sent');

  // --- run summary ---------------------------------------------------------
  const wall = (Date.now() - started) / 1000;
  const audioS = sentSamples / SR;
  const perGpu = {};
  for (const s of qualityStats) {
    const k = `gpu${s.gpu}`;
    perGpu[k] = perGpu[k] || { segments: 0, audio_s: 0, gen_s: 0, gain_db_sum: 0, first_chunk_ms_sum: 0 };
    perGpu[k].segments++;
    perGpu[k].audio_s += s.audio_s;
    perGpu[k].gen_s += s.gen_ms / 1000;
    perGpu[k].gain_db_sum += s.gain_db;
    perGpu[k].first_chunk_ms_sum += s.first_chunk_ms;
  }
  for (const v of Object.values(perGpu)) {
    v.audio_s = Number(v.audio_s.toFixed(2));
    v.gen_s = Number(v.gen_s.toFixed(3));
    v.rtf = Number((v.gen_s / Math.max(v.audio_s, 0.001)).toFixed(4));
    v.rtf_x = Number((v.audio_s / Math.max(v.gen_s, 0.001)).toFixed(3));
    v.gain_db_mean = Number((v.gain_db_sum / v.segments).toFixed(2));
    v.first_chunk_ms_mean = Math.round(v.first_chunk_ms_sum / v.segments);
    delete v.gain_db_sum; delete v.first_chunk_ms_sum;
  }
  const anomalies = [...new Set(qualityStats.flatMap((s) => s.anomalies))];
  const run = {
    request_mode: mode,
    content_source: mode === 'chat' ? 'llm_output' : 'user_text',
    source_build_id: runSourceBuild,
    source_build_attested: false,
    acoustic_text_verified: false,
    quality_verified: false,
    training_verified: false,
    simulated: true,
    session: sessionId,
    at: new Date().toISOString(),
    chars: segments.reduce((n, s) => n + [...s.text].length, 0),
    segments: segments.length,
    audio_s: Number(audioS.toFixed(2)),
    wall_s: Number(wall.toFixed(2)),
    overall_rtf_x: Number((audioS / Math.max(wall, 0.001)).toFixed(2)),
    quality_policy: policy,
    codec_policy: DSP.SENTENCE_CODEC.has(policy) ? 'sentence' : 'windowed',
    diagnostic_segments: qualityStats.slice(-32),
    diagnostic_segments_total: qualityStats.length,
    diagnostic_segments_truncated: qualityStats.length > 32,
    client: sessionClientReport(sessionId),
    llm_delta_count: llmDeltas,
    llm_error: false,
    error_count: 0,
    timeline_ms: timeline,
    per_gpu: perGpu,
    anomalies,
    errors: [],
    underruns: 0,
    client_first_played_ms: 0,
    profile: pid,
    language: lang,
    seed,
    voice_binding: voiceBinding,
    policy: policyFor(agg),
    generation_completed: !(opts.aborted && opts.aborted()),
    stream_interrupted: !!(opts.aborted && opts.aborted()),
  };
  send(FRAME.END, 0, run);
  if (opts.record !== false) store.recordRun(run);
  return {
    run,
    headers: { 'X-Session-Id': sessionId, 'Content-Type': 'application/octet-stream' },
    clientFrames, workerFrames,
    stats: qualityStats, segments, timeline,
  };
}

/* ----------------------------------------------------------- HTTP handler */
async function speak(req, res, body, helpers) {
  const text = String(body.text || '').trim();
  if (!text) return helpers.json(res, 400, { error: 'text is empty' });
  if (!DSP.POLICIES.includes(String(body.quality_policy || 'legacy-stream'))) {
    return helpers.json(res, 400, { error: 'unsupported quality policy or test seed' });
  }
  if (body.test_seed !== undefined && (!Number.isInteger(body.test_seed) || body.test_seed < 0 || body.test_seed > 2147483647)) {
    return helpers.json(res, 400, { error: 'unsupported quality policy or test seed' });
  }
  try { LIMITS.validateSpeak(body); }
  catch (e) { return helpers.json(res, e.status || 400, { error: e.message }); }
  const st = store.get();
  const pid = body.profile || store.readActive();
  if (!store.findProfile(pid) && !store.listProfilesFromDisk().find((p) => p.id === pid)) {
    return helpers.json(res, 400, { error: 'no voice profile selected: create one in the Voice Lab first' });
  }

  let aborted = false;
  req.on('close', () => { aborted = true; });
  const sessionId = store.hex(6);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Session-Id': sessionId,
    'Access-Control-Expose-Headers': 'X-Session-Id',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    await buildStream(body, (t, s, p) => writeFrame(res, t, s, p), {
      sessionId, aborted: () => aborted, keepFrames: false,
    });
  } catch (e) {
    if (!res.writableEnded) writeFrame(res, FRAME.ERROR, 0, { error: e.message, simulated: true });
  }
  res.end();
}

/** Capture a complete stream without an HTTP response (frame inspector / tests). */
async function captureStream(body) {
  const frames = [];
  const result = await buildStream(body, () => {}, { fast: true, record: false });
  return {
    frames: result.clientFrames.map((f) => ({
      type: f.type, name: f.name, seg: f.seg, length: f.length,
      payload: Buffer.isBuffer(f.payload) ? `PCM ${f.payload.length} bytes` : f.payload,
    })),
    workerFrames: result.workerFrames.map((f) => ({
      type: f.type, name: f.name, length: f.length,
      payload: Buffer.isBuffer(f.payload) ? `PCM ${f.payload.length} bytes` : f.payload,
    })),
    segments: result.segments, timeline: result.timeline, run: result.run,
  };
}

module.exports = {
  FRAME, WFRAME, FRAME_NAMES, WFRAME_NAMES, frame, workerFrame, writeFrame,
  buildStream, captureStream, speak, policyFor, detectLang, simulatedReply,
  registerSession, telemetry, mergeReport, sessionClientReport,
  activeSessions, activeSessionSnapshots, sessions,
};
