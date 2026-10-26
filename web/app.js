'use strict';
const $ = s => document.querySelector(s);
const api = async (url, body, method) => {
  const r = await fetch(url, body !== undefined
    ? {method: method || 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}
    : {});
  const j = await r.json().catch(() => ({ok: false, error: '服务器无响应 HTTP ' + r.status}));
  if (!r.ok && j.ok === undefined) j.ok = false;
  return j;
};
function toast(msg, err = false) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toast').appendChild(t); setTimeout(() => t.remove(), err ? 9000 : 5200);
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const human = n => n > 1048576 ? (n/1048576).toFixed(1)+'MB' : n > 1024 ? (n/1024).toFixed(1)+'KB' : n + 'B';
const fileToB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });

/* ---------------- Notebook ---------------- */
let nb = {name: 'my_kaggle_voice_clone', cells: []};
const SESSION = 'browser-' + Math.random().toString(36).slice(2, 8);

function cellEl(c, idx) {
  const div = document.createElement('div');
  div.className = 'cell' + (c.cell_type === 'markdown' ? ' md' : '');
  const label = c.cell_type === 'markdown' ? `Markdown` : c.execution_count ? `In [${c.execution_count}]` : 'In [ ]';
  div.innerHTML = `
    <div class="cellhead"><span>${label} · 格 ${idx + 1}</span>
      <span class="ops">
        ${c.cell_type === 'markdown' ? '' : '<button data-op="run" title="运行本格">▶ 运行</button>'}
        <button data-op="up">▲</button><button data-op="down">▼</button>
        <button data-op="add">＋下方加格</button><button data-op="del">✖</button>
      </span></div>
    <textarea spellcheck="false" rows="${Math.min(18, Math.max(3, (c.source || '').split('\n').length + 1))}">${esc(c.source || '')}</textarea>
    <div class="outs"></div>`;
  const ta = div.querySelector('textarea');
  ta.addEventListener('input', () => { c.source = ta.value; markDirty(); });
  ta.addEventListener('keydown', e => {
    if ((e.shiftKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runCell(idx); }
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); c.source = ta.value; }
  });
  const renderOuts = () => {
    const box = div.querySelector('.outs'); box.innerHTML = '';
    (c.outputs || []).forEach(o => { const d = document.createElement('div'); d.className = 'out ' + (o.kind || ''); d.textContent = o.text; box.appendChild(d); });
  };
  renderOuts(); div._renderOuts = renderOuts; div._label = div.querySelector('.cellhead span');
  div.querySelectorAll('[data-op]').forEach(b => b.onclick = () => {
    const op = b.dataset.op;
    if (op === 'run') runCell(idx);
    else if (op === 'del') { nb.cells.splice(idx, 1); renderCells(); markDirty(); }
    else if (op === 'add') { nb.cells.splice(idx + 1, 0, {cell_type: 'code', source: '', outputs: []}); renderCells(); }
    else if (op === 'up' && idx > 0) { [nb.cells[idx-1], nb.cells[idx]] = [nb.cells[idx], nb.cells[idx-1]]; renderCells(); }
    else if (op === 'down' && idx < nb.cells.length - 1) { [nb.cells[idx+1], nb.cells[idx]] = [nb.cells[idx], nb.cells[idx+1]]; renderCells(); }
  });
  return div;
}
function renderCells() {
  const box = $('#cells'); box.innerHTML = '';
  nb.cells.forEach((c, i) => box.appendChild(cellEl(c, i)));
  $('#nbName').value = nb.name || '';
}
async function runCell(idx) {
  const c = nb.cells[idx]; if (!c || c.cell_type === 'markdown') return;
  const el = $('#cells').children[idx];
  el._label.innerHTML = '<span class="spin">⟳</span> 运行中…（!pip 可能较慢）';
  const r = await api('/api/kernel/run', {code: c.source, session: SESSION});
  if (!r.ok && !r.outputs) { toast('运行失败: ' + (r.error || ''), true); }
  c.outputs = r.outputs || []; c.execution_count = r.execution_count;
  if (!c.outputs.length) c.outputs = [{kind: 'stdout', text: `(无输出 · ${r.duration_ms}ms)`}];
  el._renderOuts(); el._label.textContent = `In [${c.execution_count}] · 格 ${idx + 1} · ${r.duration_ms}ms`;
  refreshFiles(); markDirty();
}
$('#btnRunAll').onclick = async e => {
  e.target.disabled = true;
  for (let i = 0; i < nb.cells.length; i++) { if (nb.cells[i].cell_type !== 'markdown') await runCell(i); }
  e.target.disabled = false; toast('✅ 全部格子运行完毕（点“保存 .ipynb+.py”真实落盘）');
};
$('#btnAddCell').onclick = () => { nb.cells.push({cell_type: 'code', source: '# 新代码格\n', outputs: []}); renderCells(); window.scrollTo(0, document.body.scrollHeight); };
$('#btnAddMd').onclick = () => { nb.cells.push({cell_type: 'markdown', source: '## 说明', outputs: []}); renderCells(); };
$('#btnRestart').onclick = async () => { await api('/api/kernel/reset', {session: SESSION}); nb.cells.forEach(c => { c.execution_count = null; c.outputs = []; }); renderCells(); toast('内核已重启，变量已清空'); };

async function saveNotebook(silent) {
  nb.name = $('#nbName').value.trim() || 'untitled';
  const r = await api('/api/notebooks/save', {notebook: nb});
  if (r.ok) { if (!silent) toast('💾 ' + r.msg + `\n(${r.cells} 格 · ${r.saved_at})`); refreshNbList(); refreshGit(); }
  else toast('保存失败: ' + r.error, true);
  return r.ok;
}
$('#btnSaveNb').onclick = () => saveNotebook(false);
$('#btnNewNb').onclick = () => { nb = {name: $('#nbName').value.trim() || 'untitled', cells: [{cell_type: 'markdown', source: '# 新 Notebook\n在这里粘贴或编写 Kaggle 代码。'}, {cell_type: 'code', source: 'import sys, os\nprint(sys.version)\nprint("working:", os.getcwd())', outputs: []}]}; renderCells(); };

async function refreshNbList() {
  const r = await api('/api/notebooks'); const box = $('#nbList'); box.innerHTML = '';
  (r.notebooks || []).forEach(n => {
    const d = document.createElement('div'); d.className = 'fi' + (n.name === nb.name ? ' active' : '');
    d.innerHTML = `<span>📓 ${esc(n.name)}</span><span class="meta">${human(n.size)} · ${esc(n.modified)}</span>`;
    d.title = '点击打开';
    d.onclick = async () => { const rr = await api('/api/notebooks/' + encodeURIComponent(n.name)); if (rr.ok) { nb = rr.notebook; renderCells(); toast('已打开 notebooks/' + n.name + '.ipynb'); } };
    box.appendChild(d);
  });
  if (!box.children.length) box.innerHTML = '<div class="hint">（暂无，保存后出现在这里）</div>';
}

/* ---------------- 导入完整 Kaggle 代码 ---------------- */
const modal = $('#importModal');
$('#btnImport').onclick = () => { modal.hidden = false; $('#impNameEcho').textContent = $('#impName').value; };
$('#impName').oninput = e => $('#impNameEcho').textContent = e.target.value;
$('#btnImportCancel').onclick = () => modal.hidden = true;
$('#impFileToggle').onchange = e => { if (e.target.checked) $('#impFile').click(); e.target.checked = false; };
$('#impFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; $('#impText').value = await f.text(); $('#impName').value = f.name.replace(/\.(ipynb|py)$/, ''); $('#impNameEcho').textContent = $('#impName').value; toast('文件已读入 ' + f.name + '，点右下角导入。'); };
$('#btnImportGo').onclick = async e => {
  const text = $('#impText').value; if (!text.trim()) return toast('请先粘贴代码', true);
  e.target.disabled = true;
  const r = await api('/api/notebooks/import', {text, name: $('#impName').value, save: true});
  e.target.disabled = false;
  if (r.ok) { nb = r.notebook; renderCells(); modal.hidden = true; toast('📥 ' + r.msg); refreshNbList(); refreshGit(); }
  else toast('导入失败: ' + r.error, true);
};

/* ---------------- /kaggle 文件 ---------------- */
async function refreshFiles() {
  const r = await api('/api/files'); const box = $('#fileTree'); box.innerHTML = '';
  const sel = $('#refFromWorking'); const cur = sel.value; sel.innerHTML = '<option value="">或选 working 里的 wav…</option>';
  ['input', 'working', 'output'].forEach(area => {
    (r.files?.[area] || []).forEach(f => {
      const d = document.createElement('div'); d.className = 'fi';
      d.innerHTML = `<span>${esc(f.path)}</span><span class="meta">${human(f.size)}</span>`;
      d.title = '点击下载/播放(音频将调用浏览器打开)';
      d.onclick = () => window.open('/api/file?path=' + encodeURIComponent(f.path), '_blank');
      box.appendChild(d);
      if (f.name.toLowerCase().endsWith('.wav')) { const o = document.createElement('option'); o.value = f.path; o.textContent = f.path; sel.appendChild(o); }
    });
  });
  sel.value = cur;
  if (!box.children.length) box.innerHTML = '<div class="hint">（为空：运行代码产生 wav 后会出现在这里）</div>';
}
$('#fileUpload').onchange = async e => {
  for (const f of e.target.files) {
    const r = await api('/api/upload', {filename: f.name, area: 'input', data_base64: await fileToB64(f)});
    toast(r.ok ? `已存入 ${r.virtual_path}（真实文件 ${human(r.size)}）` : '上传失败 ' + r.error, !r.ok);
  }
  e.target.value = ''; refreshFiles(); refreshGit();
};
$('#btnSymlink').onclick = async () => { const r = await api('/api/kernel/symlink', {}); toast(r.msg || r.error); };

/* ---------------- 波形绘制 ---------------- */
async function drawWave(canvas, url) {
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ac.decodeAudioData(buf.slice(0));
    const ch = audio.getChannelData(0), W = canvas.width, H = canvas.height, step = Math.ceil(ch.length / W);
    const g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, '#7b8cff'); g.addColorStop(1, '#9b6bff');
    ctx.fillStyle = g;
    for (let x = 0; x < W; x++) {
      let mx = 0; for (let i = x * step; i < Math.min(ch.length, (x + 1) * step); i += Math.max(1, step >> 5)) mx = Math.max(mx, Math.abs(ch[i]));
      const h = Math.max(1, mx * H * 0.92); ctx.fillRect(x, (H - h) / 2, 1, h);
    }
    ac.close(); return audio;
  } catch (e) { ctx.fillStyle = '#9aa0c3'; ctx.fillText('波形加载失败: ' + e.message, 10, 20); }
}

/* ---------------- 参考音频: 上传/录音/从working选 ---------------- */
let refB64 = null, refVirtualPath = null;
$('#refUpload').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  refB64 = await fileToB64(f); refVirtualPath = null;
  const url = URL.createObjectURL(f); $('#refPlayer').src = url;
  const a = await drawWave($('#refWave'), url);
  $('#refInfo').textContent = `参考音频: ${f.name} · ${human(f.size)}` + (a ? ` · ${a.duration.toFixed(2)}s · ${a.sampleRate}Hz` : '');
};
$('#refFromWorking').onchange = async e => {
  refVirtualPath = e.target.value || null; refB64 = null;
  if (!refVirtualPath) return;
  const url = '/api/file?path=' + encodeURIComponent(refVirtualPath);
  $('#refPlayer').src = url; const a = await drawWave($('#refWave'), url);
  $('#refInfo').textContent = '参考音频: ' + refVirtualPath + (a ? ` · ${a.duration.toFixed(2)}s` : '');
};
let recState = null;
$('#btnRec').onclick = async () => {
  const btn = $('#btnRec');
  if (recState) {
    recState.stop(); recState = null; btn.textContent = '🔴 浏览器录音'; return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1); const chunks = [];
    proc.onaudioprocess = ev => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(ac.destination);
    btn.textContent = '⏹️ 停止录音（说几秒话…）';
    recState = {stop: async () => {
      proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop());
      const total = chunks.reduce((s, c) => s + c.length, 0), pcm = new Float32Array(total);
      let off = 0; chunks.forEach(c => { pcm.set(c, off); off += c.length; });
      const wav = encodeWav(pcm, ac.sampleRate); await ac.close();
      refB64 = await fileToB64(wav); refVirtualPath = null;
      const url = URL.createObjectURL(wav); $('#refPlayer').src = url;
      const a = await drawWave($('#refWave'), url);
      $('#refInfo').textContent = `录音完成 · ${a ? a.duration.toFixed(2) : '?'}s（合成时存入实验目录 reference.wav）`;
      toast('🎙️ 录音已捕获，点克隆合成即可保存为实验');
    }};
  } catch (e) { toast('无法使用麦克风: ' + e.message, true); }
};
function encodeWav(pcm, sr) {
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, pcm[i] * 32767)), true);
  return new Blob([buf], {type: 'audio/wav'});
}

/* ---------------- 语音克隆合成 ---------------- */
[['#pSim','#vSim',v=>(+v).toFixed(2)],['#pTemp','#vTemp',v=>(+v).toFixed(2)],['#pSpeed','#vSpeed',v=>(+v).toFixed(2)+'×'],['#pPitch','#vPitch',v=>v+' 半音']]
  .forEach(([p, s, f]) => $(p).oninput = e => $(s).textContent = f(e.target.value));

$('#btnSynth').onclick = async e => {
  const btn = e.target; btn.disabled = true; btn.textContent = '⟳ 正在克隆合成…';
  const r = await api('/api/synth', {
    text: $('#synthText').value, language: $('#pLang').value,
    similarity: +$('#pSim').value, temperature: +$('#pTemp').value,
    speed: +$('#pSpeed').value, pitch_semitones: +$('#pPitch').value,
    ref_text: $('#refText').value, ref_audio: refVirtualPath, ref_data_base64: refB64,
  });
  btn.disabled = false; btn.textContent = '🎙️ 克隆合成并保存实验';
  if (!r.ok) return toast('合成失败: ' + r.error, true);
  const url = r.audio_url + '&t=' + Date.now();
  $('#outPlayer').src = url;
  drawWave($('#outWave'), url);
  const sp = $('#outSpec'); sp.src = r.spectrogram_url + '&t=' + Date.now(); sp.style.display = 'block';
  const m = r.experiment.metrics, a = r.experiment.audio;
  $('#metrics').innerHTML =
    ['speaker_similarity(SIM)', 'MOS(sim)', 'WER(sim)'].map(k => `<div class="metric"><b>${m[k]}</b><small>${k}</small></div>`).join('') +
    `<div class="metric"><b>${a.duration_sec}s</b><small>时长 · 基频 ${a.base_f0_hz}Hz</small></div>
     <div class="metric"><b>${a.est_pitch_hz}Hz</b><small>估测音高(ZCR)</small></div>
     <div class="metric"><b>${a.rms}</b><small>RMS</small></div>`;
  toast('✅ ' + r.msg + '\n点顶部“提交到项目 → 推送 GitHub”即可同步');
  refreshFiles(); refreshExperiments(); refreshGit();
};

/* ---------------- 实验记录 ---------------- */
async function refreshExperiments() {
  const r = await api('/api/experiments'); const box = $('#expList'); box.innerHTML = '';
  (r.experiments || []).forEach(x => {
    const d = document.createElement('div'); d.className = 'exp';
    const m = x.metrics || {};
    d.innerHTML = `<div class="t">🧪 ${esc(x.id)} <small>${esc(x.created_at || '')} · ${esc(x.kind || '')}</small></div>
      <div>${esc(x.text || '')}</div>
      <div class="c">SIM ${m['speaker_similarity(SIM)'] ?? '-'} · MOS ${m['MOS(sim)'] ?? '-'} · WER ${m['WER(sim)'] ?? '-'} · 时长 ${x.audio?.duration_sec ?? '-'}s · 文件: ${esc((x.files || []).join(', '))}</div>
      <audio controls src="/api/file?path=experiments/${esc(x.id)}/cloned.wav"></audio>`;
    box.appendChild(d);
  });
  if (!box.children.length) box.innerHTML = '<div class="hint">暂无实验。去“语音克隆实验室”合成一次即可生成。</div>';
}
$('#btnRefreshExp').onclick = refreshExperiments;

/* ---------------- Git 一键同步 ---------------- */
function markDirty() { /* Notebook 有未保存修改时提示 */ }
async function refreshGit() {
  const r = await api('/api/status'); if (!r.ok) return;
  $('#runtimePill').textContent = `🐍 Python ${r.python} · 模拟 ${r.runtime.simulated_accelerator}`;
  const g = r.git, pill = $('#gitPill');
  pill.textContent = `⎇ ${g.branch}` + (g.dirty ? ` · ${g.dirty_files.length} 个未提交文件` : ' · 已同步');
  pill.className = 'pill git ' + (g.dirty ? 'dirty' : 'clean');
  pill.title = (g.dirty_files.join('\n') || g.head);
}
$('#btnCommit').onclick = async e => {
  e.target.disabled = true;
  await saveNotebook(true); // 先把当前 Notebook 真落盘再提交
  const msg = prompt('提交说明（commit message）:', 'voice-lab: 保存 Notebook 与语音克隆实验');
  if (msg === null) { e.target.disabled = false; return; }
  const r = await api('/api/git/commit', {message: msg});
  e.target.disabled = false;
  toast(r.ok ? '💾 已提交到本地项目仓库:\n' + (r.output || r.git.head) : '提交结果: ' + r.output, !r.ok);
  refreshGit();
};
$('#btnPush').onclick = async e => {
  e.target.disabled = true; e.target.textContent = '⟳ 推送中…';
  const r = await api('/api/git/push', {});
  e.target.disabled = false; e.target.textContent = '⬆️ 推送 GitHub';
  toast(r.ok ? `✅ 已推送到 GitHub 分支 ${r.branch}` : '推送失败:\n' + r.output, !r.ok);
  refreshGit();
};

/* ---------------- 页签 / 计时 / 初始化 ---------------- */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
});
const t0 = Date.now();
setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('#sessionPill').textContent = `会话 ${String(s/3600|0).padStart(2,'0')}:${String(s/60%60|0).padStart(2,'0')}:${String(s%60).padStart(2,'0')} / Kaggle上限12h(模拟)`; }, 1000);

(async function init() {
  await refreshGit(); await refreshNbList(); await refreshFiles(); await refreshExperiments();
  const list = await api('/api/notebooks');
  const first = (list.notebooks || [])[0];
  if (first) { const r = await api('/api/notebooks/' + encodeURIComponent(first.name)); if (r.ok) nb = r.notebook; }
  if (!nb.cells.length) $('#btnNewNb').onclick();
  else renderCells();
})();
