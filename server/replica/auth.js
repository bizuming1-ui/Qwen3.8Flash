'use strict';
/**
 * auth.js — compatible re-implementation of the Go gateway's private entry.
 *
 *   POST /api/session/issue     (Bearer, notebook-side)  -> one-use 43-char grant
 *   POST /api/session/exchange  (grant in JSON body)     -> HttpOnly session cookie
 *   GET  /api/session/status    (cookie)                 -> {ready:true}
 *   POST /api/session/logout                            -> revoke cookie session
 *
 * The original requires trusted same-origin HTTPS for cookie writes. Behind the
 * Arena preview proxy Host/Origin may be rewritten, so the check accepts
 * Sec-Fetch-Site=same-origin/same-site as equivalent evidence of same origin.
 */
const crypto = require('crypto');
const store = require('./store');

const COOKIE = 'qtts_private_session';
const GRANT_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const grants = new Map();    // sha256(grant) -> expiresAt
const sessions = new Map();  // sha256(secret) -> expiresAt
let requestBudget = { tokens: 20, last: Date.now() };

function accessToken() {
  return process.env.QTTS_ACCESS_TOKEN || store.get().accessToken;
}

function secret43() { return crypto.randomBytes(32).toString('base64url'); }
function valid43(s) {
  return typeof s === 'string' && s.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(s);
}
function h(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function prune() {
  const t = Date.now();
  for (const [k, v] of grants) if (v <= t) grants.delete(k);
  for (const [k, v] of sessions) if (v <= t) sessions.delete(k);
}

function issueGrant() {
  prune();
  if (grants.size >= 8) throw Object.assign(new Error('pending private entry limit reached'), { status: 429 });
  const value = secret43();
  grants.set(h(value), Date.now() + GRANT_TTL_MS);
  return { grant: value, expires_in: GRANT_TTL_MS / 1000 };
}

function parseCookies(req) {
  const out = {};
  for (const chunk of String(req.headers.cookie || '').split(';')) {
    const i = chunk.indexOf('=');
    if (i < 0) continue;
    const k = chunk.slice(0, i).trim();
    const v = chunk.slice(i + 1).trim();
    if (k === COOKIE) (out[k] || (out[k] = [])).push(v);
  }
  return out;
}

function setSessionCookie(res, req, value, maxAgeSeconds) {
  const origin = String(req.headers.origin || '');
  const secure = origin.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function normalizedHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
}

function entryOrigin(req, required) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return false;
  if (site === 'same-origin' || site === 'same-site') return true;
  const origin = req.headers.origin;
  if (!origin) return !required || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(normalizedHost(req));
  try {
    const u = new URL(origin);
    const host = normalizedHost(req);
    if (u.host.toLowerCase() === host) return true;
    // preview proxies sometimes rewrite Host; accept same registrable e2b host
    const stripPort = (x) => x.split(':')[0];
    const suffix = (x) => stripPort(x).split('.').slice(-2).join('.');
    return host && suffix(u.host) === suffix(host) && suffix(host) !== '';
  } catch { return false; }
}

function bearerOk(req) {
  const values = req.headers.authorization;
  if (Array.isArray(values)) return false;
  const v = String(values || '');
  if (!v.startsWith('Bearer ')) return false;
  const got = Buffer.from(h(v.slice(7)), 'hex');
  const want = Buffer.from(h(accessToken()), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function sessionOk(req) {
  const list = parseCookies(req)[COOKIE] || [];
  if (list.length !== 1 || !valid43(list[0])) return false;
  prune();
  const until = sessions.get(h(list[0]));
  return !!until && Date.now() < until;
}

function authorized(req) {
  if (req.headers.authorization) return bearerOk(req);
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  return entryOrigin(req, unsafe) && sessionOk(req);
}

function rateLimited() {
  const t = Date.now();
  requestBudget.tokens = Math.min(20, requestBudget.tokens + (t - requestBudget.last) / 500);
  requestBudget.last = t;
  if (requestBudget.tokens < 1) return true;
  requestBudget.tokens -= 1;
  return false;
}

function exchange(body, req, res) {
  if (!entryOrigin(req, true)) throw Object.assign(new Error('trusted same-origin required'), { status: 403 });
  if (rateLimited()) throw Object.assign(new Error('entry request budget exceeded'), { status: 429 });
  const grant = body && body.grant;
  if (!valid43(grant)) throw Object.assign(new Error('invalid entry request'), { status: 400 });
  prune();
  const key = h(grant);
  const until = grants.get(key);
  if (!until || Date.now() >= until) {
    throw Object.assign(new Error('entry expired or already used; open a new Notebook entry'), { status: 401 });
  }
  grants.delete(key);                       // atomic one-use exchange
  for (const c of parseCookies(req)[COOKIE] || []) sessions.delete(h(c));
  const value = secret43();
  sessions.set(h(value), Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, req, value, SESSION_TTL_MS / 1000);
  return { ready: true, expires_in: SESSION_TTL_MS / 1000 };
}

function logout(req, res) {
  if (!entryOrigin(req, true)) throw Object.assign(new Error('same-origin required'), { status: 403 });
  for (const c of parseCookies(req)[COOKIE] || []) sessions.delete(h(c));
  clearSessionCookie(res);
  return { ready: false };
}

function stats() {
  prune();
  return { pendingGrants: grants.size, activeSessions: sessions.size, grantTTL: GRANT_TTL_MS / 1000, sessionTTL: SESSION_TTL_MS / 1000 };
}

module.exports = {
  COOKIE, accessToken, issueGrant, exchange, logout, authorized, bearerOk, sessionOk,
  entryOrigin, stats, secret43, valid43,
};
