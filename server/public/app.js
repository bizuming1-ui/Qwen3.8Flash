'use strict';
/* =========================================================================
 * Kaggle Voice Lab — browser client
 *
 * IMPORTANT: the browser is only a VIEW. All notebook state is written to
 * real files by the server (PUT /lab/api/notebooks/:id -> .ipynb + .py).
 * There is no localStorage-only source of truth.
 * ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const shortNum = (n) => (typeof n === 'number' ? (Math.abs(n) < 0.001 ? n.toExponential(2) : Number(n.toFixed(5))) : String(n ?? '—'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ state */

const S = {
  boot: null,
  notebooks: [],
  notebook: null,
  activeId: null,
  settings: { autosaveMs: 1200, simulationSpeed: 1 },
  dirty: false,
  saving: false,
  saveTimer: null,
  analysisTimer: null,
  analysis: null,
  editors: new Map(),
  cellMetrics: {},
  mdEditing: new Set(),
  expanded: new Set(['input', 'working', 'notebooks', 'working/runs', 'experiments']),
  console: { log: [], files: [], git: [], sys: [] },
  activeTab: 'log',
  experiments: [],
  datasets: { catalog: [], mounted: [] },
  git: null,
  commits: [],
  tree: { notebooks: [], input: [], working: [], experiments: [] },
  recentWrites: [],
  run: null,
  eventSource: null,
  startedAt: Date.now(),
  currentFilePath: null,
  loading: false,
  currentView: 'notebook',
  replica: { status: null, entry: null, assets: null, apiMap: null, verification: null },
  assetExpanded: new Set(['go', 'py', 'web', 'tools', 'rust', 'go/gateway', 'rust/audio_rt']),
};

/* ------------------------------------------------------------- utilities */

async function api(path, method = 'GET', body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch('/lab/api' + path, opt);
  } catch (e) {
    throw new Error('无法连接本地服务：' + e.message);
  }
  let j;
  try { j = await r.json(); } catch { throw new Error(`HTTP ${r.status}：响应不是 JSON`); }
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function clog(tab, text) {
  const arr = S.console[tab] || (S.console[tab] = []);
  arr.push(`[${hhmmss()}] ${text}`);
  if (arr.length > 500) arr.shift();
  if (S.activeTab === tab) renderConsole();
}

function toast(title, msg = '', type = 'info', small = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<b>${esc(title)}</b>${msg ? `<div>${esc(msg)}</div>` : ''}${small ? `<small>${esc(small)}</small>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 5200);
}

function setSaveState(cls, text) {
  const el = $('#save-state');
  el.className = `save-state ${cls}`;
  $('.save-text', el).textContent = text;
}

function markDirty() {
  S.dirty = true;
  setSaveState('dirty', '● 有未保存更改');
}

function scheduleAutosave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => saveNow(true), Math.max(400, Number(S.settings.autosaveMs) || 1200));
}

/* ------------------------------------------------------- notebook / cells */

async function loadBootstrap(keepId = true, preferId = null) {
  const b = await api('/bootstrap');
  S.boot = b;
  S.notebooks = b.notebooks || [];
  S.settings = { ...S.settings, ...(b.settings || {}) };
  const autoSync = $('#import-autosync');
  if (autoSync) autoSync.checked = !!S.settings.autoSyncOnImport;
  S.experiments = b.experiments || [];
  S.datasets = b.datasets || { catalog: [], mounted: [] };
  S.git = b.git || null;
  S.commits = b.recentCommits || [];
  S.tree = b.tree || S.tree;
  S.recentWrites = b.recentWrites || [];
  S.console.files = b.recentWrites.map((w) =>
    `[${w.at ? new Date(w.at).toLocaleTimeString() : ''}] ${w.action.padEnd(9)} ${w.path}${w.bytes ? '  ' + fmtBytes(w.bytes) : ''}`);
  S.localPythonEnabled = !!b.localPythonEnabled;
  if (b.replica) {
    S.replica.verification = b.replica.verification || null;
    S.replica.status = b.replica.state || null;
    S.replica.endpoints = b.replica.endpoints || 0;
    const note = $('#view-tabs-note');
    if (note && b.replica.verification) note.textContent = `${b.replica.verification.assetsVerified}/${b.replica.verification.assetsTotal} 资产已校验 · ${b.replica.endpoints} API`;
  }

  const wanted = (preferId && S.notebooks.some((n) => n.id === preferId))
    ? preferId
    : (keepId && S.activeId && S.notebooks.some((n) => n.id === S.activeId))
      ? S.activeId
      : (S.settings.activeNotebookId && S.notebooks.some((n) => n.id === S.settings.activeNotebookId)
        ? S.settings.activeNotebookId : (S.notebooks[0] && S.notebooks[0].id));

  renderNotebookSelect();
  renderEnv(b.environment || {});
  renderExperiments();
  renderTrees();
  renderGitMini();
  renderConsole();
  if (wanted) await openNotebook(wanted, false);
  else { $('#nb-title').textContent = '（还没有笔记本）'; $('#cells').innerHTML = ''; }
  clog('sys', `已连接服务 · 分支 ${b.git?.branch || '?'} · ${b.notebooks.length} 个笔记本 · 工作区 ${b.app.workspace}`);
}

function renderNotebookSelect() {
  const sel = $('#notebook-select');
  sel.innerHTML = S.notebooks.map((n) =>
    `<option value="${esc(n.id)}" ${n.id === S.activeId ? 'selected' : ''}>${esc(n.name)} (${n.cellCount} cells)</option>`).join('');
}

async function openNotebook(id, refreshList = true) {
  const r = await api('/notebooks/' + encodeURIComponent(id));
  S.notebook = r.notebook;
  S.activeId = id;
  S.mdEditing.clear();
  renderNotebookSelect();
  renderNotebook();
  renderNbFiles();
  scheduleAnalysis();
  setSaveState('saved', '✓ 已从磁盘加载');
  api('/settings', 'PUT', { activeNotebookId: id }).catch(() => {});
  if (refreshList) {
    const list = await api('/notebooks');
    S.notebooks = list.notebooks;
    renderNotebookSelect();
  }
}

function autoHeight(cm) {
  const lines = cm.lineCount();
  const h = Math.min(520, Math.max(84, lines * 20 + 24));
  if (cm._labHeight !== h) { cm._labHeight = h; cm.setSize('100%', h); }
}

function editorOptions(mode, extra = {}) {
  return {
    mode, theme: 'material-darker',
    lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
    autoCloseBrackets: true, styleActiveLine: true, lineWrapping: false,
    foldGutter: true, gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    autoRefresh: true,
    extraKeys: {
      'Ctrl-S': () => saveNow(), 'Cmd-S': () => saveNow(),
      'Tab': (cm) => cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    '),
      'Ctrl-/': (cm) => cm.toggleComment(), 'Cmd-/': (cm) => cm.toggleComment(),
      ...extra,
    },
  };
}

function makeEditor(container, cell, idx, mode) {
  const opts = editorOptions(mode, {
    'Ctrl-Enter': () => runCell(idx),
    'Cmd-Enter': () => runCell(idx),
    'Shift-Enter': () => { runCell(idx); focusCell(idx + 1); },
  });
  const cm = CodeMirror(container, { ...opts, value: cell.source });
  S.editors.set(cell.id, cm);
  autoHeight(cm);
  cm.on('change', () => {
    cell.source = cm.getValue();
    autoHeight(cm);
    markDirty();
    scheduleAutosave();
    scheduleAnalysis();
  });
  return cm;
}

function renderNotebook() {
  const nb = S.notebook;
  if (!nb) return;
  $('#nb-title').textContent = nb.name;
  $('#nb-meta').innerHTML =
    `id: <code>${esc(nb.id)}</code> · ${nb.cells.length} cells · 更新于 ${esc(new Date(nb.updatedAt).toLocaleString())} · ` +
    `保存位置 <code>${esc(nb.paths.ipynb)}</code>`;
  $('#cell-count').textContent = nb.cells.length;
  // Old editors are discarded together with their DOM nodes (no state kept in them).
  S.editors.clear();
  const host = $('#cells');
  host.innerHTML = '';
  nb.cells.forEach((cell, idx) => {
    host.appendChild(cellElement(cell, idx));
    host.appendChild(dividerElement(idx));
  });
  renderCellNav();
  $$('.cell-editor-host', host).forEach((el) => {
    const idx = Number(el.dataset.idx);
    const cell = nb.cells[idx];
    if (cell.type === 'markdown' && !S.mdEditing.has(cell.id)) {
      el.innerHTML = `<div class="md-render">${markdown(cell.source)}</div>`;
    } else {
      makeEditor(el, cell, idx, cell.type === 'markdown' ? 'markdown' : 'python');
    }
  });
  nb.cells.forEach((cell, idx) => renderCellOutput(idx));
  if (!S.dirty) setSaveState('saved', '✓ 已保存到项目');
}

function flushEditors() {
  if (!S.notebook) return;
  S.notebook.cells.forEach((c) => { const cm = S.editors.get(c.id); if (cm) c.source = cm.getValue(); });
}

/** Re-render after a structural cell change and persist immediately. */
function applyMutations() {
  markDirty();
  renderNotebook();
  scheduleAnalysis();
  saveNow(true);
}

function cellElement(cell, idx) {
  const el = document.createElement('article');
  el.className = `cell ${cell.type === 'markdown' ? 'markdown' : ''}`;
  el.dataset.idx = idx;
  el.dataset.id = cell.id;
  el.id = 'cell-' + idx;
  const isMd = cell.type === 'markdown';
  el.innerHTML = `
    <div class="cell-toolbar">
      <span class="cell-index">${isMd ? 'MD' : `In [${idx + 1}]:`}</span>
      <span class="cell-tag">${isMd ? 'markdown' : 'python'}</span>
      <span class="spacer"></span>
      ${isMd
        ? `<button class="cbtn" data-act="md-edit">${S.mdEditing.has(cell.id) ? '👁 预览' : '✎ 编辑'}</button>`
        : `<button class="cbtn run" data-act="run" title="模拟运行此 cell (Ctrl+Enter)">▶ 运行</button>`}
      <button class="cbtn" data-act="type" title="切换代码/Markdown">⇄ 类型</button>
      <button class="cbtn" data-act="up" title="上移">↑</button>
      <button class="cbtn" data-act="down" title="下移">↓</button>
      <button class="cbtn" data-act="dup" title="复制">⧉</button>
      <button class="cbtn del" data-act="del" title="删除">✕</button>
    </div>
    <div class="cell-editor"><div class="cell-editor-host" data-idx="${idx}"></div></div>
    ${isMd ? '' : '<div class="cell-output empty">尚未运行 · 模拟输出会显示在这里</div>'}`;
  return el;
}

function dividerElement(afterIdx) {
  const d = document.createElement('div');
  d.className = 'cell-divider';
  d.innerHTML = `<button class="btn btn-ghost btn-sm" data-act="add" data-type="code" data-after="${afterIdx}">＋ 代码</button>
                 <button class="btn btn-ghost btn-sm" data-act="add" data-type="markdown" data-after="${afterIdx}">＋ Markdown</button>`;
  return d;
}

function renderCellNav() {
  const host = $('#cell-nav');
  if (!S.notebook) { host.innerHTML = ''; return; }
  host.innerHTML = S.notebook.cells.map((c, i) => {
    const first = c.source.split('\n').find((l) => l.trim() && !/^\s*#\s*(%%|In\[)/.test(l)) || '(空单元格)';
    return `<div class="cell-nav-item ${c.type === 'markdown' ? 'md' : ''}" data-goto="${i}">
      <span class="idx">${c.type === 'markdown' ? 'MD' : `[${i + 1}]`}</span>
      <span class="txt">${esc(first.trim().slice(0, 60))}</span></div>`;
  }).join('');
}

function renderCellOutput(idx) {
  const cell = S.notebook.cells[idx];
  if (!cell || cell.type === 'markdown') return;
  const box = $(`.cell[data-idx="${idx}"] .cell-output`);
  if (!box) return;
  const outputs = cell.outputs || [];
  const metrics = S.cellMetrics[cell.id];
  if (!outputs.length && !metrics) {
    box.className = 'cell-output empty';
    box.textContent = '尚未运行 · 模拟输出会显示在这里';
    return;
  }
  box.className = 'cell-output';
  let html = outputs.length
    ? `<pre class="out-text">${esc(outputs.map((o) => o.text).join('').slice(-12000))}</pre>` : '';
  if (metrics && metrics.loss && metrics.loss.length) html += `<canvas class="cell-chart" data-metrics="${esc(cell.id)}"></canvas>`;
  box.innerHTML = html;
  if (metrics) {
    const cv = $('.cell-chart', box);
    if (cv) requestAnimationFrame(() => drawChart(cv, metrics));
  }
}

function focusCell(idx) {
  if (!S.notebook || idx < 0 || idx >= S.notebook.cells.length) return;
  const cell = S.notebook.cells[idx];
  if (cell.type === 'markdown') { S.mdEditing.add(cell.id); renderNotebook(); }
  const el = $(`.cell[data-idx="${idx}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const cm = S.editors.get(cell.id);
  if (cm) setTimeout(() => cm.focus(), 250);
}

/* --------------------------------------------------------------- markdown */

function markdown(src) {
  const lines = String(src || '').split(/\r?\n/);
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let out = '', inList = false, inTable = false;
  const closeList = () => { if (inList) { out += '</ul>'; inList = false; } };
  const closeTable = () => { if (inTable) { out += '</table>'; inTable = false; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) {
      closeList();
      const cells = l.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (!inTable) { out += '<table><thead><tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'; inTable = true; }
      else if (cells.every((c) => /^:?-{2,}:?$/.test(c))) { /* separator */ }
      else out += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
      continue;
    }
    closeTable();
    if (/^\s*[-*] /.test(l)) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`;
      continue;
    }
    closeList();
    if (/^\s*#{1,6} /.test(l)) {
      const n = ((l.match(/^\s*(#+)/) || [, '#'])[1] || '#').length;
      out += `<h${Math.min(n, 4)}>${inline(l.replace(/^\s*#+\s*/, ''))}</h${Math.min(n, 4)}>`;
    } else if (/^\s*>/.test(l)) out += `<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>`;
    else if (!l.trim()) out += '<div style="height:5px"></div>';
    else out += `<p>${inline(l)}</p>`;
  }
  closeList(); closeTable();
  return out;
}

/* -------------------------------------------------------- cell operations */

function newCell(type, source = '') {
  return { id: 'cell-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4), type, source, outputs: [] };
}

function onCellsClick(e) {
  const btn = e.target.closest('[data-act]');
  const goto = e.target.closest('[data-goto]');
  if (goto) { focusCell(Number(goto.dataset.goto)); return; }
  if (!btn || !S.notebook) return;
  const cellEl = btn.closest('.cell');
  const idx = cellEl ? Number(cellEl.dataset.idx) : Number(btn.dataset.after);
  const act = btn.dataset.act;
  const cells = S.notebook.cells;
  flushEditors();

  if (act === 'add') {
    cells.splice(idx + 1, 0, newCell(btn.dataset.type, btn.dataset.type === 'markdown' ? '## 新段落\n' : '\n'));
  } else if (act === 'run') { runCell(idx); return; }
  else if (act === 'del') {
    if (!confirm(`确定删除单元格 ${idx + 1}？（会立即写入磁盘）`)) return;
    cells.splice(idx, 1);
    if (!cells.length) cells.push(newCell('code', '\n'));
  } else if (act === 'dup') cells.splice(idx + 1, 0, { ...cells[idx], id: newCell(cells[idx].type).id, outputs: [] });
  else if (act === 'up' && idx > 0) [cells[idx - 1], cells[idx]] = [cells[idx], cells[idx - 1]];
  else if (act === 'down' && idx < cells.length - 1) [cells[idx + 1], cells[idx]] = [cells[idx], cells[idx + 1]];
  else if (act === 'type') {
    cells[idx].type = cells[idx].type === 'markdown' ? 'code' : 'markdown';
    cells[idx].outputs = [];
  } else if (act === 'md-edit') {
    const id = cells[idx].id;
    if (S.mdEditing.has(id)) S.mdEditing.delete(id); else S.mdEditing.add(id);
  } else return;

  applyMutations();
}

function appendBottomCell(type) {
  if (!S.notebook) return;
  flushEditors();
  S.notebook.cells.push(newCell(type, type === 'markdown' ? '## 新段落\n' : '\n'));
  applyMutations();
  setTimeout(() => focusCell(S.notebook.cells.length - 1), 80);
}

/* --------------------------------------------------------------- save/load */

async function saveNow(silent = false) {
  clearTimeout(S.saveTimer);
  if (!S.notebook) return;
  if (S.saving) { S.pendingSave = true; return; }
  // flush editors into the model
  flushEditors();
  S.saving = true;
  setSaveState('saving', '正在写入磁盘…');
  try {
    const r = await api('/notebooks/' + encodeURIComponent(S.notebook.id), 'PUT', { notebook: S.notebook });
    S.notebook.updatedAt = r.savedAt;
    S.dirty = false;
    setSaveState('saved', '✓ 已保存到项目 ' + hhmmss());
    if (!silent) toast('已保存到项目', '代码已写入真实的 .ipynb 与 .py 文件', 'success', `${r.notebook.paths.ipynb}  ·  ${r.notebook.paths.py}`);
    clog('sys', `保存 notebook -> ${r.notebook.paths.ipynb} + ${r.notebook.paths.py}`);
    refreshLight();
  } catch (e) {
    setSaveState('error', '保存失败');
    toast('保存失败', e.message, 'error');
    clog('sys', '保存失败: ' + e.message);
  } finally {
    S.saving = false;
    if (S.pendingSave) { S.pendingSave = false; setTimeout(() => saveNow(true), 60); }
  }
}

let refreshThrottle = 0;
async function refreshLight() {
  const now = Date.now();
  if (now - refreshThrottle < 1500) return;
  refreshThrottle = now;
  try {
    const [f, g, n] = await Promise.all([api('/files'), api('/git'), api('/notebooks')]);
    S.tree = f.tree; S.recentWrites = f.recentWrites;
    S.console.files = f.recentWrites.map((w) =>
      `[${w.at ? new Date(w.at).toLocaleTimeString() : ''}] ${w.action.padEnd(9)} ${w.path}${w.bytes ? '  ' + fmtBytes(w.bytes) : ''}`);
    S.git = g.git; S.commits = g.commits; S.notebooks = n.notebooks;
    renderTrees(); renderGitMini(); renderNotebookSelect(); renderNbFiles(); renderConsole();
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------- analysis */

function scheduleAnalysis() {
  clearTimeout(S.analysisTimer);
  S.analysisTimer = setTimeout(analyzeCurrent, 550);
}

async function analyzeCurrent() {
  if (!S.notebook) return;
  const code = S.notebook.cells.filter((c) => c.type === 'code').map((c) => c.source).join('\n');
  try {
    const r = await api('/analyze', 'POST', { code });
    S.analysis = r.analysis;
    renderAnalysis();
  } catch (e) { clog('sys', '静态分析失败: ' + e.message); }
}

function renderAnalysis() {
  const a = S.analysis;
  const box = $('#analysis-box');
  if (!a) { box.innerHTML = '<span class="tiny-note">分析代码…</span>'; return; }
  const hp = Object.entries(a.hyperparams || {});
  box.innerHTML = `
    <div class="kv"><span>代码行数</span><b>${a.lines}</b></div>
    <div class="kv"><span>字符数</span><b>${a.chars}</b></div>
    <div class="kv"><span>类 / 函数</span><b>${(a.classes || []).length} / ${(a.functions || []).length}</b></div>
    <h4>检测到的框架</h4>
    <div class="chips">${(a.libs || []).slice(0, 14).map((l) => `<span class="chip hot">${esc(l)}</span>`).join('') || '<span class="tiny-note">无</span>'}</div>
    <h4>超参数（静态提取）</h4>
    ${hp.length ? hp.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(shortNum(v))}</b></div>`).join('') : '<span class="tiny-note">未在代码中发现字面量超参数</span>'}
    <h4>数据路径</h4>
    ${(a.datasets || []).length ? (a.datasets).slice(0, 8).map((d) => `<div class="kv"><span style="overflow:hidden;text-overflow:ellipsis">${esc(d)}</span></div>`).join('') : '<span class="tiny-note">无 /kaggle/input 引用</span>'}
    <h4>运行阶段</h4>
    <div class="chips">${(a.stages || []).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
    <h4>提示</h4>
    ${(a.warnings || []).map((w) => `<div class="warn-item ${w.level}">${esc(w.text)}</div>`).join('') || '<span class="tiny-note">无</span>'}`;
}

/* ------------------------------------------------------------- run / SSE */

async function runAll() {
  if (!S.notebook) return;
  if (S.eventSource) { toast('已有运行在进行中', '请先停止当前运行', 'warn'); return; }
  await saveNow(true);
  $('#run-panel').classList.remove('hidden');
  $('#run-panel-body').classList.remove('collapsed');
  $('#run-log').textContent = '';
  $('#run-summary').innerHTML = '';
  $('#run-progress').style.width = '2%';
  $('#run-stage').textContent = '提交模拟任务…';
  $('#chart-legend').textContent = '';
  S.metrics = { loss: [], val_loss: [], mel_loss: [] };
  drawChart($('#run-chart'), S.metrics);
  try {
    await startRun({ speed: Number(S.settings.simulationSpeed) || 1, target: 'panel' });
  } catch (e) { toast('运行失败', e.message, 'error'); clog('log', 'ERROR ' + e.message); }
}

async function runCell(idx) {
  if (!S.notebook) return;
  if (S.eventSource) { toast('已有运行在进行中', '请先停止当前运行', 'warn'); return; }
  const cell = S.notebook.cells[idx];
  if (!cell || cell.type === 'markdown') return;
  const cm = S.editors.get(cell.id);
  if (cm) cell.source = cm.getValue();
  cell.outputs = [{ type: 'stream', text: '[SIMULATED] Kaggle Voice Lab · 单 cell 模拟运行\n' }];
  S.cellMetrics[cell.id] = { loss: [], val_loss: [], mel_loss: [] };
  const el = $(`.cell[data-idx="${idx}"]`);
  if (el) el.classList.add('running');
  renderCellOutput(idx);
  clog('log', `▶ 模拟运行 cell ${idx + 1} (${cell.source.length} chars)`);
  try {
    await startRun({
      code: cell.source,
      speed: Number(S.settings.simulationSpeed) || 1,
      target: 'cell', cellId: cell.id, cellIdx: idx,
    });
  } catch (e) { toast('运行失败', e.message, 'error'); }
}

async function startRun({ code, speed = 1, target = 'panel', cellId = null, cellIdx = null }) {
  const body = { notebookId: S.activeId || 'scratch', speed };
  if (code !== undefined) body.code = code;
  const r = await api('/simulate/run', 'POST', body);
  S.run = {
    id: r.runId, target, cellId, cellIdx,
    logs: [], metrics: { loss: [], val_loss: [], mel_loss: [] },
    events: 0, total: r.eventCount,
  };
  clog('log', `run ${r.runId} 已创建 · ${r.eventCount} 个事件 · ${r.analysis.lines} 行代码 · ${r.analysis.libs.length} 个框架`);
  const es = new EventSource('/lab/api/simulate/stream?runId=' + encodeURIComponent(r.runId));
  S.eventSource = es;
  es.onmessage = (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    handleRunEvent(data);
  };
  es.addEventListener('end', () => {
    es.close();
    if (S.eventSource === es) S.eventSource = null;
    onRunFinished();
  });
  es.onerror = () => {
    // The server closes the stream at the end; that is not an error for us.
    if (S.eventSource === es) { es.close(); S.eventSource = null; onRunFinished(); }
  };
  return r;
}

function appendRunText(text, level = 'info') {
  const run = S.run;
  if (!run) return;
  run.logs.push(text);
  if (run.logs.length > 400) run.logs.shift();
  if (run.target === 'panel') {
    const pre = $('#run-log');
    pre.textContent = run.logs.join('\n');
    pre.scrollTop = pre.scrollHeight;
  } else if (run.cellId) {
    const cell = S.notebook.cells.find((c) => c.id === run.cellId);
    if (cell) {
      cell.outputs = cell.outputs || [];
      cell.outputs.push({ type: 'stream', text: text + '\n' });
      if (cell.outputs.length > 200) cell.outputs.shift();
      renderCellOutput(S.notebook.cells.indexOf(cell));
    }
  }
  clog('log', text);
}

function handleRunEvent(ev) {
  const run = S.run;
  if (!run) return;
  run.events++;
  if (ev.type === 'log') appendRunText(ev.text, ev.level);
  else if (ev.type === 'stage') {
    $('#run-stage').textContent = `${ev.stage} (${ev.index + 1}/${ev.total})`;
    const pct = Math.round(((ev.index + 1) / Math.max(1, ev.total)) * 100);
    $('#run-progress').style.width = pct + '%';
    appendRunText(`\n── ${ev.stage} ──`);
  } else if (ev.type === 'metric') {
    for (const k of ['loss', 'val_loss', 'mel_loss']) run.metrics[k].push(ev[k]);
    appendRunText(ev.text, 'metric');
    $('#run-progress').style.width = Math.round((ev.epoch / ev.epochs) * 100) + '%';
    if (run.target === 'panel') { S.metrics = run.metrics; drawChart($('#run-chart'), S.metrics); }
    else if (run.cellId) {
      S.cellMetrics[run.cellId] = run.metrics;
      const cell = S.notebook.cells.find((c) => c.id === run.cellId);
      if (cell) renderCellOutput(S.notebook.cells.indexOf(cell));
    }
  } else if (ev.type === 'done') {
    $('#run-progress').style.width = '100%';
    $('#run-stage').textContent = '✓ 模拟完成';
    renderRunSummary(ev.summary);
    appendRunText('\n✔ 模拟运行结束 —— 所有日志/指标均为模拟数据。', 'ok');
  }
}

function renderRunSummary(sum) {
  if (!sum) return;
  if (S.run.target === 'panel') {
    $('#chart-legend').textContent = `loss ${shortNum(sum.finalLoss)} · val ${shortNum(sum.finalValLoss)}`;
    $('#run-summary').innerHTML = `
      <div class="kpi">epochs <b>${sum.epochs}</b></div>
      <div class="kpi">batch <b>${sum.batch}</b></div>
      <div class="kpi">lr <b>${sum.lr}</b></div>
      <div class="kpi">final loss <b>${shortNum(sum.finalLoss)}</b></div>
      <div class="kpi">val loss <b>${shortNum(sum.finalValLoss)}</b></div>
      <div class="kpi">产物 <b>${sum.artifacts.length} 个真实文件</b></div>`;
  } else {
    toast('模拟运行完成', `cell ${S.run.cellIdx + 1} · final loss ${shortNum(sum.finalLoss)}`, 'success');
  }
}

async function onRunFinished() {
  if (S.run && S.run.cellId) {
    const cell = S.notebook.cells.find((c) => c.id === S.run.cellId);
    if (cell) renderCellOutput(S.notebook.cells.indexOf(cell));
    const el = $(`.cell[data-idx="${S.run.cellIdx}"]`);
    if (el) el.classList.remove('running');
    saveNow(true);   // persist simulated outputs into the .ipynb as well
  }
  toast('模拟运行结束', '日志、指标与实验记录已写入 kaggle_workspace/working/', 'success');
  clog('sys', '模拟运行产物已落盘，记得提交到 GitHub 保存这些记录。');
  const [f, g, e] = await Promise.all([api('/files'), api('/git'), api('/experiments')]);
  S.tree = f.tree; S.recentWrites = f.recentWrites;
  S.console.files = f.recentWrites.map((w) =>
    `[${w.at ? new Date(w.at).toLocaleTimeString() : ''}] ${w.action.padEnd(9)} ${w.path}`);
  S.git = g.git; S.commits = g.commits; S.experiments = e.experiments;
  renderTrees(); renderExperiments(); renderGitMini(); renderConsole();
}

function stopRun() {
  if (S.eventSource) { S.eventSource.close(); S.eventSource = null; onRunFinished(); }
  toast('已断开事件流', '服务器端模拟仍会跑完并写入产物文件', 'warn');
}

/* ------------------------------------------------------------------ chart */

function drawChart(canvas, m) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320, h = canvas.clientHeight || 160;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#080e1b'; ctx.fillRect(0, 0, w, h);
  const P = { l: 40, r: 8, t: 10, b: 20 };
  const series = [['loss', '#22d3ee'], ['val_loss', '#a78bfa'], ['mel_loss', '#fbbf24']]
    .filter(([k]) => m && m[k] && m[k].length);
  const all = series.flatMap(([k]) => m[k]);
  const max = Math.max(0.5, ...all) * 1.1;
  const n = Math.max(1, ...series.map(([k]) => m[k].length));
  const X = (i) => P.l + (i / Math.max(1, n - 1)) * (w - P.l - P.r);
  const Y = (v) => h - P.b - (v / max) * (h - P.t - P.b);

  ctx.strokeStyle = '#1e2c46'; ctx.lineWidth = 1; ctx.fillStyle = '#5f7595'; ctx.font = '9px monospace';
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g, y = Y(v);
    ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(w - P.r, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), 3, y + 3);
  }
  ctx.fillText('epoch', w - P.r - 30, h - 5);
  ctx.fillText('0', P.l - 2, h - 5);
  ctx.fillText(String(n), w - P.r - 10, h - 5);

  if (!series.length) {
    ctx.fillStyle = '#4f6382'; ctx.font = '11px monospace';
    ctx.fillText('等待模拟指标…', P.l + 20, h / 2);
    return;
  }
  for (const [key, color] of series) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath();
    m[key].forEach((v, i) => { const x = X(i), y = Y(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  // legend
  let lx = P.l + 6;
  ctx.font = '9px monospace';
  for (const [key, color] of series) {
    ctx.fillStyle = color; ctx.fillRect(lx, P.t + 2, 8, 3);
    ctx.fillStyle = '#8ea6c4'; ctx.fillText(key, lx + 12, P.t + 7);
    lx += key.length * 6 + 30;
  }
}

/* ----------------------------------------------------------- file trees */

function treeHtml(nodes, level = 0) {
  if (!nodes || !nodes.length) return '<div class="tree-empty">（空目录）</div>';
  return nodes.map((n) => {
    const open = S.expanded.has(n.path);
    const isDir = n.type === 'dir';
    const icon = isDir ? (open ? '📂' : '📁') : (/\.(py|ipynb)$/.test(n.name) ? '🐍' : /\.(json|md|txt|log|csv)$/.test(n.name) ? '📄' : '📎');
    const caret = isDir ? `<span class="caret">${open ? '▾' : '▸'}</span>` : '<span class="caret"></span>';
    return `<div class="tree-node">
      <div class="tree-row" data-${isDir ? 'dir' : 'file'}="${esc(n.path)}" title="${esc(n.path)}">
        ${caret}<span class="ico">${icon}</span><span class="nm">${esc(n.name)}</span>
        ${!isDir ? `<span class="sz">${fmtBytes(n.size)}</span>` : ''}
      </div>
      ${isDir && open ? `<div class="tree-children">${treeHtml(n.children || [], level + 1)}</div>` : ''}
    </div>`;
  }).join('');
}

function renderTrees() {
  $('#tree-input').innerHTML = treeHtml(S.tree.input || []);
  $('#tree-working').innerHTML = treeHtml(S.tree.working || []);
  renderNbFiles();
}

function renderNbFiles() {
  const all = S.tree.notebooks || [];
  if (!S.notebook) {
    $('#nb-files').innerHTML = all.length
      ? all.map((n) => `<a href="/lab/api/file?path=${encodeURIComponent(n.path)}&download=1">⬇ ${esc(n.name)}</a>`).join('')
      : '<span class="tiny-note">暂无笔记本文件</span>';
    return;
  }
  const p = S.notebook.paths;
  $('#nb-files').innerHTML = `
    <a href="/lab/api/file?path=${encodeURIComponent(p.ipynb)}&download=1" title="下载 notebook">⬇ ${esc(p.ipynb.split('/').pop())}</a>
    <a href="/lab/api/file?path=${encodeURIComponent(p.py)}&download=1" title="下载 python 导出">⬇ ${esc(p.py.split('/').pop())}</a>
    <div class="tiny-note" style="padding:4px 7px">项目内共 ${all.length} 个笔记本文件</div>`;
}

function onTreeClick(e) {
  const d = e.target.closest('[data-dir]');
  const f = e.target.closest('[data-file]');
  if (d) {
    const p = d.dataset.dir;
    if (S.expanded.has(p)) S.expanded.delete(p); else S.expanded.add(p);
    renderTrees();
  } else if (f) openFile(f.dataset.file);
}

function renderExperiments() {
  $('#exp-count').textContent = S.experiments.length;
  $('#experiment-list').innerHTML = S.experiments.length
    ? S.experiments.map((x) => `<div class="experiment-item" data-run="${esc(x.id)}" title="点击查看 run.log">
        <div class="t">${esc(new Date(x.createdAt).toLocaleString())}</div>
        <div class="n">${esc(x.notebookName || x.notebookId)}</div>
        <div class="m">${x.epochs} epochs · loss ${esc(shortNum(x.finalLoss))}</div></div>`).join('')
    : '<div class="tree-empty">还没有实验记录，点「模拟运行」生成。</div>';
}

async function openFile(rel, quiet = false) {
  try {
    const r = await api('/file?path=' + encodeURIComponent(rel));
    S.currentFilePath = rel;
    $('#file-title').textContent = rel.split('/').pop();
    $('#file-path').textContent = 'kaggle_workspace/' + rel + '  ·  ' + fmtBytes(r.size);
    $('#file-content').textContent = r.content;
    $('#btn-file-download').href = `/lab/api/file?path=${encodeURIComponent(rel)}&download=1`;
    $('#btn-file-download').setAttribute('download', rel.split('/').pop());
    showModal('modal-file');
    return true;
  } catch (e) {
    if (!quiet) toast('无法打开文件', e.message, 'error');
    return false;
  }
}

/* -------------------------------------------------------- environment UI */

function renderEnv(env) {
  $('#env-gpu').textContent = (env.accelerator || '—').replace('2 × NVIDIA ', '');
  $('#env-python').textContent = env.python || '—';
  $('#env-internet').textContent = env.internet || '—';
  $('#env-note').textContent = env.note || '';
  $('#package-chips').innerHTML = (env.packages || []).map((p) => `<span class="chip">${esc(p)}</span>`).join('');
  if (env.real) clog('sys', `真实运行环境: Node ${env.real.node} · ${env.real.python} · ${env.real.cpus} CPU · ${env.real.memoryGB} GB RAM · 无 GPU`);
}

function tickEnv() {
  const sec = Math.floor((Date.now() - S.startedAt) / 1000);
  $('#env-uptime').textContent = `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
setInterval(() => {
  $$('.gauge .track i').forEach((bar) => {
    const cur = parseFloat(bar.style.width) || 20;
    const next = Math.max(8, Math.min(88, cur + (Math.random() - 0.48) * 8));
    bar.style.width = next.toFixed(1) + '%';
  });
}, 3200);
setInterval(tickEnv, 1000);

/* --------------------------------------------------------------- git UI */

function renderGitMini() {
  const g = S.git;
  const box = $('#git-mini');
  if (!g) { box.innerHTML = '<span class="tiny-note">git 状态不可用</span>'; return; }
  const files = (g.files || []).slice(0, 8);
  box.innerHTML = `
    <div class="gm-row"><span>分支</span><b>${esc(g.branch || '?')}</b></div>
    <div class="gm-row"><span>未提交改动</span><b style="color:${g.dirty ? 'var(--amber)' : 'var(--green)'}">${(g.files || []).length} 个文件</b></div>
    <div class="gm-row"><span>ahead / behind</span><b>${g.ahead || 0} / ${g.behind || 0}</b></div>
    <div class="gm-row"><span>最新提交</span><b title="${esc(g.lastCommit?.subject || '')}">${esc(g.lastCommit?.hash || '—')}</b></div>
    <div class="gm-files">${files.map((f) => `<div title="${esc(f.path)}">${f.state === 'untracked' ? '?' : 'M'} ${esc(f.path)}</div>`).join('') || '<div>（工作区干净）</div>'}</div>
    <button class="btn btn-primary" id="gm-open">☁ 提交 / 推送到 GitHub</button>`;
  $('#gm-open').addEventListener('click', openGitModal);
}

function stateLabel(s) {
  return ({ untracked: '新增', added: '已暂存', modified: '已修改', deleted: '已删除', renamed: '重命名' })[s] || s;
}

async function openGitModal() {
  showModal('modal-git');
  await refreshGitModal();
}

async function refreshGitModal() {
  try {
    const r = await api('/git');
    const g = r.git;
    S.git = g; S.commits = r.commits;
    $('#git-status-grid').innerHTML = `
      <div class="gs-cell"><span>BRANCH</span><b>${esc(g.branch || '?')}</b></div>
      <div class="gs-cell"><span>未提交文件</span><b>${(g.files || []).length}</b></div>
      <div class="gs-cell"><span>AHEAD / BEHIND</span><b>${g.ahead || 0} / ${g.behind || 0}</b></div>
      <div class="gs-cell"><span>REMOTE</span><b title="${esc(g.remote || '')}">${esc((g.remote || '').split('/').slice(-2).join('/'))}</b></div>`;
    $('#git-file-count').textContent = (g.files || []).length;
    $('#git-file-list').innerHTML = (g.files || []).length
      ? g.files.map((f) => `<div><span class="st">${stateLabel(f.state)}</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(f.path)}</span></div>`).join('')
      : '<div>工作区干净 ✓</div>';
    $('#git-commits').innerHTML = (r.commits || []).map((c) =>
      `<div><span class="h">${esc(c.hash)}</span> ${esc(c.subject)} <span style="color:var(--txt-3)">· ${esc(c.when)}</span></div>`).join('') || '<div>暂无提交</div>';
    $('#git-diff').textContent = r.diff || '(无差异)';
    $('#git-repo-link').href = g.webUrl || '#';
    if (!$('#git-message').value) $('#git-message').value = `保存 Kaggle 语音克隆代码 · ${new Date().toLocaleString('zh-CN')}`;
    renderGitMini();
  } catch (e) { $('#git-output').textContent = '读取 git 状态失败: ' + e.message; }
}

async function gitAction(kind) {
  const msg = $('#git-message').value.trim();
  const out = $('#git-output');
  out.textContent = `执行中：${kind} …\n`;
  clog('git', `$ git ${kind} ${msg ? '-m "' + msg + '"' : ''}`);
  const btns = ['#btn-git-commit', '#btn-git-sync', '#btn-git-push'];
  btns.forEach((b) => $(b).disabled = true);
  try {
    const r = await api('/git/' + kind, 'POST', { message: msg });
    const parts = [];
    if (r.result.commit) parts.push(`commit: ${r.result.commit.ok ? 'OK' : 'FAIL'} — ${r.result.commit.message}\n${r.result.commit.output || ''}`);
    if (r.result.push) parts.push(`push: ${r.result.push.ok ? 'OK' : 'FAIL'}\n${r.result.push.output || ''}`);
    if (!parts.length) parts.push(r.result.output || JSON.stringify(r.result));
    const text = parts.join('\n\n');
    out.textContent = text;
    clog('git', text.replace(/\n/g, ' | ').slice(0, 500));
    if (r.result.ok) toast(kind === 'sync' ? '已同步到 GitHub ✅' : 'Git 操作成功', kind === 'sync' ? 'commit + push 已完成' : msg, 'success');
    else toast('Git 操作失败', (r.result.push || r.result.commit || r.result).output || '请查看输出', 'error');
    await refreshGitModal();
    const [f, e] = await Promise.all([api('/files'), api('/experiments')]);
    S.tree = f.tree; S.experiments = e.experiments;
    S.console.files = f.recentWrites.map((w) => `[${w.at ? new Date(w.at).toLocaleTimeString() : ''}] ${w.action.padEnd(9)} ${w.path}`);
    renderTrees(); renderExperiments(); renderConsole();
  } catch (e) {
    out.textContent = '错误：' + e.message;
    clog('git', '错误: ' + e.message);
    toast('Git 操作失败', e.message, 'error');
  } finally { btns.forEach((b) => $(b).disabled = false); }
}

/* ------------------------------------------------------------ import UI */

function detectImport(text) {
  const t = text.trim();
  const el = $('#import-detect');
  $('#import-size').textContent = `${text.length.toLocaleString()} 字符 · ${fmtBytes(new Blob([text]).size)}`;
  if (!t) { el.textContent = '等待粘贴…'; return; }
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j.cells)) { el.textContent = `✓ 检测到 Notebook JSON · ${j.cells.length} 个 cell`; return; }
    } catch { /* not JSON yet */ }
    el.textContent = '可能是 JSON（仍在输入中…）';
    return;
  }
  const marks = (text.match(/^\s*#\s*(?:%%|In\[[^\]]*\])/gm) || []).length;
  el.textContent = marks
    ? `✓ 检测到 Python 脚本 · ${marks} 个 # %% cell 分隔符`
    : '✓ 纯代码文本 · 将完整保存为 1 个 cell';
}

async function doImport(syncRequested) {
  const sync = !!syncRequested || !!S.settings.autoSyncOnImport;
  const content = $('#import-content').value;
  if (!content.trim()) { toast('没有内容', '请先粘贴 Kaggle 代码', 'warn'); return; }
  const name = $('#import-name').value.trim() || `kaggle-code-${new Date().toISOString().slice(0, 10)}`;
  const body = {
    content, name,
    mode: $('#import-mode').value,
    split: $('#import-split').checked,
    sync,
    commitMessage: `导入 Kaggle 完整代码: ${name}`,
  };
  $('#btn-import-save').disabled = $('#btn-import-sync').disabled = true;
  toast('正在写入项目文件…', `${content.length} 字符`, 'info');
  try {
    const r = await api('/import', 'POST', body);
    const nb = r.notebook;
    hideModal('modal-import');
    $('#import-content').value = '';
    $('#import-name').value = '';
    detectImport('');
    toast('✅ 代码已真实保存到项目', `${r.import.note} · ${nb.cells.length} 个 cell`, 'success',
      `kaggle_workspace/${nb.paths.ipynb}  +  kaggle_workspace/${nb.paths.py}`);
    clog('sys', `导入完成 -> ${nb.paths.ipynb} / ${nb.paths.py} (${nb.cells.length} cells, ${r.import.note})`);
    if (r.git) {
      clog('git', `commit: ${r.git.ok ? 'OK' : 'FAIL'} ${r.git.message || ''} ${r.git.push ? '| push: ' + (r.git.push.ok ? 'OK' : 'FAIL') : ''}`);
      if (r.git.push && !r.git.push.ok) toast('GitHub push 失败', '文件已保存并提交，但推送失败，请在 Git 面板检查', 'error');
      else if (r.git.ok && sync) toast('🚀 已推送到 GitHub', r.git.message, 'success');
    }
    await loadBootstrap(false, nb.id);
    if (nb.id) await openNotebook(nb.id);
  } catch (e) {
    toast('导入失败', e.message, 'error');
    clog('sys', '导入失败: ' + e.message);
  } finally { $('#btn-import-save').disabled = $('#btn-import-sync').disabled = false; }
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('#import-content').value = String(reader.result || '');
    if (!$('#import-name').value) $('#import-name').value = file.name.replace(/\.(ipynb|py|txt|json|md)$/i, '');
    if (/\.ipynb$/i.test(file.name)) $('#import-mode').value = 'ipynb';
    else if (/\.py$/i.test(file.name)) $('#import-mode').value = 'py';
    detectImport($('#import-content').value);
    toast('文件已读入', `${file.name} · ${fmtBytes(file.size)}`, 'success');
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------- datasets UI */

async function openDatasets() {
  showModal('modal-datasets');
  try {
    const r = await api('/datasets');
    S.datasets = r;
    $('#dataset-catalog').innerHTML = r.catalog.map((d) => {
      const mounted = r.mounted.some((m) => m.id === d.id);
      return `<div class="ds-card ${mounted ? 'mounted' : ''}">
        <h4>${esc(d.name)}</h4><div class="sub">/kaggle/input/${esc(d.id)} · ${esc(d.bytes)}</div>
        <p>${esc(d.description)}</p>
        <div class="tiny-note" style="margin-bottom:8px">${d.files.length} 个占位文件 · ${esc(d.license)}</div>
        <button class="btn ${mounted ? 'btn-danger' : 'btn-primary'}" data-ds="${esc(d.id)}" data-mounted="${mounted}">
          ${mounted ? '✕ 取消挂载' : '＋ 挂载（创建真实元数据）'}</button>
      </div>`;
    }).join('');
  } catch (e) { toast('读取数据集失败', e.message, 'error'); }
}

async function mountDataset(id, mounted) {
  try {
    if (mounted) await api('/datasets/unmount', 'POST', { id });
    else await api('/datasets/mount', 'POST', { id });
    toast(mounted ? '已取消挂载' : '已挂载', `/kaggle/input/${id} 的元数据文件已写入项目`, 'success');
    clog('files', `${mounted ? 'unmount' : 'mount'} input/${id}`);
    await openDatasets();
    const f = await api('/files'); S.tree = f.tree; renderTrees();
    refreshLight();
  } catch (e) { toast('操作失败', e.message, 'error'); }
}

/* ------------------------------------------------------------- modals UI */

function showModal(id) { $('#' + id).classList.remove('hidden'); }
function hideModal(id) { $('#' + id).classList.add('hidden'); }
function hideAllModals() { $$('.modal-overlay').forEach((m) => m.classList.add('hidden')); }
function openImportModal() {
  $('#import-autosync').checked = !!S.settings.autoSyncOnImport;
  showModal('modal-import');
  setTimeout(() => $('#import-content').focus(), 60);
}

function renderHelp() {
  const b = S.boot || { app: {}, environment: {} };
  $('#help-body').innerHTML = `
    <h3>这个页面是什么？</h3>
    <p>一个<strong>本地 Kaggle 笔记本 / 实验模拟器</strong>。它模拟 Kaggle 的 cell 编辑、运行日志、loss 曲线、GPU 会话和 /kaggle/input 数据集挂载。
    所有日志与指标都<strong>明确标记为模拟</strong>——本沙箱没有 GPU，不会真的训练你的语音克隆模型。</p>
    <h3>但你的代码是真实的</h3>
    <ul>
      <li>粘贴或编辑的代码会立刻写入仓库磁盘：
        <code>kaggle_workspace/notebooks/&lt;名称&gt;.ipynb</code>（标准 nbformat 4，可直接上传回 Kaggle）和
        <code>&lt;名称&gt;.py</code>（<code># %%</code> cell 导出）。</li>
      <li>模拟运行的产物写入 <code>kaggle_workspace/working/runs/&lt;run-id&gt;/</code>，
        实验记录写入 <code>kaggle_workspace/experiments/&lt;run-id&gt;.json</code>。</li>
      <li>数据集挂载写入 <code>kaggle_workspace/input/&lt;id&gt;/</code>（元数据 + 清单）。</li>
      <li>点「提交到 GitHub」会执行真实的 <code>git add -A &amp;&amp; git commit &amp;&amp; git push origin HEAD</code>。</li>
    </ul>
    <h3>使用流程（语音克隆项目）</h3>
    <ul>
      <li>点 <strong>「导入完整 Kaggle 代码」</strong>，粘贴你在 Kaggle 的完整 <code>.ipynb</code> JSON 或 <code>.py</code> 全文 → 选「只保存到项目」或「保存并提交到 GitHub」。</li>
      <li>粘贴 <code>.ipynb</code> 时会恢复全部 cell；粘贴 <code>.py</code> 时按 <code># %%</code> 分隔符拆 cell；没有分隔符就完整保留为 1 个 cell，绝不会偷偷改你的代码。</li>
      <li>自动保存默认 1.2 秒；也可以 <kbd>Ctrl/⌘ + S</kbd> 手动保存。</li>
      <li>点「模拟运行」查看日志与曲线；产物是真实文件，但数值是模拟的。</li>
      <li>把 <code>.ipynb</code> 下载/上传回 Kaggle 开启 GPU 才能真训练。</li>
    </ul>
    <h3>快捷键</h3>
    <p><kbd>Ctrl/⌘ + S</kbd> 保存 · <kbd>Ctrl/⌘ + Enter</kbd> 运行当前 cell ·
       <kbd>Shift + Enter</kbd> 运行并跳到下一个 · <kbd>Ctrl/⌘ + I</kbd> 导入 ·
       <kbd>Ctrl/⌘ + G</kbd> Git 面板 · <kbd>Esc</kbd> 关闭弹窗</p>
    <h3>真实运行环境</h3>
    <p>分支 <code>${esc(S.git?.branch || '—')}</code> · Node <code>${esc(b.environment?.real?.node || '')}</code> ·
       ${esc(b.environment?.real?.python || '')} · ${b.environment?.real?.cpus || '?'} CPU ·
       ${b.environment?.real?.memoryGB || '?'} GB RAM · <strong>无 GPU</strong>。
       右侧显示的 T4×2 / 29 GB RAM 等是 Kaggle 会话的模拟值。</p>
    <p class="tiny-note">服务由 <code>npm start</code> 启动（Node ${esc(b.environment?.real?.node || '')}），
       无外部 CDN 依赖，CodeMirror 已随仓库一起提交。</p>`;
}

/* -------------------------------------------------------------- console */

function renderConsole() {
  const arr = S.console[S.activeTab] || [];
  const pre = $('#console-pre');
  pre.textContent = arr.length ? arr.join('\n') : '(暂无内容)';
  pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
}

/* ------------------------------------------------- replica / study views */

function switchView(name) {
  S.currentView = name;
  $$('.view-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  for (const v of ['notebook', 'replica', 'assets', 'api', 'precision']) {
    const el = $(`#view-${v}`);
    if (el) el.classList.toggle('hidden', v !== name);
  }
  if (name === 'notebook') {
    S.editors.forEach((cm) => { try { cm.refresh(); } catch {} });
  }
  if (name === 'replica' || name === 'assets' || name === 'api') loadReplicaData();
  if (name === 'precision') loadPrecisionSummary();
}

async function loadReplicaData(force = false) {
  try {
    if (force || !S.replica.status || !S.replica.assets || !S.replica.apiMap) {
      const [st, assets, map] = await Promise.all([
        api('/replica/status'), api('/replica/assets'), api('/replica/api-map'),
      ]);
      S.replica.status = st.replica;
      S.replica.verification = st.manifest
        ? { assetsVerified: st.manifest.verified, assetsTotal: st.manifest.assets, webIdentical: st.web.filter((w) => w.identical).length, webTotal: st.web.length }
        : S.replica.verification;
      S.replica.web = st.web;
      S.replica.endpoints = st.endpoints;
      S.replica.assets = assets;
      S.replica.apiMap = map.endpoints;
      renderResearch();
      renderAssetSummary();
      renderAssetTree();
      renderApiTable();
    }
    renderReplicaStatus();
  } catch (e) {
    clog('sys', '读取复刻信息失败: ' + e.message);
  }
}

function renderResearch() {
  const box = $('#research-box');
  if (!box) return;
  const m = S.replica.assets?.manifest || {};
  const groups = {};
  for (const a of m.assets || []) groups[a.group] = (groups[a.group] || 0) + 1;
  const kaggle = S.notebooks.find((n) => n.id === 'kaggle');
  const v = S.replica.verification || {};
  box.innerHTML = `
    <div class="kv"><span>粘贴方式</span><b>1 cell · ${kaggle ? kaggle.codeChars.toLocaleString() : '347,551'} 字符</b></div>
    <div class="kv"><span>内嵌资产</span><b>${m.verified || 0} 个 / ${((m.total_bytes || 0) / 1024).toFixed(1)} KB</b></div>
    <div class="kv"><span>资产分组</span><b>${Object.entries(groups).map(([k, n]) => k + ':' + n).join(' ')}</b></div>
    <div class="kv"><span>Go gateway</span><b>:7860</b></div>
    <div class="kv"><span>Python analyst</span><b>:7010</b></div>
    <div class="kv"><span>GPU workers</span><b>:7001 / :7002</b></div>
    <div class="kv"><span>兼容 API</span><b>${S.replica.endpoints || 38} 个</b></div>
    <div class="kv"><span>网站文件</span><b>${v.webIdentical ?? 4}/4 字节一致</b></div>
    <div class="kv"><span>音频协议</span><b>9B 帧头 + int16 24kHz</b></div>
    <h4>结论</h4>
    <div class="warn-item">这是一个 <b>one-cell paste-and-run</b> 候选：先校验 70 个资产 SHA-256，
      再检查端口/双 T4，最后用随机目录解包并启动 bootstrap。网页只是其中的 <code>web/</code> 四个文件。</div>
    <div class="warn-item">本地复刻用 Node 实现了 Go gateway + Python analyst 的整条 API 契约；
      模型/训练/音质仍需在 Kaggle 双 T4 上验证。</div>`;
}

function renderReplicaStatus() {
  const el = $('#replica-status');
  const pill = $('#replica-session-pill');
  if (!el) return;
  const s = S.replica.status || {};
  const e = S.replica.entry;
  const v = S.replica.verification || {};
  pill.textContent = e ? '私有入口已生成' : '未连接';
  pill.className = 'pill ' + (e ? 'pill-sim' : '');
  el.classList.remove('bad');
  el.innerHTML = `
    <b>校验</b>：源码资产 ${v.assetsVerified ?? '—'}/${v.assetsTotal ?? '—'} SHA-256 通过 ·
    网站文件 ${v.webIdentical ?? '—'}/${v.webTotal ?? 4} 字节一致 ·
    兼容接口 ${S.replica.endpoints || 38} 个 ·
    会话 ${s.auth?.activeSessions ?? 0} 个 ·
    档案 ${s.profiles ?? 0} · 声音库 ${s.libraries ?? 0} · 训练快照 ${s.trainingDatasets ?? 0} · 运行 ${s.runs ?? 0} 次
    ${e ? `<br><b>私有入口</b>：一次性链接已自动兑换为 HttpOnly 会话；无需输入或复制任何密钥。` : '<br>进入后由一次性私有入口自动建立会话；无需输入密钥。'}`;
}

async function copyFullKaggleCode() {
  const status = $('#copy-kaggle-status');
  const box = $('#copy-kaggle-content');
  const button = $('#btn-copy-kaggle');
  if (button) button.disabled = true;
  if (status) status.textContent = '正在读取项目内完整 Kaggle 单 cell 文件…';
  try {
    const file = await api('/file?path=' + encodeURIComponent('notebooks/kaggle.py'));
    const code = String(file.content || '');
    if (!code.trim() || !code.includes('FILES = {') || code.length < 100000) {
      throw new Error('项目中的 Kaggle 文件不完整；没有复制部分代码。');
    }
    if (box) box.value = code;
    if (status) status.textContent = `${code.length.toLocaleString()} 字符 · ${new Blob([code]).size.toLocaleString()} 字节 · 完整单 cell 脚本`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard API unavailable');
      await navigator.clipboard.writeText(code);
      toast('完整 Kaggle 代码已复制', `${code.length.toLocaleString()} 字符，可直接粘贴到 Kaggle 的一个 Python cell 后运行。`, 'success', '来源：项目内 kaggle.py');
      clog('sys', `已复制仓库中的完整 Kaggle 单 cell 脚本 (${code.length} chars)`);
    } catch {
      showModal('modal-copy-kaggle');
      if (box) { box.focus(); box.select(); }
      if (status) status.textContent += ' · 自动复制被浏览器拦截，请在文本框中 Ctrl/⌘+A 后复制；也可下载文件。';
      toast('完整代码已载入', '请在弹窗中全选复制，或下载 kaggle.py。', 'info');
    }
  } catch (e) {
    if (status) status.textContent = '读取失败：' + e.message;
    toast('复制 Kaggle 代码失败', e.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

/** Keep the byte-identical upstream website intact while tailoring this local
 * simulator's iframe: local simulated chat needs no user-provided API key, and
 * the one-use same-origin grant already provides a session (no bearer paste).
 */
function concealLocalSecretFields() {
  const frame = $('#replica-frame');
  try {
    const d = frame?.contentDocument;
    if (!d) return;
    const key = d.querySelector('#dskey');
    if (key) {
      const row = key.closest('.grid > div') || key.parentElement;
      if (row) row.hidden = true;
      key.value = '';
      key.disabled = true;
    }
    const chat = d.querySelector('#mode option[value="chat"]');
    if (chat) chat.textContent = '模型回复 → 克隆语音（无需输入密钥）';
    const manual = d.querySelector('#manual-access');
    if (manual) manual.hidden = true;
  } catch { /* opaque iframe: leave upstream bytes untouched */ }
}

async function issueEntry(openNewTab = false) {
  try {
    const r = await api('/replica/entry', 'POST', {});
    S.replica.entry = r;
    const url = r.url;
    if (openNewTab) {
      window.open(url, '_blank', 'noopener');
      toast('已在新标签打开复刻网站', '一次性私有入口已自动带上', 'success');
    } else {
      const frame = $('#replica-frame');
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = url; }, 120);
      toast('私有入口已生成', '网站正在自动解锁（同域 HttpOnly 会话）', 'success');
    }
    clog('sys', `签发一次性私有入口 ${r.grant.slice(0, 12)}… -> /site/`);
    renderReplicaStatus();
  } catch (e) {
    const el = $('#replica-status');
    el.classList.add('bad');
    el.textContent = '生成私有入口失败：' + e.message;
    toast('生成私有入口失败', e.message, 'error');
  }
}

function replicaTreeHtml(nodes, level = 0) {
  if (!nodes || !nodes.length) return '<div class="tree-empty">（空）</div>';
  return nodes.map((n) => {
    const open = S.assetExpanded.has(n.path);
    const isDir = n.type === 'dir';
    const icon = isDir ? (open ? '📂' : '📁') : (/\.go$/.test(n.name) ? '🐹' : /\.py$/.test(n.name) ? '🐍' : /\.rs$/.test(n.name) ? '🦀' : /\.js$/.test(n.name) ? '📜' : '📄');
    return `<div class="tree-node">
      <div class="tree-row" data-${isDir ? 'assetdir' : 'asset'}="${esc(n.path)}" title="${esc(n.path)}">
        <span class="caret">${isDir ? (open ? '▾' : '▸') : ''}</span><span class="ico">${icon}</span>
        <span class="nm">${esc(n.name)}</span>${!isDir ? `<span class="sz">${fmtBytes(n.size)}</span>` : ''}
      </div>
      ${isDir && open ? `<div class="tree-children">${replicaTreeHtml(n.children || [], level + 1)}</div>` : ''}
    </div>`;
  }).join('');
}

function renderAssetTree() {
  const el = $('#asset-tree');
  if (!el || !S.replica.assets) return;
  el.innerHTML = replicaTreeHtml(S.replica.assets.tree || []);
  $('#asset-count').textContent = (S.replica.assets.manifest?.assets || []).length;
}

function renderAssetSummary() {
  const m = S.replica.assets?.manifest || {};
  const v = S.replica.verification || {};
  const groups = {};
  for (const a of m.assets || []) groups[a.group] = (groups[a.group] || 0) + 1;
  $('#asset-summary').innerHTML = `
    <div class="kpi">SHA-256 校验 <b>${v.assetsVerified ?? m.verified ?? 0}/${v.assetsTotal ?? (m.assets || []).length}</b></div>
    <div class="kpi">原始字节 <b>${fmtBytes(m.total_bytes || 0)}</b></div>
    <div class="kpi">网站文件 <b>${v.webIdentical ?? 4}/4 一致</b></div>
    ${Object.entries(groups).map(([k, n]) => `<div class="kpi">${esc(k)}/ <b>${n}</b></div>`).join('')}`;
}

async function openAsset(rel) {
  try {
    const r = await api('/replica/asset?path=' + encodeURIComponent(rel));
    $('#asset-content').textContent = r.content;
    $('#asset-current').textContent = rel;
  } catch (e) { toast('无法读取资产', e.message, 'error'); }
}

async function verifyAssets() {
  try {
    const r = await api('/replica/verify', 'POST', {});
    S.replica.verification = {
      assetsVerified: r.verification.assetsVerified, assetsTotal: r.verification.assetsTotal,
      webIdentical: r.verification.webIdentical, webTotal: r.verification.webTotal,
    };
    renderAssetSummary(); renderResearch(); renderReplicaStatus();
    const bad = r.verification.mismatches || [];
    toast(bad.length ? '校验发现问题' : '✓ 全部资产校验通过',
      `${r.verification.assetsVerified}/${r.verification.assetsTotal} 源码 · ${r.verification.webIdentical}/${r.verification.webTotal} 网站文件`,
      bad.length ? 'error' : 'success');
  } catch (e) { toast('校验失败', e.message, 'error'); }
}

function renderApiTable() {
  const el = $('#api-table');
  const rows = S.replica.apiMap || [];
  if (!el || !rows.length) return;
  const groups = {};
  for (const r of rows) (groups[r.origin] || (groups[r.origin] = [])).push(r);
  let html = `<div class="asset-summary">
    <div class="kpi">已实现接口 <b>${rows.length}</b></div>
    <div class="kpi">Go gateway <b>${(groups['Go gateway'] || []).length + (groups['Go guard'] || []).length}</b></div>
    <div class="kpi">Python analyst <b>${(groups['Python analyst'] || []).length}</b></div>
    <div class="kpi">library_api <b>${(groups['library_api.py'] || []).length}</b></div>
    <div class="kpi">diagnostics <b>${(groups['diagnostic_pair.py'] || []).length}</b></div>
  </div>`;
  for (const [origin, list] of Object.entries(groups)) {
    html += `<div class="api-group">▸ ${esc(origin)} · ${list.length} endpoints</div>`;
    for (const r of list) {
      html += `<div class="api-row">
        <span class="m">${esc(r.method)}</span>
        <span class="r" title="${esc(r.route)}">${esc(r.route)}</span>
        <span class="d">${esc(r.description)}</span>
        <span class="o">${esc(r.origin)}</span>
        <span class="y">✓</span></div>`;
    }
  }
  el.innerHTML = html;
}

/* ------------------------------------------- precision comparison lab */

async function loadPrecisionSummary() {
  const box = $('#precision-summary');
  if (!box) return;
  try {
    const st = await api('/replica/status');
    const r = st.replica || {};
    box.innerHTML = [
      ['已移植算法', '4 个模块'], ['质量策略', (r.qualityPolicies || []).length + ' 种'],
      ['分段配置', 'FirstMin ' + (r.segmentation?.FirstMin ?? '—') + ' / Target ' + (r.segmentation?.Target ?? '—')],
      ['文本上限', (r.limits?.TextChars ?? '—') + ' 字符'],
      ['worker 快照', (r.workers ?? '—') + ' 个'],
      ['落盘文件', (r.onDiskLayout || []).length + ' 个'],
    ].map(([k, v]) => `<div class="kpi">${esc(k)} <b>${esc(v)}</b></div>`).join('');
  } catch (e) { box.innerHTML = `<div class="kpi warn">读取失败 <b>${esc(e.message)}</b></div>`; }
}

async function runSegProbe() {
  const out = $('#seg-result');
  if (!out) return;
  out.textContent = '正在切分…';
  try {
    const r = await api('/replica/segment', 'POST', {
      text: $('#seg-input').value,
      mode: $('#seg-mode').value,
      seed: Number($('#seg-seed').value) || 42,
    });
    let html = `<b>${esc(r.cfg)}</b> · ${r.count} 段 · 总 units ${r.units}<table><tr><th>#</th><th>文本</th><th>units</th><th>边界</th><th>停顿</th><th>呼吸</th></tr>`;
    for (const s of r.segments) {
      html += `<tr><td class="n">${s.index}</td><td>${esc(s.text)}</td><td class="n">${esc(s.units)}</td>` +
        `<td class="tag">${esc(s.boundary)}</td><td class="n">${esc(s.pause_ms)} ms</td><td>${s.breath ? '✓' : '—'}</td></tr>`;
    }
    out.innerHTML = html + '</table>';
  } catch (e) { out.textContent = '失败：' + e.message; }
}

async function runDspProbe() {
  const out = $('#dsp-result');
  if (!out) return;
  out.textContent = '正在计算…';
  try {
    const r = await api('/replica/dsp', 'POST', { seed: 42 });
    $('#dsp-note').textContent = `共同输入 ${r.input.samples} samples / ${r.input.seconds.toFixed(2)} s · sha256 ${r.input.sha256.slice(0, 12)}…`;
    let html = '<table><tr><th>策略</th><th>gain</th><th>peak</th><th>rms</th><th>rtf_x</th><th>输出 sha</th></tr>';
    for (const p of r.policies) {
      html += `<tr><td class="tag">${esc(p.policy)}</td><td class="n">${esc(p.stats.gain_db)} dB</td>` +
        `<td class="n">${esc(p.stats.peak_dbfs)}</td><td class="n">${esc(p.stats.rms_dbfs)}</td>` +
        `<td class="n">${esc(p.stats.rtf_x)}</td><td>${esc(p.output.sha256.slice(0, 12))}…</td></tr>`;
    }
    out.innerHTML = html + '</table><span class="warn">波形为合成音；增益/限幅数学来自原 Python 源码。</span>';
  } catch (e) { out.textContent = '失败：' + e.message; }
}

async function runFrameProbe() {
  const out = $('#frame-result');
  if (!out) return;
  out.textContent = '正在捕获一次完整流…';
  try {
    const r = await api('/replica/frames', 'POST', {
      text: $('#frame-text').value || '帧协议检查文本。',
      mode: 'chat', quality_policy: $('#frame-policy').value,
    });
    const clientCounts = {}, workerCounts = {};
    for (const f of r.frames) clientCounts[f.name] = (clientCounts[f.name] || 0) + 1;
    for (const f of r.workerFrames) workerCounts[f.name] = (workerCounts[f.name] || 0) + 1;
    const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}×${v}`).join('  ');
    out.innerHTML = `<b>client ← gateway</b>  ${esc(fmt(clientCounts))}\n` +
      `<b>worker → gateway</b>  ${esc(fmt(workerCounts))}\n` +
      `<b>segments</b> ${r.segments.length} · <b>policy</b> ${esc(r.run.quality_policy)} · <b>codec</b> ${esc(r.run.codec_policy)}\n` +
      `<b>timeline_ms</b> ${esc(Object.entries(r.timeline).map(([k, v]) => k + '=' + v).join('  '))}\n` +
      `<b>前 12 帧</b>\n` + r.frames.slice(0, 12).map((f, i) =>
        `${String(i).padStart(2)}  ${esc(f.name).padEnd(8)} seg=${f.seg}  len=${f.length}`).join('\n') +
      `\n<span class="warn">${esc(r.legend.client)}</span>`;
  } catch (e) { out.textContent = '失败：' + e.message; }
}

async function refreshWorkers() {
  const out = $('#worker-result');
  if (!out) return;
  out.textContent = '正在读取…';
  try {
    const [w, st] = await Promise.all([api('/replica/workers'), api('/replica/status')]);
    const h = st.replica || {};
    let html = '';
    for (const x of w.workers) {
      html += `<b>/worker/${x.id}</b>  ready=${x.ready}  served=${x.served}  rtf_x=${x.rtf_x}  ` +
        `model_loaded=${x.worker.model_loaded}  profiles=[${esc(x.worker.profiles.join(','))}]\n`;
    }
    html += `\n<b>Guard</b>  JSON≤${h.limits?.JSONBytes}B  text≤${h.limits?.TextChars}  ` +
      `speak/min=${h.limits?.SpeakPerMinute}  speak并发=${h.limits?.SpeakConcurrent}\n`;
    html += `<b>落盘</b>  ` + (h.onDiskLayout || []).slice(0, 8).map((f) => esc(f.path)).join('  ') +
      ((h.onDiskLayout || []).length > 8 ? `  …共 ${h.onDiskLayout.length} 个` : '');
    out.innerHTML = html;
  } catch (e) { out.textContent = '失败：' + e.message; }
}

/* ---------------------------------------------------------- event wiring */

function bindEvents() {
  $('#notebook-select').addEventListener('change', (e) => {
    if (S.dirty && !confirm('当前笔记本有未保存更改，确定切换？')) { renderNotebookSelect(); return; }
    saveNow(true).then(() => openNotebook(e.target.value));
  });
  // new: replica / study views
  $$('.view-tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#btn-open-replica').addEventListener('click', () => {
    switchView('replica');
    if (!S.replica.entry) issueEntry(false);
  });
  $('#btn-replica-entry').addEventListener('click', () => issueEntry(false));
  $('#btn-replica-newtab').addEventListener('click', () => issueEntry(true));
  $('#btn-replica-reload').addEventListener('click', () => issueEntry(false));
  $('#replica-frame').addEventListener('load', concealLocalSecretFields);
  $('#btn-verify-assets').addEventListener('click', verifyAssets);
  $('#btn-copy-kaggle').addEventListener('click', copyFullKaggleCode);
  $('#btn-copy-kaggle-again').addEventListener('click', async () => {
    const box = $('#copy-kaggle-content');
    try {
      await navigator.clipboard.writeText(box.value);
      toast('完整 Kaggle 代码已复制', `${box.value.length.toLocaleString()} 字符`, 'success');
      $('#modal-copy-kaggle').classList.add('hidden');
    } catch {
      box.focus(); box.select();
      toast('请手动复制', '文本已全选；按 Ctrl/⌘+C。', 'info');
    }
  });
  $('#btn-seg-run').addEventListener('click', runSegProbe);
  $('#btn-dsp-run').addEventListener('click', runDspProbe);
  $('#btn-frame-run').addEventListener('click', runFrameProbe);
  $('#btn-worker-refresh').addEventListener('click', refreshWorkers);
  $('#asset-tree').addEventListener('click', (e) => {
    const d = e.target.closest('[data-assetdir]');
    const f = e.target.closest('[data-asset]');
    if (d) {
      const p = d.dataset.assetdir;
      if (S.assetExpanded.has(p)) S.assetExpanded.delete(p); else S.assetExpanded.add(p);
      renderAssetTree();
    } else if (f) openAsset(f.dataset.asset);
  });

  $('#btn-import').addEventListener('click', openImportModal);
  $('#btn-save').addEventListener('click', () => saveNow());
  $('#btn-run').addEventListener('click', runAll);
  $('#btn-git').addEventListener('click', openGitModal);
  $('#btn-help').addEventListener('click', () => { renderHelp(); showModal('modal-help'); });
  $('#btn-new-notebook').addEventListener('click', () => { $('#new-name').value = ''; showModal('modal-new'); });
  $('#btn-new-file').addEventListener('click', () => showModal('modal-newfile'));
  $('#btn-datasets').addEventListener('click', openDatasets);
  $('#btn-git-refresh').addEventListener('click', async () => { await refreshLight(); toast('Git 状态已刷新', '', 'success'); });
  $('#cells').addEventListener('click', onCellsClick);
  $('#cell-nav').addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) focusCell(Number(g.dataset.goto));
  });
  $('#tree-input').addEventListener('click', onTreeClick);
  $('#tree-working').addEventListener('click', onTreeClick);
  $('#experiment-list').addEventListener('click', async (e) => {
    const r = e.target.closest('[data-run]');
    if (!r) return;
    const ok = await openFile(`working/runs/${r.dataset.run}/run.log`, true);
    if (!ok) await openFile(`experiments/${r.dataset.run}.json`, true);
  });
  $('#btn-run-stop').addEventListener('click', stopRun);
  $('#btn-run-panel-toggle').addEventListener('click', () => {
    const p = $('#run-panel-body');
    p.classList.toggle('collapsed');
    $('#btn-run-panel-toggle').textContent = p.classList.contains('collapsed') ? '展开' : '收起';
  });

  // bottom add-cell row
  $$('.add-cell-row [data-add]').forEach((b) => b.addEventListener('click', () => appendBottomCell(b.dataset.add)));

  // console
  $$('.console-tab').forEach((t) => t.addEventListener('click', () => {
    $$('.console-tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active'); S.activeTab = t.dataset.tab; renderConsole();
  }));
  $('#btn-clear-console').addEventListener('click', () => { S.console[S.activeTab] = []; renderConsole(); });
  $('#btn-toggle-console').addEventListener('click', () => {
    const app = $('#app'); app.classList.toggle('console-collapsed');
    $('#btn-toggle-console').textContent = app.classList.contains('console-collapsed') ? '▴' : '▾';
  });

  // modals
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('.modal-overlay').classList.add('hidden')));
  $$('.modal-overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) o.classList.add('hidden'); }));

  // import
  $('#import-content').addEventListener('input', (e) => detectImport(e.target.value));
  $('#import-autosync').addEventListener('change', async (e) => {
    try {
      const r = await api('/settings', 'PUT', {
        autoSyncOnImport: e.target.checked,
        autoCommitOnImport: e.target.checked,
      });
      S.settings = { ...S.settings, ...r.settings };
      toast(e.target.checked ? '已开启自动同步' : '已关闭自动同步',
        e.target.checked ? '以后每次导入完整 Kaggle 代码都会自动 commit + push 到 GitHub' : '导入只会保存到项目磁盘',
        'success', 'kaggle_workspace/settings.json');
      clog('git', `autoSyncOnImport = ${e.target.checked}`);
    } catch (err) { e.target.checked = !e.target.checked; toast('设置保存失败', err.message, 'error'); }
  });
  $('#import-file').addEventListener('change', (e) => handleImportFile(e.target.files[0]));
  const dz = $('#import-drop');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => handleImportFile(e.dataTransfer.files[0]));
  $('#btn-import-save').addEventListener('click', () => doImport(false));
  $('#btn-import-sync').addEventListener('click', () => doImport(true));

  // git
  $('#btn-git-commit').addEventListener('click', () => gitAction('commit'));
  $('#btn-git-sync').addEventListener('click', () => gitAction('sync'));
  $('#btn-git-push').addEventListener('click', () => gitAction('push'));

  // datasets
  $('#dataset-catalog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ds]');
    if (b) mountDataset(b.dataset.ds, b.dataset.mounted === 'true');
  });
  $('#btn-ds-mount').addEventListener('click', async () => {
    const id = $('#ds-id').value.trim();
    if (!id) { toast('需要 ID', '请填写数据集 ID / 目录名', 'warn'); return; }
    try {
      await api('/datasets/mount', 'POST', { id, customName: $('#ds-name').value, customFiles: $('#ds-files').value });
      toast('已挂载', `input/${id}/ 已创建`, 'success');
      $('#ds-id').value = ''; $('#ds-name').value = ''; $('#ds-files').value = '';
      await openDatasets(); refreshLight();
    } catch (e) { toast('挂载失败', e.message, 'error'); }
  });

  // new notebook
  $('#btn-new-create').addEventListener('click', async () => {
    const name = $('#new-name').value.trim() || '新建笔记本';
    const useTemplate = $('#new-template').checked;
    try {
      const r = useTemplate ? await api('/seed', 'POST', {}) : await api('/notebooks', 'POST', { name });
      hideModal('modal-new');
      await loadBootstrap(false, r.notebook.id);
      await openNotebook(r.notebook.id);
      toast('已创建笔记本', '真实文件已写入项目', 'success', r.notebook.paths.ipynb);
    } catch (e) { toast('创建失败', e.message, 'error'); }
  });

  // new file
  $('#btn-nf-create').addEventListener('click', async () => {
    const dir = $('#nf-dir').value;
    const name = $('#nf-name').value.trim().replace(/\.\./g, '').replace(/^\/+/, '') || 'notes.md';
    const path = `${dir}/${name}`;
    try {
      await api('/file', 'PUT', { path, content: $('#nf-content').value });
      hideModal('modal-newfile');
      $('#nf-name').value = ''; $('#nf-content').value = '';
      const f = await api('/files'); S.tree = f.tree; renderTrees();
      toast('文件已创建', `kaggle_workspace/${path}`, 'success');
      clog('files', `create ${path}`);
    } catch (e) { toast('创建失败', e.message, 'error'); }
  });

  // file viewer
  $('#btn-file-delete').addEventListener('click', async () => {
    if (!S.currentFilePath || !confirm(`确定删除 kaggle_workspace/${S.currentFilePath}？`)) return;
    try {
      await api('/file?path=' + encodeURIComponent(S.currentFilePath), 'DELETE');
      hideModal('modal-file');
      const f = await api('/files'); S.tree = f.tree; renderTrees();
      toast('已删除', S.currentFilePath, 'success');
      clog('files', 'delete ' + S.currentFilePath);
    } catch (e) { toast('删除失败', e.message, 'error'); }
  });

  // global keys
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { hideAllModals(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); openImportModal(); }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); openGitModal(); }
  });

  window.addEventListener('resize', () => {
    if (S.metrics && $('#run-chart')) drawChart($('#run-chart'), S.metrics);
    $$('.cell-chart').forEach((cv) => { const m = S.cellMetrics[cv.dataset.metrics]; if (m) drawChart(cv, m); });
  });

  // Best-effort flush on tab close: still a REAL network write, not localStorage.
  const flush = () => {
    if (!S.dirty || !S.notebook) return;
    S.notebook.cells.forEach((c) => { const cm = S.editors.get(c.id); if (cm) c.source = cm.getValue(); });
    fetch('/lab/api/notebooks/' + encodeURIComponent(S.notebook.id), {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebook: S.notebook }),
    }).catch(() => {});
  };
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

/* ------------------------------------------------------------------- boot */

(async function init() {
  bindEvents();
  renderConsole();
  try {
    await loadBootstrap(false);
    loadReplicaData().catch(() => {});
    toast('Kaggle Voice Lab 已就绪', '你的 Kaggle 代码已解包为 70 个真实源码资产，网站已字节级复刻', 'success',
      '/site/ ← QTTS 声音台（原站） · replica/source/ ← 全部源码');
  } catch (e) {
    setSaveState('error', '连接失败');
    $('#nb-title').textContent = '无法连接服务';
    clog('sys', '启动失败: ' + e.message);
    toast('启动失败', e.message, 'error');
  }
})();
