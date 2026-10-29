'use strict';

const names = ['order', 'product', 'total', 'current', 'now'];
const numbers = new Set(['total', 'current', 'now']);
const controls = Object.fromEntries(names.map(name => [name, document.getElementById(name)]));
const status = document.getElementById('status');
const message = document.getElementById('message');
const confirmButton = document.getElementById('confirm');
const timers = {};
const generations = Object.fromEntries(names.map(name => [name, 0]));
const dirty = Object.fromEntries(names.map(name => [name, false]));
const queues = Object.fromEntries(names.map(name => [name, Promise.resolve()]));
let state = null;
let confirming = false;

const shareUrl = new URL(location.pathname, location.origin).href;
document.getElementById('qr').src = `/api/qr?url=${encodeURIComponent(shareUrl)}`;

function render() {
  if (!state) return;
  for (const name of names) {
    if (!dirty[name] && controls[name].value !== state[name]) controls[name].value = state[name];
    controls[name].disabled = confirming && name === 'now';
  }
  confirmButton.disabled = confirming;
}
function receive(next) {
  if (!next || (state && next.revision < state.revision)) return;
  if (state && next.nowEpoch !== state.nowEpoch) {
    for (const name of ['now', 'current']) {
      clearTimeout(timers[name]);
      generations[name]++;
      dirty[name] = false;
    }
  }
  state = next;
  render();
}
async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) {
    if (result.state) receive(result.state);
    throw new Error(result.error || '保存失败');
  }
  receive(result);
  return result;
}
function save(name, value, generation, epoch) {
  queues[name] = queues[name].catch(() => {}).then(async () => {
    if ((name === 'now' || name === 'current') && state.nowEpoch !== epoch) return;
    try {
      await post('/api/field', { field: name, value, nowEpoch: epoch });
      if (generations[name] === generation) { dirty[name] = false; message.textContent = ''; render(); }
    } catch (error) {
      if (generations[name] === generation) message.textContent = `${error.message}，请检查连接后重新输入。`;
    }
  });
}
for (const name of names) {
  controls[name].addEventListener('input', () => {
    if (numbers.has(name)) controls[name].value = controls[name].value.replace(/[^0-9]/g, '');
    dirty[name] = true;
    const generation = ++generations[name];
    const value = controls[name].value;
    const epoch = state.nowEpoch;
    clearTimeout(timers[name]);
    timers[name] = setTimeout(() => save(name, value, generation, epoch), 150);
  });
}
document.getElementById('form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state || confirming) return;
  const value = controls.now.value;
  if (!/^\d{1,40}$/.test(value)) { message.textContent = '请在“现在”填写非负整数。'; controls.now.focus(); return; }
  clearTimeout(timers.now);
  const generation = ++generations.now;
  dirty.now = true;
  confirming = true;
  render();
  try {
    await post('/api/confirm', { value, nowEpoch: state.nowEpoch });
    message.textContent = '';
  } catch (error) {
    message.textContent = error.message;
    if (generations.now === generation) dirty.now = true;
  } finally {
    confirming = false;
    render();
  }
});

const events = new EventSource('/api/events');
events.onopen = () => { status.textContent = '实时同步中'; };
events.onmessage = event => { try { receive(JSON.parse(event.data)); } catch { message.textContent = '同步数据无效'; } };
events.onerror = () => { status.textContent = '连接中断，正在自动重连…'; };
