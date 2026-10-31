import os from 'node:os';
import QRCode from 'qrcode';

const cache = new Map<string, { svg: string; at: number }>();
const TTL = 10 * 60 * 1000;

function lanAddress(): string | null {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

/**
 * 推断「别的手机能扫得到的公网/局域网地址」。
 * 反向代理（沙盒预览）会带 x-forwarded-proto / x-forwarded-host，
 * 优先使用它们；本地 localhost 调试时回退到局域网 IP，手机同 WiFi 也能扫。
 */
export function publicBaseUrl(headers: Record<string, string | string[] | undefined>, fallbackPort: number): string {
  const pick = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() ?? '';

  const host = pick(headers['x-forwarded-host']) || pick(headers.host);
  let proto = pick(headers['x-forwarded-proto']) || 'http';
  if (!host) return `http://127.0.0.1:${fallbackPort}`;

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host);
  if (isLocal) {
    const lan = lanAddress();
    const port = host.includes(':') ? host.split(':').pop() : String(fallbackPort);
    if (lan) return `${proto}://${lan}:${port}`;
  }
  if (proto !== 'http' && proto !== 'https') proto = 'https';
  return `${proto}://${host}`;
}

export async function qrSvg(text: string): Promise<string> {
  const hit = cache.get(text);
  const now = Date.now();
  if (hit && now - hit.at < TTL) return hit.svg;
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 512,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
  cache.set(text, { svg, at: now });
  if (cache.size > 64) cache.clear();
  return svg;
}
