'use strict';
/**
 * datasets.js — simulated /kaggle/input dataset mounting.
 * Mounting creates REAL files (metadata + README + file manifest) inside
 * kaggle_workspace/input/, so the paths your Kaggle code references actually
 * exist in this repository. It never downloads gigabytes of audio.
 */

const fs = require('fs');
const path = require('path');
const W = require('./workspace');
const { DATASET_CATALOG } = require('./templates');

function metaPath(id) {
  return `input/${id}/dataset-metadata.json`;
}

function listMounted() {
  const root = W.DIRS.input;
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    try {
      const meta = W.readJson(metaPath(id));
      out.push({ ...meta, mounted: true, path: `input/${id}` });
    } catch {
      out.push({ id, name: id, mounted: true, path: `input/${id}`, custom: true });
    }
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function mount(datasetId, { customName = '', customFiles = '' } = {}) {
  const id = W.slugify(datasetId, 'dataset');
  const preset = DATASET_CATALOG.find((d) => d.id === id);
  const name = customName.trim() || (preset ? preset.name : id);
  const files = (customFiles || (preset ? preset.files.join('\n') : 'README.md\n'))
    .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60);

  const meta = {
    id,
    name,
    kagglePath: `/kaggle/input/${id}`,
    localPath: `kaggle_workspace/input/${id}`,
    simulated: true,
    description: preset ? preset.description : '用户自定义数据集（仅保存元数据，未上传真实文件）。',
    license: preset ? preset.license : 'unknown',
    sizeLabel: preset ? preset.bytes : 'n/a',
    mountedAt: W.nowIso(),
    files,
    warning: '这是占位数据集：目录里只有元数据/清单，没有真实音频。真实数据请在 Kaggle 上挂载或自行上传。',
  };
  W.writeJson(metaPath(id), meta);
  W.writeText(`input/${id}/README.md`, [
    `# ${name}`,
    '',
    `> ⚠️ 模拟数据集 · 对应 Kaggle 路径 \`/kaggle/input/${id}\``,
    '',
    meta.description,
    '',
    `- 许可证: ${meta.license}`,
    `- 标称大小: ${meta.sizeLabel}`,
    `- 挂载时间: ${meta.mountedAt}`,
    '',
    '## 文件清单（占位）',
    '',
    ...files.map((f) => `- \`${f}\``),
    '',
    '这些条目只是清单文本，不代表文件真实存在。你可以用左侧「新建文件」把小的真实文件放进这个目录。',
    '',
  ].join('\n'));
  W.writeText(`input/${id}/files.txt`, files.join('\n') + '\n');
  W.writeJson(`input/${id}/.gitkeep.json`, { keep: true, note: 'keeps this simulated dataset directory in git' });
  return meta;
}

function unmount(datasetId) {
  const id = W.slugify(datasetId, 'dataset');
  const info = { id, removed: false, path: `input/${id}` };
  try { W.remove(`input/${id}`); info.removed = true; } catch (err) { info.error = err.message; }
  return info;
}

module.exports = { listMounted, mount, unmount };
