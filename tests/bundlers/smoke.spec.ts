import { existsSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { baselineDir, bundlersDir, measureDir, type LogEntry } from '../../scripts/bundlers.mjs';
import type { EngineDescriptor, ProbeResult } from '../../src/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { DEV_OFFSET, TARGETS, appUrl, hasPage, type BundlerApp, type BundlerTarget, type Family } from './targets.mjs';

type WorkerEngine = 'own' | 'mp4box' | 'mediabunny';

interface ConsumerProbe {
  readonly engines: readonly string[];
  analyze(file: Blob, options?: { engine?: string }): Promise<ProbeResult>;
}

interface Sized {
  files: number;
  gzip: number;
}

const DIR = bundlersDir();
const DIST = pathToFileURL(join(baselineDir(DIR), 'node_modules', 'video-fps-probe', 'dist')).href;
const FILES = [
  { name: 'cfr_h264_29.97.mp4', family: 'isobmff' },
  { name: 'cfr_vp9_29.97.webm', family: 'matroska' },
  { name: 'vfr_two_phase_5_200.mp4', family: 'isobmff' },
  { name: 'vp9_no_defaultduration.webm', family: 'matroska' },
] as const;
const FAMILIES: Record<WorkerEngine, readonly Family[]> = { own: ['isobmff', 'matroska'], mp4box: ['isobmff'], mediabunny: ['isobmff', 'matroska'] };
const OTHER: Record<Family, Family> = { isobmff: 'matroska', matroska: 'isobmff' };
const IGNORED_PATHS = new Set(['/favicon.ico']);

async function nodeAnalyze(name: string, engine: WorkerEngine): Promise<ProbeResult> {
  const { analyze } = (await import(`${DIST}/index.js`)) as { analyze(input: Blob, options?: { name?: string; engine?: EngineDescriptor }): Promise<ProbeResult> };
  const descriptor = engine === 'own' ? undefined : ((await import(`${DIST}/plugins/${engine}.js`)) as Record<string, () => EngineDescriptor>)[engine]!();
  return analyze(await openAsBlob(join(FILES_DIR, name)), { name, engine: descriptor });
}

function withoutTiming(r: ProbeResult) {
  const { io, mediabunny, ...rest } = r;
  return { ...rest, io: { reads: io.reads, bytesRead: io.bytesRead }, ...(mediabunny ? { mediabunny: { ...mediabunny, nativeStatsMs: 0 } } : {}) };
}

async function pick(page: Page, name: string): Promise<void> {
  await page.locator('#file').setInputFiles(join(FILES_DIR, name));
}

async function browserAnalyze(page: Page, name: string, engine: WorkerEngine): Promise<ProbeResult> {
  await pick(page, name);
  return page.evaluate(async (engine) => {
    const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
    if (!file) throw new Error('no file picked');
    return ((window as unknown as { __probe: ConsumerProbe }).__probe).analyze(file, { engine });
  }, engine);
}

async function browserFailure(page: Page, name: string): Promise<{ code: unknown; reason: unknown } | null> {
  await pick(page, name);
  return page.evaluate(async () => {
    const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
    if (!file) throw new Error('no file picked');
    try {
      await ((window as unknown as { __probe: ConsumerProbe }).__probe).analyze(file);
      return null;
    } catch (e) {
      return { code: (e as { code?: unknown }).code, reason: (e as { reason?: unknown }).reason };
    }
  });
}

async function serverLog(target: BundlerTarget, token: string, dev: boolean): Promise<LogEntry[]> {
  const port = target.port + (dev ? DEV_OFFSET : 0);
  const reply = await fetch(`http://127.0.0.1:${port}/__bundlers/log?token=${token}`);
  return (await reply.json()) as LogEntry[];
}

const after = (log: LogEntry[], mark: number) => log.filter((e) => e.seq > mark);
const lastSeq = (log: LogEntry[]) => log.reduce((n, e) => Math.max(n, e.seq), -1);
const scriptPaths = (urls: string[]) => new Set(urls.map((u) => new URL(u).pathname));
const clientFiles = (entries: LogEntry[], workers: string[]) => entries.filter((e) => e.js && e.client && e.holds.length === 0 && !scriptPaths(workers).has(e.path)).map((e) => e.path);
const sized = (entries: LogEntry[]): Sized => ({ files: entries.filter((e) => e.js).length, gzip: entries.filter((e) => e.js).reduce((n, e) => n + e.gzip, 0) });

interface Watched {
  page: Page;
  token: string;
  problems: string[];
  workers: string[];
  close(): Promise<void>;
}

async function open(browser: Browser, target: BundlerTarget, app: BundlerApp, dev: boolean, strict: boolean): Promise<Watched> {
  const context = await browser.newContext();
  const token = crypto.randomUUID();
  const origin = new URL(appUrl(target, app, dev)).origin;
  await context.addCookies([{ name: 'bundlers', value: token, url: origin }]);
  const page = await context.newPage();
  const problems: string[] = [];
  const workers: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error ${e.name}: ${e.message}`));
  page.on('worker', (w) => workers.push(w.url()));
  if (strict) {
    page.on('console', (m) => {
      if (['warning', 'error', 'assert'].includes(m.type())) problems.push(`console ${m.type()}: ${m.text()}`);
    });
    page.on('requestfailed', (r) => {
      if (new URL(r.url()).origin === origin && !IGNORED_PATHS.has(new URL(r.url()).pathname)) problems.push(`request failed ${r.url()}: ${r.failure()?.errorText}`);
    });
  }
  await page.goto(appUrl(target, app, dev));
  await page.waitForFunction(() => (window as unknown as { __probe?: unknown }).__probe !== undefined);
  await page.waitForLoadState('networkidle');
  return { page, token, problems, workers, close: () => context.close() };
}

function writeMeasurement(target: BundlerTarget, app: BundlerApp, browserName: string, value: Record<string, unknown>): void {
  const dir = measureDir(DIR, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${app.name}-${browserName}.json`), `${JSON.stringify({ target: target.name, app: app.name, browser: browserName, ...value }, null, 2)}\n`);
}

function badRequests(log: LogEntry[]): string[] {
  return log.filter((e) => e.status >= 400 && !IGNORED_PATHS.has(e.path)).map((e) => `${e.status} ${e.method} ${e.path}`);
}

async function expectResult(page: Page, name: string, engine: WorkerEngine): Promise<void> {
  const expected = await nodeAnalyze(name, engine);
  const actual = await browserAnalyze(page, name, engine);
  expect(actual.engine, `${name} with ${engine}`).toBe(engine);
  expect(actual.error, `${name} with ${engine}`).toBeNull();
  expect(withoutTiming(actual), `${name} with ${engine}`).toEqual(withoutTiming(expected));
}

async function passes(browser: Browser, browserName: string, target: BundlerTarget, app: BundlerApp, dev: boolean): Promise<void> {
  const w = await open(browser, target, app, dev, true);
  try {
    expect(await w.page.evaluate(() => [...((window as unknown as { __probe: ConsumerProbe }).__probe).engines])).toEqual(app.engines);
    expect(w.workers, 'no worker starts before the first analyze').toEqual([]);
    const initial = await serverLog(target, w.token, dev);
    let mark = lastSeq(initial);
    const firstLoads: Partial<Record<Family, LogEntry[]>> = {};
    for (const [i, file] of FILES.entries()) {
      const started = w.workers.length;
      await expectResult(w.page, file.name, 'own');
      const log = await serverLog(target, w.token, dev);
      const loaded = after(log, mark).filter((e) => e.js);
      mark = lastSeq(log);
      if (i < 2) {
        firstLoads[file.family] = loaded;
        expect(w.workers.length - started, `${file.name} starts one own worker`).toBe(1);
        expect(loaded.some((e) => e.holds.includes(file.family)), `${file.name} loads the ${file.family} parser (${loaded.map((e) => e.path).join(', ') || 'nothing'})`).toBe(true);
        expect(loaded.filter((e) => e.holds.includes(OTHER[file.family])).map((e) => e.path), `${file.name} loads no ${OTHER[file.family]} parser`).toEqual([]);
      }
    }
    const ownWorkers = w.workers.length;
    for (const engine of app.engines.filter((e): e is 'mp4box' | 'mediabunny' => e === 'mp4box' || e === 'mediabunny')) {
      for (const file of FILES.filter((f) => FAMILIES[engine].includes(f.family))) await expectResult(w.page, file.name, engine);
    }
    const prefetched = new Set(initial.filter((e) => e.prefetch).map((e) => e.path));
    const eagerClient = initial.filter((e) => e.js && e.client && !prefetched.has(e.path)).map((e) => e.path);
    const lazyClient = [...new Set(clientFiles([...initial.filter((e) => e.prefetch), ...(firstLoads.isobmff ?? []).filter((e) => !e.prefetch)], w.workers))];
    const split = eagerClient.length === 0 && lazyClient.length > 0;
    if (target.split !== false) {
      expect(eagerClient, 'the JavaScript served before the first analyze holds no probe client, except a prefetched chunk').toEqual([]);
      expect(lazyClient, 'the probe client is in a main-thread chunk, no worker script and holding no parser, that the first analyze loads or the page prefetched').not.toEqual([]);
    }
    const log = await serverLog(target, w.token, dev);
    expect(badRequests(log), 'no same-origin request fails').toEqual([]);
    expect(w.problems).toEqual([]);
    if (dev) return;
    const webm = await open(browser, target, app, dev, true);
    let webmLoads: LogEntry[];
    try {
      const before = lastSeq(await serverLog(target, webm.token, dev));
      await expectResult(webm.page, 'cfr_vp9_29.97.webm', 'own');
      webmLoads = after(await serverLog(target, webm.token, dev), before);
      expect(webm.problems).toEqual([]);
    } finally {
      await webm.close();
    }
    writeMeasurement(target, app, browserName, {
      status: 'pass',
      workers: ownWorkers,
      split,
      lazyClient,
      beforeAnalyze: sized(initial),
      firstMp4: sized(firstLoads.isobmff ?? []),
      firstWebm: sized(webmLoads),
    });
  } finally {
    await w.close();
  }
}

async function failsToLoad(browser: Browser, browserName: string, target: BundlerTarget, app: BundlerApp, dev: boolean): Promise<void> {
  const fails = target.fails!;
  const w = await open(browser, target, app, dev, false);
  try {
    expect(w.workers, 'no worker starts before the first analyze').toEqual([]);
    const missing: string[] = [];
    for (const file of FILES.slice(0, 2)) {
      expect(await browserFailure(w.page, file.name), file.name).toEqual(fails.analyze);
      const path = fails.missing![file.family];
      const log = await serverLog(target, w.token, dev);
      expect(log.filter((e) => e.path === path).map((e) => e.status), `${file.name} asks for ${path}`).toContain(404);
      missing.push(path);
    }
    expect(w.problems.filter((p) => p.startsWith('page error'))).toEqual([]);
    if (!dev) writeMeasurement(target, app, browserName, { status: 'expected-failure', failure: { ...fails.analyze, missing }, workers: null, split: null, beforeAnalyze: null, firstMp4: null, firstWebm: null });
  } finally {
    await w.close();
  }
}

for (const target of TARGETS.filter(hasPage)) {
  for (const app of target.apps!) {
    const label = `${target.name}${target.apps!.length > 1 ? ` ${app.name}` : ''}`;
    if (target.fails?.build) {
      test(`${label}: the zero-config build fails with the error the target table records @${target.group}`, async ({ browserName }) => {
        const path = join(measureDir(DIR, target), 'build.json');
        expect(existsSync(path), `${path} exists: run setup and build first`).toBe(true);
        const built = JSON.parse(readFileSync(path, 'utf8')) as { status: string; output: string | null };
        expect(built.status, 'the build still fails, so a tool upgrade has not fixed it yet').toBe('failed');
        for (const line of target.fails!.build!) expect(built.output, line).toContain(line);
        writeMeasurement(target, app, browserName, { status: 'expected-failure', failure: { build: target.fails!.build }, workers: null, split: null, beforeAnalyze: null, firstMp4: null, firstWebm: null });
      });
      continue;
    }
    for (const dev of [false, true]) {
      if (dev && !target.dev) continue;
      const mode = dev ? 'dev server' : 'build';
      const tags = dev ? `@${target.group} @dev` : `@${target.group}`;
      if (target.fails?.analyze && !dev) {
        test(`${label} ${mode}: the prebuilt worker is missing and analyze rejects with worker-failed ${tags}`, async ({ browser, browserName }) => {
          await failsToLoad(browser, browserName, target, app, dev);
        });
      } else {
        test(`${label} ${mode} gives the Node results with one own worker per container family ${tags}`, async ({ browser, browserName }) => {
          await passes(browser, browserName, target, app, dev);
        });
      }
    }
  }
}
