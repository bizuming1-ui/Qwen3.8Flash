// Supabase Edge 只提供 API 和二维码；HTML 由 GitHub Pages 托管。
// SUPABASE_ANON_KEY 是允许公开的客户端 key；严禁返回 service-role key。
import QRCode from 'npm:qrcode@1.5.4/lib/browser.js';

const PROJECT_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const PAGE_URL = 'https://bizuming1-ui.github.io/Qwen3.8Flash/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Join-Url',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function rpc(name: string, args: Record<string, unknown> = {}, authorization?: string | null): Promise<unknown> {
  const res = await fetch(`${PROJECT_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: authorization || `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data?.message === 'string' ? data.message : 'DATABASE_ERROR');
  return data;
}
async function share(): Promise<{ url: string; custom_url: string | null; hosting: string }> {
  const custom = await rpc('qwen_board_get_share');
  const url = typeof custom === 'string' && custom ? custom : PAGE_URL;
  return { url, custom_url: typeof custom === 'string' ? custom : null, hosting: 'supabase' };
}
function codeStatus(message: string): number {
  if (message.includes('ADMIN_REQUIRED') || message.includes('READ_ONLY')) return 403;
  if (message.includes('EXCEEDS_TOTAL') || message.includes('TOTAL_TOO_SMALL')) return 409;
  if (/BAD_|REQUEST_MISMATCH/.test(message)) return 400;
  return 503;
}
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!PROJECT_URL || !ANON_KEY) return json({ ok: false, error: 'CONFIG_ERROR' }, 503);
  const u = new URL(req.url);
  const marker = '/qwen-board';
  const index = u.pathname.indexOf(marker);
  const path = index >= 0 ? u.pathname.slice(index + marker.length) || '/' : u.pathname;
  try {
    if (req.method === 'GET' && path === '/api/config') {
      return json({ ok: true, mode: 'supabase', project_url: PROJECT_URL, anon_key: ANON_KEY });
    }
    if (req.method === 'GET' && path === '/api/join-url') return json({ ok: true, ...(await share()) });
    if (req.method === 'GET' && path === '/api/qr.svg') {
      const link = (await share()).url;
      const svg = await QRCode.toString(link, { errorCorrectionLevel: 'M', margin: 4, width: 512 });
      return new Response(svg, { headers: { ...cors, 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Join-Url': link, 'X-Content-Type-Options': 'nosniff' } });
    }
    if (req.method === 'GET' && (path === '/api/state' || path === '/api/health')) {
      const r = await fetch(`${PROJECT_URL}/rest/v1/qwen_board_state?id=eq.true&select=*`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
      if (!r.ok) throw new Error('DATABASE_ERROR');
      const rows = await r.json();
      const b = rows[0];
      if (!b) throw new Error('DATABASE_ERROR');
      if (path === '/api/health') return json({ ok: true, runtime: 'supabase', rev: b.rev, peers: '—', uptime_sec: 0, core: { ready: false, last_latency_ms: 0 }, services: [{ name: 'database', running: true }] });
      return json({ ok: true, rev: b.rev, state: { order_no: b.order_no, product: b.product, total: b.total, current: b.current_count, now: b.now_count } });
    }
    if (req.method === 'GET' && path === '/api/stats') return json(await rpc('qwen_board_stats'));
    if (req.method === 'GET' && path === '/api/history') {
      const limit = Math.min(10000, Math.max(0, Number(u.searchParams.get('limit') ?? 50) || 0));
      return json(await rpc('qwen_board_history', { p_limit: Math.trunc(limit) }));
    }
    if (req.method === 'GET' && path === '/api/export.csv') {
      const history = await rpc('qwen_board_history', { p_limit: 10000 }) as { items: Array<Record<string, unknown>> };
      const rows = [['时间', '生产单', '产品', '本次数量', '生产总数', '当前生产数', '版本'].map(csvCell).join(',')];
      for (const r of history.items) rows.push([new Date(Number(r.ts)).toISOString(), r.order_no, r.product, r.delta, r.total, r.current, r.rev].map(csvCell).join(','));
      return new Response('\ufeff' + rows.join('\r\n'), { headers: { ...cors, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="production-history.csv"', 'Cache-Control': 'no-store' } });
    }
    if (req.method === 'POST' && ['/api/set', '/api/confirm', '/api/reset', '/api/share'].includes(path)) {
      const auth = req.headers.get('authorization');
      const body = path === '/api/reset' ? {} : await req.json();
      let result: unknown;
      if (path === '/api/set') result = await rpc('qwen_board_set', { p_field: body.field, p_value: String(body.value ?? '') }, auth);
      else if (path === '/api/confirm') result = await rpc('qwen_board_confirm', { p_amount: body.amount, p_request: body.request_id || crypto.randomUUID() }, auth);
      else if (path === '/api/reset') result = await rpc('qwen_board_reset', {}, auth);
      else result = await rpc('qwen_board_set_share', { p_url: body.url ?? '' }, auth);
      return path === '/api/share' ? json({ ok: true, ...(await share()) }) : json({ ok: true, ...(result as Record<string, unknown>) });
    }
    return json({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'DATABASE_ERROR';
    return json({ ok: false, error: message }, codeStatus(message));
  }
});
