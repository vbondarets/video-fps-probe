import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { primaryTrack } from '../../src/core/result.ts';
import { addFixtures, nodeAnalyze, openApp, probeResults, type ProbeWindow } from './support.ts';

const FILES = [
  { name: 'cfr_vp9_30.webm', type: 'video/webm; codecs="vp9"' },
  { name: 'cfr_h264_30.mp4', type: 'video/mp4; codecs="avc1.640028"' },
];
const HANG_MS = 75_000;

test('rVFC playback estimate is recorded per engine', async ({ page, browserName }, testInfo) => {
  test.setTimeout(FILES.length * HANG_MS + 60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
  await openApp(page);
  await addFixtures(
    page,
    FILES.map((f) => f.name),
  );
  const names = (await probeResults(page)).map((r) => r.name);
  const files = [];
  for (const { name, type } of FILES) {
    const truth = primaryTrack(await nodeAnalyze(name, 'exact'));
    const outcome = await page.evaluate(
      async ({ index, type, limit }) => {
        const canPlayType = document.createElement('video').canPlayType(type);
        const t0 = performance.now();
        const hang = new Promise<null>((done) => setTimeout(() => done(null), limit));
        try {
          const r = await Promise.race([(window as ProbeWindow).__fpsProbe!.runEngine(index, 'rvfc'), hang]);
          const ms = Math.round(performance.now() - t0);
          if (!r) return { status: 'hang', canPlayType, ms };
          const t = r.videoTracks.find((x) => x.trackId === r.primaryTrackId) ?? null;
          const details = (r as { rvfc?: { confidence: string; flags: string[]; displayHz: number; rate: number } }).rvfc;
          return {
            status: r.error ? 'error' : 'ok',
            canPlayType,
            ms,
            error: r.error,
            avgFps: t?.avgFps?.value ?? null,
            nominalFps: t?.nominalFps?.value ?? null,
            isVfr: t?.isVfr ?? null,
            confidence: details?.confidence ?? null,
            flags: details?.flags ?? [],
            displayHz: details?.displayHz ?? null,
            playbackRate: details?.rate ?? null,
          };
        } catch (e) {
          return { status: 'rejected', canPlayType, ms: Math.round(performance.now() - t0), error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        }
      },
      { index: names.indexOf(name), type, limit: HANG_MS },
    );
    files.push({ name, parsedAvgFps: truth?.avgFps?.value ?? null, ...outcome });
  }
  const summary = { project: testInfo.project.name, browser: browserName, version: page.context().browser()?.version() ?? null, files };
  const path = testInfo.outputPath('rvfc-summary.json');
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
  await testInfo.attach('rvfc-summary', { path, contentType: 'application/json' });
  console.log(`rvfc ${testInfo.project.name}: ${JSON.stringify(files.map((f) => ({ name: f.name, status: f.status, avgFps: 'avgFps' in f ? f.avgFps : null, error: f.error ?? null })))}`);
  expect(files.filter((f) => f.status === 'hang' || f.status === 'rejected')).toEqual([]);
  expect(pageErrors).toEqual([]);
});
