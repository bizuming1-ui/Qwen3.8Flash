'use strict';
/**
 * simulator.js — analyses the user's REAL Kaggle code and produces a
 * deterministic, clearly-labelled SIMULATION of what running it would look
 * like (logs, metrics, artifacts). It never pretends to train a model.
 *
 * Everything it emits is persisted as real files under
 * kaggle_workspace/working/runs/<id>/ and kaggle_workspace/experiments/.
 */

const fs = require('fs');
const path = require('path');
const W = require('./workspace');

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KNOWN_LIBS = [
  ['torch', 'PyTorch'], ['torchaudio', 'Torchaudio'], ['librosa', 'librosa'],
  ['soundfile', 'soundfile'], ['transformers', '🤗 Transformers'], ['TTS', 'Coqui TTS'],
  ['openvoice', 'OpenVoice'], ['speechbrain', 'SpeechBrain'], ['whisper', 'Whisper'],
  ['so_vits_svc', 'so-vits-svc'], ['numpy', 'NumPy'], ['scipy', 'SciPy'],
  ['pandas', 'pandas'], ['matplotlib', 'matplotlib'], ['tensorflow', 'TensorFlow'],
  ['tqdm', 'tqdm'], ['datasets', '🤗 datasets'], ['ffmpeg', 'ffmpeg'],
];

/** Static analysis of pasted code. Pure string work — no code execution. */
function analyze(code) {
  const src = String(code || '');
  const imports = new Set();
  const importRe = /^[ \t]*(?:import|from)\s+([A-Za-z_][\w.]*)/gm;
  let m;
  while ((m = importRe.exec(src)) !== null) imports.add(m[1].split('.')[0]);

  const libs = KNOWN_LIBS.filter(([key]) => imports.has(key) || new RegExp('\\b' + key + '\\b', 'i').test(src))
    .map(([key, label]) => label);
  const uniqueLibs = [...new Set(libs)];

  const hyper = {};
  // Handles both `epochs = 30` and JSON-style `"epochs": 30` / `'lr': 2e-4`.
  const hRe = /(?:^|[^\w])["']?(num_epochs|epochs?|batch_size|learning_rate|sample_rate|warmup_steps|max_steps|hop_length|n_mels|batch|lr|sr|steps|seed)["']?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/gim;
  while ((m = hRe.exec(src)) !== null) {
    const key = m[1].toLowerCase();
    if (!(key in hyper)) hyper[key] = Number(m[2]);
  }

  const datasets = [...new Set((src.match(/\/kaggle\/input\/[A-Za-z0-9_\-./]+/g) || [])
    .map((p) => p.replace(/[.,)]+$/, '')))].slice(0, 20);
  const outputs = [...new Set((src.match(/\/kaggle\/working\/[A-Za-z0-9_\-./]+/g) || [])
    .map((p) => p.replace(/[.,)]+$/, '')))].slice(0, 20);
  const classes = [...new Set((src.match(/^\s*class\s+(\w+)/gm) || [])
    .map((s) => s.trim().split(/\s+/)[1]))].slice(0, 20);
  const functions = [...new Set((src.match(/^\s*(?:async\s+)?def\s+(\w+)/gm) || [])
    .map((s) => s.trim().split(/\s+/).pop()))].slice(0, 30);
  const magicLines = (src.match(/^\s*[!%]\s*\w+/gm) || []).length;

  const stages = [];
  if (/(pip install|apt-get|import |from )/i.test(src)) stages.push('环境与依赖');
  if (/(dataset|\/kaggle\/input|load_audio|glob|DataLoader|read_csv|wav)/i.test(src)) stages.push('数据集加载');
  if (/(mel|spectrogram|resample|normalize|preprocess|trim)/i.test(src)) stages.push('音频预处理');
  if (/(class |nn\.Module|model|encoder|decoder|vocoder)/i.test(src)) stages.push('模型构建');
  if (/(for epoch|train\(|backward|optimizer|loss\.backward|tqdm)/i.test(src)) stages.push('模型训练');
  if (/(inference|synthesize|generate|torchaudio\.save|save\(|export)/i.test(src)) stages.push('推理与导出');
  if (!stages.length) stages.push('静态检查');

  const warnings = [];
  if (magicLines) warnings.push({ level: 'info', text: `检测到 ${magicLines} 行 IPython 魔法命令（!pip / %time），它们只能在 Kaggle/Jupyter 内核中运行。` });
  if (datasets.length) warnings.push({ level: 'info', text: `代码引用了 ${datasets.length} 个 /kaggle/input 路径；本项目的 input/ 目录保存的是占位元数据，不是真实数据集。` });
  if (/torch\.cuda|DEVICE\s*=\s*["']cuda/.test(src)) warnings.push({ level: 'info', text: '代码使用 CUDA；当前沙箱无 GPU，模拟运行只生成日志与指标。' });
  if (/os\.system|subprocess|eval\(|exec\(/.test(src)) warnings.push({ level: 'warn', text: '代码包含动态执行调用（os.system/eval/exec），导入时不会被执行。' });
  if (src.length > 200000) warnings.push({ level: 'warn', text: '粘贴的代码很长（>200 KB），建议拆分成多个 cell。' });
  if (!/seed|random_state/i.test(src)) warnings.push({ level: 'info', text: '未检测到随机种子设置，实验结果可能不可复现。' });

  return {
    chars: src.length,
    lines: src.split('\n').length,
    imports: [...imports].slice(0, 40),
    libs: uniqueLibs,
    hyperparams: hyper,
    datasets, outputs, classes, functions,
    stages, warnings, magicLines,
  };
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = Math.floor(sec % 60);
  return [h, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * Build a full event timeline. Each event: { type, at, delay, text?, ... }
 * `delay` = ms to wait AFTER emitting this event.
 */
function buildRun({ code, notebookId, notebookName, speed = 1, cellSources = [] }) {
  const id = W.randomId('run');
  const analysis = analyze(code);
  const rand = rng(hashString(code + '|' + id.slice(-6)));
  const epochs = Math.min(Math.max(Number(analysis.hyperparams.epochs || analysis.hyperparams.num_epochs || 12), 3), 60);
  const batch = Number(analysis.hyperparams.batch_size || analysis.hyperparams.batch || 16);
  const lr = Number(analysis.hyperparams.learning_rate || analysis.hyperparams.lr || 2e-4);
  const sr = Number(analysis.hyperparams.sample_rate || 24000);
  const base = Math.max(35, Math.round(105 / Math.min(Math.max(Number(speed) || 1, 0.25), 4)));

  const events = [];
  let clock = 0;
  const push = (ev, delay = base) => {
    clock += delay;
    events.push({ at: fmtTime(Math.round(clock / 1000 * 12)), delay, ...ev });
  };
  const log = (text, level = 'info', extra = {}) => push({ type: 'log', level, text, ...extra });

  log('╔══════════════════════════════════════════════════════════════╗', 'sim');
  log('║  KAGGLE VOICE LAB · SIMULATED RUN                            ║', 'sim');
  log('║  日志 / 指标 / 时间 均为模拟数据，未执行任何真实 GPU 训练        ║', 'sim');
  log('╚══════════════════════════════════════════════════════════════╝', 'sim');
  push({ type: 'stage', stage: '初始化会话', index: 0, total: analysis.stages.length + 2, detail: notebookName }, base);
  log(`notebook   : ${notebookId}.ipynb`, 'muted');
  log(`code       : ${analysis.lines} lines / ${analysis.chars} chars (saved on disk)`, 'muted');
  log(`runtime    : Python 3.11 · 2× Tesla T4 (simulated) · CUDA available: True (simulated)`, 'muted');
  log(`libs       : ${analysis.libs.length ? analysis.libs.slice(0, 8).join(', ') : 'standard library'}`, 'muted');

  push({ type: 'stage', stage: '挂载数据集', index: 1, total: analysis.stages.length + 2, detail: `${analysis.datasets.length} refs` }, base);
  if (analysis.datasets.length) {
    for (const d of analysis.datasets.slice(0, 6)) log(`mount  ${d}  ->  kaggle_workspace${d.replace('/kaggle', '')} (metadata only)`, 'muted');
  } else {
    log('mount  (no /kaggle/input reference found in code)', 'muted');
  }
  log(`audio config: sample_rate=${sr}, batch_size=${batch}, epochs=${epochs}, lr=${lr}`, 'muted');

  let stageIndex = 2;
  for (const stage of analysis.stages) {
    push({ type: 'stage', stage, index: stageIndex++, total: analysis.stages.length + 2, detail: 'scanning code' }, base);
    if (stage === '环境与依赖') log(`import ok  : ${analysis.imports.slice(0, 10).join(', ') || '—'}`, 'ok');
    if (stage === '数据集加载') log(`scan       : found ${Math.max(8, Math.round(rand() * 800))} audio files (simulated)`, 'muted');
    if (stage === '音频预处理') log(`preprocess : resample -> trim silence -> mel (n_mels=${analysis.hyperparams.n_mels || 80})`, 'ok');
    if (stage === '模型构建') log(`model      : ${analysis.classes.slice(0, 3).join(' / ') || 'AcousticModel'} | params ≈ ${(12 + rand() * 80).toFixed(1)}M (simulated)`, 'ok');
    if (stage === '静态检查') log('static analysis complete: no GPU execution requested', 'warn');
    if (stage === '推理与导出') log('vocoder    : HiFi-GAN (simulated)', 'muted');
  }

  const metrics = { loss: [], val_loss: [], mel_loss: [], lr: [], psnr: [] };
  let startLoss = 2.2 + rand() * 0.8;
  for (let e = 1; e <= epochs; e++) {
    const decay = Math.exp(-e / (epochs / 2.4));
    const loss = startLoss * decay + 0.12 + rand() * 0.10;
    const valLoss = loss + 0.10 + rand() * 0.09;
    const mel = loss * (0.55 + rand() * 0.1);
    const curLr = lr * Math.pow(0.97, e);
    metrics.loss.push(Number(loss.toFixed(5)));
    metrics.val_loss.push(Number(valLoss.toFixed(5)));
    metrics.mel_loss.push(Number(mel.toFixed(5)));
    metrics.lr.push(Number(curLr.toFixed(9)));
    metrics.psnr.push(Number((12 + 8 * (1 - decay) + rand()).toFixed(3)));
    push({
      type: 'metric', epoch: e, epochs,
      loss: metrics.loss[e - 1], val_loss: metrics.val_loss[e - 1],
      mel_loss: metrics.mel_loss[e - 1], lr: curLr, psnr: metrics.psnr[e - 1],
      text: `epoch ${String(e).padStart(3, ' ')}/${epochs}  loss=${loss.toFixed(4)}  val=${valLoss.toFixed(4)}  mel=${mel.toFixed(4)}  lr=${curLr.toExponential(2)}`,
    }, Math.max(30, Math.round(base * 0.85)));
  }

  push({ type: 'stage', stage: '保存产物', index: stageIndex++, total: analysis.stages.length + 2, detail: 'writing real files' }, base);
  const runDir = `working/runs/${id}`;
  const artifacts = [
    `${runDir}/run.log`,
    `${runDir}/metrics.json`,
    `${runDir}/config.json`,
    `${runDir}/README.md`,
    `experiments/${id}.json`,
  ];
  for (const a of artifacts) log(`write      : kaggle_workspace/${a}`, 'ok');
  log('done       : simulation finished. No model weights were produced.', 'ok');
  push({
    type: 'done',
    summary: {
      epochs, batch, lr, sr,
      finalLoss: metrics.loss[metrics.loss.length - 1],
      finalValLoss: metrics.val_loss[metrics.val_loss.length - 1],
      artifacts,
      simulated: true,
    },
  }, 10);

  return {
    id,
    createdAt: W.nowIso(),
    notebookId, notebookName, speed,
    analysis, metrics, events, artifacts,
    codeChars: analysis.chars,
  };
}

/** Persist a completed run as real files on disk. Returns the written paths. */
function finalizeRun(run) {
  const dir = path.join(W.DIRS.working, 'runs', run.id);
  fs.mkdirSync(dir, { recursive: true });
  const logLines = run.events.filter((e) => e.type === 'log').map((e) => e.text);
  const header = [
    '# SIMULATED RUN LOG — Kaggle Voice Lab',
    `# run id      : ${run.id}`,
    `# notebook    : ${run.notebookId}.ipynb`,
    `# created at  : ${run.createdAt}`,
    '# IMPORTANT   : 以下全部为模拟日志，未发生真实训练。',
    '',
  ];
  W.writeText(`working/runs/${run.id}/run.log`, header.concat(logLines).join('\n') + '\n');
  W.writeJson(`working/runs/${run.id}/metrics.json`, run.metrics);
  W.writeJson(`working/runs/${run.id}/config.json`, {
    simulated: true,
    notebookId: run.notebookId,
    hyperparams: run.analysis.hyperparams,
    detectedLibraries: run.analysis.libs,
    datasetPaths: run.analysis.datasets,
    stages: run.analysis.stages,
    runId: run.id,
    createdAt: run.createdAt,
  });
  W.writeText(`working/runs/${run.id}/README.md`, [
    `# 实验记录 ${run.id}`,
    '',
    '> ⚠️ 本次运行为**模拟器**产生的演示数据，不代表真实模型训练结果。',
    '',
    `- Notebook: \`${run.notebookId}.ipynb\``,
    `- 代码字符数: ${run.codeChars}`,
    `- 模拟 epoch 数: ${run.metrics.loss.length}`,
    `- 最终 loss: ${run.metrics.loss.at(-1)} / val_loss: ${run.metrics.val_loss.at(-1)}`,
    '',
    '文件说明：',
    '- `run.log` — 模拟的 stdout 日志',
    '- `metrics.json` — 模拟的 loss / lr 曲线数据',
    '- `config.json` — 从你的代码静态分析出的超参数与依赖',
    '',
    '要在 Kaggle 上真跑，请把 `kaggle_workspace/notebooks/*.ipynb` 上传回 Kaggle 并开启 GPU。',
    '',
  ].join('\n'));
  W.writeJson(`experiments/${run.id}.json`, {
    id: run.id,
    createdAt: run.createdAt,
    notebookId: run.notebookId,
    notebookName: run.notebookName,
    simulated: true,
    codeChars: run.codeChars,
    epochs: run.metrics.loss.length,
    finalLoss: run.metrics.loss.at(-1),
    finalValLoss: run.metrics.val_loss.at(-1),
    metrics: run.metrics,
    analysis: run.analysis,
    artifacts: run.artifacts,
  });
  W.writeJson('working/latest_metrics.json', {
    runId: run.id, updatedAt: W.nowIso(), simulated: true, metrics: run.metrics,
  });
  return run.artifacts;
}

function listExperiments(limit = 20) {
  const dir = W.DIRS.experiments;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          id: j.id, createdAt: j.createdAt, notebookId: j.notebookId,
          notebookName: j.notebookName, epochs: j.epochs,
          finalLoss: j.finalLoss, finalValLoss: j.finalValLoss, codeChars: j.codeChars,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function getExperiment(id) {
  return W.readJson(`experiments/${W.slugify(id)}.json`);
}

module.exports = { analyze, buildRun, finalizeRun, listExperiments, getExperiment, hashString };
