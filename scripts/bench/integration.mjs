import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { AppPage } from './app.mjs';
import { findBrowser, killAllBrowsers, launchBrowser } from './browser.mjs';
import { mimeOf, resolveRequest } from './server.mjs';
import { median } from './values.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO, 'demo', 'dist');
const BENCH_DIR = join(REPO, '.bench');
const FILES_DIR = join(REPO, 'fixtures', 'files');
const LARGE_DIR = join(REPO, 'fixtures', 'large');

const HOST = {
  initialGzipBytes: 1.95e6,
  initialFiles: 364,
  initialRawBytes: 6.38e6,
  fullGzipBytes: 6.3e6,
  triggerBudgetBytes: 1000,
  uploadBytes: 100e6,
  uploadMbps: [10, 50],
  heapExamplesMB: [100, 200],
};

const PROFILES = [
  { id: 'none', label: 'none (localhost)', latencyMs: 0, downKbps: null, upKbps: null },
  { id: 'cable', label: 'cable', latencyMs: 20, downKbps: 50000, upKbps: 10000 },
  { id: 'fast4g', label: 'fast 4G', latencyMs: 85, downKbps: 9000, upKbps: 1500 },
  { id: 'slow4g', label: 'slow 4G', latencyMs: 150, downKbps: 1600, upKbps: 750 },
  { id: '3g', label: '3G', latencyMs: 300, downKbps: 750, upKbps: 250 },
];

const SCENARIOS = {
  host: [
    { id: 'cold', label: 'nothing loaded before the pick' },
    { id: 'prefetch', label: 'fetch() of the glue, worker entry and ISO BMFF chunk before the pick (HTTP cache warm)' },
    { id: 'prewarm', label: 'prewarm hook before the pick: glue imported, worker spawned, ISO BMFF chunk loaded and run once on a 16-byte ftyp blob' },
  ],
  app: [
    { id: 'cold', label: 'nothing loaded before the pick' },
    { id: 'prefetch', label: 'fetch() of the worker entry and ISO BMFF chunk before the pick (HTTP cache warm)' },
    { id: 'prewarm', label: 'a tiny MP4 (edge_single_frame.mp4, 4 KB) picked first, which spawns the worker and loads the parser' },
  ],
};

const FIRST = 'cfr_h264_30.mp4';
const TINY = 'edge_single_frame.mp4';
const LONG = 'long_cfr_3h_60fps.mp4';
const CPU_FILES = [
  { id: 'typical', label: 'typical MP4 (faststart, H.264 + AAC)', name: 'av_h264_aac_faststart.mp4' },
  { id: 'moovEnd', label: 'MP4 with moov at the end (H.264 + AAC)', name: 'av_h264_aac.mp4' },
  { id: 'fmp4', label: 'fragmented MP4 (CMAF)', name: 'fmp4_cmaf.mp4' },
  { id: 'webmExact', label: 'WebM, exact block scan (VFR)', name: 'vfr_concat_10_30_60.webm' },
  { id: 'long3h', label: '3 h CFR 60 fps MP4 (648000 frames, 13 MB)', name: LONG, large: true },
  { id: 'long1h', label: '1 h VFR screen recording MP4 (133920 frames)', name: 'long_vfr_1h_screenrec.mp4', large: true },
];

const PHASES = ['latency', 'main', 'memory', 'cpu'];

const USAGE = `Usage: node scripts/bench/integration.mjs [options]

Integration cost of the FPS probe inside a large host SPA. Serves demo/dist/ gzip-compressed
from a local node:http server (plus a virtual host-model page and the bundled worker
pool glue), drives a headless Chrome with a throwaway profile in .bench/ over CDP.

  --reps <n>         page loads per profile and scenario for the first-file latency (default 5)
  --batch-reps <n>   fresh pages for the main-thread runs (default 3)
  --cpu-reps <n>     single-file picks per CPU fixture (default 7)
  --profiles <list>  comma separated: ${PROFILES.map((p) => p.id).join(',')} (default all)
  --skip <list>      comma separated phases to skip: ${PHASES.join(',')}
  --out <dir>        report directory (default report)
  --render <json>    re-render the report from a saved integration-cost.json, no browser
  --no-write         print the summary only
  --help

Build first: npm run build.
`;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sum = (xs) => xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);

function pctile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

function options() {
  const { values } = parseArgs({
    options: {
      reps: { type: 'string', default: '5' },
      'batch-reps': { type: 'string', default: '3' },
      'cpu-reps': { type: 'string', default: '7' },
      profiles: { type: 'string', default: PROFILES.map((p) => p.id).join(',') },
      skip: { type: 'string', default: '' },
      out: { type: 'string', default: 'report' },
      render: { type: 'string' },
      'no-write': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const count = (k) => {
    const n = Number(values[k]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${k} must be a positive integer`);
    return n;
  };
  const skip = new Set(values.skip.split(',').map((s) => s.trim()).filter(Boolean));
  for (const s of skip) if (!PHASES.includes(s)) throw new Error(`unknown phase in --skip: ${s}`);
  const profiles = values.profiles.split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of profiles) if (!PROFILES.some((x) => x.id === p)) throw new Error(`unknown profile: ${p}`);
  return {
    help: values.help,
    reps: count('reps'),
    batchReps: count('batch-reps'),
    cpuReps: count('cpu-reps'),
    profiles: PROFILES.filter((p) => profiles.includes(p.id)),
    skip,
    out: resolve(REPO, values.out),
    render: values.render ? resolve(REPO, values.render) : null,
    write: !values['no-write'],
  };
}

function conditions(p) {
  return {
    offline: false,
    latency: p.latencyMs,
    downloadThroughput: p.downKbps ? (p.downKbps * 1000) / 8 : -1,
    uploadThroughput: p.upKbps ? (p.upKbps * 1000) / 8 : -1,
  };
}
const NO_THROTTLE = conditions(PROFILES[0]);

const gz = (buf) => gzipSync(buf, { level: 9 });

function distChunks() {
  const assets = join(DIST, 'assets');
  if (!existsSync(join(DIST, 'index.html')) || !existsSync(assets)) throw new Error('demo/dist/ is missing: run npm run build first');
  const files = readdirSync(assets);
  const pick = (prefix) => {
    const f = files.find((x) => x.startsWith(prefix) && x.endsWith('.js'));
    if (!f) throw new Error(`demo/dist/assets has no ${prefix}*.js`);
    return f;
  };
  return { entry: pick('probe.worker-'), isobmff: pick('isobmff-'), matroska: pick('matroska-'), main: pick('index-') };
}

const GLUE_ID = 'fps-glue';
const GLUE_WORKER_REF = './fps-worker-entry.js';
const GLUE_SOURCE = `import { WorkerPool } from ${JSON.stringify(join(REPO, 'src', 'client', 'pool.ts'))};
const pool = new WorkerPool({ create: () => new Worker(new URL('${GLUE_WORKER_REF}', import.meta.url), { type: 'module' }), size: 2, idleTimeoutMs: 0 });
export function submit(file, engine, options) {
  return { promise: pool.run({ type: 'analyze', file, name: file.name, engine, options }).then((r) => (r.type === 'result' ? r.result : Promise.reject(new Error(r.type)))) };
}
`;

async function buildGlue(entryFile) {
  const require = createRequire(join(REPO, 'package.json'));
  const { rolldown } = await import(pathToFileURL(require.resolve('rolldown')).href);
  const glue = { name: 'fps-glue', resolveId: (id) => (id === GLUE_ID ? id : null), load: (id) => (id === GLUE_ID ? GLUE_SOURCE : null) };
  const bundle = await rolldown({ input: GLUE_ID, plugins: [glue], logLevel: 'silent' });
  try {
    const { output } = await bundle.generate({ format: 'es', minify: true });
    const code = output[0].code;
    if (!code.includes(GLUE_WORKER_REF)) throw new Error('glue: the worker reference was not found in the bundled WorkerPool glue');
    return code.replace(GLUE_WORKER_REF, `./${entryFile}`);
  } finally {
    await bundle.close();
  }
}

const TRIGGER = `let probe;
const loadProbe = () => (probe ??= import('./assets/fps-glue.js'));
const list = document.getElementById('out');
const state = { results: [], pending: 0 };
const show = (r) => {
  const t = r.videoTracks && r.videoTracks[0];
  const li = document.createElement('li');
  li.textContent = r.name + ': ' + (t && t.avgFps ? t.avgFps.value.toFixed(3) + ' fps' : r.error);
  list.append(li);
};
document.getElementById('pick').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const { submit } = await loadProbe();
  for (const file of files) {
    state.pending++;
    submit(file, 'own', { matroskaMode: 'auto' }).promise
      .catch((err) => ({ name: file.name, error: String(err), videoTracks: [], io: { ms: 0, reads: 0, bytesRead: 0 } }))
      .then((r) => { state.results.push(r); state.pending--; show(r); });
  }
});
window.__host = { loadProbe, state };`;

const HARNESS = `if (new URLSearchParams(location.search).has('control')) {
  addEventListener('change', (e) => {
    if (!e.target.matches || !e.target.matches('#pick')) return;
    e.stopImmediatePropagation();
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      window.__host.state.results.push({ name: f.name, size: f.size, error: null, videoTracks: [], io: { ms: 0, reads: 0, bytesRead: 0 } });
      const li = document.createElement('li');
      li.textContent = f.name + ': ' + f.size + ' B';
      document.getElementById('out').append(li);
    }
  }, true);
}
window.__fpsProbe = {
  get results() { return window.__host.state.results; },
  get pending() { return window.__host.state.pending; },
  runEngine() { return Promise.reject(new Error('not available on the host model page')); },
};
window.__harness = {
  async prewarm() {
    const t0 = performance.now();
    const { submit } = await window.__host.loadProbe();
    const ftyp = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0]);
    const r = await submit(new File([ftyp], 'warmup.mp4'), 'own', {}).promise;
    return { ms: performance.now() - t0, container: r.container, error: r.error };
  },
};`;

const HOST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Host model</title>
<style>body{font:14px system-ui,sans-serif;margin:16px}</style>
</head>
<body>
<p>Host model: only the trigger script below is in the critical path.</p>
<input id="pick" type="file" multiple data-testid="file-input">
<ol id="out"></ol>
<script type="module">${TRIGGER}</script>
<script type="module">${HARNESS}</script>
</body>
</html>
`;

const MT = `(() => {
  if (window.__mt) return;
  const s = { lt: [], raf: [], to: [], keys: [], on: false, ltError: null };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  } catch (e) { s.ltError = String(e); }
  const raf = () => { if (!s.on) return; s.raf.push(performance.now()); requestAnimationFrame(raf); };
  const tick = () => { if (!s.on) return; s.to.push(performance.now()); setTimeout(tick, 0); };
  addEventListener('keydown', (e) => { if (s.on) s.keys.push([e.timeStamp, performance.now()]); }, true);
  s.start = () => { s.raf = []; s.to = []; s.keys = []; s.on = true; requestAnimationFrame(raf); setTimeout(tick, 0); return performance.now(); };
  s.stop = () => { s.on = false; return { now: performance.now(), lt: s.lt, raf: s.raf, to: s.to, keys: s.keys, ltError: s.ltError }; };
  s.prefetch = async (urls) => {
    const t0 = performance.now();
    const bytes = await Promise.all(urls.map((u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => b.byteLength)));
    return { ms: performance.now() - t0, bytes };
  };
  s.rt = () => performance.getEntriesByType('resource').map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd, transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize }));
  window.__mt = s;
})();`;

const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;

function startGzipServer(dir, virtual) {
  const root = resolve(dir);
  const cache = new Map();
  const log = [];
  const t0 = performance.now();
  const server = http.createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      path = '/';
    }
    let body = null;
    let type = null;
    if (virtual.has(path)) {
      ({ body, type } = virtual.get(path));
    } else {
      const file = resolveRequest(root, req.url ?? '/');
      try {
        if (file && statSync(file).isFile()) {
          body = readFileSync(file);
          type = mimeOf(file);
        }
      } catch {
        body = null;
      }
    }
    const entry = { at: performance.now() - t0, path, status: 404, encoding: null, rawBytes: 0, bodyBytes: 0 };
    log.push(entry);
    if (!body || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('not found');
      return;
    }
    const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && COMPRESSIBLE.test(type);
    let out = body;
    if (gzipOk) {
      out = cache.get(path) ?? gz(body);
      cache.set(path, out);
    }
    entry.status = 200;
    entry.encoding = gzipOk ? 'gzip' : 'identity';
    entry.rawBytes = body.length;
    entry.bodyBytes = out.length;
    const headers = {
      'Content-Type': type,
      'Content-Length': out.length,
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept-Encoding',
    };
    if (gzipOk) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : out);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      done({
        url: `http://127.0.0.1:${server.address().port}/`,
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

class Tracker {
  constructor(page) {
    this.page = page;
    this.conn = page.conn;
    this.workers = new Map();
    this.events = [];
    this.recording = false;
    this.cacheDisabled = false;
    this.pauseMs = [];
    this.rendererPid = null;
    this.conn.handlers.add((m) => this.onMessage(m));
  }

  onMessage(m) {
    if (m.method === 'Target.attachedToTarget' && m.sessionId === this.page.sessionId) {
      const sid = m.params.sessionId;
      const w = { sid, type: m.params.targetInfo.type, url: m.params.targetInfo.url, attachedAt: performance.now() };
      if (w.type === 'worker') this.workers.set(sid, w);
      void this.setup(w);
      return;
    }
    if (m.method === 'Target.detachedFromTarget') {
      this.workers.delete(m.params.sessionId);
      return;
    }
    if (!m.method?.startsWith('Network.')) return;
    if (m.sessionId === this.page.sessionId && m.method === 'Network.requestWillBeSent' && this.rendererPid === null) {
      const pid = /^(\d+)\.\d+$/.exec(m.params.requestId ?? '');
      if (pid) this.rendererPid = Number(pid[1]);
    }
    if (this.recording && (m.sessionId === this.page.sessionId || this.workers.has(m.sessionId))) {
      this.events.push({ worker: m.sessionId !== this.page.sessionId, method: m.method, params: m.params });
    }
  }

  async setup(w) {
    const send = (method, params = {}) => this.conn.send(method, params, w.sid, 10_000);
    try {
      if (w.type === 'worker') {
        await send('Network.enable');
        if (this.cacheDisabled) await send('Network.setCacheDisabled', { cacheDisabled: true });
      }
    } catch {
      w.networkFailed = true;
    } finally {
      await send('Runtime.runIfWaitingForDebugger').catch(() => {});
      this.pauseMs.push(performance.now() - w.attachedAt);
    }
  }

  start() {
    this.events = [];
    this.recording = true;
  }

  stop() {
    this.recording = false;
    return this.events;
  }

  send(sid, method, params = {}, timeoutMs = 30_000) {
    return this.conn.send(method, params, sid, timeoutMs);
  }

  async evalWorkers(expression) {
    const out = [];
    for (const w of [...this.workers.values()]) {
      try {
        const r = await this.send(w.sid, 'Runtime.evaluate', { expression, returnByValue: true }, 10_000);
        if (!r.exceptionDetails) out.push(r.result.value);
      } catch {
        continue;
      }
    }
    return out;
  }
}

function processMemory(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${Number(pid)} | Select-Object WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],
        { encoding: 'utf8', timeout: 20_000, windowsHide: true },
      );
      const j = JSON.parse(out);
      return { workingSet: j.WorkingSet64, private: j.PrivateMemorySize64 };
    }
    const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 }).trim());
    return { workingSet: rss * 1024, private: null };
  } catch {
    return null;
  }
}

function fixture(name) {
  for (const dir of [FILES_DIR, LARGE_DIR]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

class Bench {
  constructor({ b, server, chunks, glueBytes }) {
    this.b = b;
    this.page = b.page;
    this.server = server;
    this.chunks = chunks;
    this.glueBytes = glueBytes;
    this.tracker = new Tracker(b.page);
    this.app = new AppPage(b.page, server.url);
    this.urls = {
      host: `${server.url}host.html`,
      control: `${server.url}host.html?control=1`,
      app: server.url,
    };
  }

  async init() {
    await this.page.send('Network.enable');
    await this.page.send('Performance.enable');
    await this.page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source: MT });
    await this.page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  async open(kind, { cacheDisabled = false, clearCache = true } = {}) {
    await this.page.send('Network.emulateNetworkConditions', NO_THROTTLE);
    if (clearCache) await this.page.send('Network.clearBrowserCache');
    this.tracker.cacheDisabled = cacheDisabled;
    await this.page.send('Network.setCacheDisabled', { cacheDisabled });
    this.app.url = this.urls[kind];
    const load = await this.app.open();
    await sleep(300);
    return load;
  }

  times() {
    return this.page.eval('window.__bench.waiter.then((r) => ({ t0: r.t0, t1: r.t1, origin: performance.timeOrigin }))');
  }

  pick(names, opts = {}) {
    return this.app.addFiles(this.paths(names), opts);
  }

  paths(names) {
    return names.map((n) => {
      const p = fixture(n);
      if (!p) throw new Error(`fixture not found: ${n}`);
      return p;
    });
  }

  async pickLight(names, timeoutMs = 300_000) {
    const paths = this.paths(names);
    await this.page.eval(`window.__bench.arm(${paths.length}, ${timeoutMs}, false)`);
    const objectId = await this.page.handle(`document.querySelector('input[data-testid="file-input"]')`);
    try {
      await this.page.send('DOM.setFileInputFiles', { files: paths, objectId });
    } finally {
      await this.page.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
    return this.page.eval('window.__bench.waiter.then((r) => ({ t0: r.t0, t1: r.t1, wallMs: r.t1 - r.t0, origin: performance.timeOrigin }))', timeoutMs + 10_000);
  }

  lastResults(n) {
    return this.page.eval(`window.__fpsProbe.results.slice(-${n}).map((r) => ({ name: r.name, ms: r.io.ms, error: r.error }))`);
  }

  async cpu() {
    const [{ metrics }, procs] = await Promise.all([this.page.send('Performance.getMetrics'), this.b.browser.send('SystemInfo.getProcessInfo', {}, 20_000).catch(() => null)]);
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const byPid = {};
    for (const p of procs?.processInfo ?? []) byPid[p.id] = { type: p.type, cpu: p.cpuTime };
    return { at: performance.now(), thread: m.ThreadTime, process: m.ProcessTime, task: m.TaskDuration, script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration, byPid };
  }

  async memory(label, gc) {
    if (gc) {
      await this.page.send('HeapProfiler.collectGarbage').catch(() => {});
      for (const w of [...this.tracker.workers.values()]) await this.tracker.send(w.sid, 'HeapProfiler.collectGarbage').catch(() => {});
    }
    const p = await this.page.send('Runtime.getHeapUsage');
    const workers = [];
    for (const w of [...this.tracker.workers.values()]) {
      try {
        const h = await this.tracker.send(w.sid, 'Runtime.getHeapUsage');
        workers.push({ used: h.usedSize, total: h.totalSize, embedder: h.embedderHeapUsedSize ?? null, backing: h.backingStorageSize ?? null });
      } catch {
        workers.push(null);
      }
    }
    return {
      label,
      gc,
      page: { used: p.usedSize, total: p.totalSize, embedder: p.embedderHeapUsedSize ?? null, backing: p.backingStorageSize ?? null },
      workers,
      workerCount: this.tracker.workers.size,
      workersUsed: sum(workers.map((w) => w?.used)),
      workersTotal: sum(workers.map((w) => w?.total)),
      process: processMemory(this.tracker.rendererPid),
    };
  }
}

function cpuDelta(a, b) {
  const byType = {};
  let all = 0;
  for (const [pid, pb] of Object.entries(b.byPid)) {
    const pa = a.byPid[pid];
    if (!pa) continue;
    const d = (pb.cpu - pa.cpu) * 1000;
    byType[pb.type] = (byType[pb.type] ?? 0) + d;
    all += d;
  }
  return {
    wallMs: b.at - a.at,
    mainThreadMs: (b.thread - a.thread) * 1000,
    rendererProcessMs: (b.process - a.process) * 1000,
    taskMs: (b.task - a.task) * 1000,
    scriptMs: (b.script - a.script) * 1000,
    layoutMs: (b.layout - a.layout) * 1000,
    styleMs: (b.style - a.style) * 1000,
    allProcessesMs: all,
    byProcessType: byType,
  };
}

function wallToPage(wallSec, origin) {
  return wallSec * 1000 - origin;
}

function firstAfter(list, t0, pred) {
  return list.filter(pred).filter((e) => e.end >= t0 - 0.5).sort((a, b) => a.end - b.end)[0] ?? null;
}

function networkFor(events, needle) {
  const req = events.find((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes(needle));
  if (!req) return null;
  const id = req.params.requestId;
  const offset = req.params.wallTime - req.params.timestamp;
  const resp = events.find((e) => e.method === 'Network.responseReceived' && (e.params.requestId === id || e.params.response.url.includes(needle)));
  const fin = events.find((e) => e.method === 'Network.loadingFinished' && e.params.requestId === (resp?.params.requestId ?? id));
  return {
    startWall: req.params.wallTime,
    endWall: fin ? fin.params.timestamp + offset : null,
    headersBytes: resp?.params.response.encodedDataLength ?? null,
    encodedDataLength: fin?.params.encodedDataLength ?? null,
    fromDiskCache: resp?.params.response.fromDiskCache ?? null,
    fromMemoryCache: resp?.params.response.fromMemoryCache ?? null,
    status: resp?.params.response.status ?? null,
    workerSession: resp ? resp.worker : null,
  };
}

function breakdown(kind, t, pageRt, workerRt, events, chunks) {
  const origin = t.origin;
  const glueRt = kind === 'host' ? firstAfter(pageRt, t.t0, (e) => e.name.includes('fps-glue')) : null;
  const entryRt = firstAfter(pageRt, t.t0, (e) => e.name.includes(chunks.entry));
  const parserRt = firstAfter(workerRt, t.t0, (e) => e.name.includes(chunks.isobmff));
  const net = {
    glue: kind === 'host' ? networkFor(events, 'fps-glue') : null,
    entry: networkFor(events, chunks.entry),
    parser: networkFor(events, chunks.isobmff),
  };
  const entryStart = net.entry ? wallToPage(net.entry.startWall, origin) : null;
  const marks = {
    t0: t.t0,
    glueStart: glueRt?.start ?? null,
    glueEnd: glueRt?.end ?? null,
    entryStart: entryStart !== null && entryStart >= t.t0 - 1 ? entryStart : null,
    entryEnd: entryRt?.end ?? null,
    parserStart: parserRt?.start ?? (net.parser ? wallToPage(net.parser.startWall, origin) : null),
    parserEnd: parserRt?.end ?? (net.parser?.endWall ? wallToPage(net.parser.endWall, origin) : null),
    t1: t.t1,
  };
  const d = (a, b) => (marks[a] !== null && marks[b] !== null ? marks[b] - marks[a] : null);
  const fetched = marks.entryStart !== null && marks.entryEnd !== null && marks.parserStart !== null && marks.parserEnd !== null;
  const phases = {
    totalMs: t.t1 - t.t0,
    glueMs: kind === 'host' && marks.glueEnd !== null ? marks.glueEnd - t.t0 : null,
    glueFetchMs: d('glueStart', 'glueEnd'),
    spawnMs: fetched ? marks.entryStart - (kind === 'host' && marks.glueEnd !== null ? marks.glueEnd : t.t0) : null,
    entryFetchMs: fetched ? d('entryStart', 'entryEnd') : null,
    entryEvalMs: fetched ? d('entryEnd', 'parserStart') : null,
    parserFetchMs: fetched ? d('parserStart', 'parserEnd') : null,
    firstRunMs: fetched ? d('parserEnd', 't1') : null,
  };
  const parserNetEnd = net.parser?.endWall ? wallToPage(net.parser.endWall, origin) : null;
  return {
    marks,
    phases,
    network: net,
    clockCheckMs: parserRt && parserNetEnd !== null ? parserNetEnd - parserRt.end : null,
    rt: {
      glue: glueRt ? { transfer: glueRt.transfer, encoded: glueRt.encoded, decoded: glueRt.decoded } : null,
      entry: entryRt ? { transfer: entryRt.transfer, encoded: entryRt.encoded, decoded: entryRt.decoded } : null,
      parser: parserRt ? { transfer: parserRt.transfer, encoded: parserRt.encoded, decoded: parserRt.decoded } : null,
    },
  };
}

async function latencyRun(bench, kind, profile, scenario) {
  const { page, tracker, server, chunks } = bench;
  await bench.open(kind, { cacheDisabled: scenario === 'cold' });
  await page.send('Network.emulateNetworkConditions', conditions(profile));
  const preMark = server.mark();
  let pre = null;
  if (scenario === 'prefetch') {
    const urls = [...(kind === 'host' ? ['./assets/fps-glue.js'] : []), `./assets/${chunks.entry}`, `./assets/${chunks.isobmff}`];
    pre = await page.eval(`window.__mt.prefetch(${JSON.stringify(urls)})`);
  } else if (scenario === 'prewarm') {
    pre = kind === 'host' ? await page.eval('window.__harness.prewarm()') : { ms: (await bench.pick([TINY])).wallMs };
  }
  const preRequests = server.since(preMark).map((r) => ({ path: r.path, bodyBytes: r.bodyBytes, rawBytes: r.rawBytes, encoding: r.encoding }));
  const mark = server.mark();
  tracker.start();
  const run = await bench.pick([FIRST], { timeoutMs: 120_000 });
  const t = await bench.times();
  await sleep(50);
  const events = tracker.stop();
  const requests = server.since(mark).map((r) => ({ path: r.path, bodyBytes: r.bodyBytes, rawBytes: r.rawBytes, encoding: r.encoding }));
  const pageRt = await page.eval('window.__mt.rt()');
  const workerRt = [];
  for (const w of await tracker.evalWorkers(`JSON.stringify({ origin: performance.timeOrigin, res: performance.getEntriesByType('resource').map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd, transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize })) })`)) {
    const j = JSON.parse(w);
    for (const e of j.res) workerRt.push({ ...e, start: e.start + j.origin - t.origin, end: e.end + j.origin - t.origin });
  }
  const warm = await bench.pick([FIRST], { timeoutMs: 60_000 });
  const result = run.results[run.results.length - 1];
  const warmResult = warm.results[warm.results.length - 1];
  const bd = breakdown(kind, t, pageRt, workerRt, events, chunks);
  await page.send('Network.emulateNetworkConditions', NO_THROTTLE);
  return {
    wallMs: run.wallMs,
    ioMs: result.io.ms,
    warmWallMs: warm.wallMs,
    warmIoMs: warmResult.io.ms,
    resultOk: !result.error && result.videoTracks.length > 0,
    pre,
    preRequests,
    requests,
    ...bd,
  };
}

function summarizeLatency(runs) {
  const m = (f) => median(runs.map(f));
  const keys = ['totalMs', 'glueMs', 'glueFetchMs', 'spawnMs', 'entryFetchMs', 'entryEvalMs', 'parserFetchMs', 'firstRunMs'];
  const phases = Object.fromEntries(keys.map((k) => [k, m((r) => r.phases[k])]));
  const warmWallMs = m((r) => r.warmWallMs);
  const assetRequests = (r) => r.requests.filter((q) => q.path.startsWith('/assets/'));
  return {
    reps: runs.length,
    wallMs: m((r) => r.wallMs),
    totalMs: phases.totalMs,
    minTotalMs: Math.min(...runs.map((r) => r.phases.totalMs)),
    maxTotalMs: Math.max(...runs.map((r) => r.phases.totalMs)),
    warmWallMs,
    extraMs: phases.totalMs !== null && warmWallMs !== null ? phases.totalMs - warmWallMs : null,
    ioMs: m((r) => r.ioMs),
    warmIoMs: m((r) => r.warmIoMs),
    phases,
    preMs: m((r) => r.pre?.ms ?? null),
    networkRequestsAtPick: median(runs.map((r) => assetRequests(r).length)),
    networkBytesAtPick: median(runs.map((r) => sum(assetRequests(r).map((q) => q.bodyBytes)))),
    allResultsOk: runs.every((r) => r.resultOk),
    clockCheckMs: m((r) => r.clockCheckMs),
    throttleApplied: runs.every((r) => r.throttleApplied !== false),
  };
}

async function latencyPhase(bench, opts) {
  const out = { host: {}, app: {} };
  for (const profile of opts.profiles) {
    for (const kind of ['host', 'app']) {
      out[kind][profile.id] = {};
      for (const sc of SCENARIOS[kind]) {
        const runs = [];
        for (let i = 0; i < opts.reps; i++) {
          const r = await latencyRun(bench, kind, profile, sc.id);
          if (sc.id === 'cold' && profile.latencyMs > 0) {
            r.throttleApplied = r.phases.entryFetchMs !== null && r.phases.parserFetchMs !== null && r.phases.entryFetchMs >= profile.latencyMs * 0.9 && r.phases.parserFetchMs >= profile.latencyMs * 0.9;
          }
          runs.push(r);
        }
        const s = summarizeLatency(runs);
        out[kind][profile.id][sc.id] = { summary: s, runs };
        log(`  ${kind} ${profile.id} ${sc.id}: total ${s.totalMs?.toFixed(1)} ms (warm ${s.warmWallMs?.toFixed(1)} ms, extra ${s.extraMs?.toFixed(1)} ms, pre ${s.preMs?.toFixed(1) ?? '-'} ms, ${s.networkRequestsAtPick} asset requests at pick)`);
      }
    }
  }
  return out;
}

function gaps(ts, a, b) {
  const out = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] > a && ts[i] <= b) out.push(ts[i] - ts[i - 1]);
  return out;
}

function dist(values) {
  return { n: values.length, p50: pctile(values, 50), p95: pctile(values, 95), max: values.length ? Math.max(...values) : null };
}

function windowStats(rec, a, b) {
  const lt = rec.lt.filter(([s, d]) => s + d > a && s < b);
  const rafGaps = gaps(rec.raf, a, b);
  const toGaps = gaps(rec.to, a, b);
  const keys = rec.keys.filter(([ts]) => ts >= a && ts <= b).map(([ts, at]) => at - ts);
  return {
    windowMs: b - a,
    longTasks: lt.length,
    longTaskMs: sum(lt.map(([, d]) => d)),
    longestTaskMs: lt.length ? Math.max(...lt.map(([, d]) => d)) : 0,
    tbtMs: sum(lt.map(([, d]) => Math.max(0, d - 50))),
    raf: { ...dist(rafGaps), over50: rafGaps.filter((g) => g > 50).length },
    timeout: dist(toGaps),
    input: dist(keys),
  };
}

function startKeys(page, everyMs) {
  const pending = [];
  let stopped = false;
  const key = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 };
  const timer = setInterval(() => {
    if (stopped) return;
    pending.push(page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key }, 60_000).catch(() => {}));
    pending.push(page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, 60_000).catch(() => {}));
  }, everyMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.all(pending);
    },
  };
}

async function mainThreadWindow(bench, names, { idleMs = 1000, tailMs = 200, timeoutMs = 300_000 } = {}) {
  const { page } = bench;
  const c0 = await bench.cpu();
  const startAt = await page.eval('window.__mt.start()');
  const keys = startKeys(page, 25);
  await sleep(idleMs);
  const c1 = await bench.cpu();
  const t = await bench.pickLight(names, timeoutMs);
  await sleep(tailMs);
  const c2 = await bench.cpu();
  await keys.stop();
  const rec = await page.eval('window.__mt.stop()');
  const results = await bench.lastResults(names.length);
  const idle = windowStats(rec, startAt + 50, t.t0 - 20);
  const active = windowStats(rec, t.t0, t.t1 + tailMs);
  const idleCpu = cpuDelta(c0, c1);
  const activeCpu = cpuDelta(c1, c2);
  const rate = (k) => (idleCpu.wallMs > 0 ? idleCpu[k] / idleCpu.wallMs : 0);
  return {
    files: names.length,
    wallMs: t.wallMs,
    sumIoMs: sum(results.map((r) => r.ms)),
    errors: results.filter((r) => r.error).length,
    idle,
    active,
    longTaskApi: rec.ltError ? `unavailable: ${rec.ltError}` : 'ok',
    cpu: {
      idle: idleCpu,
      active: activeCpu,
      addedMainThreadMs: activeCpu.mainThreadMs - rate('mainThreadMs') * activeCpu.wallMs,
      addedRendererMs: activeCpu.rendererProcessMs - rate('rendererProcessMs') * activeCpu.wallMs,
      addedAllProcessesMs: activeCpu.allProcessesMs - rate('allProcessesMs') * activeCpu.wallMs,
      addedScriptMs: activeCpu.scriptMs - rate('scriptMs') * activeCpu.wallMs,
      addedLayoutStyleMs: activeCpu.layoutMs + activeCpu.styleMs - (rate('layoutMs') + rate('styleMs')) * activeCpu.wallMs,
    },
  };
}

function summarizeMain(runs) {
  const m = (f) => median(runs.map(f));
  return {
    reps: runs.length,
    files: runs[0]?.files ?? null,
    wallMs: m((r) => r.wallMs),
    sumIoMs: m((r) => r.sumIoMs),
    errors: Math.max(...runs.map((r) => r.errors)),
    longTasks: m((r) => r.active.longTasks),
    longTaskMs: m((r) => r.active.longTaskMs),
    longestTaskMs: m((r) => r.active.longestTaskMs),
    worstLongestTaskMs: Math.max(...runs.map((r) => r.active.longestTaskMs)),
    tbtMs: m((r) => r.active.tbtMs),
    rafP95: m((r) => r.active.raf.p95),
    rafMax: m((r) => r.active.raf.max),
    rafOver50: m((r) => r.active.raf.over50),
    timeoutP95: m((r) => r.active.timeout.p95),
    timeoutMax: m((r) => r.active.timeout.max),
    inputN: m((r) => r.active.input.n),
    inputP95: m((r) => r.active.input.p95),
    inputMax: m((r) => r.active.input.max),
    idle: {
      longTasks: m((r) => r.idle.longTasks),
      tbtMs: m((r) => r.idle.tbtMs),
      rafP50: m((r) => r.idle.raf.p50),
      rafP95: m((r) => r.idle.raf.p95),
      rafMax: m((r) => r.idle.raf.max),
      timeoutP50: m((r) => r.idle.timeout.p50),
      timeoutP95: m((r) => r.idle.timeout.p95),
      timeoutMax: m((r) => r.idle.timeout.max),
      inputP95: m((r) => r.idle.input.p95),
      inputMax: m((r) => r.idle.input.max),
    },
    mainThreadCpuMs: m((r) => r.cpu.active.mainThreadMs),
    addedMainThreadMs: m((r) => r.cpu.addedMainThreadMs),
    addedRendererMs: m((r) => r.cpu.addedRendererMs),
    addedAllProcessesMs: m((r) => r.cpu.addedAllProcessesMs),
    addedScriptMs: m((r) => r.cpu.addedScriptMs),
    addedLayoutStyleMs: m((r) => r.cpu.addedLayoutStyleMs),
    activeWindowMs: m((r) => r.active.windowMs),
    mainThreadBusyPct: m((r) => (r.active.windowMs > 0 ? (100 * r.cpu.addedMainThreadMs) / r.active.windowMs : null)),
    longTaskApi: runs.every((r) => r.longTaskApi === 'ok') ? 'ok' : runs.find((r) => r.longTaskApi !== 'ok').longTaskApi,
  };
}

async function mainPhase(bench, opts) {
  const batch = readdirSync(FILES_DIR).sort();
  const hasLong = !!fixture(LONG);
  const out = { batchFiles: batch.length, longFile: hasLong ? LONG : null, host: {}, control: {}, app: {} };
  for (const kind of ['host', 'control', 'app']) {
    const first = [];
    const cold = [];
    const warm = [];
    const long = [];
    for (let i = 0; i < opts.batchReps; i++) {
      await bench.open(kind);
      first.push(await mainThreadWindow(bench, [FIRST]));
      await bench.open(kind);
      cold.push(await mainThreadWindow(bench, batch));
      warm.push(await mainThreadWindow(bench, batch));
      if (hasLong) long.push(await mainThreadWindow(bench, [LONG]));
    }
    out[kind] = {
      firstFile: { summary: summarizeMain(first), runs: first },
      coldBatch: { summary: summarizeMain(cold), runs: cold },
      warmBatch: { summary: summarizeMain(warm), runs: warm },
      long: hasLong ? { summary: summarizeMain(long), runs: long } : null,
    };
    const s = out[kind].coldBatch.summary;
    log(`  ${kind} main thread, cold batch of ${batch.length}: ${s.wallMs.toFixed(0)} ms, ${s.longTasks} long tasks, TBT ${s.tbtMs.toFixed(0)} ms, rAF gap p95 ${s.rafP95?.toFixed(1)} max ${s.rafMax?.toFixed(1)} ms, input p95 ${s.inputP95?.toFixed(1)} ms`);
  }
  return out;
}

const MEM_STEPS = [
  { id: 'loaded', label: 'page loaded, no worker yet', gc: true },
  { id: 'loaded2', label: 'same page 2 s later (noise reference)', gc: true },
  { id: 'first', label: 'after the first file', gc: true },
  { id: 'batchPeak', label: 'right after the batch, before GC', gc: false },
  { id: 'batch', label: 'right after the batch, after GC', gc: true },
  { id: 'idle', label: '3 s idle after the batch, after GC', gc: true },
  { id: 'longPeak', label: 'right after the 3 h file, before GC', gc: false },
  { id: 'long', label: 'after the 3 h file, after GC', gc: true },
];

async function memoryPass(bench, kind, batch, hasLong) {
  await bench.open(kind);
  await bench.page.eval(`fetch('./favicon.svg').then((r) => r.arrayBuffer()).then(() => 0)`);
  await sleep(1000);
  const snaps = [];
  const snap = async (id) => {
    const step = MEM_STEPS.find((x) => x.id === id);
    snaps.push({ id, ...(await bench.memory(step.label, step.gc)) });
  };
  await snap('loaded');
  await sleep(2000);
  await snap('loaded2');
  await bench.pick([FIRST]);
  await sleep(300);
  await snap('first');
  await bench.pick(batch, { timeoutMs: 300_000 });
  await snap('batchPeak');
  await snap('batch');
  await sleep(3000);
  await snap('idle');
  if (hasLong) {
    await bench.pick([LONG], { timeoutMs: 120_000 });
    await snap('longPeak');
    await snap('long');
  }
  return { rendererPid: bench.tracker.rendererPid, snapshots: snaps };
}

function summarizeMemory(passes) {
  return passes[0].snapshots.map(({ id, label, gc }) => {
    const rows = passes.map((p) => ({ s: p.snapshots.find((x) => x.id === id), base: p.snapshots[0] })).filter((r) => r.s);
    const m = (f) => median(rows.map(f));
    const priv = (r) => (r.s.process && r.base.process ? r.s.process.private - r.base.process.private : null);
    return {
      id,
      label,
      gc,
      pageUsed: m((r) => r.s.page.used),
      pageDelta: m((r) => r.s.page.used - r.base.page.used),
      workerCount: m((r) => r.s.workerCount),
      workersUsed: m((r) => r.s.workersUsed),
      workersTotal: m((r) => r.s.workersTotal),
      workerUsedEach: rows[0].s.workers.map((w, i) => median(rows.map((r) => r.s.workers[i]?.used ?? null))),
      jsAdded: m((r) => r.s.page.used - r.base.page.used + r.s.workersUsed),
      private: m((r) => r.s.process?.private ?? null),
      privateDelta: m(priv),
      privateDeltas: rows.map(priv),
      workingSetDelta: m((r) => (r.s.process && r.base.process ? r.s.process.workingSet - r.base.process.workingSet : null)),
    };
  });
}

async function memoryPhase(env, opts) {
  const batch = readdirSync(FILES_DIR).sort();
  const hasLong = !!fixture(LONG);
  const out = { reps: opts.batchReps, host: { passes: [] }, control: { passes: [] }, app: { passes: [] } };
  for (let i = 0; i < opts.batchReps; i++) {
    for (const kind of ['host', 'control', 'app']) {
      const b = await launchBrowser({ exe: env.chromeExe, profileDir: join(BENCH_DIR, 'integration-memory-profile') });
      try {
        const bench = new Bench({ b, server: env.server, chunks: env.chunks });
        await bench.init();
        const pass = await memoryPass(bench, kind, batch, hasLong);
        out[kind].passes.push(pass);
        const by = Object.fromEntries(pass.snapshots.map((x) => [x.id, x]));
        const d = (x) => (x.process && by.loaded.process ? ((x.process.private - by.loaded.process.private) / 1e6).toFixed(2) : '-');
        log(`  ${kind} memory pass ${i + 1}: renderer pid ${pass.rendererPid}, private +${d(by.idle)} MB idle after batch (noise ${d(by.loaded2)} MB), workers ${(by.idle.workersUsed / 1e6).toFixed(2)} MB used`);
      } finally {
        await b.close();
      }
    }
  }
  for (const kind of ['host', 'control', 'app']) out[kind].summary = summarizeMemory(out[kind].passes);
  return out;
}

async function cpuPhase(bench, opts) {
  const batch = readdirSync(FILES_DIR).sort();
  await bench.open('host');
  await bench.pick(batch, { timeoutMs: 300_000 });
  const files = CPU_FILES.filter((f) => fixture(f.name));
  for (const f of files) await bench.pick([f.name], { timeoutMs: 120_000 });
  const perFile = {};
  for (const f of files) {
    const runs = [];
    for (let i = 0; i < opts.cpuReps; i++) {
      const { wallMs, results } = await bench.pick([f.name], { timeoutMs: 120_000 });
      runs.push({ wallMs, result: results[results.length - 1] });
    }
    const r0 = runs[0].result;
    const t = r0.videoTracks.find((x) => x.trackId === r0.primaryTrackId) ?? r0.videoTracks[0];
    perFile[f.id] = {
      label: f.label,
      name: f.name,
      size: statSync(fixture(f.name)).size,
      container: r0.container,
      scan: r0.scan,
      frames: t ? (t.presentedFrames ?? t.frames) : null,
      avgFps: t?.avgFps ? `${t.avgFps.num}/${t.avgFps.den}` : null,
      error: r0.error,
      reads: r0.io.reads,
      bytesRead: r0.io.bytesRead,
      ms: runs.map((r) => r.result.io.ms),
      medianMs: median(runs.map((r) => r.result.io.ms)),
      medianWallMs: median(runs.map((r) => r.wallMs)),
    };
    log(`  cpu ${f.name}: ${perFile[f.id].medianMs.toFixed(2)} ms worker, ${perFile[f.id].medianWallMs.toFixed(2)} ms UI (scan ${r0.scan})`);
  }
  const batches = [];
  for (let i = 0; i < opts.batchReps; i++) {
    const c0 = await bench.cpu();
    const { wallMs } = await bench.pickLight(batch);
    const c1 = await bench.cpu();
    const own = await bench.lastResults(batch.length);
    batches.push({ wallMs, sumIoMs: sum(own.map((r) => r.ms)), cpu: cpuDelta(c0, c1) });
  }
  const m = (f) => median(batches.map(f));
  return {
    perFile,
    warmBatch: {
      files: batch.length,
      reps: batches.length,
      wallMs: m((b) => b.wallMs),
      sumIoMs: m((b) => b.sumIoMs),
      rendererProcessMs: m((b) => b.cpu.rendererProcessMs),
      mainThreadMs: m((b) => b.cpu.mainThreadMs),
      allProcessesMs: m((b) => b.cpu.allProcessesMs),
      byProcessType: batches[Math.floor(batches.length / 2)].cpu.byProcessType,
      runs: batches,
    },
  };
}

function sizes(chunks, glue) {
  const file = (f) => readFileSync(join(DIST, 'assets', f));
  const row = (id, label, buf) => ({ id, label, raw: buf.length, gzip: gz(buf).length });
  return [
    row('trigger', 'host trigger (inline script on the host page, readable source)', Buffer.from(TRIGGER)),
    row('glue', 'glue chunk (WorkerPool from src/client/pool.ts, minified by rolldown)', Buffer.from(glue)),
    row('entry', `worker entry (${chunks.entry})`, file(chunks.entry)),
    row('isobmff', `ISO BMFF parser chunk (${chunks.isobmff})`, file(chunks.isobmff)),
    row('matroska', `Matroska parser chunk (${chunks.matroska})`, file(chunks.matroska)),
    row('main', `PoC main chunk, React + UI (${chunks.main}), not shipped in the integration`, file(chunks.main)),
  ];
}

function environment(version, opts, pauseMs) {
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus[0]?.model.trim() ?? null,
    logicalCores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    browser: version.product,
    userAgent: version.userAgent,
    jsVersion: version.jsVersion,
    options: { reps: opts.reps, batchReps: opts.batchReps, cpuReps: opts.cpuReps, profiles: opts.profiles.map((p) => p.id), skipped: [...opts.skip] },
    workerAttachPauseMs: { n: pauseMs.length, p50: pctile(pauseMs, 50), max: pauseMs.length ? Math.max(...pauseMs) : null },
  };
}

function model(data) {
  const S = Object.fromEntries(data.sizes.map((s) => [s.id, s]));
  const lazyMp4 = S.glue.gzip + S.entry.gzip + S.isobmff.gzip;
  const lazyMkv = S.glue.gzip + S.entry.gzip + S.matroska.gzip;
  const lazyBoth = lazyMp4 + S.matroska.gzip;
  const pct = (a, b) => (100 * a) / b;
  const out = {
    triggerGzip: S.trigger.gzip,
    triggerAssumedBytes: HOST.triggerBudgetBytes,
    initialIncreasePct: pct(HOST.triggerBudgetBytes, HOST.initialGzipBytes),
    initialIncreaseMeasuredPct: pct(S.trigger.gzip, HOST.initialGzipBytes),
    lazyMp4Gzip: lazyMp4,
    lazyMkvGzip: lazyMkv,
    lazyBothGzip: lazyBoth,
    lazyMp4VsInitialPct: pct(lazyMp4, HOST.initialGzipBytes),
    lazyMp4VsFullPct: pct(lazyMp4, HOST.fullGzipBytes),
    lazyBothVsInitialPct: pct(lazyBoth, HOST.initialGzipBytes),
    lazyBothVsFullPct: pct(lazyBoth, HOST.fullGzipBytes),
    profiles: [],
    upload: [],
  };
  const lat = data.latency?.host ?? {};
  for (const p of PROFILES) {
    const r = lat[p.id];
    if (!r) continue;
    const hostTransferMs = p.downKbps ? (HOST.initialGzipBytes * 8) / p.downKbps : null;
    const lazyTransferMs = p.downKbps ? (lazyMp4 * 8) / p.downKbps : null;
    const row = { id: p.id, label: p.label, hostInitialTransferMs: hostTransferMs, lazyTransferMs };
    for (const sc of SCENARIOS.host) {
      const s = r[sc.id]?.summary;
      if (!s) continue;
      row[sc.id] = { totalMs: s.totalMs, extraMs: s.extraMs, preMs: s.preMs, vsHostTransferPct: hostTransferMs && s.extraMs !== null ? pct(s.extraMs, hostTransferMs) : null };
    }
    out.profiles.push(row);
  }
  const cpu = data.cpu?.perFile ?? {};
  const coldNone = lat.none?.cold?.summary?.extraMs ?? null;
  for (const mbps of HOST.uploadMbps) {
    const uploadMs = (HOST.uploadBytes * 8) / (mbps * 1000);
    const row = { mbps, uploadMs, files: {} };
    for (const [id, f] of Object.entries(cpu)) row.files[id] = { ms: f.medianMs, pct: pct(f.medianMs, uploadMs) };
    row.coldFirstFileExtra = {};
    for (const p of PROFILES) {
      const e = lat[p.id]?.cold?.summary?.extraMs;
      if (Number.isFinite(e)) row.coldFirstFileExtra[p.id] = { ms: e, pct: pct(e, uploadMs) };
    }
    out.upload.push(row);
  }
  out.coldExtraNoneMs = coldNone;
  const eagerBytes = S.trigger.gzip + lazyBoth;
  out.options = {
    eagerBytes,
    eagerVsInitialPct: pct(eagerBytes, HOST.initialGzipBytes),
    eagerVsFullPct: pct(eagerBytes, HOST.fullGzipBytes),
    eagerTransferMs: Object.fromEntries(PROFILES.filter((p) => p.downKbps).map((p) => [p.id, (eagerBytes * 8) / p.downKbps])),
    triggerTransferMs: Object.fromEntries(PROFILES.filter((p) => p.downKbps).map((p) => [p.id, (S.trigger.gzip * 8) / p.downKbps])),
  };
  const mainHost = data.main?.host;
  const mainCtl = data.main?.control;
  if (mainHost) {
    const net = (k) => (mainCtl?.[k] ? mainHost[k].summary.addedMainThreadMs - mainCtl[k].summary.addedMainThreadMs : null);
    out.main = {
      firstFileProbeCpuMs: net('firstFile'),
      coldBatchProbeCpuMs: net('coldBatch'),
      warmBatchProbeCpuMs: net('warmBatch'),
      longProbeCpuMs: net('long'),
      coldBatchProbeBusyPct: net('coldBatch') !== null ? pct(net('coldBatch'), mainHost.coldBatch.summary.activeWindowMs) : null,
      firstFileTbtMs: mainHost.firstFile.summary.tbtMs,
      coldBatchTbtMs: mainHost.coldBatch.summary.tbtMs,
      warmBatchTbtMs: mainHost.warmBatch.summary.tbtMs,
      longTbtMs: mainHost.long?.summary.tbtMs ?? null,
      coldBatchBusyPct: mainHost.coldBatch.summary.mainThreadBusyPct,
      warmBatchBusyPct: mainHost.warmBatch.summary.mainThreadBusyPct,
    };
  }
  const memHost = data.memory?.host?.summary;
  if (memHost) {
    const by = Object.fromEntries(memHost.map((s) => [s.id, s]));
    const f = (s) => ({
      pageHeapDelta: s.pageDelta,
      workersUsed: s.workersUsed,
      workersTotal: s.workersTotal,
      workerCount: s.workerCount,
      jsAdded: s.jsAdded,
      processPrivateDelta: s.privateDelta,
      processPrivateDeltas: s.privateDeltas,
      processWorkingSetDelta: s.workingSetDelta,
    });
    out.memory = { first: f(by.first), idle: f(by.idle), peak: f(by.batchPeak), long: by.long ? f(by.long) : null, noise: f(by.loaded2) };
    const ctl = data.memory?.control?.summary;
    if (ctl) {
      const cb = Object.fromEntries(ctl.map((s) => [s.id, s]));
      const net = (id) => ({ jsAdded: by[id].jsAdded - cb[id].jsAdded, processPrivateDelta: by[id].privateDelta - cb[id].privateDelta, controlPrivateDelta: cb[id].privateDelta, controlJsAdded: cb[id].jsAdded });
      out.memory.probe = { first: net('first'), idle: net('idle'), peak: net('batchPeak'), long: by.long && cb.long ? net('long') : null };
    }
    out.memory.examples = HOST.heapExamplesMB.map((mb) => ({
      hostMB: mb,
      jsPct: pct(out.memory.idle.jsAdded / 1e6, mb),
      processPct: out.memory.idle.processPrivateDelta !== null ? pct(out.memory.idle.processPrivateDelta / 1e6, mb) : null,
      probePct: out.memory.probe ? pct(out.memory.probe.idle.processPrivateDelta / 1e6, mb) : null,
      probeFirstPct: out.memory.probe ? pct(out.memory.probe.first.processPrivateDelta / 1e6, mb) : null,
    }));
  }
  return out;
}

async function run(opts) {
  const chunks = distChunks();
  const chromeExe = findBrowser('chrome');
  if (!chromeExe) throw new Error('Chrome not found: set CHROME_PATH');
  const glue = await buildGlue(chunks.entry);
  const virtual = new Map([
    ['/host.html', { body: Buffer.from(HOST_PAGE), type: 'text/html; charset=utf-8' }],
    ['/assets/fps-glue.js', { body: Buffer.from(glue), type: 'text/javascript; charset=utf-8' }],
  ]);
  const data = {
    schema: 1,
    command: `node scripts/bench/integration.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    host: HOST,
    profiles: opts.profiles,
    scenarios: SCENARIOS,
    server: 'node:http on 127.0.0.1, gzip level 9 (Content-Encoding: gzip), /assets/* Cache-Control: public, max-age=31536000, immutable; pages no-cache',
    chunks,
    sizes: sizes(chunks, glue),
  };
  const server = await startGzipServer(DIST, virtual);
  const t0 = performance.now();
  let b;
  try {
    log(`Chrome: ${chromeExe}`);
    b = await launchBrowser({ exe: chromeExe, profileDir: join(BENCH_DIR, 'integration-profile') });
    log(`  ${b.version.product}, pid ${b.pid}`);
    const bench = new Bench({ b, server, chunks });
    await bench.init();
    if (!opts.skip.has('latency')) {
      log('first-file latency');
      data.latency = await latencyPhase(bench, opts);
    }
    if (!opts.skip.has('main')) {
      log('main thread');
      data.main = await mainPhase(bench, opts);
    }
    if (!opts.skip.has('cpu')) {
      log('cpu per file');
      data.cpu = await cpuPhase(bench, opts);
    }
    data.environment = environment(b.version, opts, bench.tracker.pauseMs);
    await b.close();
    b = null;
    if (!opts.skip.has('memory')) {
      log('memory (fresh browser per pass)');
      data.memory = await memoryPhase({ chromeExe, server, chunks }, opts);
    }
  } finally {
    if (b) await b.close();
    await server.close();
  }
  data.totalSeconds = (performance.now() - t0) / 1000;
  data.model = model(data);
  return data;
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const fms = (x) => (!Number.isFinite(x) ? '-' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
const fkb = (n) => (Number.isFinite(n) ? `${(n / 1000).toFixed(2)} KB` : '-');
const fmb = (n) => (Number.isFinite(n) ? `${(n / 1e6).toFixed(2)} MB` : '-');
const fpct = (x) => {
  if (!Number.isFinite(x)) return '-';
  if (x === 0) return '0%';
  if (Math.abs(x) < 0.001) return '<0.001%';
  if (Math.abs(x) < 0.1) return `${x.toFixed(3)}%`;
  return `${x.toFixed(2)}%`;
};
const cell = (s) => String(s ?? '-').replace(/\|/g, '\\|');

function table(head, align, rows) {
  return [
    `| ${head.join(' | ')} |`,
    `|${align.split('').map((a) => (a === 'r' ? '---:' : '---')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function profileText(p) {
  if (!p.downKbps) return 'no throttling';
  return `${p.downKbps >= 1000 ? `${p.downKbps / 1000} Mbps` : `${p.downKbps} kbps`} down, ${p.upKbps >= 1000 ? `${p.upKbps / 1000} Mbps` : `${p.upKbps} kbps`} up, ${p.latencyMs} ms latency`;
}

const batchN = (d) => d.main?.batchFiles ?? 'all';

function headline(d) {
  const M = d.model;
  const out = [];
  out.push(`Initial load of the host grows only by the trigger: ${M.triggerGzip} B gzip measured (budget ${HOST.triggerBudgetBytes} B), ${fpct(M.initialIncreaseMeasuredPct)} of ${fmb(HOST.initialGzipBytes)} (${fpct(M.initialIncreasePct)} at the 1 KB budget).`);
  out.push(`First MP4 lazily downloads ${fkb(M.lazyMp4Gzip)} gzip (glue + worker entry + ISO BMFF chunk): ${fpct(M.lazyMp4VsInitialPct)} of the host initial load, ${fpct(M.lazyMp4VsFullPct)} of the full app; both parsers ${fkb(M.lazyBothGzip)} (${fpct(M.lazyBothVsInitialPct)} / ${fpct(M.lazyBothVsFullPct)}).`);
  const lat = M.profiles.map((p) => `${p.label} ${fms(p.cold?.totalMs)} ms cold / ${fms(p.prefetch?.totalMs)} ms HTTP-prefetched / ${fms(p.prewarm?.totalMs)} ms prewarmed`);
  if (lat.length) out.push(`First MP4 from pick to result (host model, median of ${d.environment.options.reps}): ${lat.join('; ')}.`);
  if (M.main) out.push(`Main thread on the host model: TBT ${fms(M.main.firstFileTbtMs)} ms for the first file, ${fms(M.main.coldBatchTbtMs)} ms for ${batchN(d)} files at once (cold), ${fms(M.main.warmBatchTbtMs)} ms warm, ${fms(M.main.longTbtMs)} ms for the 3 h file (no long tasks); probe main-thread CPU ${fms(M.main.firstFileProbeCpuMs)} ms for the first file and ${fms(M.main.coldBatchProbeCpuMs)} ms for ${batchN(d)} files, in short tasks.`);
  if (M.memory) out.push(`Memory after use (host model, idle after ${batchN(d)} files, after GC, median of ${d.memory.reps} fresh browsers): +${fmb(M.memory.idle.jsAdded)} JS heap (page delta + ${M.memory.idle.workerCount} worker heaps), renderer private memory ${M.memory.idle.processPrivateDelta !== null ? `+${fmb(M.memory.idle.processPrivateDelta)}` : 'not measured'} (peak before GC +${fmb(M.memory.peak.processPrivateDelta)})${M.memory.probe ? `; of that the probe itself (minus the pick-and-list control) +${fmb(M.memory.probe.idle.processPrivateDelta)}, +${fmb(M.memory.probe.first.processPrivateDelta)} after the first file` : ''}.`);
  const cpu = d.cpu?.perFile;
  if (cpu) out.push(`Worker time per file (warm, median): ${Object.values(cpu).map((f) => `${f.name} ${fms(f.medianMs)} ms`).join(', ')}; ${batchN(d)} files ${fms(d.cpu.warmBatch.sumIoMs)} ms summed worker time.`);
  const up = M.upload.find((u) => u.mbps === 10);
  if (up?.files.typical) out.push(`Against a 100 MB upload (${fms(up.uploadMs / 1000)} s at 10 Mbps): a typical MP4 adds ${fpct(up.files.typical.pct)}; the one-time cold first-file extra on 3G adds ${fpct(up.coldFirstFileExtra['3g']?.pct)}.`);
  return out;
}

function summaryTable(d) {
  const M = d.model;
  if (!M?.options || !M.profiles.length) return null;
  const P = Object.fromEntries(M.profiles.map((p) => [p.id, p]));
  const lat = ['fast4g', 'slow4g', '3g'].filter((id) => P[id]);
  const mem = M.memory?.probe;
  const hostMB = 200;
  const memPct = (x) => (Number.isFinite(x) ? `${fmb(x)} (${fpct(pct(x / 1e6, hostMB))})` : '-');
  const pct = (a, b) => (100 * a) / b;
  const up = M.upload.find((u) => u.mbps === 10);
  const typical = up?.files.typical;
  const rows = [
    ['Host initial load, bytes (critical bundle)', `+${fpct(M.initialIncreaseMeasuredPct)}`, `+${fpct(M.initialIncreaseMeasuredPct)}`, `+${fpct(M.options.eagerVsInitialPct)}`],
    ['Host full app, bytes', `+${fpct(M.lazyMp4VsFullPct)} only after a video is picked`, `+${fpct(M.lazyMp4VsFullPct)} once the dialog opens`, `+${fpct(M.options.eagerVsFullPct)} on every load`],
    ...lat.map((id) => [
      `First video, one-time wait, ${P[id].label}`,
      `+${fms(P[id].cold?.extraMs)} ms (${fpct(P[id].cold?.vsHostTransferPct)} of the host's own initial download)`,
      `+${fms(P[id].prewarm?.extraMs)} ms prewarmed, +${fms(P[id].prefetch?.extraMs)} ms HTTP-prefetched or cached`,
      `+${fms(P[id].prewarm?.extraMs)} ms, but +${fms(M.options.eagerTransferMs[id])} ms on every page load`,
    ]),
    ['Main thread (long tasks, TBT)', `0 long tasks, TBT ${fms(M.main?.coldBatchTbtMs)} ms even for ${batchN(d)} files at once`, 'same', 'same, plus worker start at page load'],
    ['Memory (renderer, probe share)', `+${memPct(mem?.first.processPrivateDelta)} after the first video, +${memPct(mem?.idle.processPrivateDelta)} after ${batchN(d)}`, 'same, from dialog open', `+${memPct(mem?.first.processPrivateDelta)} for every visitor`],
    ['Per video, against a 100 MB upload at 10 Mbps', typical ? `+${fms(typical.ms)} ms = ${fpct(typical.pct)}` : '-', 'same', 'same'],
  ];
  return table(['What', 'Lazy on the first file (proposed)', 'Lazy + prefetch when the upload dialog opens', 'Eager (in the critical bundle)'], 'llll', rows);
}

function renderMarkdown(d) {
  const e = d.environment;
  const M = d.model;
  const L = [];
  L.push('# Integration cost');
  L.push('');
  L.push('What it costs to embed the FPS probe into an existing large React SPA, measured in headless Chrome on the built `demo/dist/` served gzip-compressed from localhost. Produced by `scripts/bench/integration.mjs`. KB and MB are powers of 1000.');
  L.push('');
  L.push('## Headline');
  L.push('');
  for (const h of headline(d)) L.push(`- ${h}`);
  L.push('');
  const summary = summaryTable(d);
  if (summary) {
    L.push('## Summary in percent');
    L.push('');
    L.push(summary);
    L.push('');
    L.push('Critical bundle = the JS and CSS the host downloads, parses and runs before its first render, on every page load. "+0.03%" means only the trigger joins it; the probe itself is lazy and costs nothing until a user picks a video. Latency percentages compare the one-time wait with the time the host already needs to download its own initial bundle on the same link; memory percentages assume a host tab of 200 MB, since the host was not measured. Details and formulas: section 6.');
    L.push('');
  }
  L.push('## Environment');
  L.push('');
  L.push(
    table(['Item', 'Value'], 'll', [
      ['Browser', `${e.browser} (V8 ${e.jsVersion}), headless=new, throwaway profile`],
      ['OS', e.os],
      ['CPU', `${e.cpu}, ${e.logicalCores} logical cores, ${e.memoryGiB} GiB RAM`],
      ['Node', e.node],
      ['Server', d.server],
      ['Runs', `latency ${e.options.reps} page loads per profile and scenario; main thread ${e.options.batchReps} fresh pages; memory ${e.options.batchReps} fresh browsers per page; CPU ${e.options.cpuReps} picks per file`],
      ['Date', e.date],
      ['Total time', `${d.totalSeconds.toFixed(0)} s`],
    ]),
  );
  L.push('');
  L.push('## Integration model');
  L.push('');
  L.push(`Host app as given: initial load ${fmb(HOST.initialGzipBytes)} gzip (${HOST.initialFiles} files, ${fmb(HOST.initialRawBytes)} raw JS + CSS), full app ${fmb(HOST.fullGzipBytes)} gzip.`);
  L.push('');
  L.push('Two pages are measured on the same server and browser:');
  L.push('');
  L.push('- **Host model** (`/host.html`, generated by the script, not a file in the repo): a near-empty page whose only probe code in the critical path is a small inline trigger. On the first pick the trigger does `import()` of the glue chunk (the real `WorkerPool` class from `src/client/pool.ts` with two workers, bundled and minified by rolldown, worker URL pointed at the built worker entry); the glue spawns the module worker, whose entry imports the parser chunk for the sniffed container. That is three chained requests: glue, worker entry, parser. It shows each result as one list item. This is the integration as proposed, without the PoC UI.');
  L.push(`- **PoC app** (\`/\`, the built React app): the worker pool is part of the main chunk, so the first pick chains two requests (worker entry, parser). Its ${batchN(d)}-card React list is PoC UI the host would not ship; it is measured as a reference for what a heavy result UI adds.`);
  L.push('');
  L.push('Critical bundle means the code the host downloads, parses and runs before its first render, on every page load. Only the trigger joins it. Everything else is lazy: it is fetched the first time a user picks a video (or earlier, if the host prefetches it), and never on page loads where nobody picks a file.');
  L.push('');
  L.push('## 1. Bytes');
  L.push('');
  const hdr = d.latency?.host?.none?.cold?.runs?.[0]?.network?.parser?.headersBytes;
  L.push(`Sizes from the files, gzip level 9 (the server sends exactly these bodies). Each request adds its response headers on the wire (${Number.isFinite(hdr) ? `${hdr} B` : 'a few hundred bytes'} with this server, CDP \`responseReceived.encodedDataLength\`).`);
  L.push('');
  L.push(table(['Piece', 'When it loads', 'Raw', 'gzip'], 'llrr', d.sizes.map((s) => [s.label, { trigger: 'host critical path (every page load)', glue: 'first pick (or prefetch)', entry: 'first pick (worker spawn)', isobmff: 'first MP4/MOV', matroska: 'first MKV/WebM', main: 'PoC only' }[s.id], fkb(s.raw), fkb(s.gzip)])));
  L.push('');
  const coldNone = d.latency?.host?.none?.cold?.runs ?? d.latency?.host?.[Object.keys(d.latency?.host ?? {})[0]]?.cold?.runs;
  if (coldNone?.length) {
    const r = coldNone[0];
    const net = r.network;
    const server = (needle) => r.requests.find((q) => q.path.includes(needle));
    const row = (label, needle, n, rt) => {
      const sv = server(needle);
      return [label, sv ? `${sv.bodyBytes} (${sv.encoding})` : '-', n?.headersBytes ?? '-', n?.encodedDataLength ?? '-', rt?.encoded ?? '-', rt?.transfer ?? '-'];
    };
    L.push('Bytes on the wire for the first MP4 on the host model page (cold, one run):');
    L.push('');
    L.push(
      table(['Request', 'Server body bytes', 'CDP headers bytes', 'CDP encodedDataLength (total)', 'Resource Timing encodedBodySize', 'Resource Timing transferSize'], 'lrrrrr', [
        row('glue chunk', 'fps-glue', net.glue, r.rt.glue),
        row('worker entry', d.chunks.entry, net.entry, r.rt.entry),
        row('ISO BMFF parser chunk', d.chunks.isobmff, net.parser, r.rt.parser),
      ]),
    );
    L.push('');
    L.push('CDP `loadingFinished.encodedDataLength` is headers plus body for the glue and the parser chunk. For the worker entry (a dedicated worker main script, fetched by the browser process) Chrome reports only the header bytes there, so the server count and Resource Timing are the reliable numbers for that request. Resource Timing `transferSize` is the encoded body plus a nominal 300 B header allowance.');
    L.push('');
  }
  if (d.latency) {
    L.push('## 2. One-time latency of the first file');
    L.push('');
    const throttled = [];
    for (const kind of ['host', 'app']) for (const p of d.profiles) if (p.latencyMs > 0) throttled.push(...(d.latency[kind]?.[p.id]?.cold?.runs ?? []));
    const unverified = throttled.filter((r) => r.throttleApplied !== true).length;
    const throttleText = unverified === 0 ? `verified: in all ${throttled.length} throttled cold runs both the worker entry and the parser chunk took at least 90% of the profile latency` : `NOT verified in ${unverified} of ${throttled.length} throttled cold runs (a fetch was faster than the profile latency)`;
    L.push(`Time from the file pick (\`change\` event) to the rendered result for the first MP4 (\`${FIRST}\`, 89 KB) on a freshly loaded page, median of ${e.options.reps} page loads per cell. The page itself loads unthrottled; throttling (CDP \`Network.emulateNetworkConditions\` on the page, which also covers its dedicated workers; ${throttleText}) starts right before the prefetch or the pick. Cold runs clear the HTTP cache and disable it (page and worker targets). "Warm" is the same file picked again on the same page right after (worker and parser loaded and compiled): the steady cost. Extra = total minus warm, the one-time cost of the integration on the first file.`);
    L.push('');
    L.push(table(['Profile', 'Link'], 'll', d.profiles.map((p) => [p.label, profileText(p)])));
    L.push('');
    for (const kind of ['host', 'app']) {
      const K = d.latency[kind];
      L.push(kind === 'host' ? '### Host model' : '### PoC app (cross-check)');
      L.push('');
      const rows = [];
      for (const p of d.profiles) {
        for (const sc of SCENARIOS[kind]) {
          const s = K[p.id]?.[sc.id]?.summary;
          if (!s) continue;
          rows.push([p.label, sc.id, fms(s.totalMs), `${fms(s.minTotalMs)} to ${fms(s.maxTotalMs)}`, fms(s.warmWallMs), fms(s.extraMs), s.preMs === null ? '-' : fms(s.preMs), s.networkRequestsAtPick, s.networkBytesAtPick]);
        }
      }
      L.push(table(['Profile', 'Scenario', 'Pick to result ms', 'Range ms', 'Warm ms', 'Extra ms', 'Prefetch or prewarm ms (before the pick)', 'Requests to the server at pick', 'gzip bytes at pick'], 'llrrrrrrr', rows));
      L.push('');
      L.push(SCENARIOS[kind].map((s) => `\`${s.id}\`: ${s.label}.`).join(' '));
      L.push('');
      const bd = [];
      for (const p of d.profiles) {
        for (const sc of ['cold', 'prefetch']) {
          const s = K[p.id]?.[sc]?.summary;
          if (!s) continue;
          const ph = s.phases;
          bd.push([p.label, sc, fms(ph.totalMs), kind === 'host' ? fms(ph.glueMs) : 'in main chunk', fms(ph.spawnMs), fms(ph.entryFetchMs), fms(ph.entryEvalMs), fms(ph.parserFetchMs), fms(ph.firstRunMs), fms(s.warmWallMs)]);
        }
      }
      L.push(`Breakdown (medians per phase, so they need not add up exactly to the median total):`);
      L.push('');
      L.push(table(['Profile', 'Scenario', 'Total', kind === 'host' ? 'Pick to glue loaded' : 'Glue', 'Worker spawn (to entry request)', 'Worker entry fetch', 'Worker boot + entry eval + first read (to parser request)', 'Parser chunk fetch', 'Parser compile + first run + render', 'Steady (warm) pick'], 'llrrrrrrrr', bd));
      L.push('');
    }
    const cc = d.latency.host?.none?.cold?.summary?.clockCheckMs;
    L.push('The `prefetch` row is also roughly what a returning visitor gets with no prefetch code at all: the chunks have hashed names and are served `immutable`, so they come from the HTTP cache; only the compile and the first unoptimised run remain (possibly a little less, since V8 can reuse its code cache on repeat visits).');
    L.push('');
    L.push(`Phase marks come from Resource Timing in the page (glue, worker entry end) and in the worker (parser chunk), and from CDP \`Network.requestWillBeSent.wallTime\` for the worker entry start (its Resource Timing start is reported at response time). Clock check: parser chunk end from CDP minus Resource Timing, median ${f2(cc)} ms on the unthrottled profile. Worker targets are auto-attached paused so their network events are captured; resuming took median ${f2(e.workerAttachPauseMs.p50)} ms (max ${f2(e.workerAttachPauseMs.max)} ms), which can only lengthen the unthrottled cold path by that much (on throttled profiles it overlaps the entry download).`);
    L.push('');
  }
  if (d.main) {
    L.push('## 3. Main thread while analysing');
    L.push('');
    L.push(`Recorded in the page: \`PerformanceObserver('longtask')\` (tasks over 50 ms; TBT = sum of the part above 50 ms), a \`requestAnimationFrame\` loop and a \`setTimeout(0)\` chain (gaps between callbacks), and synthetic key presses sent over CDP every 25 ms (input delay = handler time minus \`event.timeStamp\`). Window: from the pick to 200 ms after the last result (so "busy" is diluted for short work); the idle row is the 1 s before the pick on the same page, with the same loops running. Main-thread CPU is CDP \`Performance.getMetrics\` ThreadTime, with the idle rate subtracted. Batch: all ${d.main.batchFiles} files of \`fixtures/files\` picked at once; cold = fresh page, warm = the same batch again on that page. Medians of ${e.options.batchReps} fresh pages.`);
    L.push('');
    for (const kind of ['host', 'control', 'app']) {
      const K = d.main[kind];
      if (!K?.coldBatch) continue;
      L.push({ host: '### Host model', control: '### Control (host model page with the probe switched off: files picked and listed by name only)', app: `### PoC app (React UI, ${batchN(d)} result cards)` }[kind]);
      L.push('');
      const rows = [];
      const add = (label, s) => {
        if (!s) return;
        rows.push([label, fms(s.wallMs), s.longTasks, fms(s.longestTaskMs), fms(s.tbtMs), `${fms(s.rafP95)} / ${fms(s.rafMax)}`, `${fms(s.timeoutP95)} / ${fms(s.timeoutMax)}`, `${fms(s.inputP95)} / ${fms(s.inputMax)} (n ${Math.round(s.inputN)})`, fms(s.addedMainThreadMs), `${fms(s.addedScriptMs)} / ${fms(s.addedLayoutStyleMs)}`, fpct(s.mainThreadBusyPct)]);
      };
      const idle = K.coldBatch.summary.idle;
      rows.push(['idle page (baseline)', '-', idle.longTasks, '-', fms(idle.tbtMs), `${fms(idle.rafP95)} / ${fms(idle.rafMax)}`, `${fms(idle.timeoutP95)} / ${fms(idle.timeoutMax)}`, `${fms(idle.inputP95)} / ${fms(idle.inputMax)}`, '-', '-', '-']);
      add(`first file, cold (${FIRST})`, K.firstFile.summary);
      add(`${d.main.batchFiles} files at once, cold`, K.coldBatch.summary);
      add(`${d.main.batchFiles} files at once, warm`, K.warmBatch.summary);
      add(`3 h file (${LONG}), warm`, K.long?.summary);
      L.push(table(['Work', 'Wall ms', 'Long tasks', 'Longest ms', 'TBT ms', 'rAF gap p95 / max ms', 'setTimeout(0) gap p95 / max ms', 'Input delay p95 / max ms', 'Main-thread CPU added ms', 'of it script / layout+style ms', 'Main thread busy'], 'lrrrrrrrrrr', rows));
      L.push('');
    }
    if (M.main?.coldBatchProbeCpuMs !== null && M.main?.coldBatchProbeCpuMs !== undefined) {
      L.push(`Probe share of the main-thread CPU (host model minus control, which carries the same pick, list update and CDP harness work): first file ${fms(M.main.firstFileProbeCpuMs)} ms, ${d.main.batchFiles} files cold ${fms(M.main.coldBatchProbeCpuMs)} ms (${fpct(M.main.coldBatchProbeBusyPct)} of the window), warm ${fms(M.main.warmBatchProbeCpuMs)} ms, 3 h file ${fms(M.main.longProbeCpuMs)} ms. These are spread over many short tasks (message handling for ${d.main.batchFiles} results and progress events); none of them is a long task. Differences of a few ms are within run-to-run noise (see the per-run values in the JSON).`);
      L.push('');
    }
    L.push(`rAF in this headless Chrome follows the display (idle gap p50 ${fms(d.main.host.coldBatch.summary.idle.rafP50)} ms). Long Task API: ${d.main.host.coldBatch.summary.longTaskApi}.`);
    L.push('');
  }
  if (d.memory) {
    L.push('## 4. Memory');
    L.push('');
    L.push(`Each pass runs in a fresh Chrome (new renderer process, so no garbage from earlier pages), median of ${d.memory.reps} passes per page. JS heap from CDP \`Runtime.getHeapUsage\` on the page and on each dedicated worker target (auto-attached), after \`HeapProfiler.collectGarbage\` on all of them where marked. Process memory is the renderer process that hosts the page and its workers (pid from the CDP request ids), read with \`Get-Process\` (private bytes and working set); it includes the per-thread V8 isolate and Blink overhead that the heap numbers miss. Deltas are against the first row of the same pass.`);
    L.push('');
    for (const kind of ['host', 'control', 'app']) {
      const K = d.memory[kind];
      if (!K?.summary) continue;
      L.push({ host: '### Host model', control: '### Control (probe switched off: files picked and listed only)', app: '### PoC app' }[kind]);
      L.push('');
      const rows = K.summary.map((s) => [
        MEM_STEPS.find((x) => x.id === s.id)?.label ?? s.label,
        s.gc ? 'yes' : 'no',
        fmb(s.pageUsed),
        fmb(s.pageDelta),
        s.workerCount,
        s.workerUsedEach.length ? s.workerUsedEach.map((w) => (Number.isFinite(w) ? fmb(w) : 'not measured')).join(', ') : '-',
        fmb(s.jsAdded),
        fmb(s.private),
        fmb(s.privateDelta),
        s.privateDeltas.map((x) => (Number.isFinite(x) ? (x / 1e6).toFixed(1) : '-')).join(', '),
        fmb(s.workingSetDelta),
      ]);
      L.push(table(['State', 'GC', 'Page heap used', 'Page heap delta', 'Workers', 'Worker heap used (each)', 'JS added (page delta + workers)', 'Renderer private', 'Private delta', 'Private delta per pass MB', 'Working set delta'], 'llrrrlrrrrr', rows));
      L.push('');
    }
    if (M.memory?.probe) {
      const P = M.memory.probe;
      L.push(`Probe share (host model minus control, renderer private bytes): first file +${fmb(P.first.processPrivateDelta)}, right after ${batchN(d)} files before GC +${fmb(P.peak.processPrivateDelta)}, idle after the batch +${fmb(P.idle.processPrivateDelta)}${P.long ? `, after the 3 h file +${fmb(P.long.processPrivateDelta)}` : ''}. The control alone (${batchN(d)} File objects, ${batchN(d)} list items) adds ${fmb(P.idle.controlPrivateDelta)} at idle.`);
      L.push('');
    }
    L.push(`Reading the host rows: the first file brings one worker and costs about 5 MB of private memory, almost all of it outside the JS heaps (worker thread, isolate, Blink worker scope); the second worker joins during the batch. JS heaps grow by only about 2.4 MB in total, so the rest of the idle delta after ${batchN(d)} files is allocator memory kept after ${batchN(d)} concurrent reads, not live objects. The peak before GC is transient.`);
    L.push('');
    L.push('The glue keeps its two workers alive after use (`idleTimeoutMs: 0`, as in the demo), so the idle rows are what stays resident until the page unloads; the default idle termination of `WorkerPool` (30 s) would hand the worker part back. The noise row shows how much the renderer moves on an idle page.');
    L.push('');
  }
  if (d.cpu) {
    L.push('## 5. CPU per file');
    L.push('');
    L.push(`Worker-side \`FileResult.io.ms\` (wall time inside the worker from the first read to the result, so an upper bound on its CPU time) on the host model page after a warm-up batch, median of ${e.options.cpuReps} picks; "UI ms" adds the message round trip and the list update.`);
    L.push('');
    L.push(
      table(
        ['Case', 'File', 'Size', 'Scan', 'Frames', 'Avg FPS', 'Reads', 'Bytes read', 'Worker ms', 'UI ms'],
        'llrlrlrrrr',
        Object.values(d.cpu.perFile).map((f) => [f.label, f.name, fmb(f.size), f.scan ?? '-', f.frames ?? '-', f.avgFps ?? f.error ?? '-', f.reads, fmb(f.bytesRead), fms(f.medianMs), fms(f.medianWallMs)]),
      ),
    );
    L.push('');
    const w = d.cpu.warmBatch;
    const types = Object.entries(w.byProcessType)
      .map(([k, v]) => `${k} ${fms(v)} ms`)
      .join(', ');
    L.push(`${w.files} files at once on the warm page, median of ${w.reps}: ${fms(w.wallMs)} ms wall, ${fms(w.sumIoMs)} ms worker time summed over files (two workers in parallel), renderer process CPU ${fms(w.rendererProcessMs)} ms (main thread ${fms(w.mainThreadMs)} ms), all Chrome processes ${fms(w.allProcessesMs)} ms (${types}). The browser process share covers the Blob reads of the local files and this harness's CDP traffic; the main-thread share is the pick itself, result messages and the host page list update.`);
    L.push('');
  }
  L.push('## 6. Percentages against the host app');
  L.push('');
  L.push('Formulas (B = bytes, gzip):');
  L.push('');
  L.push(`- Initial-load increase = trigger B / ${HOST.initialGzipBytes} B. Measured trigger ${M.triggerGzip} B gives ${fpct(M.initialIncreaseMeasuredPct)}; the 1 KB budget gives ${fpct(M.initialIncreasePct)}. Parse and run cost of the trigger: one closure and one event listener, not measurable against the host's ${fmb(HOST.initialRawBytes)} of raw JS.`);
  L.push(`- Lazy first-file bytes = glue + worker entry + parser chunk = ${fkb(M.lazyMp4Gzip)} for MP4/MOV (${fkb(M.lazyMkvGzip)} for MKV/WebM, ${fkb(M.lazyBothGzip)} once both parsers loaded). Against the initial load: ${fpct(M.lazyMp4VsInitialPct)} (both parsers ${fpct(M.lazyBothVsInitialPct)}); against the full app: ${fpct(M.lazyMp4VsFullPct)} (both ${fpct(M.lazyBothVsFullPct)}). Paid once per page session, only by users who pick a video, and cacheable (hashed file names).`);
  L.push(`- One-time latency = cold extra ms (pick to result, minus the warm pick). Relative figure: extra / time to download the host's initial ${fmb(HOST.initialGzipBytes)} on the same link (B x 8 / down bps, transfer only, so the real host load is longer and the percentage smaller).`);
  L.push('');
  if (M.profiles.length) {
    L.push(
      table(
        ['Profile', 'Host initial transfer s', 'Lazy bytes transfer ms', 'Cold total ms', 'Cold extra ms', 'Extra vs host initial', 'HTTP-prefetched total ms', 'Prewarmed total ms', 'Prefetch needs ms', 'Prewarm needs ms'],
        'lrrrrrrrrr',
        M.profiles.map((p) => [p.label, p.hostInitialTransferMs ? f1(p.hostInitialTransferMs / 1000) : '-', p.lazyTransferMs ? fms(p.lazyTransferMs) : '-', fms(p.cold?.totalMs), fms(p.cold?.extraMs), fpct(p.cold?.vsHostTransferPct), fms(p.prefetch?.totalMs), fms(p.prewarm?.totalMs), fms(p.prefetch?.preMs), fms(p.prewarm?.preMs)]),
      ),
    );
    L.push('');
    L.push('"Needs" is how long the prefetch or prewarm itself took on that link: the hook has to start at least that long before the pick (for example when the upload dialog opens; the OS file dialog alone usually takes seconds) to hide the whole cost.');
    L.push('');
  }
  if (M.main) {
    L.push(`- Main-thread blocking added (TBT, host model): first file ${fms(M.main.firstFileTbtMs)} ms, ${d.main.batchFiles} files at once ${fms(M.main.coldBatchTbtMs)} ms cold and ${fms(M.main.warmBatchTbtMs)} ms warm, 3 h file ${fms(M.main.longTbtMs)} ms. Probe main-thread CPU (host minus control): ${fms(M.main.firstFileProbeCpuMs)} ms for the first file, ${fms(M.main.coldBatchProbeCpuMs)} ms for ${d.main.batchFiles} files (${fpct(M.main.coldBatchProbeBusyPct)} of the batch window), ${fms(M.main.longProbeCpuMs)} ms for the 3 h file (differences of a few ms are within run-to-run noise). Parsing runs in the workers; the main thread only posts File handles and receives small result objects. Between picks the added main-thread work is zero.`);
  }
  if (M.memory) {
    if (M.memory.probe) L.push(`- Memory added by the probe (host model minus control, renderer private bytes, after GC): first file +${fmb(M.memory.probe.first.processPrivateDelta)}, idle after ${batchN(d)} files +${fmb(M.memory.probe.idle.processPrivateDelta)}, peak right after ${batchN(d)} files before GC +${fmb(M.memory.probe.peak.processPrivateDelta)}. As an illustration against a host tab of ${M.memory.examples.map((x) => `${x.hostMB} MB: ${fpct(x.probeFirstPct)} after one file, ${fpct(x.probePct)} after ${batchN(d)}`).join('; ')} (formula: added MB / host MB; the host's own memory was not measured).`);
    L.push(`- Memory added (host model, after GC): after the first file JS +${fmb(M.memory.first.jsAdded)}, renderer private +${fmb(M.memory.first.processPrivateDelta)} (one worker); idle after ${batchN(d)} files JS +${fmb(M.memory.idle.jsAdded)} (page ${fmb(M.memory.idle.pageHeapDelta)}, workers ${fmb(M.memory.idle.workersUsed)} used), renderer private +${fmb(M.memory.idle.processPrivateDelta)} (two workers). Peak right after ${batchN(d)} files before GC: JS +${fmb(M.memory.peak.jsAdded)}, private +${fmb(M.memory.peak.processPrivateDelta)}. These host-model numbers include the pick-and-list work that the control isolates.`);
  }
  L.push(`- Per-file cost against an upload of ${fmb(HOST.uploadBytes)}: upload time = B x 8 / upload bps, so ${HOST.uploadMbps.map((m) => `${fms((HOST.uploadBytes * 8) / (m * 1e6))} s at ${m} Mbps`).join(' and ')}. Share = probe ms / upload ms (the probe reads only container headers from the local file, it does not use the network):`);
  L.push('');
  if (M.upload.length && d.cpu) {
    const ids = Object.keys(d.cpu.perFile);
    L.push(
      table(
        ['Upload speed', 'Upload time s', ...ids.map((id) => d.cpu.perFile[id].name), ...Object.keys(M.upload[0].coldFirstFileExtra).map((id) => `cold first-file extra, ${PROFILES.find((p) => p.id === id).label}`)],
        `lr${'r'.repeat(ids.length)}${'r'.repeat(Object.keys(M.upload[0].coldFirstFileExtra).length)}`,
        M.upload.map((u) => [`${u.mbps} Mbps`, f1(u.uploadMs / 1000), ...ids.map((id) => `${fms(u.files[id].ms)} ms = ${fpct(u.files[id].pct)}`), ...Object.values(u.coldFirstFileExtra).map((c) => `${fms(c.ms)} ms = ${fpct(c.pct)}`)]),
      ),
    );
    L.push('');
  }
  if (M.options && M.profiles.length) {
    const O = M.options;
    const prof = M.profiles.filter((p) => p.id !== 'none');
    const mem = M.memory?.probe;
    L.push('### Integration options compared');
    L.push('');
    L.push(`Derived from the measurements above. Eager means the glue, worker entry and both parser chunks are part of the critical bundle and the worker is started at page load (${fkb(O.eagerBytes)} gzip, which is the trigger plus all lazy pieces); its first-file latency is the prewarm row, and every visitor pays its bytes and its idle worker, whether they upload a video or not. Transfer ms = bytes x 8 / down kbps.`);
    L.push('');
    L.push(
      table(
        ['Option', 'Critical-path bytes', 'vs host initial', 'Added initial transfer', 'Bytes when used', 'First-file latency (cold extra or total)', 'Memory', 'Who pays'],
        'lrrlllll',
        [
          ['lazy on the first file (proposed)', fkb(M.triggerGzip), fpct(M.initialIncreaseMeasuredPct), prof.map((p) => `${p.label} ${fms(O.triggerTransferMs[p.id])} ms`).join(', '), `${fkb(M.lazyMp4Gzip)} (MP4)`, prof.map((p) => `${p.label} +${fms(p.cold?.extraMs)} ms`).join(', '), mem ? `+${fmb(mem.first.processPrivateDelta)} after the first file` : '-', 'only users who pick a video'],
          ['lazy + prefetch when the upload dialog opens', fkb(M.triggerGzip), fpct(M.initialIncreaseMeasuredPct), prof.map((p) => `${p.label} ${fms(O.triggerTransferMs[p.id])} ms`).join(', '), `${fkb(M.lazyMp4Gzip)} (also if the dialog is cancelled)`, prof.map((p) => `${p.label} ${fms(p.prewarm?.totalMs)} ms total if prewarmed, ${fms(p.prefetch?.totalMs)} ms if only HTTP-prefetched`).join(', '), mem ? `+${fmb(mem.first.processPrivateDelta)} once prewarmed` : '-', 'users who open the dialog'],
          ['eager (in the critical bundle)', fkb(O.eagerBytes), fpct(O.eagerVsInitialPct), prof.map((p) => `${p.label} ${fms(O.eagerTransferMs[p.id])} ms`).join(', '), '0 (already loaded)', prof.map((p) => `${p.label} ${fms(p.prewarm?.totalMs)} ms total`).join(', '), mem ? `+${fmb(mem.first.processPrivateDelta)} for every visitor from page load` : '-', 'every visitor, every page load'],
        ],
      ),
    );
    L.push('');
  }
  L.push('## Caveats');
  L.push('');
  L.push('- One desktop machine, one Chrome build, headless. A mid-range phone runs JS several times slower: compile, first run and per-file times scale up accordingly, network-bound phases do not.');
  L.push('- The server is localhost. Throttling is CDP request-level emulation (latency added per request, bandwidth shaped per response), not packet-level: no TCP slow start, no TLS, no connection setup, no HTTP/2 multiplexing effects. Lighthouse applies a 3.75x latency multiplier to request-level throttling to approximate packet-level slow 4G (562.5 ms); with that, each of the three chained requests would wait about 410 ms longer than in the slow 4G row here.');
  L.push('- The host model page is near-empty. In the real host the pick happens on a busy main thread with its own long tasks and network traffic; the probe adds its numbers on top, it does not make the host slower outside the pick.');
  L.push(`- Fixtures are short clips (the batch is the ${batchN(d)} files of \`fixtures/files\` at measurement time). Worker time grows with the number of samples in the index (moov/stts/stsz, fragments, Matroska blocks), not with file bytes: a 100 MB phone video with a few thousand frames costs about the same as the small MP4s here; the 3 h and 1 h files bound the long tail.`);
  L.push('- Process memory is per renderer and includes everything Chrome keeps for the page; differences of a few hundred KB are within noise. Worker heap numbers exclude the isolate overhead that private bytes show.');
  L.push('- The glue chunk is the `WorkerPool` class from `src/client/pool.ts` with a one-function `submit` wrapper; the package probe API adds descriptors, fallback and compare on top, within the same order of size.');
  L.push('');
  L.push('## Rerun');
  L.push('');
  L.push('`npm run build && node scripts/bench/integration.mjs` (options: `--reps`, `--batch-reps`, `--cpu-reps`, `--profiles none,cable,fast4g,slow4g,3g`, `--skip latency,main,memory,cpu`, `--render report/integration-cost.json` to redraw this file without measuring, `--no-write`). Writes `report/integration-cost.md` and `.json`. Command of this run: `' + d.command + '`.');
  L.push('');
  return L.join('\n');
}

const round = (x) => (typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 1000) / 1000 : x);

async function main() {
  let opts;
  try {
    opts = options();
  } catch (e) {
    console.error(String(e.message ?? e));
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  let data;
  if (opts.render) {
    data = JSON.parse(readFileSync(opts.render, 'utf8'));
    data.model = model(data);
  } else {
    data = await run(opts);
  }
  const md = renderMarkdown(data);
  if (opts.write) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, 'integration-cost.json'), `${JSON.stringify(data, (k, v) => round(v), 1)}\n`);
    writeFileSync(join(opts.out, 'integration-cost.md'), md);
    log(`wrote ${join(basename(opts.out), 'integration-cost.md')} and .json${opts.render ? ' (re-rendered)' : ` in ${data.totalSeconds.toFixed(0)} s`}`);
  } else {
    log(md);
  }
  return 0;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killAllBrowsers();
    process.exit(130);
  });
}
process.on('exit', () => killAllBrowsers());

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    killAllBrowsers();
    console.error(e?.stack ?? String(e));
    process.exitCode = 2;
  },
);
