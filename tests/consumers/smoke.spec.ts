import { existsSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { CONSUMERS_PORT, FIXTURES, OWN_WORKERS, SPLIT_ROUTING, buildUrl, consumersDir, devUrl, fixtureDist, installedPackage } from '../../scripts/consumers.mjs';
import type { HeaderResult } from '../../src/header/index.ts';
import type { EngineDescriptor, ProbeResult } from '../../src/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

type WorkerEngine = 'own' | 'mp4box' | 'mediabunny';
type LibraryOutcome = Pick<LibraryRun, 'outcome' | 'detail'>;

interface LibraryRun {
  browser: string;
  fixture: string;
  mode: 'build' | 'dev';
  file: string;
  engine: Exclude<WorkerEngine, 'own'>;
  outcome: 'equal' | 'differs' | 'error' | 'threw';
  detail: string | null;
}

interface ConsumerProbe {
  readonly engines: readonly string[];
  analyze(file: Blob, options?: { engine?: string; host?: HTMLElement }): Promise<ProbeResult>;
}

interface PackageRoot {
  analyze(input: Blob, options?: { name?: string; engine?: EngineDescriptor }): Promise<ProbeResult>;
}

const FILES = [
  { name: 'cfr_h264_29.97.mp4', family: 'isobmff' },
  { name: 'cfr_vp9_29.97.webm', family: 'matroska' },
  { name: 'vfr_two_phase_5_200.mp4', family: 'isobmff' },
  { name: 'vp9_no_defaultduration.webm', family: 'matroska' },
] as const;

const OWN_WORKER_NAMES = Object.values(OWN_WORKERS);
const SKEW_FIXTURES = ['default', 'zero-config'];

const FAMILIES: Record<WorkerEngine, readonly string[]> = {
  own: ['isobmff', 'matroska'],
  mp4box: ['isobmff'],
  mediabunny: ['isobmff', 'matroska'],
};

const RVFC_FILES = ['cfr_h264_29.97.mp4', 'cfr_vp9_29.97.webm'] as const;
const HEADER_FILES = ['cfr_h264_29.97.mp4', 'cfr_vp9_29.97.webm', 'vfr_two_phase_5_200.mp4', 'fmp4_global_sidx.mp4', 'rec_chromium_h264.mp4', 'corrupt_trunc_no_moov.mp4'] as const;
const RVFC_UNSUPPORTED = 'requestVideoFrameCallback unsupported';

const DIST = pathToFileURL(join(installedPackage(consumersDir()), 'dist')).href;
const LIBRARY_REPORT = process.env.CONSUMERS_LIBRARY_REPORT ? resolve(process.env.CONSUMERS_LIBRARY_REPORT) : null;

function holdsSplitRouting(fixture: string, url: string): boolean {
  const prefix = `/${fixture}/`;
  const path = decodeURIComponent(new URL(url).pathname);
  if (!path.startsWith(prefix) || !/\.m?js$/.test(path)) return false;
  const map = join(fixtureDist(consumersDir(), fixture), `${path.slice(prefix.length)}.map`);
  return existsSync(map) && (JSON.parse(readFileSync(map, 'utf8')) as { sources: string[] }).sources.some((s) => s.includes(SPLIT_ROUTING));
}

async function nodeAnalyze(name: string, engine: WorkerEngine): Promise<ProbeResult> {
  const { analyze } = (await import(`${DIST}/index.js`)) as PackageRoot;
  const descriptor = engine === 'own' ? undefined : ((await import(`${DIST}/plugins/${engine}.js`)) as Record<string, () => EngineDescriptor>)[engine]!();
  return analyze(await openAsBlob(join(FILES_DIR, name)), { name, engine: descriptor });
}

async function browserAnalyze(page: Page, name: string, engine: WorkerEngine, batched = true): Promise<ProbeResult> {
  await page.locator('#file').setInputFiles(join(FILES_DIR, name));
  return page.evaluate(
    async ([engine, batched]) => {
      const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
      if (!file) throw new Error('no file picked');
      const picked = window as unknown as { __picked?: File[] };
      if (batched) (picked.__picked ??= []).push(file);
      return (window.__probe as ConsumerProbe).analyze(file, { engine });
    },
    [engine, batched] as const,
  );
}

async function browserFailure(page: Page, name: string): Promise<{ code: unknown; reason: unknown } | null> {
  await page.locator('#file').setInputFiles(join(FILES_DIR, name));
  return page.evaluate(async () => {
    const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
    if (!file) throw new Error('no file picked');
    try {
      await (window.__probe as ConsumerProbe).analyze(file);
      return null;
    } catch (e) {
      return { code: (e as { code?: unknown }).code, reason: (e as { reason?: unknown }).reason };
    }
  });
}

async function browserBatch(page: Page): Promise<(string | null)[]> {
  return page.evaluate(async () => {
    const files = (window as unknown as { __picked?: File[] }).__picked ?? [];
    const results = await Promise.all([...files, ...files].map((f) => (window.__probe as ConsumerProbe).analyze(f)));
    return results.map((r) => r.error);
  });
}

async function browserRvfc(page: Page, name: string): Promise<{ supported: boolean; engine: string; error: string | null }> {
  await page.locator('#file').setInputFiles(join(FILES_DIR, name));
  return page.evaluate(async () => {
    const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
    if (!file) throw new Error('no file picked');
    const supported = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const { engine, error } = await (window.__probe as ConsumerProbe).analyze(file, { engine: 'rvfc', host: document.body });
    return { supported, engine, error };
  });
}

function withoutTiming(r: ProbeResult) {
  const { io, mediabunny, ...rest } = r;
  return { ...rest, io: { reads: io.reads, bytesRead: io.bytesRead }, ...(mediabunny ? { mediabunny: { ...mediabunny, nativeStatsMs: 0 } } : {}) };
}

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;

async function libraryOutcome(page: Page, name: string, engine: WorkerEngine): Promise<LibraryOutcome> {
  try {
    const expected: Record<string, unknown> = withoutTiming(await nodeAnalyze(name, engine));
    const actual = await browserAnalyze(page, name, engine, false);
    if (actual.engine !== engine || actual.error !== null) return { outcome: 'error', detail: actual.error ?? `ran on ${actual.engine}` };
    const measured: Record<string, unknown> = withoutTiming(actual);
    const fields = [...new Set([...Object.keys(expected), ...Object.keys(measured)])].filter((k) => !isDeepStrictEqual(plain(measured[k]), plain(expected[k])));
    return fields.length === 0 ? { outcome: 'equal', detail: null } : { outcome: 'differs', detail: fields.join(', ') };
  } catch (e) {
    return { outcome: 'threw', detail: firstLine(e) };
  }
}

async function nodeHeader(name: string): Promise<HeaderResult> {
  const { analyzeHeader } = (await import(`${DIST}/header/index.js`)) as { analyzeHeader: (input: Blob, options: { name: string }) => Promise<HeaderResult> };
  return analyzeHeader(await openAsBlob(join(FILES_DIR, name)), { name });
}

const withoutMs = (r: HeaderResult): unknown => plain({ ...r, io: { ...r.io, ms: 0 } });

for (const fixture of FIXTURES.filter((f) => f.pageOnly)) {
  for (const mode of ['build', 'dev'] as const) {
    test(`${fixture.name} under vite ${mode} equals Node analyzeHeader from the same tarball`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
      const workerUrls: string[] = [];
      page.on('worker', (worker) => workerUrls.push(worker.url()));
      await page.goto(mode === 'build' ? buildUrl(CONSUMERS_PORT, fixture.name) : devUrl(CONSUMERS_PORT, fixture.name));
      await page.waitForFunction(() => window.__header !== undefined);
      for (const name of HEADER_FILES) {
        await page.locator('#file').setInputFiles(join(FILES_DIR, name));
        const actual = await page.evaluate(async (fileName) => {
          const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
          if (!file) throw new Error('no file picked');
          return window.__header!.analyzeHeader(file, { name: fileName });
        }, name);
        expect(actual.scan, name).toBe('header');
        expect(withoutMs(actual), name).toEqual(withoutMs(await nodeHeader(name)));
      }
      expect(workerUrls, 'the header entry starts no worker').toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}

for (const mode of ['build', 'dev'] as const) {
  test(`url-entry under vite ${mode} reads a ranged URL through httpRange and openRangeSource as Node reads the file`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    const ranges: string[] = [];
    await page.route('**/__object/*', async (route) => {
      const request = route.request();
      const bytes = readFileSync(join(FILES_DIR, decodeURIComponent(new URL(request.url()).pathname.split('/').pop()!)));
      const range = (await request.allHeaders()).range ?? '';
      ranges.push(range);
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m) return route.fulfill({ status: 200, body: bytes });
      const first = Number(m[1]);
      const last = Math.min(Number(m[2]), bytes.byteLength - 1);
      return route.fulfill({ status: 206, headers: { 'content-range': `bytes ${first}-${last}/${bytes.byteLength}`, 'content-length': String(last - first + 1) }, body: bytes.subarray(first, last + 1) });
    });
    await page.goto(mode === 'build' ? buildUrl(CONSUMERS_PORT, 'url-entry') : devUrl(CONSUMERS_PORT, 'url-entry'));
    await page.waitForFunction(() => window.__url !== undefined);
    for (const name of HEADER_FILES) {
      ranges.length = 0;
      const actual = await page.evaluate(async (fileName) => {
        const { analyzeHeader, httpRange, openRangeSource } = window.__url!;
        const source = await openRangeSource(httpRange(new URL(`__object/${encodeURIComponent(fileName)}`, location.href)));
        return analyzeHeader(source, { name: fileName });
      }, name);
      expect(withoutMs(actual), name).toEqual(withoutMs(await nodeHeader(name)));
      expect(ranges, name).toHaveLength(actual.io.reads);
      expect(ranges.every((r) => /^bytes=\d+-\d+$/.test(r)), name).toBe(true);
    }
    expect(pageErrors).toEqual([]);
  });
}

for (const fixture of FIXTURES.filter((f) => !f.pageOnly)) {
  for (const mode of ['build', 'dev'] as const) {
    test(`${fixture.name} under vite ${mode} equals Node analyze from the same tarball`, async ({ page, browserName }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations++;
      });
      const workerUrls: string[] = [];
      page.on('worker', (worker) => workerUrls.push(worker.url()));
      const requested: string[] = [];
      page.on('request', (request) => requested.push(request.url()));
      await page.goto(mode === 'build' ? buildUrl(CONSUMERS_PORT, fixture.name) : devUrl(CONSUMERS_PORT, fixture.name));
      await page.waitForFunction(() => window.__probe !== undefined);
      expect(await page.evaluate(() => [...(window.__probe as ConsumerProbe).engines])).toEqual(fixture.engines);

      const engines = fixture.engines.filter((e): e is WorkerEngine => e !== 'rvfc');
      const split = OWN_WORKER_NAMES.every((name) => fixture.workers.includes(name));
      const ownStarted = () => workerUrls.filter((url) => OWN_WORKER_NAMES.some((name) => url.includes(name)));
      let runs = 0;
      const library: LibraryRun[] = [];
      for (const file of FILES) {
        for (const engine of engines) {
          if (!FAMILIES[engine].includes(file.family)) continue;
          if (LIBRARY_REPORT && engine !== 'own') {
            library.push({ browser: browserName, fixture: fixture.name, mode, file: file.name, engine, ...(await libraryOutcome(page, file.name, engine)) });
            continue;
          }
          const expected = await nodeAnalyze(file.name, engine);
          const before = ownStarted().length;
          const actual = await browserAnalyze(page, file.name, engine);
          if (split && engine === 'own') {
            const other = OWN_WORKERS[file.family === 'isobmff' ? 'matroska' : 'isobmff'];
            const started = ownStarted().slice(before);
            expect(started.filter((url) => url.includes(other)), `${file.name} started ${started.join(', ') || 'no own worker'}`).toEqual([]);
          }
          expect(actual.engine, `${file.name} with ${engine}`).toBe(engine);
          expect(actual.error, `${file.name} with ${engine}`).toBeNull();
          expect(withoutTiming(actual), `${file.name} with ${engine}`).toEqual(withoutTiming(expected));
          runs++;
        }
      }
      if (LIBRARY_REPORT && library.length > 0) {
        mkdirSync(LIBRARY_REPORT, { recursive: true });
        writeFileSync(join(LIBRARY_REPORT, `${browserName}-${fixture.name}-${mode}.json`), `${JSON.stringify(library, null, 2)}\n`);
      }
      expect(runs).toBeGreaterThanOrEqual(FILES.length);
      if (split) {
        expect(await browserBatch(page), 'a mixed batch of every file twice').toEqual(Array(2 * runs).fill(null));
        expect(ownStarted(), 'one own worker per container family with the default workers: 1').toHaveLength(OWN_WORKER_NAMES.length);
      }
      if (fixture.engines.includes('rvfc')) {
        const rvfcSupported = browserName !== 'webkit' || process.platform !== 'win32';
        for (const name of RVFC_FILES) {
          const { supported, engine, error } = await browserRvfc(page, name);
          expect(engine, `${name} with rvfc`).toBe('rvfc');
          expect(supported, `requestVideoFrameCallback in ${browserName} on ${process.platform}`).toBe(rvfcSupported);
          expect(error, `${name} with rvfc`).toBe(rvfcSupported ? null : RVFC_UNSUPPORTED);
        }
      }
      const libraryWorkers = LIBRARY_REPORT ? engines.filter((e) => e !== 'own').map((e) => `${e}.worker`) : [];
      for (const name of fixture.workers.filter((w) => !libraryWorkers.includes(w))) expect(workerUrls.some((url) => url.includes(name)), `a ${name} worker ran (started: ${workerUrls.join(', ') || 'none'})`).toBe(true);
      if (mode === 'build') {
        const routing = requested.filter((url) => holdsSplitRouting(fixture.name, url));
        if (fixture.byContainer) expect(routing, 'the split routing chunk loads once with byContainer').toHaveLength(1);
        if (fixture.clientMustNot?.includes(SPLIT_ROUTING)) expect(routing, 'a custom worker without byContainer never loads the split routing').toEqual([]);
      }
      expect(pageErrors).toEqual([]);
      expect(navigations, mode === 'dev' ? 'the dev server reloaded the page when an engine first ran' : 'the page navigated again').toBe(1);
    });
  }
}

for (const name of SKEW_FIXTURES) {
  test(`${name}: a missing Matroska worker fails only the WebM jobs, with reason load, and is retried`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    let missing = true;
    await page.route(`**/${OWN_WORKERS.matroska}-*.js`, (route) => (missing ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }) : route.fallback()));
    await page.goto(buildUrl(CONSUMERS_PORT, name));
    await page.waitForFunction(() => window.__probe !== undefined);
    expect(await browserFailure(page, 'cfr_vp9_29.97.webm')).toEqual({ code: 'worker-failed', reason: 'load' });
    const mp4 = await browserAnalyze(page, 'cfr_h264_29.97.mp4', 'own');
    expect(withoutTiming(mp4)).toEqual(withoutTiming(await nodeAnalyze('cfr_h264_29.97.mp4', 'own')));
    missing = false;
    const webm = await browserAnalyze(page, 'cfr_vp9_29.97.webm', 'own');
    expect(withoutTiming(webm)).toEqual(withoutTiming(await nodeAnalyze('cfr_vp9_29.97.webm', 'own')));
    expect(pageErrors).toEqual([]);
  });
}
