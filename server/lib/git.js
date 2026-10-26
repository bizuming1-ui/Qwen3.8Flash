'use strict';
/**
 * git.js — REAL git operations on this repository.
 * This is what makes "更新 GitHub" actually happen: the browser calls
 * /api/git/sync, we `git add -A && git commit && git push origin HEAD`.
 */

const { spawnSync } = require('child_process');
const W = require('./workspace');

const ROOT = W.ROOT;
const TIMEOUT_MS = 120000;

function git(args, { timeout = 30000 } = {}) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    ok: r.status === 0 && !r.error,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? r.error.message : null,
    command: 'git ' + args.join(' '),
  };
}

function cleanMessage(msg) {
  let m = String(msg || '')
    .replace(/[\r\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .trim();
  if (m.length > 240) m = m.slice(0, 240) + '…';
  return m || `Kaggle Voice Lab: 保存笔记本改动 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
}

function parsePorcelain(stdout) {
  const files = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0] || ' ';
    const y = line[1] || ' ';
    let p = line.slice(3).trim();
    // git quotes unusual paths
    if (p.startsWith('"') && p.endsWith('"')) {
      try { p = JSON.parse(p); } catch { /* leave as-is */ }
    }
    let renamedFrom = null;
    if ((x === 'R' || y === 'R' || x === 'C') && p.includes(' -> ')) {
      const bits = p.split(' -> ');
      renamedFrom = bits[0];
      p = bits[bits.length - 1];
    }
    let state = 'modified';
    if (x === '?' && y === '?') state = 'untracked';
    else if (x === 'A' || y === 'A') state = 'added';
    else if (x === 'D' || y === 'D') state = 'deleted';
    else if (x === 'R' || y === 'R') state = 'renamed';
    else if (x === 'M' || y === 'M') state = 'modified';
    files.push({ path: p, state, staged: x !== ' ' && x !== '?', renamedFrom });
  }
  return files;
}

function status() {
  const [branchR, remoteR, porcelainR, sbR, lastR] = [
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['remote', 'get-url', 'origin']),
    git(['status', '--porcelain=v1', '-uall']),
    git(['status', '-sb']),
    git(['log', '-1', '--pretty=format:%h%x09%an%x09%ar%x09%s']),
  ];
  const sbFirst = (sbR.stdout || '').split('\n')[0] || '';
  const ahead = /ahead\s+(\d+)/.exec(sbFirst);
  const behind = /behind\s+(\d+)/.exec(sbFirst);
  const remote = (remoteR.stdout || '').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  const parts = (lastR.stdout || '').split('\t');
  return {
    ok: branchR.ok,
    branch: branchR.stdout || 'unknown',
    remote,
    webUrl: /^https?:\/\//.test(remote) ? remote : null,
    files: parsePorcelain(porcelainR.stdout || ''),
    dirty: parsePorcelain(porcelainR.stdout || '').length > 0,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    lastCommit: parts.length >= 4
      ? { hash: parts[0], author: parts[1], when: parts[2], subject: parts.slice(3).join('\t') }
      : null,
  };
}

function log(n = 12) {
  const r = git(['log', `--pretty=format:%h%x09%an%x09%ar%x09%s`, '-n', String(Math.min(Math.max(n, 1), 50))]);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, author, when, ...rest] = line.split('\t');
    return { hash, author, when, subject: rest.join('\t') };
  });
}

function diffStat() {
  const unstaged = git(['diff', '--stat']);
  const staged = git(['diff', '--cached', '--stat']);
  return [
    staged.stdout ? `--- staged ---\n${staged.stdout}` : '',
    unstaged.stdout ? `--- unstaged ---\n${unstaged.stdout}` : '',
  ].filter(Boolean).join('\n') || '(no textual diff — possibly new/untracked files)';
}

function commit(message) {
  const msg = cleanMessage(message);
  const add = git(['add', '-A']);
  if (!add.ok) return { ok: false, step: 'add', output: add.stderr || add.error, message: msg };
  const check = git(['diff', '--cached', '--quiet']);
  if (check.ok) {
    return { ok: true, nothingToCommit: true, message: msg, output: '工作区干净，没有需要提交的改动。' };
  }
  const c = git(['commit', '-m', msg]);
  return {
    ok: c.ok,
    nothingToCommit: false,
    message: msg,
    output: [c.stdout, c.stderr].filter(Boolean).join('\n') || (c.ok ? '已提交。' : '提交失败。'),
    hash: c.ok ? (git(['rev-parse', '--short', 'HEAD']).stdout || null) : null,
  };
}

function push() {
  // `git push origin HEAD` always pushes the CURRENT branch to its own remote
  // counterpart — never to main and never to some other branch.
  const p = git(['push', 'origin', 'HEAD'], { timeout: TIMEOUT_MS });
  return {
    ok: p.ok,
    output: [p.stdout, p.stderr].filter(Boolean).join('\n') || (p.ok ? 'push 完成。' : 'push 失败。'),
    command: p.command,
  };
}

function sync(message) {
  const c = commit(message);
  if (!c.ok) return { ok: false, step: 'commit', commit: c, push: null, output: c.output };
  const p = push();
  return {
    ok: p.ok,
    step: p.ok ? null : 'push',
    commit: c,
    push: p,
    output: [`$ ${c.message ? 'git commit -m "' + c.message + '"' : ''}`, c.output, '$ git push origin HEAD', p.output].filter(Boolean).join('\n'),
  };
}

module.exports = { ROOT, git, status, log, diffStat, commit, push, sync, cleanMessage };
