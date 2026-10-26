'use strict';
/**
 * limits.js — faithful port of go/gateway/security.go admission control.
 *   defaultLimits(): 1 MiB JSON, 128 MiB upload, 20000 text chars,
 *   32000 history chars, 2 speak / 2 heavy slots, 12 speaks/min, 1800 s timeout.
 */
const defaultLimits = () => ({
  JSONBytes: 1 << 20,
  UploadBytes: 128 << 20,
  TextChars: 20000,
  HistoryChars: 32000,
  SpeakConcurrent: 2,
  HeavyConcurrent: 2,
  SpeakPerMinute: 12,
  RequestSeconds: 1800,
});

/** go/gateway/security.go boundedEnv(): validated env overrides. */
function boundedEnv(name, fallback, min, max) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min},${max}]`);
  }
  return n;
}
function loadLimits() {
  const l = defaultLimits();
  for (const [name, field, min, max] of [
    ['QTTS_MAX_TEXT_CHARS', 'TextChars', 1, 200000],
    ['QTTS_MAX_HISTORY_CHARS', 'HistoryChars', 1, 200000],
    ['QTTS_MAX_SPEAK_CONCURRENT', 'SpeakConcurrent', 1, 8],
    ['QTTS_MAX_HEAVY_CONCURRENT', 'HeavyConcurrent', 1, 8],
    ['QTTS_SPEAK_PER_MINUTE', 'SpeakPerMinute', 1, 120],
    ['QTTS_REQUEST_TIMEOUT_S', 'RequestSeconds', 1, 7200],
    ['QTTS_MAX_JSON_BYTES', 'JSONBytes', 1024, 4 << 20],
    ['QTTS_MAX_UPLOAD_BYTES', 'UploadBytes', 1024, 512 << 20],
  ]) l[field] = boundedEnv(name, l[field], min, max);
  return l;
}

class TokenBucket {
  constructor(capacity, perSecond) {
    this.tokens = this.capacity = capacity;
    this.perSecond = perSecond;
    this.last = Date.now();
  }
  allow() {
    const now = Date.now();
    this.tokens += (now - this.last) / 1000 * this.perSecond;
    this.last = now;
    if (this.tokens > this.capacity) this.tokens = this.capacity;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

const L = loadLimits();
const buckets = {
  all: new TokenBucket(120, 20),
  failed: new TokenBucket(10, 1),
  speech: new TokenBucket(L.SpeakPerMinute, L.SpeakPerMinute / 60),
};
const slots = { speak: 0, heavy: 0 };
const librarySamplesUpload = /^\/api\/prep\/libraries\/[0-9a-f]{32}\/samples$/;

function err(status, message) { return Object.assign(new Error(message), { status }); }

function validateSpeak(req) {
  const text = String(req.text || '');
  if ([...text].length > L.TextChars) throw err(400, 'text exceeds configured character limit');
  const history = Array.isArray(req.history) ? req.history : [];
  const system = String(req.system || '');
  if (history.length > 16 || [...system].length > 4096) throw err(400, 'history/system budget exceeded');
  let total = 0;
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw err(400, 'history role must be user or assistant');
    total += [...String(m.content || '')].length;
  }
  if (total > L.HistoryChars) throw err(400, 'history character budget exceeded');
  return true;
}

function maxBodyFor(req, pathname) {
  if (pathname === '/api/prep/profiles' || pathname === '/api/prep/evaluate' ||
      (req.method === 'POST' && librarySamplesUpload.test(pathname))) return L.UploadBytes;
  return L.JSONBytes;
}

/** Mirrors Guard.middleware: rate budget, body limit, concurrency slots. */
function admit(req, pathname) {
  if (!buckets.all.allow()) throw err(429, 'request rate exceeded');
  const max = maxBodyFor(req, pathname);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > max) throw err(413, 'request body exceeds configured limit');
  req.maxBodyBytes = max;
  let slot = null;
  if (pathname === '/api/speak' && req.method === 'POST') {
    slot = 'speak';
  } else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
             (pathname.startsWith('/api/prep/') || pathname === '/api/profiles/activate')) {
    slot = 'heavy';
  }
  let release = () => {};
  if (slot) {
    const limit = slot === 'speak' ? L.SpeakConcurrent : L.HeavyConcurrent;
    if (slots[slot] >= limit) throw err(429, 'concurrent operation limit reached');
    slots[slot]++;
    release = () => { slots[slot] = Math.max(0, slots[slot] - 1); };
  }
  // Go checks speech.allow() AFTER acquiring the slot; release the slot on denial.
  if (pathname === '/api/speak' && req.method === 'POST' && !buckets.speech.allow()) {
    release();
    throw err(429, 'speech request budget exceeded');
  }
  return release;
}

function failedAllowed() { return buckets.failed.allow(); }
function snapshot() { return { limits: L, slots: { ...slots }, speechTokens: Number(buckets.speech.tokens.toFixed(2)) }; }

module.exports = { defaultLimits, loadLimits, boundedEnv, TokenBucket, validateSpeak, admit, failedAllowed, snapshot, maxBodyFor, L };
