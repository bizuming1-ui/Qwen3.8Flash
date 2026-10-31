// 只读的线上部署自检：不修改看板，也不读取或返回任何密钥。
Deno.serve(async () => {
  try {
    const root = 'https://bizuming1-ui.github.io/Qwen3.8Flash/';
    const page = await fetch(root, { headers: { 'Cache-Control': 'no-cache' } });
    const html = await page.text();
    const js = await fetch(root + 'app.js', { headers: { 'Cache-Control': 'no-cache' } });
    const css = await fetch(root + 'styles.css', { headers: { 'Cache-Control': 'no-cache' } });
    const api = (Deno.env.get('SUPABASE_URL') || '') + '/functions/v1/qwen-board';
    const cfg = await fetch(api + '/api/config');
    const qr = await fetch(api + '/api/qr.svg');
    const svg = await qr.text();
    const join = await (await fetch(api + '/api/join-url')).json();
    return new Response(JSON.stringify({
      page_status: page.status,
      page_title: html.includes('界面1 · 生产看板'),
      current_readonly: /id="current"[^>]*readonly/.test(html),
      cloud_config: html.includes('name="board-base"'),
      js_status: js.status,
      js_type: js.headers.get('content-type'),
      js_bytes: (await js.text()).length,
      css_status: css.status,
      api_status: cfg.status,
      qr_status: qr.status,
      qr_svg: svg.startsWith('<svg'),
      qr_join_matches: qr.headers.get('x-join-url') === join.url,
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { headers: { 'Content-Type': 'application/json' } });
  }
});
