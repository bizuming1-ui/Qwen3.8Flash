'use strict';
/**
 * Kaggle Voice Lab — local web server.
 *
 *   Browser  <--HTTP/JSON + SSE-->  this server  -->  REAL files in the repo
 *                                                 -->  REAL git commit / push
 *
 * No runtime npm dependencies, no CDN, no localStorage-only state.
 * Run:  npm start    (listens on 0.0.0.0:$PORT, default 3000)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const W = require('./lib/workspace');
const NB = require('./lib/notebook');
const GIT = require('./lib/git');
const SIM = require('./lib/simulator');
const DS = require('./lib/datasets');
const { VOICE_CLONE_CELLS, DATASET_CATALOG, KAGGLE_ENV } = require('./lib/templates');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const STARTED_AT = W.nowIso();
const MAX_BODY = 12 * 1024 * 1024; // 12 MB — enough for a very large notebook paste

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ utils */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: String(message), ...extra });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`请求体过大（上限 ${Math.round(MAX_BODY / 1024 / 1024)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (e) { throw new Error('请求体不是合法 JSON: ' + e.message); }
}

function ok(res, data, status = 200) { sendJson(res, status, { ok: true, ...data }); }

const recentWrites = [];
function noteWrite(entry) {
  recentWrites.unshift({ ...entry, at: W.nowIso() });
  if (recentWrites.length > 60) recentWrites.length = 60;
}

function getSettings() {
  return W.readJson('settings.json', {
    activeNotebookId: null,
    autosaveMs: 1200,
    simulationSpeed: 1,
    autoCommitOnImport: false,
    autoSyncOnImport: false,
  });
}
function putSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch, updatedAt: W.nowIso() };
  W.writeJson('settings.json', next);
  noteWrite({ path: 'settings.json', action: 'update' });
  return next;
}

function realEnvironment() {
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 5000 });
  return {
    node: process.version,
    python: (py.stdout || py.stderr || 'unknown').trim(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    memoryGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    realGpu: false,
  };
}

function bootstrap() {
  const notebooks = NB.listNotebooks();
  const settings = getSettings();
  let g;
  try { g = GIT.status(); } catch (e) { g = { ok: false, error: e.message, files: [], branch: '?' }; }
  return {
    app: {
      name: 'Kaggle Voice Lab',
      version: '1.0.0',
      startedAt: STARTED_AT,
      repoRoot: W.ROOT,
      workspace: 'kaggle_workspace/',
      simulated: true,
    },
    notebooks,
    settings: { ...settings, activeNotebookId: settings.activeNotebookId || (notebooks[0] && notebooks[0].id) || null },
    tree: {
      notebooks: W.listTree('notebooks'),
      input: W.listTree('input'),
      working: W.listTree('working'),
      experiments: W.listTree('experiments'),
    },
    datasets: { catalog: DATASET_CATALOG, mounted: DS.listMounted() },
    environment: { ...KAGGLE_ENV, real: realEnvironment() },
    experiments: SIM.listExperiments(20),
    git: g,
    recentCommits: GIT.log(8),
    recentWrites: recentWrites.slice(0, 30),
    localPythonEnabled: process.env.ENABLE_LOCAL_PYTHON === '1',
  };
}

/** Ensure a template notebook exists on first boot (real seeded files). */
function ensureSeed() {
  if (NB.listNotebooks().length === 0) {
    const nb = NB.createNotebook({ name: '语音克隆实验 · Kaggle 模板', cells: VOICE_CLONE_CELLS, origin: 'seed' });
    noteWrite({ path: nb.paths.ipynb, action: 'create', bytes: fs.statSync(W.safePath(nb.paths.ipynb)).size });
    DS.mount('my-voice');
    noteWrite({ path: 'input/my-voice/dataset-metadata.json', action: 'create' });
    return nb;
  }
  return null;
}

/* ------------------------------------------- simulated run streaming (SSE) */

const activeRuns = new Map();

function startRun(run) {
  const rec = { ...run, emitted: [], listeners: new Set(), finished: false, finalized: false, index: 0 };
  activeRuns.set(run.id, rec);
  // keep memory bounded
  if (activeRuns.size > 12) {
    const oldest = [...activeRuns.keys()].find((k) => k !== run.id);
    if (oldest) activeRuns.delete(oldest);
  }
  const tick = () => {
    if (rec.index >= rec.events.length) {
      rec.finished = true;
      if (!rec.finalized) {
        rec.finalized = true;
        try {
          const written = SIM.finalizeRun(rec);
          for (const p of written) noteWrite({ path: p, action: 'create', simulated: true });
        } catch (e) {
          console.error('[run] finalize failed:', e);
        }
      }
      for (const l of rec.listeners) l.end();
      rec.listeners.clear();
      return;
    }
    const ev = rec.events[rec.index++];
    rec.emitted.push(ev);
    for (const l of rec.listeners) l.write(ev);
    rec.timer = setTimeout(tick, Math.max(20, ev.delay || 80));
  };
  rec.timer = setTimeout(tick, 180);
  return rec;
}

function handleStream(req, res, runId) {
  const rec = activeRuns.get(runId);
  if (!rec) { sendError(res, 404, '找不到该运行记录（可能已过期），请重新运行。'); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  let seq = 0;
  const write = (ev) => {
    if (res.writableEnded) return;
    res.write(`id: ${++seq}\nevent: message\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const listener = {
    write,
    end() {
      if (res.writableEnded) return;
      res.write('event: end\ndata: {}\n\n');
      res.end();
    },
  };
  for (const ev of rec.emitted) write(ev);      // replay anything already emitted
  if (rec.finished) { listener.end(); return; }
  rec.listeners.add(listener);
  req.on('close', () => rec.listeners.delete(listener));
  req.on('error', () => rec.listeners.delete(listener));
}

/* -------------------------------------------------------------- API router */

async function api(req, res, u) {
  const p = u.pathname;
  const method = req.method.toUpperCase();
  const q = u.searchParams;

  // ---- health / bootstrap -------------------------------------------------
  if (p === '/api/health' && method === 'GET') {
    return ok(res, { status: 'running', startedAt: STARTED_AT, branch: GIT.status().branch });
  }
  if (p === '/api/bootstrap' && method === 'GET') {
    return ok(res, bootstrap());
  }
  if (p === '/api/settings' && method === 'PUT') {
    return ok(res, { settings: putSettings(await readJsonBody(req)) });
  }
  if (p === '/api/environment' && method === 'GET') {
    return ok(res, { environment: { ...KAGGLE_ENV, real: realEnvironment() } });
  }

  // ---- notebooks ----------------------------------------------------------
  if (p === '/api/notebooks' && method === 'GET') {
    return ok(res, { notebooks: NB.listNotebooks() });
  }
  if (p === '/api/notebooks' && method === 'POST') {
    const b = await readJsonBody(req);
    const nb = NB.createNotebook({
      name: b.name || '新建笔记本',
      cells: b.cells,
      origin: b.origin || 'new',
    });
    noteWrite({ path: nb.paths.ipynb, action: 'create' });
    noteWrite({ path: nb.paths.py, action: 'create' });
    return ok(res, { notebook: nb }, 201);
  }
  let m = /^\/api\/notebooks\/([^/]+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === 'GET') return ok(res, { notebook: NB.loadNotebook(id) });
    if (method === 'PUT') {
      const b = await readJsonBody(req);
      const nb = NB.saveNotebook({ ...(b.notebook || b), id });
      noteWrite({ path: nb.paths.ipynb, action: 'save', bytes: fs.statSync(W.safePath(nb.paths.ipynb)).size });
      noteWrite({ path: nb.paths.py, action: 'save' });
      return ok(res, { notebook: nb, savedAt: nb.updatedAt });
    }
    if (method === 'DELETE') return ok(res, { ...NB.deleteNotebook(id) });
  }

  // ---- the big one: import full Kaggle code --------------------------------
  if (p === '/api/import' && method === 'POST') {
    const b = await readJsonBody(req);
    const content = String(b.content || '');
    if (!content.trim()) return sendError(res, 400, '没有收到任何代码内容。');
    if (Buffer.byteLength(content) > MAX_BODY) return sendError(res, 413, '代码超过 12 MB 上限。');
    const imported = NB.importNotebook({
      content,
      name: b.name,
      mode: b.mode || 'auto',
      split: b.split !== false,
      origin: b.origin || 'paste',
    });
    noteWrite({ path: imported.paths.ipynb, action: 'import', chars: content.length });
    noteWrite({ path: imported.paths.py, action: 'import' });
    let gitResult = null;
    if (b.sync === true || b.autoCommit === true) {
      gitResult = GIT.commit(b.commitMessage || `导入 Kaggle 代码: ${imported.name}`);
    }
    if (b.sync === true && gitResult && gitResult.ok) gitResult.push = GIT.push();
    return ok(res, { notebook: imported, git: gitResult, import: imported.import }, 201);
  }

  // ---- generic real file operations ---------------------------------------
  if (p === '/api/files' && method === 'GET') {
    return ok(res, {
      tree: {
        notebooks: W.listTree('notebooks'),
        input: W.listTree('input'),
        working: W.listTree('working'),
        experiments: W.listTree('experiments'),
      },
      recentWrites: recentWrites.slice(0, 30),
    });
  }
  if (p === '/api/file' && method === 'GET') {
    const rel = q.get('path');
    if (!rel) return sendError(res, 400, '缺少 path 参数');
    const abs = W.safePath(rel, { mustExist: true });
    if (!fs.statSync(abs).isFile()) return sendError(res, 400, '不是文件');
    if (q.get('download') === '1') {
      const data = fs.readFileSync(abs);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(abs).replace(/[^\w.\-]/g, '_')}"`,
        'Content-Length': data.length,
      });
      return res.end(data);
    }
    return ok(res, { path: W.relativeTo(abs), content: W.readText(rel), size: fs.statSync(abs).size });
  }
  if (p === '/api/file' && method === 'PUT') {
    const b = await readJsonBody(req);
    const out = W.writeText(b.path, b.content ?? '');
    noteWrite({ path: out.path, action: 'write', bytes: out.bytes });
    return ok(res, { file: out });
  }
  if (p === '/api/file' && method === 'DELETE') {
    const rel = q.get('path');
    if (!rel) return sendError(res, 400, '缺少 path 参数');
    const r = W.remove(rel);
    noteWrite({ path: r.path, action: 'delete' });
    return ok(res, { file: r });
  }
  if (p === '/api/upload' && method === 'POST') {
    const b = await readJsonBody(req);
    const name = W.slugify(path.basename(String(b.filename || 'file.bin')), 'file');
    const dir = ['input', 'working', 'notebooks'].includes(b.dir) ? b.dir : 'working';
    const out = W.writeBase64(`${dir}/${b.subdir ? W.slugify(b.subdir) + '/' : ''}${name}`, b.base64);
    noteWrite({ path: out.path, action: 'upload', bytes: out.bytes });
    return ok(res, { file: out }, 201);
  }

  // ---- simulated /kaggle/input datasets -----------------------------------
  if (p === '/api/datasets' && method === 'GET') {
    return ok(res, { catalog: DATASET_CATALOG, mounted: DS.listMounted() });
  }
  if (p === '/api/datasets/mount' && method === 'POST') {
    const b = await readJsonBody(req);
    const meta = DS.mount(b.id, b);
    noteWrite({ path: `input/${meta.id}/dataset-metadata.json`, action: 'mount' });
    return ok(res, { dataset: meta, mounted: DS.listMounted() });
  }
  if (p === '/api/datasets/unmount' && method === 'POST') {
    const b = await readJsonBody(req);
    const r = DS.unmount(b.id);
    noteWrite({ path: r.path, action: 'unmount' });
    return ok(res, { ...r, mounted: DS.listMounted() });
  }

  // ---- static analysis + simulated runs ------------------------------------
  if (p === '/api/analyze' && method === 'POST') {
    const b = await readJsonBody(req);
    return ok(res, { analysis: SIM.analyze(String(b.code || '')) });
  }
  if (p === '/api/simulate/run' && method === 'POST') {
    const b = await readJsonBody(req);
    let notebookId = b.notebookId || 'scratch';
    let notebookName = notebookId;
    let code = String(b.code || '');
    if (!code) {
      try {
        const nb = NB.loadNotebook(notebookId);
        notebookName = nb.name;
        code = nb.cells.filter((c) => c.type === 'code').map((c) => c.source).join('\n\n# %% next cell\n\n');
      } catch (e) {
        return sendError(res, 404, '找不到 notebook: ' + e.message);
      }
    }
    const run = SIM.buildRun({
      code, notebookId, notebookName,
      speed: Number(b.speed || 1),
      cellSources: b.cellSources || [],
    });
    startRun(run);
    return ok(res, {
      runId: run.id,
      eventCount: run.events.length,
      estimatedMs: run.events.reduce((n, e) => n + (e.delay || 0), 0) + 180,
      analysis: run.analysis,
    }, 201);
  }
  if (p === '/api/simulate/stream' && method === 'GET') {
    return handleStream(req, res, q.get('runId'));
  }
  if (p === '/api/simulate/runs' && method === 'GET') {
    return ok(res, {
      runs: [...activeRuns.values()].map((r) => ({
        id: r.id, createdAt: r.createdAt, notebookId: r.notebookId,
        finished: r.finished, emitted: r.emitted.length, total: r.events.length,
      })),
    });
  }
  if (p === '/api/experiments' && method === 'GET') {
    return ok(res, { experiments: SIM.listExperiments(50) });
  }
  m = /^\/api\/experiments\/([^/]+)$/.exec(p);
  if (m && method === 'GET') {
    try { return ok(res, { experiment: SIM.getExperiment(decodeURIComponent(m[1])) }); }
    catch (e) { return sendError(res, 404, e.message); }
  }

  // ---- real local python (opt-in, disabled by default) --------------------
  if (p === '/api/execute' && method === 'POST') {
    if (process.env.ENABLE_LOCAL_PYTHON !== '1') {
      return sendError(res, 403,
        '真实本地执行默认关闭。若确需执行你自己的轻量 Python 片段，请用 ENABLE_LOCAL_PYTHON=1 npm start 启动服务。',
        { localPythonEnabled: false });
    }
    const b = await readJsonBody(req);
    const code = String(b.code || '').slice(0, 30000);
    const timeout = Math.min(Math.max(Number(b.timeoutMs || 8000), 1000), 15000);
    const t0 = Date.now();
    const r = spawnSync('python3', ['-I', '-c', code], {
      cwd: W.DIRS.sandbox,
      encoding: 'utf8',
      timeout,
      maxBuffer: 512 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: W.DIRS.sandbox,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        LANG: 'C.UTF-8',
      },
    });
    return ok(res, {
      real: true, simulated: false,
      stdout: (r.stdout || '').slice(0, 100000),
      stderr: (r.stderr || '').slice(0, 100000),
      exitCode: r.status,
      timedOut: !!r.error && r.error.code === 'ETIMEDOUT',
      durationMs: Date.now() - t0,
    });
  }

  // ---- git ----------------------------------------------------------------
  if (p === '/api/git' && method === 'GET') {
    return ok(res, { git: GIT.status(), commits: GIT.log(10), diff: GIT.diffStat() });
  }
  if (p === '/api/git/diff' && method === 'GET') {
    return ok(res, { diff: GIT.diffStat(), status: GIT.status() });
  }
  if (p === '/api/git/commit' && method === 'POST') {
    const b = await readJsonBody(req);
    const r = GIT.commit(b.message);
    return ok(res, { result: r, git: GIT.status(), commits: GIT.log(10) });
  }
  if (p === '/api/git/push' && method === 'POST') {
    const r = GIT.push();
    return ok(res, { result: r, git: GIT.status(), commits: GIT.log(10) });
  }
  if (p === '/api/git/sync' && method === 'POST') {
    const b = await readJsonBody(req);
    const r = GIT.sync(b.message);
    return ok(res, { result: r, git: GIT.status(), commits: GIT.log(10), diff: GIT.diffStat() });
  }

  // ---- maintenance ---------------------------------------------------------
  if (p === '/api/seed' && method === 'POST') {
    const nb = NB.createNotebook({
      name: '语音克隆实验 · Kaggle 模板 (副本)',
      cells: VOICE_CLONE_CELLS,
      origin: 'seed',
    });
    noteWrite({ path: nb.paths.ipynb, action: 'create' });
    return ok(res, { notebook: nb }, 201);
  }

  return sendError(res, 404, `未知接口: ${method} ${p}`);
}

/* ------------------------------------------------------- static file serving */

function serveStatic(req, res, u) {
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch { pathname = '/'; }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  // normalize and guard against traversal
  const abs = path.resolve(PUBLIC, '.' + pathname);
  if (!abs.startsWith(PUBLIC + path.sep) && abs !== PUBLIC) {
    res.writeHead(403); return res.end('forbidden');
  }
  let file = abs;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 — ' + pathname);
  }
  const ext = path.extname(file).toLowerCase();
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    return serveStatic(req, res, u);
  } catch (err) {
    console.error('[http]', err);
    const badRequest = /path escapes|absolute paths|not found|not a file|缺少|不是合法|path is required|file too large|请求体|没有收到|代码超过|unknown/i.test(err.message || '');
    if (!res.headersSent) sendError(res, err.status || (badRequest ? 400 : 500), err.message || 'internal error');
    else if (!res.writableEnded) res.end();
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

ensureSeed();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════╗');
  console.log('  ║   Kaggle Voice Lab — local notebook & experiment simulator  ║');
  console.log('  ╚═══════════════════════════════════════════════════════════╝');
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  ➜  repo        : ${W.ROOT}`);
  console.log(`  ➜  workspace   : ${W.WS}`);
  console.log(`  ➜  branch      : ${GIT.status().branch}`);
  console.log(`  ➜  local python: ${process.env.ENABLE_LOCAL_PYTHON === '1' ? 'ENABLED (opt-in)' : 'disabled (simulation only)'}`);
  console.log('');
});

module.exports = { server };
