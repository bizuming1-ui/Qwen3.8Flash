#!/usr/bin/env node
'use strict';
/** CLI helper: (re)create the voice-cloning template notebook as real files. */
const NB = require('../server/lib/notebook');
const DS = require('../server/lib/datasets');
const { VOICE_CLONE_CELLS } = require('../server/lib/templates');

const nb = NB.createNotebook({
  name: '语音克隆实验 · Kaggle 模板 (CLI 副本)',
  cells: VOICE_CLONE_CELLS,
  origin: 'seed-cli',
});
DS.mount('my-voice');
console.log('created:');
console.log('  kaggle_workspace/' + nb.paths.ipynb);
console.log('  kaggle_workspace/' + nb.paths.py);
console.log('cells:', nb.cells.length);
