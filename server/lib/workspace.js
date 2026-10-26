'use strict';
/**
 * workspace.js — the single source of truth for "real files on disk".
 *
 * EVERY paste / edit / simulated artifact goes through here. Nothing is kept
 * only in the browser (no localStorage-only state), nothing is kept only in
 * some in-memory "Kaggle" object. Files land in:
 *
 *   <repo>/kaggle_workspace/
 *     notebooks/    *.ipynb  (real Jupyter/Kaggle notebooks)
 *                *.py     (plain-python export, round-trippable)
 *     input/        simulated /kaggle/input datasets (mount metadata)
 *     working/      simulated /kaggle/working outputs (logs, metrics, config)
 *     experiments/  one JSON record per simulated run
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const WS = path.join(ROOT, 'kaggle_workspace');
const DIRS = {
  root: WS,
  notebooks: path.join(WS, 'notebooks'),
  input: path.join(WS, 'input'),
  working: path.join(WS, 'working'),
  experiments: path.join(WS, 'experiments'),
  runs: path.join(WS, 'working', 'runs'),
  sandbox: path.join(WS, 'working', 'sandbox'),
};

function ensureDirs() {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirs();

function nowIso() {
  return new Date().toISOString();
}

function slugify(input, fallback = 'untitled') {
  const s = String(input || '')
    .trim()
    .replace(/\.(ipynb|py|txt|md)$/i, '')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

function randomId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Resolve a user-supplied relative path and GUARANTEE it stays inside WS. */
function safePath(rel, { mustExist = false } = {}) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('path is required');
  if (path.isAbsolute(rel)) throw new Error('absolute paths are not allowed');
  const candidate = path.resolve(WS, rel);
  if (candidate !== WS && !candidate.startsWith(WS + path.sep)) {
    throw new Error('path escapes the workspace');
  }
  if (mustExist && !fs.existsSync(candidate)) throw new Error('not found: ' + rel);
  return candidate;
}

/** Convert an absolute path inside WS back into a workspace-relative POSIX path. */
function relativeTo(abs) {
  return path.relative(WS, abs).split(path.sep).join('/');
}

function atomicWrite(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
  return abs;
}

function writeText(rel, content, encoding = 'utf8') {
  const abs = safePath(rel);
  atomicWrite(abs, Buffer.isBuffer(content) ? content : Buffer.from(String(content), encoding));
  return { path: relativeTo(abs), bytes: fs.statSync(abs).size, writtenAt: nowIso() };
}

/** Write a base64-encoded (binary-capable) file. */
function writeBase64(rel, base64) {
  const abs = safePath(rel);
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (buf.length > 3 * 1024 * 1024) throw new Error('file too large (max 3 MB per upload)');
  atomicWrite(abs, buf);
  return { path: relativeTo(abs), bytes: buf.length, writtenAt: nowIso() };
}

function readText(rel) {
  const abs = safePath(rel, { mustExist: true });
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > 8 * 1024 * 1024) throw new Error('file too large to preview (>8 MB)');
  return fs.readFileSync(abs, 'utf8');
}

function readJson(rel, fallback = null) {
  try {
    return JSON.parse(readText(rel));
  } catch (err) {
    if (fallback !== null && (err.code === 'ENOENT' || err.message.startsWith('not found'))) return fallback;
    throw err;
  }
}

function writeJson(rel, value) {
  return writeText(rel, JSON.stringify(value, null, 2) + '\n');
}

function remove(rel) {
  const abs = safePath(rel, { mustExist: true });
  if (abs === WS) throw new Error('cannot delete workspace root');
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
  else fs.unlinkSync(abs);
  return { path: relativeTo(abs), removed: true };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.cache']);

/** Recursive directory listing for the sidebar file trees. */
function listTree(relDir = '.', { depth = 4, maxEntries = 400, _level = 0 } = {}) {
  const abs = safePath(relDir, { mustExist: true });
  if (!fs.statSync(abs).isDirectory()) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp-')) continue;
    if (out.length >= maxEntries) break;
    const childAbs = path.join(abs, entry.name);
    const rel = relativeTo(childAbs);
    let stat;
    try { stat = fs.statSync(childAbs); } catch { continue; }
    const node = {
      name: entry.name,
      path: rel,
      type: entry.isDirectory() ? 'dir' : 'file',
      size: entry.isDirectory() ? 0 : stat.size,
      mtime: stat.mtime.toISOString(),
    };
    if (entry.isDirectory() && _level < depth - 1) {
      node.children = listTree(rel, { depth, maxEntries, _level: _level + 1 });
    }
    out.push(node);
  }
  return out;
}

function countFiles(node) {
  if (!node || node.type !== 'dir') return 0;
  return (node.children || []).reduce(
    (n, c) => n + (c.type === 'dir' ? countFiles(c) : 1), 0
  );
}

module.exports = {
  ROOT, WS, DIRS,
  ensureDirs, nowIso, slugify, randomId,
  safePath, relativeTo,
  atomicWrite, writeText, writeBase64, writeJson,
  readText, readJson, remove, listTree, countFiles,
};
