import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CONSUMERS_PORT, FIXTURES, buildUrl, consumersDir, devUrl, installedPackage } from '../../scripts/consumers.mjs';
import type { EngineDescriptor, ProbeResult } from '../../src/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

type WorkerEngine = 'own' | 'mp4box' | 'mediabunny';

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
] as const;

const FAMILIES: Record<WorkerEngine, readonly string[]> = {
  own: ['isobmff', 'matroska'],
  mp4box: ['isobmff'],
  mediabunny: ['isobmff', 'matroska'],
};

const RVFC_FILES = ['cfr_h264_29.97.mp4', 'cfr_vp9_29.97.webm'] as const;
const RVFC_UNSUPPORTED = 'requestVideoFrameCallback unsupported';

const DIST = pathToFileURL(join(installedPackage(consumersDir()), 'dist')).href;

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
    return (window.__probe as ConsumerProbe).analyze(file, { engine });
  }, engine);
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
      let runs = 0;
      for (const file of FILES) {
        for (const engine of engines) {
          if (!FAMILIES[engine].includes(file.family)) continue;
          const expected = await nodeAnalyze(file.name, engine);
          const actual = await browserAnalyze(page, file.name, engine);
          expect(actual.engine, `${file.name} with ${engine}`).toBe(engine);
          expect(actual.error, `${file.name} with ${engine}`).toBeNull();
          expect(withoutTiming(actual), `${file.name} with ${engine}`).toEqual(withoutTiming(expected));
          runs++;
        }
      }
      expect(runs).toBeGreaterThanOrEqual(FILES.length);
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
