'use strict';
/** Minimal dependency-free HTTP helpers (JSON + multipart/form-data). */
const MAX_BODY = 128 << 20;   // go/gateway/security.go defaultLimits().UploadBytes

function readBody(req, max = MAX_BODY) {
  const limit = Math.min(max, req.maxBodyBytes || MAX_BODY);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body exceeds configured limit'), { status: 413 }));
        req.resume();   // drain the socket so the 413 response can still be written
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, max) {
  const raw = await readBody(req, max);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('a single valid JSON value is required'), { status: 400 }); }
}

/** Parse multipart/form-data into fields + binary files. */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!m) throw Object.assign(new Error('multipart boundary missing'), { status: 400 });
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  const files = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) throw Object.assign(new Error('malformed multipart body'), { status: 400 });
  pos += boundary.length;
  while (pos < buf.length) {
    if (buf.slice(pos, pos + 2).toString() === '--') break;   // closing boundary
    if (buf.slice(pos, pos + 2).toString() === '\r\n') pos += 2;
    const sep = buf.indexOf('\r\n\r\n', pos);
    if (sep < 0) break;
    const headerText = buf.slice(pos, sep).toString('utf8');
    const next = buf.indexOf(boundary, sep + 4);
    if (next < 0) break;
    let end = next - 2;                                        // strip trailing CRLF
    if (end < sep + 4) end = sep + 4;
    const data = buf.slice(sep + 4, end);
    const nameM = /name="([^"]*)"/i.exec(headerText);
    const fileM = /filename="([^"]*)"/i.exec(headerText);
    const typeM = /Content-Type:\s*([^\r\n;]+)/i.exec(headerText);
    const name = nameM ? nameM[1] : '';
    if (fileM) {
      files.push({
        field: name,
        filename: fileM[1].replace(/\\/g, '/').split('/').pop().slice(0, 128) || 'audio',
        contentType: typeM ? typeM[1].trim() : 'application/octet-stream',
        data: Buffer.from(data),
      });
    } else if (name) {
      fields[name] = data.toString('utf8');
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** denyBusy() in go/gateway/security.go: 429 + Retry-After: 5. */
function busy(res, message) {
  const body = JSON.stringify({ error: message });
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Retry-After': '5',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

module.exports = { MAX_BODY, readBody, readJson, parseMultipart, json, fail, busy };
