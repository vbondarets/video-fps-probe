import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AppPage } from './app.mjs';
import { findBrowser, killAllBrowsers, launchBrowser } from './browser.mjs';
import { renderMarkdown } from './report.mjs';
import { startServer } from './server.mjs';
import { takeScreenshots } from './shots.mjs';
import { agreement, compareRuns, median, minimum, summarize } from './values.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO, 'demo', 'dist');
const BENCH_DIR = join(REPO, '.bench');
const PHASES = ['warm', 'engines', 'large', 'cold-first', 'rvfc', 'edge', 'node', 'shots'];
const RVFC_FILES = [
  'cfr_h264_24.mp4',
  'cfr_h264_25.mp4',
  'cfr_h264_29.97.mp4',
  'cfr_h264_30.mp4',
  'cfr_h264_60.mp4',
  'cfr_h264_120.mp4',
  'cfr_h264_240.mp4',
  'vfr_concat_10_30_60.mp4',
  'vfr_setpts_sine.mp4',
  'cfr_vp9_29.97.webm',
  'hevc_hvc1.mp4',
  'mov_prores.mov',
  'h264.mkv',
];
const COLD_FIRST = [
  ['cfr_h264_30.mp4', 'ISO BMFF'],
  ['h264.mkv', 'Matroska'],
];
const LARGE_FILES = ['long_cfr_3h_60fps.mp4', 'long_vfr_1h_screenrec.mp4', 'big_1080p_moov_end.mp4', 'big_1080p_faststart.mp4', 'big_1080p.mkv'];

const USAGE = `Usage: npm run bench -- [options]

Real-browser benchmark of the built app (demo/dist/). Starts a local static server and a
headless Chrome with a throwaway profile in .bench/, drives the file input over CDP.

  --reps <n>          warm own-engine runs per fixture (default 5)
  --engine-reps <n>   mp4box / mediabunny runs per fixture (default 3)
  --cold-reps <n>     page reloads for the cold first-file cost (default 5)
  --filter <text>     only fixtures whose name contains the text (writes *.local.* reports, no screenshots)
  --skip <list>       comma separated phases to skip: ${PHASES.join(',')}
  --out <dir>         report directory (default report)
  --shots <dir>       screenshot directory (default docs/screenshots)
  --no-write          print the summary only
  --self-test         check the server, value comparison and report helpers, no browser
  --help

Chrome comes from CHROME_PATH or the standard install locations; Edge (EDGE_PATH or the
standard locations) is used for the warm own-engine run when installed.
Build first: npm run build.
`;

const log = (...a) => console.log(...a);
const elapsed = (t0) => `${((performance.now() - t0) / 1000).toFixed(1)} s`;

function options() {
  const { values } = parseArgs({
    options: {
      reps: { type: 'string', default: '5' },
      'engine-reps': { type: 'string', default: '3' },
      'cold-reps': { type: 'string', default: '5' },
      filter: { type: 'string' },
      skip: { type: 'string', default: '' },
      out: { type: 'string', default: 'report' },
      shots: { type: 'string', default: join('docs', 'screenshots') },
      'no-write': { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
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
  if (values.filter) skip.add('shots');
  return {
    help: values.help,
    selfTest: values['self-test'],
    reps: count('reps'),
    engineReps: count('engine-reps'),
    coldReps: count('cold-reps'),
    filter: values.filter ?? null,
    skip,
    out: resolve(REPO, values.out),
    shots: resolve(REPO, values.shots),
    write: !values['no-write'],
  };
}

async function loadRepoModules() {
  const fixtures = await import('../../tests/helpers/fixtures.ts');
  const { parseRef } = await import('../compare/ref.ts');
  const { openFixture } = await import('../../tests/helpers/open-blob.ts');
  const { analyze } = await import('../../src/core/index.ts');
  return { ...fixtures, parseRef, openFixture, analyze };
}

function displayHzFromOs() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.CurrentRefreshRate }'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    const hz = out.split(/\s+/).map(Number).filter((n) => n > 0);
    return hz.length ? hz : null;
  } catch {
    return null;
  }
}

async function browserInfo(b, app) {
  let gpu = null;
  try {
    const info = await b.browser.send('SystemInfo.getInfo', {}, 20_000);
    const dev = info.gpu?.devices?.[0];
    gpu = {
      device: dev ? dev.deviceString || `vendor ${dev.vendorId} device ${dev.deviceId}` : null,
      videoDecode: info.gpu?.featureStatus?.video_decode ?? null,
      gpuCompositing: info.gpu?.featureStatus?.gpu_compositing ?? null,
    };
  } catch {
    gpu = null;
  }
  return {
    product: b.version.product,
    userAgent: b.version.userAgent,
    jsVersion: b.version.jsVersion,
    gpu,
    rafHz: null,
    timerResolutionMs: await app.timerResolution(),
  };
}

function requestsOf(entries) {
  return entries.map((e) => ({ path: e.url, status: e.status, bytes: e.bytes }));
}

function byName(results) {
  return new Map(results.map((r) => [r.name, r]));
}

async function coldBatch(app, server, fixtures) {
  const mark = server.mark();
  const { wallMs, results } = await app.addFiles(
    fixtures.map((f) => f.path),
    { timeoutMs: 300_000 },
  );
  const sumMs = results.reduce((s, r) => s + r.io.ms, 0);
  return { files: fixtures.length, wallMs, sumMs, requests: requestsOf(server.since(mark)), results };
}

async function warmRuns(app, fixtures, reps, label) {
  const runs = new Map(fixtures.map((f) => [f.name, []]));
  const t0 = performance.now();
  for (let rep = 0; rep < reps; rep++) {
    for (const f of fixtures) {
      const { wallMs, results } = await app.addFiles([f.path], { clear: true });
      const r = results[results.length - 1];
      if (!r || r.name !== f.name) throw new Error(`${label}: expected a result for ${f.name}`);
      runs.get(f.name).push({ wallMs, result: r });
    }
    log(`  ${label} rep ${rep + 1}/${reps} done (${elapsed(t0)})`);
  }
  const out = {};
  for (const f of fixtures) {
    const list = runs.get(f.name);
    const ms = list.map((x) => x.result.io.ms);
    const first = list[0].result;
    const same = list.every((x) => compareRuns(x.result, first).identical);
    out[f.name] = {
      ms,
      wallMs: list.map((x) => x.wallMs),
      medianMs: median(ms),
      minMs: minimum(ms),
      medianWallMs: median(list.map((x) => x.wallMs)),
      reads: first.io.reads,
      bytesRead: first.io.bytesRead,
      size: first.size,
      container: first.container,
      summary: summarize(first),
      repeatable: same,
      result: first,
    };
  }
  return out;
}

const ISO = new Set(['mp4', 'mov']);
const SUPPORTED = { mp4box: (c) => ISO.has(c), mediabunny: (c) => c !== 'unknown' };

async function engineRuns(app, own, names, reps, engines = ['mp4box', 'mediabunny']) {
  const index = new Map(own.map((r, i) => [r.name, i]));
  const ownBy = byName(own);
  const out = {};
  for (const name of names) {
    const base = ownBy.get(name);
    if (!base) continue;
    out[name] = {};
    for (const engine of engines) {
      if (!SUPPORTED[engine](base.container)) continue;
      const runs = [];
      for (let i = 0; i < reps; i++) runs.push(await app.engine(index.get(name), engine));
      const ok = runs.filter((r) => r.result);
      const first = ok[0]?.result ?? null;
      out[name][engine] = {
        ms: ok.map((r) => r.result.io.ms),
        wallMs: runs.map((r) => r.wallMs),
        medianMs: median(ok.map((r) => r.result.io.ms)),
        medianWallMs: median(runs.map((r) => r.wallMs)),
        reads: first?.io.reads ?? null,
        bytesRead: first?.io.bytesRead ?? null,
        error: first?.error ?? runs.find((r) => r.threw)?.threw ?? null,
        summary: summarize(first),
        agreement: agreement(base, first),
        nativeStatsMs: median(ok.map((r) => r.result.mediabunny?.nativeStatsMs)),
        nativeSkipped: ok.some((r) => r.result.mediabunny?.tracks?.some((t) => t.nativeCallSkipped)),
      };
    }
  }
  return out;
}

async function coldFirst(app, server, pathOf, reps) {
  const out = [];
  for (const [name, label] of COLD_FIRST) {
    const path = pathOf(name);
    if (!path) continue;
    const runs = [];
    for (let i = 0; i < reps; i++) {
      await app.open();
      const mark = server.mark();
      const cold = await app.addFiles([path]);
      const chunks = requestsOf(server.since(mark)).filter((r) => r.path.includes('/assets/'));
      const warm = await app.addFiles([path], { clear: true });
      runs.push({
        coldWallMs: cold.wallMs,
        coldMs: cold.results[0].io.ms,
        warmWallMs: warm.wallMs,
        warmMs: warm.results[0].io.ms,
        chunks,
      });
    }
    const m = (k) => median(runs.map((r) => r[k]));
    out.push({
      name,
      label,
      runs,
      coldWallMs: m('coldWallMs'),
      coldMs: m('coldMs'),
      warmWallMs: m('warmWallMs'),
      warmMs: m('warmMs'),
      chunks: runs[0].chunks.map((c) => ({ path: c.path, bytes: c.bytes })),
    });
  }
  return out;
}

function refRate(mods, name) {
  const json = mods.loadRef(name);
  if (!json) return null;
  const ref = mods.parseRef(name, json);
  const s = ref.videoStreams.find((v) => v.enabled) ?? ref.videoStreams[0];
  if (!s) return null;
  const [num, den] = s.avgFrameRate.split('/').map(Number);
  return { rate: s.avgFrameRate, value: den ? num / den : null, isVfr: s.packets?.isVfr ?? null };
}

async function rvfcRuns(app, mods, pathOf) {
  const files = RVFC_FILES.filter((n) => pathOf(n));
  await app.open();
  const { results } = await app.addFiles(files.map(pathOf));
  const index = new Map(results.map((r, i) => [r.name, i]));
  const rows = [];
  for (const name of files) {
    const run = await app.engine(index.get(name), 'rvfc', 180_000);
    const r = run.result;
    const t = r?.videoTracks?.[0] ?? null;
    const ref = refRate(mods, name);
    const d = r?.rvfc ?? null;
    rows.push({
      name,
      ref: ref?.rate ?? null,
      refValue: ref?.value ?? null,
      refVfr: ref?.isVfr ?? null,
      estimate: t?.avgFps ? `${t.avgFps.num}/${t.avgFps.den}` : null,
      value: t?.avgFps?.value ?? null,
      errorPct: t?.avgFps && ref?.value ? (t.avgFps.value / ref.value - 1) * 100 : null,
      isVfr: t?.isVfr ?? null,
      confidence: d?.confidence ?? null,
      flags: d?.flags ?? [],
      passes: d?.passes ?? [],
      callbacks: d ? d.passes.reduce((s, p) => s + p.callbacks, 0) : 0,
      rate: d?.rate ?? null,
      displayHz: d?.displayHz ?? null,
      ms: r?.io.ms ?? null,
      wallMs: run.wallMs,
      error: r?.error ?? run.threw ?? null,
    });
    log(`  rvfc ${name}: ${rows.at(-1).error ?? `${rows.at(-1).estimate} (${rows.at(-1).confidence}) in ${(rows.at(-1).ms / 1000).toFixed(1)} s`}`);
  }
  return rows;
}

async function nodeSanity(mods, fixtures, chromeBy) {
  const rows = [];
  for (const f of fixtures) {
    const chrome = chromeBy.get(f.name);
    if (!chrome) continue;
    const opened = await mods.openFixture(f.path);
    let node;
    try {
      node = await mods.analyze(opened.blob, f.name);
    } finally {
      await opened.close();
    }
    rows.push({ name: f.name, ...compareRuns(chrome, node) });
  }
  return {
    compared: rows.length,
    identical: rows.filter((r) => r.identical).length,
    keyFieldsEqual: rows.filter((r) => r.keyFieldsEqual).length,
    differences: rows.filter((r) => !r.identical),
  };
}

function environment(chrome, edge) {
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()}${typeof os.version === 'function' ? ` (${os.version()})` : ''} ${os.arch()}`,
    cpu: cpus[0]?.model.trim() ?? null,
    logicalCores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    displayHzOs: displayHzFromOs(),
    chrome,
    edge,
  };
}

function distAssets() {
  const assets = join(DIST, 'assets');
  if (!existsSync(join(DIST, 'index.html')) || !existsSync(assets)) return null;
  return readdirSync(assets)
    .sort()
    .map((f) => ({ file: `assets/${f}`, bytes: statSync(join(assets, f)).size }));
}

async function run(opts) {
  const assets = distAssets();
  if (!assets) throw new Error('demo/dist/ is missing: run npm run build first');
  const chromeExe = findBrowser('chrome');
  if (!chromeExe) throw new Error('Chrome not found: set CHROME_PATH');
  const mods = await loadRepoModules();
  const manifest = mods.loadManifest();
  const pathOf = (name) => mods.fixturePath(name);
  const fixtures = manifest
    .filter((e) => e.committed && (!opts.filter || e.name.includes(opts.filter)))
    .map((e) => ({ name: e.name, category: e.category, path: pathOf(e.name) }))
    .filter((f) => f.path);
  if (fixtures.length === 0) throw new Error('no fixtures selected');
  const large = opts.skip.has('large')
    ? []
    : LARGE_FILES.filter((n) => (!opts.filter || n.includes(opts.filter)) && pathOf(n)).map((n) => ({ name: n, category: 'long', path: pathOf(n) }));

  const data = {
    schema: 1,
    command: `node scripts/bench/run-bench.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    options: { reps: opts.reps, engineReps: opts.engineReps, coldReps: opts.coldReps, filter: opts.filter, skipped: [...opts.skip] },
    server: 'node:http on 127.0.0.1, Cache-Control: no-store, no compression',
    dist: assets,
    fixtures: fixtures.map((f) => ({ name: f.name, category: f.category, size: statSync(f.path).size })),
    chrome: {},
    edge: null,
  };

  const server = await startServer(DIST);
  const t0 = performance.now();
  try {
    log(`Chrome: ${chromeExe}`);
    const b = await launchBrowser({ exe: chromeExe, profileDir: join(BENCH_DIR, 'chrome-profile') });
    let chromeInfo;
    try {
      const app = new AppPage(b.page, server.url);
      const mark = server.mark();
      const load = await app.open();
      data.chrome.pageLoad = { ...load, requests: requestsOf(server.since(mark)) };
      chromeInfo = await browserInfo(b, app);
      log(`  ${chromeInfo.product}, page ready in ${load.readyMs.toFixed(0)} ms`);

      const cold = await coldBatch(app, server, fixtures);
      data.chrome.coldBatch = { ...cold, results: undefined, perFile: Object.fromEntries(cold.results.map((r) => [r.name, { ms: r.io.ms, reads: r.io.reads, bytesRead: r.io.bytesRead }])) };
      log(`  cold batch: ${fixtures.length} files in ${cold.wallMs.toFixed(0)} ms (${elapsed(t0)})`);

      if (!opts.skip.has('engines')) {
        const names = fixtures.map((f) => f.name);
        data.chrome.engines = await engineRuns(app, cold.results, names, opts.engineReps);
        log(`  engines done (${elapsed(t0)})`);
      }

      if (!opts.skip.has('warm')) data.chrome.warm = await warmRuns(app, fixtures, opts.reps, 'chrome warm');

      const largeOwn = [];
      if (large.length) {
        data.chrome.large = {};
        for (const f of large) {
          const own = await warmRuns(app, [f], opts.engineReps, `large ${f.name}`);
          largeOwn.push(own[f.name].result);
          const engines = await engineRuns(app, [own[f.name].result], [f.name], opts.engineReps);
          data.chrome.large[f.name] = { own: { ...own[f.name], result: undefined }, ...engines[f.name] };
          log(`  large ${f.name} done (${elapsed(t0)})`);
        }
      }

      if (!opts.skip.has('cold-first')) {
        data.chrome.coldFirst = await coldFirst(app, server, pathOf, opts.coldReps);
        const walls = [];
        for (let i = 0; i < opts.coldReps; i++) {
          await app.open();
          walls.push((await coldBatch(app, server, fixtures)).wallMs);
        }
        data.chrome.reloadBatch = { files: fixtures.length, wallMs: walls, medianMs: median(walls), minMs: minimum(walls), maxMs: Math.max(...walls) };
        log(`  cold first-file cost and reload batches done (${elapsed(t0)})`);
      }

      if (!opts.skip.has('rvfc')) {
        data.chrome.rvfc = { mode: 'headless=new (GPU enabled, default flags), muted playback in the floating rVFC host', rows: await rvfcRuns(app, mods, pathOf) };
      }

      if (!opts.skip.has('node')) {
        const chromeBy = byName([...cold.results, ...largeOwn]);
        data.sanity = await nodeSanity(mods, [...fixtures, ...large], chromeBy);
        if (data.chrome.warm) {
          const warmVsCold = fixtures.filter((f) => data.chrome.warm[f.name] && !compareRuns(data.chrome.warm[f.name].result, chromeBy.get(f.name)).identical);
          data.sanity.warmDiffersFromCold = warmVsCold.map((f) => f.name);
          data.sanity.warmNotRepeatable = fixtures.filter((f) => data.chrome.warm[f.name] && !data.chrome.warm[f.name].repeatable).map((f) => f.name);
        }
        log(`  Chrome vs Node: ${data.sanity.identical}/${data.sanity.compared} identical (${elapsed(t0)})`);
      }

      if (!opts.skip.has('shots')) {
        data.screenshots = await takeScreenshots({ page: b.page, app, pathOf, dir: opts.write ? opts.shots : join(BENCH_DIR, 'screenshots') });
        log(`  screenshots: ${data.screenshots.map((s) => `${s.file} ${(s.bytes / 1024).toFixed(0)} KiB`).join(', ')}`);
      }
      await app.open();
      chromeInfo.rafHz = await app.hz();
    } finally {
      await b.close();
    }
    if (data.chrome.warm) for (const v of Object.values(data.chrome.warm)) delete v.result;

    let edgeInfo = null;
    const edgeExe = opts.skip.has('edge') || opts.skip.has('warm') ? null : findBrowser('edge');
    if (edgeExe) {
      log(`Edge: ${edgeExe}`);
      const e = await launchBrowser({ exe: edgeExe, profileDir: join(BENCH_DIR, 'edge-profile') });
      try {
        const app = new AppPage(e.page, server.url);
        await app.open();
        edgeInfo = await browserInfo(e, app);
        const cold = await coldBatch(app, server, fixtures);
        const warm = await warmRuns(app, fixtures, opts.reps, 'edge warm');
        for (const v of Object.values(warm)) delete v.result;
        data.edge = { coldBatch: { files: cold.files, wallMs: cold.wallMs, sumMs: cold.sumMs }, warm };
        await app.open();
        edgeInfo.rafHz = await app.hz();
        log(`  Edge done (${elapsed(t0)})`);
      } finally {
        await e.close();
      }
    }
    data.environment = environment(chromeInfo, edgeInfo);
  } finally {
    await server.close();
  }
  data.totalSeconds = (performance.now() - t0) / 1000;
  return data;
}

const round = (x) => (typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 1000) / 1000 : x);

function serialize(data) {
  const text = JSON.stringify(
    data,
    (key, value) => {
      if (!/(ms|Ms|Hz)$/.test(key)) return value;
      return Array.isArray(value) ? value.map(round) : round(value);
    },
    1,
  );
  return text.replace(/\[\s*(-?[\d.e+-]+(?:,\s*-?[\d.e+-]+)*)\s*\]/g, (_, list) => `[${list.split(/,\s*/).join(', ')}]`);
}

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
  if (opts.selfTest) {
    const { runSelfTest } = await import('./self-test.mjs');
    return (await runSelfTest()) ? 0 : 1;
  }
  const data = await run(opts);
  const md = renderMarkdown(data);
  if (opts.write) {
    mkdirSync(opts.out, { recursive: true });
    const stem = opts.filter ? 'browser-bench.local' : 'browser-bench';
    writeFileSync(join(opts.out, `${stem}.json`), `${serialize(data)}\n`);
    writeFileSync(join(opts.out, `${stem}.md`), md);
    log(`wrote ${join(basename(opts.out), `${stem}.md`)} and .json in ${data.totalSeconds.toFixed(0)} s`);
  } else {
    log(md);
  }
  const bad = data.sanity && data.sanity.identical !== data.sanity.compared;
  if (bad) console.error(`Chrome and Node results differ for ${data.sanity.compared - data.sanity.identical} file(s)`);
  return bad ? 1 : 0;
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
