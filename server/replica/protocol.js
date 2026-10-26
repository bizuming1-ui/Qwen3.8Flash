'use strict';
/**
 * protocol.js — binary streaming protocol of the real Go gateway, re-implemented.
 *
 * Frame layout (identical to go/gateway/session.go writeFrame):
 *   byte 0      : type (1 PCM, 2 SEG, 3 TEXT, 4 STATS, 5 END, 6 ERROR, 7 POLICY)
 *   bytes 1..4  : uint32 LE segment index
 *   bytes 5..8  : uint32 LE payload length
 *   bytes 9..   : payload (PCM = int16 LE 24 kHz mono; others = UTF-8 JSON)
 *
 * The audio is a deterministic SYNTHETIC tone, not a cloned human voice:
 * this sandbox has no model weights / GPU / DeepSeek key. Every receipt says so.
 */
const store = require('./store');

const FRAME = { PCM: 1, SEG: 2, TEXT: 3, STATS: 4, END: 5, ERROR: 6, POLICY: 7 };
const SR = store.SAMPLE_RATE;

function frame(type, seg, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.allocUnsafe(9);
  head[0] = type;
  head.writeUInt32LE(seg >>> 0, 1);
  head.writeUInt32LE(body.length, 5);
  return Buffer.concat([head, body]);
}

function writeFrame(res, type, seg, payload) {
  if (res.writableEnded || res.destroyed) return false;
  return res.write(frame(type, seg, payload));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectLang(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  if (kana > 0 && kana >= cjk * 0.2) return 'Japanese';
  if (hangul > cjk && hangul > 0) return 'Korean';
  if (cjk > 0 && cjk >= latin * 0.35) return 'Chinese';
  return 'English';
}

/** Split text into the SEG frames the diagnostics table expects. */
function segmentText(text, pauseSentenceMs = 320) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const clauses = clean.split(/(?<=[。！？!?；;，,、\n])/u).filter((s) => s.trim());
  const segments = [];
  let buffer = '';
  const maxLen = 36;
  for (const clause of clauses) {
    if (buffer && (buffer + clause).length > maxLen) {
      segments.push(buffer.trim());
      buffer = '';
    }
    buffer += clause;
    if (buffer.length >= maxLen) { segments.push(buffer.trim()); buffer = ''; }
  }
  if (buffer.trim()) segments.push(buffer.trim());
  return segments.slice(0, 24).map((s, i) => ({
    index: i, text: s,
    pause_ms: i === 0 ? 0 : (/[。！？!?\n]$/.test(s) ? pauseSentenceMs : 180),
    breath: false,
  }));
}

function simulatedReply(text, language, history) {
  const lang = language && language !== 'auto' ? language : detectLang(text);
  const prefix = '[本地模拟回复｜复刻环境没有 DeepSeek/模型权重，以下为确定性演示文本] ';
  const tail = lang === 'English'
    ? `You said: "${text.slice(0, 90)}". This is a local simulation of the QTTS gateway.`
    : `你刚才说的是：「${text.slice(0, 90)}」。这里是 QTTS 网关的本地复刻，返回的文本与音频均为模拟数据，不代表真实模型输出。`;
  const context = Array.isArray(history) && history.length ? `（上下文 ${history.length} 条）` : '';
  return prefix + context + tail;
}

const sessions = new Map();  // session id -> { telemetry:[], reports:[], startedAt }

function registerSession(id, meta) {
  sessions.set(id, { telemetry: [], reports: [], startedAt: Date.now(), meta });
  if (sessions.size > 50) sessions.delete(sessions.keys().next().value);
}
function telemetry(id, patch) {
  const s = sessions.get(id);
  if (!s) return false;
  s.telemetry.push({ at: Date.now(), ...patch });
  if (s.telemetry.length > 200) s.telemetry.shift();
  return true;
}
function mergeReport(id, patch) {
  const s = sessions.get(id);
  if (!s) return false;
  const seq = Number(patch && patch.report_sequence) || 0;
  const last = s.reports.length ? Number(s.reports[s.reports.length - 1].report_sequence) || 0 : -1;
  if (seq >= last) s.reports.push({ ...patch, receivedAt: Date.now() });
  return true;
}
function sessionClientReport(id) {
  const s = sessions.get(id);
  if (!s || !s.reports.length) return null;
  return s.reports[s.reports.length - 1];
}
function activeSessions() { return sessions.size; }

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

const VALID_POLICIES = new Set([
  'legacy-stream', 'sentence-linear', 'sentence-agc',
  'sentence-agc-headroom', 'windowed-linear', '',
]);

async function speak(req, res, body, helpers) {
  const text = String(body.text || '').trim();
  const mode = body.mode === 'read' ? 'read' : 'chat';
  if (!text) return helpers.json(res, 400, { error: 'text is empty' });
  if (!VALID_POLICIES.has(String(body.quality_policy || ''))) {
    return helpers.json(res, 400, { error: 'unsupported quality policy or test seed' });
  }
  if (body.test_seed !== undefined && (!Number.isInteger(body.test_seed) || body.test_seed < 0 || body.test_seed > 2147483647)) {
    return helpers.json(res, 400, { error: 'unsupported quality policy or test seed' });
  }
  const st = store.get();
  const pid = body.profile || st.activeProfile;
  const profile = store.findProfile(pid);
  if (!profile) return helpers.json(res, 400, { error: 'no voice profile selected: create one in the Voice Lab first' });

  const sessionId = store.hex(6);  // 12 hex chars, matches QttsTrace.headers()
  const started = Date.now();
  const t0 = performance.now();
  registerSession(sessionId, { mode, profile: pid, quality_policy: body.quality_policy || 'legacy-stream' });

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Session-Id': sessionId,
    'Access-Control-Expose-Headers': 'X-Session-Id',
    'X-Content-Type-Options': 'nosniff',
  });

  let aborted = false;
  req.on('close', () => { aborted = true; });
  const mark = (name) => timeline[name] = Math.round(performance.now() - t0);
  const timeline = { request: 0 };
  const agg = 2.4;
  writeFrame(res, FRAME.POLICY, 0, policyFor(agg));

  // --- LLM text stream -----------------------------------------------------
  const spoken = mode === 'chat' ? simulatedReply(text, body.language, body.history) : text;
  const deltas = spoken.match(/[\s\S]{1,14}/g) || [spoken];
  for (const d of deltas.slice(0, 40)) {
    if (aborted) break;
    writeFrame(res, FRAME.TEXT, 0, { t: d });
    await sleep(18);
  }
  mark('llm_done');

  // --- audio segments ------------------------------------------------------
  const segments = segmentText(spoken, profile.pause_sentence_ms || 320);
  const seedBase = `${text}|${pid}|${body.test_seed ?? ''}|${body.quality_policy || ''}`;
  let sentSamples = 0;
  const segStats = [];
  let firstAudioAt = null;
  const maxSamples = SR * 30; // 30 s ceiling, matches the site's documented limit

  for (const seg of segments) {
    if (aborted) break;
    writeFrame(res, FRAME.SEG, seg.index, seg);
    const seconds = Math.min(2.6, Math.max(0.42, seg.text.length * 0.075));
    const pcm = store.synthPcm(`${seedBase}|${seg.index}`, seconds, { amplitude: 0.16 });
    const chunkSamples = Math.floor(SR * 0.12);
    const chunkBytes = chunkSamples * 2;
    let offset = 0;
    while (offset < pcm.length && !aborted && sentSamples < maxSamples) {
      const part = pcm.subarray(offset, offset + chunkBytes);
      offset += chunkBytes;
      if (!firstAudioAt) { firstAudioAt = performance.now() - t0; mark('first_audio_sent'); }
      writeFrame(res, FRAME.PCM, seg.index, part);
      sentSamples += part.length / 2;
      await sleep(28);
    }
    const audioS = Number(((sentSamples / SR)).toFixed(3));
    const stats = {
      gpu: seg.index % 2,
      rtf: 0.18, rtf_x: 5.55,
      first_chunk_ms: Math.round(firstAudioAt || 0),
      audio_s: Number(seconds.toFixed(3)),
      gen_ms: Math.round(seconds * 180),
      gain_db: -1.31,
      anomalies: ['simulated_tone_not_human_voice'],
      simulated: true,
    };
    segStats.push(stats);
    writeFrame(res, FRAME.STATS, seg.index, stats);
  }
  mark('all_audio_sent');

  const wall = (Date.now() - started) / 1000;
  const audioS = sentSamples / SR;
  const perGpu = {};
  for (const s of segStats) {
    const k = `gpu${s.gpu}`;
    perGpu[k] = perGpu[k] || { segments: 0, audio_s: 0, gen_s: 0, gain_db_mean: -1.31, first_chunk_ms_mean: s.first_chunk_ms };
    perGpu[k].segments += 1;
    perGpu[k].audio_s += s.audio_s;
    perGpu[k].gen_s += s.gen_ms / 1000;
  }
  for (const v of Object.values(perGpu)) {
    v.audio_s = Number(v.audio_s.toFixed(2));
    v.gen_s = Number(v.gen_s.toFixed(3));
    v.rtf = Number((v.gen_s / Math.max(v.audio_s, 0.001)).toFixed(4));
    v.rtf_x = Number((v.audio_s / Math.max(v.gen_s, 0.001)).toFixed(3));
  }
  const run = {
    request_mode: mode,
    content_source: mode === 'chat' ? 'simulated_llm_reply' : 'user_text',
    source_build_id: 'qvoice-replica-node',
    source_build_attested: false,
    acoustic_text_verified: false,
    quality_verified: false,
    training_verified: false,
    simulated: true,
    session: sessionId,
    at: new Date().toISOString(),
    chars: spoken.length,
    segments: segments.length,
    audio_s: Number(audioS.toFixed(2)),
    wall_s: Number(wall.toFixed(2)),
    overall_rtf_x: Number((audioS / Math.max(wall, 0.001)).toFixed(2)),
    diagnostic_segments: segStats.slice(-32),
    diagnostic_segments_total: segStats.length,
    diagnostic_segments_truncated: segStats.length > 32,
    client: sessionClientReport(sessionId),
    llm_delta_count: deltas.length,
    llm_error: false,
    error_count: 0,
    timeline_ms: timeline,
    per_gpu: perGpu,
    anomalies: ['simulated_tone_not_human_voice'],
    errors: [],
    underruns: 0,
    client_first_played_ms: 0,
    profile: pid,
    policy: policyFor(agg),
    generation_completed: !aborted,
    stream_interrupted: aborted,
  };
  writeFrame(res, FRAME.END, 0, run);
  store.recordRun(run);
  res.end();
}

module.exports = {
  FRAME, frame, writeFrame, speak, policyFor, detectLang, segmentText, simulatedReply,
  registerSession, telemetry, mergeReport, sessionClientReport, activeSessions, sessions,
};
