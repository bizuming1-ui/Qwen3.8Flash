/*
 * web/src/app.ts —— 看板前端（TypeScript）
 *
 * 设计目标：
 *   1. 与设计稿像素级一致：整块画布 1356×834，按屏幕等比缩放；
 *   2. 不需要手动刷新：WebSocket 长连接推送，任何设备一改动，其它设备 < 50ms 内同步；
 *   3. 断线自动重连、重连后自动对齐版本，用户完全无感；
 *   4. 「确认」是唯一会改变生产数量的动作：现在 → 清零，当前生产数/生产总数 +n。
 */

type BoardState = {
  order_no: string;
  product: string;
  total: number;
  current: number;
  now: number;
};

type FieldKey = 'order_no' | 'product' | 'current' | 'now';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const stage = $<HTMLDivElement>('stage');
const elOrder = $<HTMLInputElement>('order');
const elProduct = $<HTMLInputElement>('product');
const elCurrent = $<HTMLInputElement>('current');
const elTotal = $<HTMLInputElement>('total');
const elNow = $<HTMLInputElement>('now');
const elConfirm = $<HTMLButtonElement>('confirm');
const elQr = $<HTMLImageElement>('qr');
const elModal = $<HTMLDivElement>('qrModal');
const elQrBig = $<HTMLImageElement>('qrBig');
const elJoinUrl = $<HTMLDivElement>('joinUrl');

/* ------------------------------------------------------------ 画布自适应 */

let stageScale = 1;

function fitStage(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(vw / 1356, vh / 834);
  stageScale = scale;
  stage.style.transform = `scale(${Number(scale.toFixed(4))})`;
}

window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', () => setTimeout(fitStage, 120));
fitStage();

/* ---------------------------------------------------------------- 状态同步 */

let ws: WebSocket | null = null;
let connected = false;
let rev = 0;
let backoff = 200;
let busy = false;
let lastPong = Date.now();
let heartbeat: number | null = null;
/** 最近一次成功从服务端拿到状态的时刻（WS 或 HTTP 兜底都算） */
let lastSync = 0;
let pollTimer: number | null = null;

const lastLocalEdit = new Map<string, number>();

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect(): void {
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    connected = true;
    backoff = 200;
    lastPong = Date.now();
    lastSync = Date.now();
    document.body.classList.remove('offline');
    stopPolling();
    startHeartbeat();
    send({ t: 'sync' });
  };
  ws.onmessage = (ev) => handleMessage(String(ev.data));
  ws.onerror = () => {
    /* onclose 会接管 */
  };
  ws.onclose = () => {
    connected = false;
    stopHeartbeat();
    // WebSocket 不可用时立即切到 HTTP 轮询兜底，界面不会变成"死的"
    startPolling();
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  const delay = Math.min(3000, backoff);
  backoff = Math.min(3000, Math.round(backoff * 1.7));
  setTimeout(connect, delay);
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeat = window.setInterval(() => {
    if (!connected) return;
    if (Date.now() - lastPong > 45_000) {
      // 连接僵死（例如换网），主动断开重连
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }
    send({ t: 'ping' });
  }, 15_000);
}

function stopHeartbeat(): void {
  if (heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

type Outgoing = { t: string; [k: string]: unknown };

function httpPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
    .catch(() => null);
}

function applyHttpResult(data: Record<string, unknown> | null): void {
  if (!data || !data.state) return;
  lastSync = Date.now();
  document.body.classList.remove('offline');
  rev = Math.max(rev, Number(data.rev ?? rev));
  applyState(data.state as BoardState, true);
}

function send(payload: Outgoing): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return;
  }
  // 兜底：网络掐掉 WebSocket 时走 HTTP
  if (payload.t === 'set') {
    void httpPost('/api/set', { field: payload.field, value: payload.value });
  } else if (payload.t === 'confirm') {
    void httpPost('/api/confirm', { amount: payload.amount }).then(applyHttpResult);
  }
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (connected) {
      stopPolling();
      return;
    }
    fetch('/api/state', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { rev?: number; state?: BoardState }) => {
        if (!data || !data.state) return;
        lastSync = Date.now();
        document.body.classList.remove('offline');
        const r = Number(data.rev ?? 0);
        if (r > rev) {
          rev = r;
          applyState(data.state, false);
        }
      })
      .catch(() => {
        if (Date.now() - lastSync > 6000) document.body.classList.add('offline');
      });
  }, 1000);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function handleMessage(raw: string): void {
  let msg: { t?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.t) {
    case 'hello':
    case 'state': {
      const r = Number(msg.rev ?? 0);
      const state = msg.state as BoardState | undefined;
      if (!state) return;
      // 只接受不落后的版本；commit 事件强制回填（发送方按了确认）
      const isCommit = Boolean(msg.commit);
      if (r < rev && !isCommit) return;
      rev = r;
      lastSync = Date.now();
      applyState(state, isCommit);
      break;
    }
    case 'pong':
      lastPong = Date.now();
      break;
    case 'error':
      if (msg.message === 'BAD_AMOUNT') flashConfirm();
      break;
    default:
      break;
  }
}

/** 设计稿里的方框是空的，所以 0 显示为空字符串 */
const fmtNum = (n: number): string => (n ? String(n) : '');

function applyState(state: BoardState, isCommit: boolean): void {
  // 文本字段：确认时也不强推，避免打断正在输入的生产单/产品
  setInput(elOrder, state.order_no ?? '', 'order_no', false);
  setInput(elProduct, state.product ?? '', 'product', false);
  // 数字字段：确认时必须强制回填（现在清零、当前生产数累加）
  setInput(elCurrent, fmtNum(state.current ?? 0), 'current', isCommit);
  setInput(elTotal, fmtNum(state.total ?? 0), 'total', true);
  setInput(elNow, fmtNum(state.now ?? 0), 'now', isCommit);
}

function setInput(
  el: HTMLInputElement,
  value: string,
  key: string,
  force: boolean,
): void {
  const focused = document.activeElement === el;
  const recentlyEdited = Date.now() - (lastLocalEdit.get(key) ?? 0) < 1200;
  if (!force && focused && recentlyEdited) return;
  if (el.value === value) return;

  // 尽量不打断正在输入的光标
  if (focused && el.value !== value) {
    const selStart = el.selectionStart ?? value.length;
    el.value = value;
    const pos = Math.min(selStart, value.length);
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* 某些浏览器不支持 */
    }
    return;
  }
  el.value = value;
}

/* ---------------------------------------------------------------- 输入绑定 */

function debounceSend(key: FieldKey, value: string | number): void {
  send({ t: 'set', field: key, value });
}

function bindField(el: HTMLInputElement, key: FieldKey, numeric: boolean): void {
  let timer: number | null = null;
  let pendingValue: string | number | null = null;

  el.addEventListener('input', () => {
    if (numeric) {
      const cleaned = el.value
        .replace(/[^\d]/g, '')
        .replace(/^0+(?=\d)/, '')
        .slice(0, 13);
      if (cleaned !== el.value) el.value = cleaned;
      pendingValue = Number(el.value || 0);
    } else {
      const cleaned = el.value.replace(/[\r\n\t]/g, '').slice(0, 200);
      if (cleaned !== el.value) el.value = cleaned;
      pendingValue = el.value;
    }

    lastLocalEdit.set(key, Date.now());
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      if (pendingValue === null) return;
      debounceSend(key, pendingValue);
      pendingValue = null;
    }, 80);
  });

  el.addEventListener('blur', () => {
    lastLocalEdit.set(key, 0);
  });
}

bindField(elOrder, 'order_no', false);
bindField(elProduct, 'product', false);
bindField(elCurrent, 'current', true);
bindField(elNow, 'now', true);

/* 回车：确认输入（现在）或结束编辑 */
[elOrder, elProduct, elCurrent, elNow].forEach((el) => {
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (el === elNow) doConfirm();
      else el.blur();
    }
  });
});

/* ------------------------------------------------------------------ 确认 */

function flashConfirm(): void {
  elConfirm.classList.remove('shake');
  void elConfirm.offsetWidth;
  elConfirm.classList.add('shake');
  setTimeout(() => elConfirm.classList.remove('shake'), 360);
}

function doConfirm(): void {
  const online = connected || Date.now() - lastSync < 8000;
  if (!online) {
    flashConfirm();
    return;
  }
  const raw = elNow.value.replace(/[^\d]/g, '');
  const amount = Number(raw || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    flashConfirm();
    return;
  }
  if (busy) return;
  busy = true;
  elConfirm.classList.add('is-sending');

  // 立即本地清零，手感 0 延迟；服务端广播随后会把所有设备对齐
  elNow.value = '';
  lastLocalEdit.set('now', 0);

  if (connected) {
    send({ t: 'confirm', amount });
  } else {
    void httpPost('/api/confirm', { amount }).then(applyHttpResult);
  }

  setTimeout(() => {
    busy = false;
    elConfirm.classList.remove('is-sending');
  }, 260);
}

elConfirm.addEventListener('click', () => {
  elConfirm.classList.add('is-active');
  setTimeout(() => elConfirm.classList.remove('is-active'), 120);
  doConfirm();
});

/* 防止双击放大 / 长按选择 */
elConfirm.addEventListener('dblclick', (e) => e.preventDefault());

/* ---------------------------------------------------------------- 二维码 */

function loadQr(): void {
  elQr.src = `/api/qr.svg?ts=${Math.floor(Date.now() / 10000)}`;
}

async function openQrModal(): Promise<void> {
  elModal.hidden = false;
  elQrBig.src = elQr.src;
  try {
    const res = await fetch('/api/join-url', { cache: 'no-store' });
    const data = (await res.json()) as { url?: string };
    elJoinUrl.textContent = data.url ?? location.origin;
  } catch {
    elJoinUrl.textContent = location.origin;
  }
}

elQr.addEventListener('click', () => void openQrModal());
$('qrbox').addEventListener('click', () => void openQrModal());
$('closeModal').addEventListener('click', () => {
  elModal.hidden = true;
});
elModal.addEventListener('click', (ev) => {
  if (ev.target === elModal) elModal.hidden = true;
});
$('copyUrl').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elJoinUrl.textContent ?? location.origin);
    $('copyUrl').textContent = '已复制';
    setTimeout(() => ($('copyUrl').textContent = '复制链接'), 1500);
  } catch {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ 启动 */

if (new URLSearchParams(location.search).get('marks') === '1') {
  document.body.classList.add('with-marks');
}

loadQr();
connect();

/* 回到前台时立即对齐一次，避免休眠期间的漂移 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!connected) connect();
    else send({ t: 'sync' });
  }
});

window.addEventListener('online', () => {
  if (!connected) connect();
});
