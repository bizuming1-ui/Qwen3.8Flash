'use strict';
/**
 * notebook.js — import / export / CRUD for real .ipynb + .py files.
 *
 * A pasted Kaggle notebook JSON or a pasted Python script becomes:
 *   1. kaggle_workspace/notebooks/<slug>.ipynb  (nbformat 4, opens in Kaggle/Jupyter)
 *   2. kaggle_workspace/notebooks/<slug>.py     (plain script export)
 * Both are ordinary files in this git repository.
 */

const fs = require('fs');
const path = require('path');
const W = require('./workspace');

const PY_MARKER = /^\s*#\s*(?:%%(?:\s*\[(?:code|markdown)\])?|In\[[^\]]*\]\s*:?|={4,}|-{4,}\s*(?:cell|步骤|step|phase)?\s*-*|[=#]{4,}\s*\S.*(?:cell|step|步骤))/i;

function splitLinesKeepEnd(source) {
  const lines = String(source).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l, i) => (i === lines.length - 1 ? l : l + '\n'));
}

function joinSource(src) {
  if (Array.isArray(src)) return src.join('');
  if (typeof src === 'string') return src;
  return '';
}

function newCell(type, source = '') {
  return {
    id: 'cell-' + W.randomId().slice(-10),
    type: type === 'markdown' ? 'markdown' : 'code',
    source,
    outputs: [],
  };
}

/** Convert an nbformat cell into our internal cell. */
function fromNbCell(cell, idx) {
  const type = cell.cell_type === 'markdown' ? 'markdown' : 'code';
  const outputs = Array.isArray(cell.outputs)
    ? cell.outputs.map((o) => {
        if (o.output_type === 'stream') return { type: 'stream', text: joinSource(o.text) };
        if (o.output_type === 'error') return { type: 'error', text: (o.traceback || []).join('\n') };
        if (o.data && o.data['text/plain']) return { type: 'text', text: joinSource(o.data['text/plain']) };
        return { type: 'text', text: '' };
      }).filter((o) => o.text)
    : [];
  return {
    id: (cell.id && /^[a-zA-Z0-9_-]{1,64}$/.test(cell.id)) ? cell.id : `cell-${idx}-${W.randomId().slice(-6)}`,
    type,
    source: joinSource(cell.source),
    outputs,
  };
}

function toNbCell(cell) {
  const base = {
    cell_type: cell.type === 'markdown' ? 'markdown' : 'code',
    id: cell.id,
    metadata: { kaggle_lab: { editor: 'python' } },
    source: splitLinesKeepEnd(cell.source),
  };
  if (base.cell_type === 'code') {
    base.execution_count = null;
    base.outputs = (cell.outputs || []).map((o) => ({
      output_type: 'stream',
      name: o.type === 'error' ? 'stderr' : 'stdout',
      text: splitLinesKeepEnd(o.text || ''),
    }));
  }
  return base;
}

function toIpynb(nb) {
  return {
    cells: nb.cells.map(toNbCell),
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: {
        name: 'python',
        version: '3.11.2',
        mimetype: 'text/x-python',
        codemirror_mode: { name: 'ipython', version: 3 },
        pygments_lexer: 'ipython3',
        nbconvert_exporter: 'python',
        file_extension: '.py',
      },
      kaggle: {
        accelerator: 'nvidiaTeslaT4',
        dataSources: [],
        isGpuEnabled: true,
        isInternetEnabled: false,
        language: 'python',
        sourceType: 'notebook',
      },
      kaggle_lab: {
        name: nb.name,
        origin: nb.origin || 'import',
        createdAt: nb.createdAt,
        updatedAt: nb.updatedAt,
        simulatedOutputs: (nb.cells || []).some((c) => (c.outputs || []).length > 0),
        note: 'Created by Kaggle Voice Lab. Outputs (if any) are SIMULATED, not produced by a real GPU run.',
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function cellsToPy(nb) {
  const header = [
    '# -*- coding: utf-8 -*-',
    `# Kaggle Voice Lab export — ${nb.name}`,
    `# Notebook id : ${nb.id}`,
    `# Exported at : ${nb.updatedAt}`,
    '#',
    '# This is a round-trippable "# %%" cell export of your Kaggle code.',
    '# Copy it back into a Kaggle/Jupyter cell (or re-import it here) at any time.',
    '# IPython magics (!pip, %time ...) are preserved VERBATIM: they need a notebook kernel.',
    '',
  ];
  const body = [];
  for (const c of nb.cells) {
    if (c.type === 'markdown') {
      body.push('# %% [markdown]');
      body.push(...String(c.source).split(/\r?\n/).map((l) => (l ? `# ${l}` : '#')));
    } else {
      body.push('# %%');
      body.push(...String(c.source).split(/\r?\n/));
    }
    body.push('');
  }
  return header.concat(body).join('\n');
}

/** Detect what the user pasted and turn it into cells. */
function parseImport(content, options = {}) {
  const text = String(content || '');
  const trimmed = text.trim();

  // 1) Full Kaggle / Jupyter notebook JSON.
  if (options.mode === 'ipynb' || trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && Array.isArray(obj.cells)) {
        const cells = obj.cells.length
          ? obj.cells.map(fromNbCell)
          : [newCell('code', '# empty notebook\n')];
        return {
          kind: 'ipynb',
          nbformat: obj.nbformat || 4,
          nbName: (obj.metadata && (obj.metadata.kaggle_lab || {}).name) || '',
          cells,
          splitInfo: { markersFound: true, cells: cells.length, note: '从 .ipynb JSON 恢复了所有 cell' },
        };
      }
    } catch (err) {
      if (options.mode === 'ipynb') throw new Error('不是合法的 .ipynb JSON: ' + err.message);
      // otherwise fall through and treat it as Python source
    }
  }

  // 2) Python / Kaggle script. Optionally split on cell markers.
  if (options.split === false || options.mode === 'code') {
    return {
      kind: 'python',
      cells: [newCell('code', text)],
      splitInfo: { markersFound: false, cells: 1, note: '完整代码保留为 1 个 cell（未做任何拆分）' },
    };
  }

  const lines = text.split(/\r?\n/);
  const markerIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (PY_MARKER.test(lines[i])) markerIdx.push(i);
  }
  if (markerIdx.length === 0) {
    return {
      kind: 'python',
      cells: [newCell('code', text)],
      splitInfo: {
        markersFound: false,
        cells: 1,
        note: '未检测到 # %% / # In[] 分隔符；为保证代码完整性，已保存为 1 个 cell。可手动添加 # %% 后重新导入。',
      },
    };
  }

  // Build segments. The marker line itself is a delimiter, never part of a cell.
  const segments = [];
  let segStart = 0;
  let segType = 'code';
  for (const idx of markerIdx) {
    segments.push({ type: segType, lines: lines.slice(segStart, idx) });
    segType = /\[markdown\]/i.test(lines[idx]) ? 'markdown' : 'code';
    segStart = idx + 1;
  }
  segments.push({ type: segType, lines: lines.slice(segStart) });

  const cells = [];
  for (const seg of segments) {
    let src = seg.type === 'markdown'
      ? seg.lines.map((l) => l.replace(/^\s*#\s?/, '')).join('\n')
      : seg.lines.join('\n');
    src = src.replace(/^\n+/, '').replace(/\s+$/, '');
    if (src.trim()) cells.push(newCell(seg.type, src + '\n'));
  }
  if (!cells.length) cells.push(newCell('code', text));

  return {
    kind: 'python',
    cells,
    splitInfo: { markersFound: true, cells: cells.length, note: `按 ${markerIdx.length} 个 cell 分隔符拆分` },
  };
}

function notebookPaths(id) {
  const slug = W.slugify(id, 'notebook');
  return {
    ipynb: `notebooks/${slug}.ipynb`,
    py: `notebooks/${slug}.py`,
  };
}

function loadNotebook(id) {
  const paths = notebookPaths(id);
  const json = W.readJson(paths.ipynb);
  const lab = (json.metadata && json.metadata.kaggle_lab) || {};
  const stat = fs.statSync(W.safePath(paths.ipynb));
  return {
    id: W.slugify(id, 'notebook'),
    name: lab.name || W.slugify(id, 'notebook'),
    origin: lab.origin || 'import',
    createdAt: lab.createdAt || stat.birthtime.toISOString(),
    updatedAt: lab.updatedAt || stat.mtime.toISOString(),
    language: 'python',
    cells: (json.cells || []).map(fromNbCell),
    paths,
  };
}

function saveNotebook(nb, { touch = true } = {}) {
  const id = W.slugify(nb.id, 'notebook');
  if (!id) throw new Error('invalid notebook id');
  const paths = notebookPaths(id);
  const now = touch ? W.nowIso() : nb.updatedAt || W.nowIso();
  const clean = {
    id,
    name: String(nb.name || id).slice(0, 160),
    origin: nb.origin || 'import',
    createdAt: nb.createdAt || now,
    updatedAt: now,
    language: 'python',
    paths: { ipynb: paths.ipynb, py: paths.py },
    cells: (nb.cells || []).map((c) => ({
      id: String(c.id || newCell('code').id),
      type: c.type === 'markdown' ? 'markdown' : 'code',
      source: String(c.source ?? ''),
      outputs: (c.outputs || []).slice(-12).map((o) => ({ type: o.type || 'stream', text: String(o.text || '').slice(0, 200000) })),
    })),
  };
  W.writeJson(paths.ipynb, toIpynb(clean));
  W.writeText(paths.py, cellsToPy(clean));
  return clean;
}

function listNotebooks() {
  const dir = W.DIRS.notebooks;
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ipynb')) continue;
    const id = f.slice(0, -6);
    try {
      const nb = loadNotebook(id);
      out.push({
        id: nb.id,
        name: nb.name,
        origin: nb.origin,
        createdAt: nb.createdAt,
        updatedAt: nb.updatedAt,
        cellCount: nb.cells.length,
        codeChars: nb.cells.reduce((n, c) => n + c.source.length, 0),
        paths: nb.paths,
      });
    } catch (err) {
      out.push({ id, name: id, error: err.message, cellCount: 0 });
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

function createNotebook({ name, cells, origin = 'new', split = true } = {}) {
  const baseName = String(name || '新建笔记本').trim() || '新建笔记本';
  let id = W.slugify(baseName, 'notebook');
  const existing = new Set(listNotebooks().map((n) => n.id));
  if (existing.has(id)) {
    let i = 2;
    while (existing.has(`${id}-${i}`)) i += 1;
    id = `${id}-${i}`;
  }
  let finalCells;
  if (Array.isArray(cells) && cells.length) {
    finalCells = cells.map((c) => {
      const nc = newCell(c.type, c.source ?? '');
      if (c.id) nc.id = c.id;
      if (Array.isArray(c.outputs)) nc.outputs = c.outputs;
      return nc;
    });
  } else {
    const parsed = parseImport('', { split });
    finalCells = parsed.cells.map((c) => newCell(c.type, '# 在这里粘贴或编写你的 Kaggle 代码\n'));
  }
  const now = W.nowIso();
  return saveNotebook({
    id, name: baseName, origin, createdAt: now, updatedAt: now, cells: finalCells,
  });
}

function importNotebook({ content, name, mode = 'auto', split = true, origin = 'import' } = {}) {
  const parsed = parseImport(content, { mode, split });
  const guessed = parsed.nbName || String(name || '').trim();
  const baseName = guessed || `kaggle-code-${new Date().toISOString().slice(0, 10)}`;
  const created = createNotebook({ name: baseName, cells: parsed.cells, origin, split });
  return { ...created, import: { kind: parsed.kind, ...parsed.splitInfo } };
}

function deleteNotebook(id) {
  const paths = notebookPaths(id);
  const removed = [];
  for (const rel of [paths.ipynb, paths.py]) {
    try { W.remove(rel); removed.push(rel); } catch { /* already gone */ }
  }
  return { id: W.slugify(id, 'notebook'), removed };
}

module.exports = {
  newCell, splitLinesKeepEnd, joinSource,
  toIpynb, cellsToPy, parseImport, notebookPaths,
  loadNotebook, saveNotebook, listNotebooks, createNotebook, importNotebook, deleteNotebook,
};
