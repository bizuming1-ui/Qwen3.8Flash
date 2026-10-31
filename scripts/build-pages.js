#!/usr/bin/env node
// 生成 GitHub Pages 的 /docs 发布物。PUBLIC_CLOUD_URL 是公开的 Edge API 地址，不是密钥。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const cloud = process.env.PUBLIC_CLOUD_URL;
if (!cloud) throw new Error('请先设置 PUBLIC_CLOUD_URL，例如 https://<project>.supabase.co/functions/v1/qwen-board');
const url = new URL(cloud);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
  throw new Error('PUBLIC_CLOUD_URL 必须是无凭证、无查询参数的 HTTPS 地址');
}
const base = url.href.replace(/\/+$/, '');
const source = path.join(root, 'web');
const target = path.join(root, 'docs');
fs.mkdirSync(target, { recursive: true });
for (const file of ['index.html', 'debug.html', 'styles.css', 'favicon.svg', 'manifest.webmanifest', 'app.js']) {
  let content = fs.readFileSync(path.join(source, file), 'utf8');
  if (file.endsWith('.html')) {
    content = content.replace('<head>', `<head>\n    <meta name="board-base" content="${base.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" />`);
  }
  fs.writeFileSync(path.join(target, file), content);
}
fs.writeFileSync(path.join(target, '.nojekyll'), '');
console.log(`Pages 发布文件已写入 docs/，云端 API: ${base}`);
