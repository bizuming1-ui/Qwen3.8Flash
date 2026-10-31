import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type BoardState = { order_no: string; product: string; total: number; current: number; now: number };
type FieldKey = 'order_no' | 'product' | 'now' | 'total';
type Snapshot = { rev: number; state: BoardState; delta?: number };
type RuntimeConfig = {
  mode: 'local' | 'redirect' | 'supabase';
  cloud_url?: string;
  project_url?: string;
  anon_key?: string;
  admin_configured?: boolean;
};

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
const shareInput = $<HTMLInputElement>('shareInput');
const notice = $<HTMLDivElement>('notice');
const adminModal = $<HTMLDivElement>('adminModal');
const adminEntry = $<HTMLButtonElement>('adminEntry');
const adminForm = $<HTMLFormElement>('adminForm');
const adminEmail = $<HTMLInputElement>('adminEmail');
const adminPassword = $<HTMLInputElement>('adminPassword');
const adminError = $<HTMLDivElement>('adminError');
const adminActions = $('adminActions');

/** 云端 HTML 注入其函数挂载前缀；本机部署是空字符串。 */
const mount = (document.querySelector('meta[name="board-base"]') as HTMLMetaElement | null)?.content.replace(/\/+$/, '') || '';
let cloudBase = '';
let mode: 'local' | 'cloud' | 'loading' = 'loading';
let supabase: SupabaseClient | null = null;
let localToken = '';
let isAdmin = false;
let ready = false;
let connected = false;
let lastSync = 0;
let rev = -1;
let latest: BoardState = { order_no: '', product: '', total: 0, current: 0, now: 0 };
let busy = false;
let starting = false;
let bootstrapTimer: number | null = null;
let bootstrapDelay = 500;
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectDelay = 200;
const lastLocalEdit = new Map<FieldKey, number>();

function fitStage(): void {
  if (window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
    stage.style.transform = 'none';
    return;
  }
  const scale = Math.min(window.innerWidth / 1356, window.innerHeight / 834);
  stage.style.transform = `scale(${Number(scale.toFixed(4))})`;
}
window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', () => setTimeout(fitStage, 120));
fitStage();

const errors: Record<string, string> = {
  EXCEEDS_TOTAL: '超出生产总数：当前生产数加上现在的数量不能大于生产总数，请修改后重试。',
  TOTAL_TOO_SMALL: '生产总数不能小于当前生产数。请设置更大的总数，或由管理员清空看板后开始新单。',
  ADMIN_REQUIRED: '请先登录管理员账号，再修改生产总数或清空看板。',
  ADMIN_NOT_CONFIGURED: '本机尚未配置管理员密码，请先设置 BOARD_ADMIN_PASSWORD 并重启服务。',
  ADMIN_LOCKED: '登录失败次数过多，请等待 15 分钟后再试。',
  BAD_CREDENTIALS: '管理员密码不正确。',
  NOT_ADMIN: '这个账号没有本看板的管理员权限。',
  READ_ONLY: '当前生产数只能通过确认自动累计，不能手动修改。',
  BAD_AMOUNT: '请输入大于零的整数。',
  BAD_NUMBER: '请输入 0 到 1000000000000 之间的整数。',
  BAD_URL: '分享地址格式不正确，请填写 http 或 https 地址。',
  NETWORK: '连接异常，请检查网络；如果刚提交过确认，请先核对当前生产数再重试。',
};
let noticeTimer: number | null = null;
function messageFor(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'NETWORK');
  const code = Object.keys(errors).find((key) => raw.includes(key));
  if (code) return errors[code];
  if (/invalid login credentials|email not confirmed/i.test(raw)) return '邮箱或密码不正确，或者邮箱尚未确认。';
  return errors.NETWORK;
}
function showError(error: unknown): void {
  notice.textContent = messageFor(error);
  notice.hidden = false;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 9000);
}

const fmtNum = (n: number) => n ? String(n) : '';
function setInput(el: HTMLInputElement, value: string, key: FieldKey, force = false): void {
  if (!force && document.activeElement === el && Date.now() - (lastLocalEdit.get(key) ?? 0) < 1200) return;
  if (el.value === value) return;
  const pos = el.selectionStart;
  el.value = value;
  if (document.activeElement === el && pos !== null) {
    try { el.setSelectionRange(Math.min(pos, value.length), Math.min(pos, value.length)); } catch { /* ignore */ }
  }
}
function acceptSnapshot(result: Snapshot, commit = false): void {
  const nextRev = Number(result.rev);
  if (!result.state || !Number.isFinite(nextRev) || nextRev < rev) return;
  rev = nextRev;
  latest = result.state;
  lastSync = Date.now();
  document.body.classList.remove('offline');
  setInput(elOrder, latest.order_no ?? '', 'order_no');
  setInput(elProduct, latest.product ?? '', 'product');
  elCurrent.value = fmtNum(Number(latest.current || 0));
  setInput(elTotal, fmtNum(Number(latest.total || 0)), 'total');
  setInput(elNow, fmtNum(Number(latest.now || 0)), 'now', commit);
}
function errorCode(error: { message?: string } | null): Error {
  return new Error(error?.message || 'NETWORK');
}
function dataFromRow(row: Record<string, unknown>): Snapshot {
  return { rev: Number(row.rev), state: {
    order_no: String(row.order_no ?? ''), product: String(row.product ?? ''),
    total: Number(row.total ?? 0), current: Number(row.current_count ?? 0), now: Number(row.now_count ?? 0),
  } };
}

function localHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (localToken) headers.Authorization = `Bearer ${localToken}`;
  return headers;
}
async function localRequest(path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${mount}${path}`, body === undefined
      ? { cache: 'no-store', headers: localHeaders() }
      : { method: 'POST', cache: 'no-store', headers: localHeaders(true), body: JSON.stringify(body) });
  } catch { throw new Error('NETWORK'); }
  let data: Record<string, unknown>;
  try { data = await res.json() as Record<string, unknown>; } catch { throw new Error('NETWORK'); }
  if (!res.ok || data.ok === false) throw new Error(String(data.error || 'NETWORK'));
  return data;
}
async function refreshState(): Promise<void> {
  try {
    if (mode === 'cloud' && supabase) {
      const { data, error } = await supabase.from('qwen_board_state').select('*').eq('id', true).single();
      if (error || !data) throw errorCode(error);
      acceptSnapshot(dataFromRow(data as Record<string, unknown>));
    } else if (mode === 'local') {
      acceptSnapshot(await localRequest('/api/state') as unknown as Snapshot);
    }
  } catch {
    if (Date.now() - lastSync > 6000) document.body.classList.add('offline');
  }
}
function connectLocal(): void {
  if (mode !== 'local' || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { ws = new WebSocket(`${proto}//${location.host}${mount}/ws`); }
  catch { scheduleReconnect(); return; }
  ws.onopen = () => {
    connected = true;
    reconnectDelay = 200;
    ws?.send(JSON.stringify({ t: 'sync' }));
    void refreshState();
  };
  ws.onmessage = (event) => {
    try {
      const m = JSON.parse(String(event.data)) as { t?: string; rev?: number; state?: BoardState; commit?: unknown };
      if ((m.t === 'hello' || m.t === 'state') && m.state) {
        acceptSnapshot({ rev: Number(m.rev), state: m.state }, Boolean(m.commit));
      }
    } catch { /* malformed frame */ }
  };
  ws.onclose = () => { connected = false; scheduleReconnect(); };
  ws.onerror = () => { /* close will schedule a reconnect */ };
}
function scheduleReconnect(): void {
  if (reconnectTimer !== null || mode !== 'local') return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectLocal();
  }, reconnectDelay);
  reconnectDelay = Math.min(3000, Math.round(reconnectDelay * 1.7));
}
function subscribeCloud(): void {
  if (!supabase) return;
  supabase.channel('qwen-board-state')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'qwen_board_state' }, (payload) => {
      const row = payload.new as Record<string, unknown>;
      acceptSnapshot(dataFromRow(row), row.last_action === 'COMMIT' || row.last_action === 'RESET');
    })
    .subscribe((status) => { connected = status === 'SUBSCRIBED'; if (connected) void refreshState(); });
}
async function writeField(field: FieldKey, value: string | number): Promise<Snapshot> {
  if (mode === 'cloud' && supabase) {
    const { data, error } = await supabase.rpc('qwen_board_set', { p_field: field, p_value: String(value) });
    if (error) throw errorCode(error);
    return data as Snapshot;
  }
  return await localRequest('/api/set', { field, value }) as unknown as Snapshot;
}
function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const a = crypto.getRandomValues(new Uint8Array(16));
  a[6] = (a[6] & 15) | 64; a[8] = (a[8] & 63) | 128;
  const h = Array.from(a, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function commitAmount(amount: number): Promise<Snapshot> {
  if (mode === 'cloud' && supabase) {
    const { data, error } = await supabase.rpc('qwen_board_confirm', { p_amount: amount, p_request: requestId() });
    if (error) throw errorCode(error);
    return data as Snapshot;
  }
  return await localRequest('/api/confirm', { amount }) as unknown as Snapshot;
}

/* 每个字段的写入串行，确认前先冲刷防抖队列，避免确认后旧的「现在」回填。 */
const pending = new Map<FieldKey, { timer: number; value: string | number }>();
const inflight = new Map<FieldKey, Promise<void>>();
function dispatchField(field: FieldKey, value: string | number): Promise<void> {
  const previous = inflight.get(field) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const result = await writeField(field, value);
    acceptSnapshot(result);
  });
  inflight.set(field, task);
  void task.then(
    () => { if (inflight.get(field) === task) inflight.delete(field); },
    () => { if (inflight.get(field) === task) inflight.delete(field); },
  );
  return task;
}
function scheduleField(field: FieldKey, value: string | number): void {
  const old = pending.get(field);
  if (old) clearTimeout(old.timer);
  const timer = window.setTimeout(() => {
    const p = pending.get(field);
    if (!p) return;
    pending.delete(field);
    void dispatchField(field, p.value).catch((e) => {
      showError(e);
      if (field === 'total' && !pending.has('total')) {
        lastLocalEdit.set('total', 0);
        elTotal.value = fmtNum(latest.total);
      }
    });
  }, 80);
  pending.set(field, { timer, value });
}
async function flushField(field: FieldKey): Promise<void> {
  const p = pending.get(field);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(field);
    await dispatchField(field, p.value);
  } else if (inflight.has(field)) await inflight.get(field);
}
function bindField(el: HTMLInputElement, field: FieldKey, numeric: boolean): void {
  el.addEventListener('input', () => {
    if (!ready) return;
    if (numeric) el.value = el.value.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
    else el.value = el.value.replace(/[\r\n\t]/g, '').slice(0, 200);
    lastLocalEdit.set(field, Date.now());
    scheduleField(field, numeric ? Number(el.value || 0) : el.value);
  });
  el.addEventListener('blur', () => lastLocalEdit.set(field, 0));
}
bindField(elOrder, 'order_no', false);
bindField(elProduct, 'product', false);
bindField(elNow, 'now', true);
bindField(elTotal, 'total', true);
[elOrder, elProduct, elNow, elTotal].forEach((el) => el.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); if (el === elNow) void doConfirm(); else el.blur(); }
}));

async function doConfirm(): Promise<void> {
  if (busy) return;
  if (!ready || Date.now() - lastSync > 8000) { showError('NETWORK'); return; }
  const amount = Number(elNow.value || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000_000) { showError('BAD_AMOUNT'); return; }
  busy = true;
  elConfirm.classList.add('is-sending');
  elNow.readOnly = true;
  try {
    if (isAdmin) await flushField('total');
    await flushField('now');
    const result = await commitAmount(amount);
    lastLocalEdit.set('now', 0);
    acceptSnapshot(result, true);
    notice.hidden = true;
  } catch (e) {
    // 不乐观清空：超额/失败时保留用户输入，权威状态也保持不变。
    showError(e);
    await refreshState();
  } finally {
    elNow.readOnly = false;
    busy = false;
    elConfirm.classList.remove('is-sending');
  }
}
elConfirm.addEventListener('click', () => void doConfirm());
elConfirm.addEventListener('dblclick', (e) => e.preventDefault());

/* --------------------------------------------------------------- 管理员 */
function updateAdminUI(): void {
  elTotal.readOnly = !isAdmin;
  elTotal.setAttribute('aria-readonly', String(!isAdmin));
  elTotal.title = isAdmin ? '设置生产总数（不能小于当前生产数）' : '点击后登录管理员，再设置生产总数';
  adminEntry.textContent = isAdmin ? '管理员已登录' : '管理员登录';
  adminForm.hidden = isAdmin;
  adminActions.hidden = !isAdmin;
  $('adminTitle').textContent = isAdmin ? '管理员' : '管理员登录';
  $('adminStatus').textContent = isAdmin
    ? '已登录。生产总数不能低于当前生产数；清空看板会保留审计记录。'
    : '管理员可以设置生产总数和清空看板。';
  $('adminEmailLabel').hidden = mode !== 'cloud';
  adminEmail.hidden = mode !== 'cloud';
}
function openAdmin(): void { adminError.textContent = ''; adminModal.hidden = false; updateAdminUI(); }
adminEntry.addEventListener('click', openAdmin);
elTotal.addEventListener('click', () => { if (!isAdmin && ready) openAdmin(); });
for (const id of ['adminClose', 'adminDone']) $(id).addEventListener('click', () => { adminModal.hidden = true; });
adminModal.addEventListener('click', (e) => { if (e.target === adminModal) adminModal.hidden = true; });
adminForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>('adminLogin');
  btn.disabled = true; adminError.textContent = '';
  try {
    if (mode === 'cloud' && supabase) {
      const { error } = await supabase.auth.signInWithPassword({ email: adminEmail.value.trim(), password: adminPassword.value });
      if (error) throw errorCode(error);
      const status = await supabase.rpc('qwen_board_is_admin');
      if (status.error) throw errorCode(status.error);
      if (!status.data) { await supabase.auth.signOut(); throw new Error('NOT_ADMIN'); }
      isAdmin = true;
    } else if (mode === 'local') {
      const result = await localRequest('/api/admin/login', { password: adminPassword.value });
      localToken = String(result.token || '');
      sessionStorage.setItem('qwen-board-local-admin', localToken);
      isAdmin = Boolean(localToken);
    } else throw new Error('NETWORK');
    adminPassword.value = '';
    updateAdminUI();
  } catch (err) { adminError.textContent = messageFor(err); }
  finally { btn.disabled = false; }
});
$('adminLogout').addEventListener('click', async () => {
  try {
    if (mode === 'cloud' && supabase) await supabase.auth.signOut();
    else if (mode === 'local') await localRequest('/api/admin/logout', {});
  } catch { /* local session still removed */ }
  localToken = ''; sessionStorage.removeItem('qwen-board-local-admin'); isAdmin = false;
  updateAdminUI();
});
$('adminReset').addEventListener('click', async () => {
  if (!isAdmin || !window.confirm('确认清空当前看板，开始新单？生产单、产品和数量将清空；历史记录保留。')) return;
  try {
    // 等待本设备已发出的字段写入，避免清空后迟到的防抖请求重新填回旧值。
    await Promise.all((['order_no', 'product', 'total', 'now'] as FieldKey[]).map((key) => flushField(key)));
    let result: Snapshot;
    if (mode === 'cloud' && supabase) {
      const r = await supabase.rpc('qwen_board_reset');
      if (r.error) throw errorCode(r.error);
      result = r.data as Snapshot;
    } else result = await localRequest('/api/reset', {}) as unknown as Snapshot;
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    for (const key of ['order_no','product','total','now'] as FieldKey[]) lastLocalEdit.set(key, 0);
    acceptSnapshot(result, true);
    adminModal.hidden = true;
  } catch (e) { showError(e); }
});

/* ---------------------------------------------------------------- 二维码 */
function assetApi(path: string): string { return `${cloudBase || mount}${path}`; }
function loadQr(): void { elQr.src = `${assetApi('/api/qr.svg')}?ts=${Date.now()}`; }
async function openQrModal(): Promise<void> {
  elModal.hidden = false;
  // 分享地址可能由另一台设备更新，打开时重新请求当前二维码。
  loadQr();
  elQrBig.src = elQr.src;
  try {
    const res = await fetch(assetApi('/api/join-url'), { cache: 'no-store' });
    if (!res.ok) throw new Error('NETWORK');
    const data = await res.json() as { url?: string; custom_url?: string | null; hosting?: string };
    elJoinUrl.textContent = data.url ?? location.href;
    shareInput.value = data.custom_url ?? '';
    $('joinHint').textContent = data.hosting === 'supabase'
      ? '手机扫描此二维码进入同一块云端看板。链接可被转发，请只分享给需要操作的人员。修改分享地址需要管理员登录。'
      : data.hosting === 'private_sandbox'
        ? '当前是私有沙盒，裸链接扫码会被平台拦截。请使用部署后的 Supabase 公网地址或在局域网自托管。'
        : '手机与服务处于可互通网络时，扫描此二维码进入同一块看板。修改分享地址需要管理员登录。';
  } catch {
    elJoinUrl.textContent = location.href;
    $('joinHint').textContent = '无法获取分享链接，请检查网络。';
  }
}
$('qrbox').addEventListener('click', () => void openQrModal());
$('closeModal').addEventListener('click', () => { elModal.hidden = true; });
elModal.addEventListener('click', (e) => { if (e.target === elModal) elModal.hidden = true; });
$('saveShare').addEventListener('click', async () => {
  if (!isAdmin) { elModal.hidden = true; openAdmin(); showError('ADMIN_REQUIRED'); return; }
  const value = shareInput.value.trim();
  try {
    if (value) {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('BAD_URL');
    }
    if (mode === 'cloud' && supabase) {
      const r = await supabase.rpc('qwen_board_set_share', { p_url: value });
      if (r.error) throw errorCode(r.error);
    } else await localRequest('/api/share', { url: value });
    loadQr(); elQrBig.src = elQr.src;
    await openQrModal();
  } catch (e) { showError(e instanceof TypeError ? 'BAD_URL' : e); }
});
$('copyUrl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(elJoinUrl.textContent || location.href); $('copyUrl').textContent = '已复制'; setTimeout(() => { $('copyUrl').textContent = '复制链接'; }, 1500); }
  catch { showError('NETWORK'); }
});

/* ------------------------------------------------------------------ 启动 */
function retryStartup(): void {
  if (ready || bootstrapTimer !== null) return;
  bootstrapTimer = window.setTimeout(() => {
    bootstrapTimer = null;
    void start();
  }, bootstrapDelay);
  bootstrapDelay = Math.min(10000, Math.round(bootstrapDelay * 1.8));
}
async function start(): Promise<void> {
  if (ready || starting) return;
  starting = true;
  document.body.classList.add('offline');
  try {
    const res = await fetch(`${mount}/api/config`, { cache: 'no-store' });
    if (!res.ok) throw new Error('NETWORK');
    let cfg = await res.json() as RuntimeConfig;
    if (cfg.mode === 'redirect') {
      cloudBase = String(cfg.cloud_url || '').replace(/\/+$/, '');
      const remote = await fetch(`${cloudBase}/api/config`, { cache: 'no-store' });
      if (!remote.ok) throw new Error('NETWORK');
      cfg = await remote.json() as RuntimeConfig;
    } else if (cfg.mode === 'supabase') cloudBase = mount;
    if (cfg.mode === 'supabase') {
      if (!cfg.project_url || !cfg.anon_key) throw new Error('NETWORK');
      mode = 'cloud';
      supabase = createClient(cfg.project_url, cfg.anon_key, { auth: {
        storage: sessionStorage, storageKey: 'qwen-board-admin-session',
        persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
      } });
      const session = await supabase.auth.getSession();
      if (session.data.session) {
        const result = await supabase.rpc('qwen_board_is_admin');
        isAdmin = !result.error && Boolean(result.data);
      }
      supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') { isAdmin = false; updateAdminUI(); }
      });
      subscribeCloud();
    } else if (cfg.mode === 'local') {
      mode = 'local';
      localToken = sessionStorage.getItem('qwen-board-local-admin') || '';
      const session = await localRequest('/api/admin/session');
      isAdmin = Boolean(session.authenticated);
      if (!isAdmin) { localToken = ''; sessionStorage.removeItem('qwen-board-local-admin'); }
      connectLocal();
    } else throw new Error('NETWORK');
    ready = true;
    updateAdminUI();
    loadQr();
    await refreshState();
    window.setInterval(() => void refreshState(), 2000);
    window.setInterval(() => { if (mode === 'local' && connected && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' })); }, 15000);
  } catch (e) { showError(e); retryStartup(); }
  finally { starting = false; }
}
if (new URLSearchParams(location.search).get('marks') === '1') document.body.classList.add('with-marks');
updateAdminUI();
void start();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!ready) void start();
    else { if (mode === 'local') connectLocal(); void refreshState(); }
  }
});
window.addEventListener('online', () => {
  if (!ready) void start();
  else { if (mode === 'local') connectLocal(); void refreshState(); }
});
