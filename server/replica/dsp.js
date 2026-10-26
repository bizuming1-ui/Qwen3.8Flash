'use strict';
/**
 * dsp.js — faithful JS port of py/step18_audio_rt.py's two levelers, wired to
 * py/worker.py's five quality policies.
 *
 *   legacy-stream           rolling causal AGC + soft limiter (ceiling .99 / knee .10)
 *   sentence-linear         ONE constant gain per phrase, bounded by .95/peak
 *   sentence-agc            whole-sentence decode + original causal AGC
 *   sentence-agc-headroom   AGC + soft peak guard (ceiling .86 -> -1.31 dBFS, knee .02)
 *   windowed-linear         rolling windows, each with an independent constant gain
 *
 * The input waveform itself is still a SYNTHETIC tone (no model weights here),
 * but the gain/limiter math is the real algorithm from the Kaggle source.
 */
const SR = 24000;
const OUTPUT_TARGET_DBFS = -18.0;   // qtts_common.output_target_dbfs()
const OUTPUT_MAX_GAIN_DB = 6.0;     // worker.output_max_gain_db()
const AGC_HEADROOM_PEAK_CEILING = 0.86;
const AGC_HEADROOM_LIMITER_KNEE = 0.02;

const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const fromDb = (v) => Math.pow(10, v / 20);

function toFloat(int16Buf) {
  const n = Math.floor(int16Buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = int16Buf.readInt16LE(i * 2) / 32768;
  return out;
}
function toInt16(floatArr) {
  const out = Buffer.allocUnsafe(floatArr.length * 2);
  for (let i = 0; i < floatArr.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(floatArr[i] * 32767)));
    out.writeInt16LE(v, i * 2);
  }
  return out;
}
function rmsDbfs(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return db(Math.sqrt(s / Math.max(1, a.length)));
}
function peak(a) {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}

class Stats {
  constructor() { this.samples = 0; this.softLimitedSamples = 0; this.peakReductionDb = 0; }
}

/** Causal DC blocker -> gated RMS AGC -> segment fade -> soft limiter. */
class Leveler {
  constructor({ sr = SR, targetDbfs = -21.0, maxGainDb = 9.0, minGainDb = -9.0,
    peakCeiling = 0.99, limiterKnee = 0.10 } = {}) {
    this.sr = sr;
    this.target = fromDb(targetDbfs);
    this.max = fromDb(maxGainDb);
    this.min = fromDb(minGainDb);
    this.ceiling = peakCeiling;
    this.knee = limiterKnee;
    this.limiterStart = peakCeiling - limiterKnee;
    this.env = this.target;
    this.gain = this.want = 1.0;
    this.seen = 0;
    this.last = this.prevX = this.prevY = 0;
    this.fadeTotal = this.fadeLeft = 0;
    this.blkLen = Math.max(32, Math.floor(sr * 0.01 + 0.5));
    this.blkN = 0; this.blkSum = 0;
    this.dcR = 1 - 2 * Math.PI * 20 / sr;
    this.att = 1 - Math.exp(-1 / (sr * 0.030));
    this.rel = 1 - Math.exp(-1 / (sr * 0.600));
    this.gate = fromDb(-46.0);
    this.stats = new Stats();
    this.closed = false;
  }
  startSegment(fadeSamples) {
    this.fadeTotal = this.fadeLeft = fadeSamples == null ? Math.max(8, Math.floor(this.sr * 0.004)) : fadeSamples;
  }
  process(input) {
    const a = input instanceof Float32Array ? input : Float32Array.from(input);
    const out = new Float32Array(a.length);
    let { prevX: px, prevY: py, fadeTotal: total, fadeLeft: left, blkN: count,
      blkSum: power, env, gain, want, seen, last, stats } = this;
    const { dcR, blkLen: block, gate, att, rel, target, min: low, max: high,
      limiterStart, knee } = this;
    for (let i = 0; i < a.length; i++) {
      let value = a[i];
      if (!Number.isFinite(value)) value = 0;
      const y = value - px + dcR * py;
      px = value; py = y;
      power += y * y; count++;
      if (count === block) {
        const rms = Math.sqrt(power / count);
        count = 0; power = 0;
        if (rms > gate) {
          env += (rms - env) * (seen < 60 ? 0.08 : 0.012);
          seen++;
          want = Math.min(high, Math.max(low, target / Math.max(env, 1e-4)));
        }
      }
      gain += (want - gain) * (want < gain ? att : rel);
      let v = y * gain;
      if (left) { v *= 0.5 - 0.5 * Math.cos(Math.PI * (total - left) / total); left--; }
      const magnitude = Math.abs(v);
      if (magnitude > limiterStart) {
        stats.softLimitedSamples++;
        const limited = limiterStart + knee * Math.tanh((magnitude - limiterStart) / knee);
        stats.peakReductionDb = Math.max(stats.peakReductionDb, 20 * Math.log10(magnitude / Math.max(limited, 1e-12)));
        v = Math.sign(v) * limited;
      }
      out[i] = v;
      last = v;
    }
    Object.assign(this, { prevX: px, prevY: py, blkN: count, blkSum: power, env, gain, want, seen, last });
    this.fadeLeft = left;
    stats.samples += a.length;
    return out;
  }
  flush(n = 192) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.last * (0.5 + 0.5 * Math.cos(Math.PI * (i + 1) / n));
    this.last = this.prevX = this.prevY = 0;
    return out;
  }
  get gainDb() { return db(Math.max(this.gain, 1e-6)); }
  get envDbfs() { return db(Math.max(this.env, 1e-6)); }
  get ceilingDbfs() { return db(this.ceiling); }
}

/** One constant gain per complete trimmed phrase, bounded by peak. Single use. */
class SentenceLinearLeveler {
  constructor({ sr = SR, targetDbfs = OUTPUT_TARGET_DBFS, maxGainDb = OUTPUT_MAX_GAIN_DB } = {}) {
    this.sr = sr; this.targetDbfs = targetDbfs; this.maxGainDb = maxGainDb;
    this.gainDbValue = 0; this.envDbfsValue = -120;
    this.peakLimited = false; this.processed = false;
    this.stats = new Stats();
  }
  startSegment() {}
  process(input) {
    if (this.processed) throw new Error('sentence linear leveler is single use');
    const x = input instanceof Float32Array ? input : Float32Array.from(input);
    if (x.length > 384 * 1920) throw new Error('invalid or over-budget quality sentence');
    this.processed = true;
    if (!x.length) return new Float32Array(0);
    this.envDbfsValue = rmsDbfs(x);
    const pk = peak(x);
    if (pk <= 1e-12) { this.stats.samples = x.length; return new Float32Array(x.length); }
    const desiredDb = Math.min(this.maxGainDb, Math.max(-9.0, this.targetDbfs - this.envDbfsValue));
    const desired = fromDb(desiredDb);
    const gain = Math.min(desired, 0.95 / pk);
    this.peakLimited = gain < desired;
    this.gainDbValue = db(Math.max(gain, 1e-12));
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] * gain;
    const head = Math.min(Math.floor(y.length / 2), Math.max(1, Math.floor(this.sr * 0.004)));
    const tail = Math.min(Math.floor(y.length / 2), Math.max(1, Math.floor(this.sr * 0.008)));
    for (let i = 0; i < head; i++) y[i] *= i / Math.max(1, head - 1);
    for (let i = 0; i < tail; i++) y[y.length - 1 - i] *= i / Math.max(1, tail - 1);
    this.stats.samples = y.length;
    return y;
  }
  flush() { return new Float32Array(0); }
  get gainDb() { return this.gainDbValue; }
  get envDbfs() { return this.envDbfsValue; }
}

const POLICIES = ['legacy-stream', 'sentence-linear', 'sentence-agc', 'sentence-agc-headroom', 'windowed-linear'];
const QUALITY_LINEAR = new Set(['sentence-linear', 'windowed-linear']);
const SENTENCE_CODEC = new Set(['sentence-linear', 'sentence-agc', 'sentence-agc-headroom']);

/**
 * Apply a worker.py quality policy to int16 PCM. Returns processed PCM + the
 * exact worker-side stats fields the original emits in its fStats frame.
 */
function applyPolicy(pcmInt16, policy = 'legacy-stream', opts = {}) {
  if (!POLICIES.includes(policy)) throw Object.assign(new Error('unsupported quality policy'), { status: 400 });
  const x = toFloat(pcmInt16);
  const seed = opts.seed ?? 42;
  const expectedS = opts.expectedS ?? Number((x.length / SR).toFixed(2));
  const t0 = performance.now();
  let out;
  let leveler;
  let chunks = 1, chunkSize = 8, extra = {};
  const linear = QUALITY_LINEAR.has(policy);
  const sentence = SENTENCE_CODEC.has(policy);

  if (policy === 'sentence-linear') {
    leveler = new SentenceLinearLeveler();
    leveler.startSegment();
    out = leveler.process(x);
    extra = { linear_peak_limited: leveler.peakLimited, soft_limiter_ceiling_dbfs: null };
    chunks = 1;
  } else if (policy === 'windowed-linear') {
    const win = 1920;
    chunks = Math.max(1, Math.ceil(x.length / win));
    const parts = [];
    let sumGain = 0;
    for (let i = 0; i < x.length; i += win) {
      const lv = new SentenceLinearLeveler();
      lv.startSegment();
      parts.push(lv.process(x.subarray(i, Math.min(i + win, x.length))));
      sumGain += lv.gainDb;
    }
    out = Float32Array.from({ length: x.length }, (_, i) => parts[Math.floor(i / win)][i % win] || 0);
    leveler = { gainDb: sumGain / chunks, envDbfs: rmsDbfs(out), stats: new Stats(), ceiling: null };
    extra = { linear_peak_limited: false, soft_limiter_ceiling_dbfs: null };
    chunkSize = 8;
  } else {
    const headroom = policy === 'sentence-agc-headroom';
    leveler = new Leveler(headroom
      ? { peakCeiling: AGC_HEADROOM_PEAK_CEILING, limiterKnee: AGC_HEADROOM_LIMITER_KNEE }
      : {});
    leveler.startSegment();
    if (sentence) {
      out = leveler.process(x);                    // one complete sentence
      chunks = 1;
    } else {
      const win = 1920;                           // rolling causal windows
      chunks = Math.max(1, Math.ceil(x.length / win));
      const parts = [];
      for (let i = 0; i < x.length; i += win) parts.push(leveler.process(x.subarray(i, Math.min(i + win, x.length))));
      out = Float32Array.from({ length: x.length }, (_, i) => parts[Math.floor(i / win)][i % win] || 0);
    }
    extra = {
      linear_peak_limited: false,
      soft_limiter_ceiling_dbfs: Number(leveler.ceilingDbfs.toFixed(2)),
      soft_limited_samples: leveler.stats.softLimitedSamples,
      soft_limited_fraction: Number((leveler.stats.softLimitedSamples / Math.max(1, leveler.stats.samples)).toFixed(6)),
      soft_limiter_peak_reduction_db: Number(leveler.stats.peakReductionDb.toFixed(3)),
    };
  }
  const buf = toInt16(out);
  const audioS = Number((buf.length / 2 / SR).toFixed(3));
  const genMs = opts.genMs ?? Math.max(12, Math.round(expectedS * 180));
  const dspMs = Number((performance.now() - t0).toFixed(3));
  const stats = {
    quality_policy: policy,
    codec_policy: sentence ? 'sentence' : 'windowed',
    rt: linear ? 'numpy-sentence-linear-v1' : 'numpy-causal-v1',
    model_output_mode: (linear || sentence) ? 'sentence-buffered' : undefined,
    gain_db: Number(Number(leveler.gainDb).toFixed(2)),
    env_dbfs: Number(Number(leveler.envDbfs).toFixed(2)),
    output_target_dbfs: OUTPUT_TARGET_DBFS,
    max_gain_db: OUTPUT_MAX_GAIN_DB,
    peak_dbfs: Number(db(peak(out)).toFixed(2)),
    rms_dbfs: Number(rmsDbfs(out).toFixed(2)),
    dsp_ms: dspMs,
    chunks, chunk_size: chunkSize,
    speech_samples: buf.length / 2,
    audio_s: audioS,
    gen_ms: genMs,
    expected_s: expectedS,
    rtf_x: Number((audioS / Math.max(genMs / 1000, 1e-3)).toFixed(3)),
    rtf: audioS > 0 ? Number((genMs / 1000 / audioS).toFixed(4)) : null,
    first_chunk_ms: opts.firstChunkMs ?? 118,
    seed,
    acoustic_text_verified: false,
    quality_verified: false,
    rtf_target: 0.3,
    voice_conditioning: 'speaker-vector-only',
    reference_pcm_splicing: false,
    extra_breath_mode: 'disabled-no-reference-playback',
    extra_breath_requested: !!opts.breath,
    extra_breath_available: false,
    simulated: true,
    ...extra,
  };
  return { pcm: buf, stats };
}

module.exports = {
  applyPolicy, Leveler, SentenceLinearLeveler, toFloat, toInt16, rmsDbfs, peak,
  POLICIES, QUALITY_LINEAR, SENTENCE_CODEC,
  OUTPUT_TARGET_DBFS, OUTPUT_MAX_GAIN_DB, AGC_HEADROOM_PEAK_CEILING, AGC_HEADROOM_LIMITER_KNEE,
};
