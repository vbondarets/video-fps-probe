import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

export function mimeOf(path) {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function resolveRequest(root, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }
  const rel = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const abs = resolve(join(root, rel));
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : 'unsatisfiable';
}

export function startServer(dir, { port = 0, host = '127.0.0.1' } = {}) {
  const root = resolve(dir);
  const log = [];
  const t0 = performance.now();
  const server = http.createServer((req, res) => {
    const file = resolveRequest(root, req.url ?? '/');
    let st = null;
    try {
      st = file ? statSync(file) : null;
    } catch {
      st = null;
    }
    const entry = { at: performance.now() - t0, url: req.url, status: 404, bytes: 0 };
    log.push(entry);
    const common = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (!st || !st.isFile() || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { ...common, 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = mimeOf(file);
    const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
    if (range === 'unsatisfiable') {
      entry.status = 416;
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${st.size}` });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : st.size - 1;
    entry.status = range ? 206 : 200;
    entry.bytes = Math.max(0, end - start + 1);
    const headers = { ...common, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': entry.bytes };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(entry.status, headers);
    if (req.method === 'HEAD' || entry.bytes === 0) res.end();
    else createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const addr = server.address();
      done({
        url: `http://${host}:${addr.port}/`,
        log,
        mark: () => log.length,
        since: (n) => log.slice(n),
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}
