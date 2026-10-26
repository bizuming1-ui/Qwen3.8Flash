'use strict';
/**
 * segmenter.js — faithful JS port of go/gateway/segmenter.go.
 *
 * Turns text (or a stream of LLM deltas) into "breath groups" cut at natural
 * clause/sentence boundaries. The first segment is short for fast first audio.
 * Every non-first segment carries the pause a human would leave before it.
 *
 * Ported constants: FirstMin 7 / FirstMax 20 / Min 12 / Target 26 / Max 64,
 * PauseClause 150 / PauseSent 340 / PausePara 560 / PauseEllipsis 460 ms,
 * CJK char = 1 unit, latin word = 1.6 units, ±12% pause irregularity.
 */
const B_NONE = 0, B_CLAUSE = 1, B_SENTENCE = 2, B_PARA = 3, B_ELLIPSIS = 4;
const BOUNDARY_NAMES = ['none', 'clause', 'sentence', 'para', 'ellipsis'];
const K_NONE = 0, K_CLAUSE = 1, K_SENTENCE = 2, K_PARA = 3;

const RE_CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
const RE_WORD = /[\p{L}\p{N}']/u;
const RE_URL = /https?:\/\/\S+/g;
const RE_MD = /[*#`_>|~]+/g;
const RE_SPACES = /[ \t\u3000]+/g;
const RE_UNITS_CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
const RE_UNITS_WORD = /[A-Za-z0-9']+/g;

const isCJK = (r) => RE_CJK.test(r);
const isWordRune = (r) => RE_WORD.test(r);
const isEmoji = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x1F000 && c <= 0x1FAFF) || (c >= 0x2600 && c <= 0x27BF) || c === 0xFE0F || c === 0x200D;
};
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isClosers = (r) => "\"'”’」』）)】]>》".includes(r);
const isPunct = (r) => '。！？!?…；;，,、：:—.'.includes(r);

function cleanDelta(s) {
  s = String(s).replace(RE_URL, '').replace(RE_MD, '');
  let out = '';
  for (const r of s) if (!isEmoji(r)) out += r;
  return out;
}
/** CJK char = 1, latin word = 1.6 (matches qtts_common.count_text_units). */
function units(s) {
  const cjk = (String(s).match(RE_UNITS_CJK) || []).length;
  const words = (String(s).match(RE_UNITS_WORD) || []).length;
  return cjk + 1.6 * words;
}

function defaultSegCfg(profile) {
  const c = {
    ImmediateFirst: false, PreserveText: false,
    FirstMin: 7, FirstMax: 20, Min: 12, Target: 26, Max: 64,
    PauseClause: 150, PauseSent: 340, PausePara: 560, PauseEllipsis: 460,
  };
  if (profile) {
    if (profile.pause_clause_ms > 0) c.PauseClause = clampInt(profile.pause_clause_ms, 60, 400);
    if (profile.pause_sentence_ms > 0) c.PauseSent = clampInt(profile.pause_sentence_ms, 160, 800);
    if (profile.pause_para_ms > 0) c.PausePara = clampInt(profile.pause_para_ms, 260, 1200);
    c.PauseEllipsis = clampInt(Math.floor(c.PauseSent * 1.35), 260, 900);
  }
  return c;
}
/** read mode preserves source and groups longer clauses. */
function readSegCfg(profile) {
  const c = defaultSegCfg(profile);
  c.PreserveText = true; c.FirstMin = 12; c.FirstMax = 24; c.Min = 20; c.Target = 40; c.Max = 80;
  return c;
}
/** chat mode preserves source and submits the first complete prefix immediately. */
function liveSegCfg(profile) {
  const c = defaultSegCfg(profile);
  c.PreserveText = true; c.ImmediateFirst = true;
  return c;
}

function openFirstDelimiter(buf) {
  const stack = [];
  const pairs = { '“': '”', '「': '」', '『': '』', '（': '）', '(': ')', '【': '】', '《': '》' };
  let quoted = false;
  for (const r of buf) {
    if (r === '"') { quoted = !quoted; continue; }
    if (pairs[r]) stack.push(pairs[r]);
    else if (stack.length && r === stack[stack.length - 1]) stack.pop();
  }
  return quoted || stack.length > 0;
}

function classify(buf, i, final) {
  const r = buf[i];
  switch (r) {
    case '。': case '！': case '？': case '!': case '?': case '…': return K_SENTENCE;
    case '\n': return K_PARA;
    case '；': case ';': case '，': case ',': case '、': case '：': case ':': case '—': return K_CLAUSE;
    case '.': {
      if (i + 1 < buf.length) {
        const n = buf[i + 1];
        if (i > 0 && /\d/u.test(buf[i - 1]) && /\d/u.test(n)) return K_NONE;
        if (/\s/u.test(n) || isCJK(n) || n === '.' || isClosers(n)) return K_SENTENCE;
        return K_NONE;
      }
      return final ? K_SENTENCE : K_SENTENCE;
    }
    default: return K_NONE;
  }
}

/** Small deterministic PRNG (Go uses math/rand; both are seeded & reproducible). */
function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

class Segmenter {
  constructor(cfg, seed) {
    this.cfg = cfg;
    this.buf = [];
    this.idx = 0;
    this.lastB = B_NONE;
    this.sinceBreath = 0;
    this.rand = rng(seed);
  }
  limits() {
    if (this.idx === 0) return [this.cfg.FirstMin, this.cfg.FirstMin, this.cfg.FirstMax];
    return [this.cfg.Min, this.cfg.Target, this.cfg.Max];
  }
  cut(final) {
    const [min, target, max] = this.limits();
    const buf = this.buf;
    let u = 0, inWord = false;
    let lastClause = -1, lastClauseUnits = 0;
    for (let i = 0; i < buf.length; i++) {
      const r = buf[i];
      if (isCJK(r)) { u++; inWord = false; }
      else if (isWordRune(r)) { if (!inWord) u += 1.6; inWord = true; }
      else inWord = false;
      const k = classify(buf, i, final);
      if (k === K_NONE) {
        if (u >= max) {
          if (lastClause >= 0 && lastClauseUnits >= min) return [lastClause, B_CLAUSE, true];
          if (/\s/u.test(r) || isCJK(r)) return [i + 1, B_NONE, true];
        }
        continue;
      }
      let j = i + 1;
      let ell = r === '…', dots = r === '.' ? 1 : 0;
      while (j < buf.length && (isPunct(buf[j]) || isClosers(buf[j]) || (buf[j] === '\n' && k === K_PARA))) {
        if (buf[j] === '…') ell = true;
        if (buf[j] === '.') dots++;
        j++;
      }
      if (dots >= 3) ell = true;
      const immediate = () => {
        if (!this.cfg.ImmediateFirst || this.idx !== 0 || r === '.' || openFirstDelimiter(buf.slice(0, j))) return null;
        if ((k === K_SENTENCE || k === K_PARA) && u >= 1) {
          return [j, k === K_PARA ? B_PARA : (ell ? B_ELLIPSIS : B_SENTENCE), true];
        }
        if (k === K_CLAUSE && u >= min) return [j, B_CLAUSE, true];
        return null;
      };
      if (j >= buf.length && !final) return immediate() || [0, B_NONE, false];
      while (j < buf.length && (buf[j] === ' ' || buf[j] === '\t')) j++;
      if (j >= buf.length && !final) return immediate() || [0, B_NONE, false];
      let kk = k;
      if (kk === K_SENTENCE && j > 0 && buf[j - 1] === '\n') kk = K_PARA;
      if (kk === K_SENTENCE || kk === K_PARA) {
        const bd = kk === K_PARA ? B_PARA : (ell ? B_ELLIPSIS : B_SENTENCE);
        if (u >= min || (this.cfg.ImmediateFirst && this.idx === 0 && u >= 1) ||
            (kk === K_PARA && u >= 3) || (final && j >= buf.length)) return [j, bd, true];
        lastClause = j; lastClauseUnits = u;
      } else if (k === K_CLAUSE) {
        if (u >= target) return [j, B_CLAUSE, true];
        lastClause = j; lastClauseUnits = u;
      }
      i = j - 1;
    }
    return [0, B_NONE, false];
  }
  pauseFor(b) {
    const base = b === B_CLAUSE ? this.cfg.PauseClause
      : b === B_SENTENCE ? this.cfg.PauseSent
      : b === B_PARA ? this.cfg.PausePara
      : b === B_ELLIPSIS ? this.cfg.PauseEllipsis : 60;
    return Math.floor(base * (0.88 + 0.24 * this.rand()));
  }
  finish(raw, b) {
    let txt = raw.join('');
    if (!this.cfg.PreserveText) txt = txt.trim().replace(RE_SPACES, ' ');
    let hasWord = false;
    for (const r of txt) if (isWordRune(r) || isCJK(r)) { hasWord = true; break; }
    if (!hasWord) {
      if (b > this.lastB) this.lastB = b;
      return null;
    }
    const rs = [...txt];
    const last = rs[rs.length - 1];
    if (!this.cfg.PreserveText && !isPunct(last) && !isClosers(last)) {
      txt += rs.some(isCJK) ? '。' : '.';
    }
    const u = units(txt);
    const seg = { index: this.idx, text: txt, units: Number(u.toFixed(2)), pause_ms: 0, breath: false, boundary: 'none' };
    if (this.idx > 0) {
      seg.pause_ms = this.pauseFor(this.lastB);
      seg.boundary = BOUNDARY_NAMES[this.lastB];
      switch (this.lastB) {
        case B_PARA: seg.breath = true; break;
        case B_SENTENCE: case B_ELLIPSIS:
          seg.breath = this.sinceBreath >= 16 || this.rand() < 0.35; break;
        case B_CLAUSE:
          seg.breath = this.sinceBreath >= 34 && seg.pause_ms >= 200;
          if (seg.breath) seg.pause_ms = clampInt(seg.pause_ms + 120, 200, 600);
          break;
      }
      if (seg.breath && seg.pause_ms < 280) seg.pause_ms = 280;
    }
    if (seg.breath) this.sinceBreath = 0;
    this.sinceBreath += u;
    this.lastB = b;
    this.idx++;
    return seg;
  }
  drain(final) {
    const out = [];
    for (;;) {
      if (!this.buf.length) return out;
      const [end, b, ok] = this.cut(final);
      if (!ok) {
        if (final) {
          const seg = this.finish(this.buf, B_NONE);
          if (seg) out.push(seg);
          this.buf = [];
        }
        return out;
      }
      const raw = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      const seg = this.finish(raw, b);
      if (seg) out.push(seg);
    }
  }
  feed(delta) {
    const d = this.cfg.PreserveText ? String(delta) : cleanDelta(delta);
    this.buf.push(...d);
    return this.drain(false);
  }
  flush() { return this.drain(true); }
}

function segmentAll(text, { mode = 'read', profile = null, seed = 42 } = {}) {
  const cfg = mode === 'read' ? readSegCfg(profile) : liveSegCfg(profile);
  const s = new Segmenter(cfg, seed);
  const out = [];
  // Feed in small deltas like a real LLM stream, so ImmediateFirst behaves identically.
  const chunks = String(text).match(/[\s\S]{1,12}/g) || [];
  for (const c of chunks) out.push(...s.feed(c));
  out.push(...s.flush());
  return out;
}

module.exports = {
  Segmenter, segmentAll, units, cleanDelta, defaultSegCfg, readSegCfg, liveSegCfg,
  B_NONE, B_CLAUSE, B_SENTENCE, B_PARA, B_ELLIPSIS, BOUNDARY_NAMES,
};
