import { mkdirSync, openAsBlob, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { CONSUMERS_PORT, FIXTURES, OWN_WORKERS, buildUrl, consumersDir, devUrl, installedPackage } from '../../scripts/consumers.mjs';
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
const RVFC_UNSUPPORTED = 'requestVideoFrameCallback unsupported';

const DIST = pathToFileURL(join(installedPackage(consumersDir()), 'dist')).href;
const LIBRARY_REPORT = process.env.CONSUMERS_LIBRARY_REPORT ? resolve(process.env.CONSUMERS_LIBRARY_REPORT) : null;

async function nodeAnalyze(name: string, engine: WorkerEngine): Promise<ProbeResult> {
  const { analyze } = (await import(`${DIST}/index.js`)) as PackageRoot;
  const descriptor = engine === 'own' ? undefined : ((await import(`${DIST}/plugins/${engine}.js`)) as Record<string, () => EngineDescriptor>)[engine]!();
  return analyze(await openAsBlob(join(FILES_DIR, name)), { name, engine: descriptor });
}

async function browserAnalyze(page: Page, name: string, engine: WorkerEngine): Promise<ProbeResult> {
  await page.locator('#file').setInputFiles(join(FILES_DIR, name));
  return page.evaluate(async (engine) => {
    const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
    if (!file) throw new Error('no file picked');
    const picked = window as unknown as { __picked?: File[] };
    (picked.__picked ??= []).push(file);
    return (window.__probe as ConsumerProbe).analyze(file, { engine });
  }, engine);
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
    const actual = await browserAnalyze(page, name, engine);
    if (actual.engine !== engine || actual.error !== null) return { outcome: 'error', detail: actual.error ?? `ran on ${actual.engine}` };
    const measured: Record<string, unknown> = withoutTiming(actual);
    const fields = [...new Set([...Object.keys(expected), ...Object.keys(measured)])].filter((k) => !isDeepStrictEqual(plain(measured[k]), plain(expected[k])));
    return fields.length === 0 ? { outcome: 'equal', detail: null } : { outcome: 'differs', detail: fields.join(', ') };
  } catch (e) {
    return { outcome: 'threw', detail: firstLine(e) };
  }
}

for (const fixture of FIXTURES) {
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
            runs++;
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
      for (const name of fixture.workers) expect(workerUrls.some((url) => url.includes(name)), `a ${name} worker ran (started: ${workerUrls.join(', ') || 'none'})`).toBe(true);
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
