import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { CONSUMERS_PORT, buildUrl, consumersDir, devUrl, installedPackage } from '../../scripts/consumers.mjs';
import type { FileResult, ProbeResult, VideoFpsSummary } from '../../src/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

interface PackageRoot {
  analyze(input: Blob, options?: { name?: string }): Promise<ProbeResult>;
  summarize(result: FileResult): VideoFpsSummary;
}

const DIST = pathToFileURL(join(installedPackage(consumersDir()), 'dist')).href;
const FILES = ['cfr_h264_29.97.mp4', 'cfr_vp9_29.97.webm', 'vfr_two_phase_5_200.mp4'];
const REACT = [
  ['react', '19.'],
  ['react18', '18.'],
] as const;

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withoutTiming = (r: ProbeResult) => ({ ...r, io: { reads: r.io.reads, bytesRead: r.io.bytesRead } });

async function nodeState(name: string): Promise<{ result: ProbeResult; summary: VideoFpsSummary }> {
  const { analyze, summarize } = (await import(`${DIST}/index.js`)) as PackageRoot;
  const result = await analyze(await openAsBlob(join(FILES_DIR, name)), { name });
  return json({ result, summary: summarize(result) });
}

for (const [fixture, major] of REACT) {
  for (const mode of ['build', 'dev'] as const) {
    const strict = mode === 'dev' ? ', through the double effects of StrictMode' : '';
    test(`${fixture} under vite ${mode}: useVideoFps renders each file's result with one analysis per file${strict}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(mode === 'build' ? buildUrl(CONSUMERS_PORT, fixture) : devUrl(CONSUMERS_PORT, fixture));
      await page.waitForFunction(() => window.__react !== undefined);
      expect(await page.evaluate(() => window.__react?.version)).toMatch(new RegExp(`^${major.replace('.', '\\.')}`));

      await page.locator('#react-file').setInputFiles(FILES.map((name) => join(FILES_DIR, name)));
      for (const name of FILES) {
        const output = page.locator(`output[data-name="${name}"]`);
        await expect(output, name).toHaveAttribute('data-status', 'success');
        const state = JSON.parse((await output.getAttribute('data-state')) ?? 'null') as { result: ProbeResult; summary: VideoFpsSummary; error: string | null };
        const expected = await nodeState(name);
        expect(state.error, name).toBeNull();
        expect(withoutTiming(state.result), name).toEqual(withoutTiming(expected.result));
        expect(state.summary, name).toEqual(expected.summary);
      }
      const calls = () => page.evaluate(() => window.__react?.calls ?? []);
      expect([...(await calls())].sort((a, b) => a.name.localeCompare(b.name))).toEqual([...FILES].sort().map((name) => ({ name, aborted: false })));

      await page.locator('#rerender').click();
      await page.locator('#toggle').click();
      await expect(page.locator('output')).toHaveCount(0);
      await page.locator('#toggle').click();
      for (const name of FILES) await expect(page.locator(`output[data-name="${name}"]`), `${name} after a remount`).toHaveAttribute('data-status', 'success');
      expect(await calls(), 'a re-render and a remount reuse the cached results').toHaveLength(FILES.length);
      expect(errors).toEqual([]);
    });
  }
}
