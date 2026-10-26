#!/usr/bin/env node
'use strict';
/** Syntax-check every server-side JS file without starting the app. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p);
    } else if (e.name.endsWith('.js')) files.push(p);
  }
}
walk(path.join(ROOT, 'server'));
walk(path.join(ROOT, 'scripts'));

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.Script(src, { filename: f });
    console.log('  ok  ', path.relative(ROOT, f));
  } catch (err) {
    bad++;
    console.error('  FAIL', path.relative(ROOT, f), '\n       ', err.message);
  }
}
console.log(`\n${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);
