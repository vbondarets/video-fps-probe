import { readFile } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primaryTrack } from '../../src/core/result.ts';
import type { FileResult } from '../../src/core/types.ts';
import { analyzeWithMediabunny } from '../../src/engines/mediabunny.ts';
import { analyzeWithMp4box } from '../../src/engines/mp4box.ts';
import { count, fps } from '../../src/ui/format.ts';
import { addFixtures, fixtureFile, nodeAnalyze, openApp, probeResults, waitSettled, withoutTiming, type ProbeWindow } from './support.ts';

const SAMPLE_COUNT = 6;
const MODULE_LOAD_FAILURE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.name}: ${e.message}`));
  return errors;
}

const card = (page: Page, name: string): Locator => page.locator('article.card', { has: page.getByRole('heading', { name, exact: true }) });

const cell = (scope: Locator, label: string): Locator => scope.locator('.c', { has: scope.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');

async function loadSamples(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Try sample files' }).click();
  await waitSettled(page, SAMPLE_COUNT);
}

test('page loads without console errors', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Video FPS Probe' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'No files yet.' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});

test('Try sample files loads 6 results', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await loadSamples(page);
  const results = await probeResults(page);
  expect(results).toHaveLength(SAMPLE_COUNT);
  for (const r of results) {
    expect(r.error, r.name).toBeNull();
    expect(primaryTrack(r)?.avgFps, r.name).not.toBeNull();
  }
  await expect(page.locator('article.card')).toHaveCount(SAMPLE_COUNT);
  await expect(page.locator('article.card .err')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Matroska in header mode offers Scan all frames, which upgrades it to exact', async ({ page }) => {
  const name = 'h264_vfr_remux.mkv';
  await openApp(page, 'header');
  await addFixtures(page, [name]);
  const c = card(page, name);
  const [header] = await probeResults(page);
  expect(header.scan).toBe('header');
  await expect(cell(c, 'Scan depth')).toHaveText('header');
  const button = c.getByRole('button', { name: 'Scan all frames' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(c.getByRole('heading', { name, exact: true })).toBeFocused();
  await page.waitForFunction(() => {
    const hook = (window as ProbeWindow).__fpsProbe!;
    return hook.pending === 0 && hook.results[0]?.scan === 'exact';
  });
  await expect(cell(c, 'Scan depth')).toHaveText('exact');
  await expect(button).toHaveCount(0);
  const [exact] = await probeResults(page);
  expect(withoutTiming(exact)).toEqual(withoutTiming(await nodeAnalyze(name, 'exact')));
});

test('two phase VFR shows the uneven badge and a 2 segment rate profile', async ({ page }) => {
  const name = 'vfr_two_phase_5_200.mp4';
  await openApp(page);
  await addFixtures(page, [name]);
  const c = card(page, name);
  await expect(c.locator('.badge.uneven')).toBeVisible();
  await expect(cell(c, 'Nominal FPS')).toHaveText(/^varies/);
  await expect(cell(c, 'Frame timing')).not.toHaveText(/%/);
  const profile = c.locator('section.rp');
  await expect(profile).toBeVisible();
  await expect(profile.locator('svg')).toBeVisible();
  await expect(profile.locator('details > summary')).toHaveText(/^2 segments, /);
  const [r] = await probeResults(page);
  const rp = primaryTrack(r)?.rateProfile;
  expect(rp?.uneven).toBe(true);
  expect(rp?.segments).toHaveLength(2);
  await profile.locator('details > summary').click();
  await expect(profile.locator('tbody tr')).toHaveCount(2);
});

for (const engine of ['mp4box', 'mediabunny'] as const) {
  test(`compare panel runs ${engine} and shows its result`, async ({ page, browserName }) => {
    const name = 'cfr_h264_29.97.mp4';
    const errors = watchErrors(page);
    await openApp(page);
    await addFixtures(page, [name]);
    const c = card(page, name);
    await c.locator('details.cmp > summary').click();
    const table = c.locator('.cmp-body table');
    await expect(table).toBeVisible();
    const column = ['own', 'mp4box', 'mediabunny', 'rvfc'].indexOf(engine);
    const row = (label: string): Locator => table.locator('tbody tr', { has: page.locator('th', { hasText: new RegExp(`^${label}$`) }) }).locator('td');
    const status = row('Status').nth(column);
    await expect.poll(() => status.innerText(), { timeout: 30_000 }).not.toMatch(/^(not run|running)$|\d%$/);
    const text = await status.innerText();
    if (MODULE_LOAD_FAILURE.test(text)) {
      test.info().annotations.push({ type: 'engine-unavailable', description: `${engine} could not load in ${browserName}: ${text}` });
      test.skip(true, `${engine} could not load in ${browserName}: ${text}`);
    }
    expect(text).toBe('done');
    const blob = await openAsBlob(fixtureFile(name));
    const want: FileResult = engine === 'mp4box' ? await analyzeWithMp4box(blob, name) : await analyzeWithMediabunny(blob, name);
    const t = primaryTrack(want);
    expect(want.error).toBeNull();
    await expect(row('Average FPS').nth(column)).toHaveText(fps(t?.avgFps));
    await expect(row('Average \\(num/den\\)').nth(column)).toHaveText(t?.avgFps ? `${t.avgFps.num}/${t.avgFps.den}` : '-');
    await expect(row('Frames').nth(column)).toHaveText(count(t?.presentedFrames ?? t?.frames));
    expect(errors).toEqual([]);
  });
}

interface ExportedJson {
  schema: string;
  app: { build: string | null };
  environment: { userAgent: string };
  settings: { matroskaMode: string };
  results: FileResult[];
}

test('Download JSON matches the result cards', async ({ page }) => {
  await openApp(page);
  await loadSamples(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
  expect(download.suggestedFilename()).toBe('video-fps-probe-results.json');
  const doc = JSON.parse(await readFile((await download.path())!, 'utf8')) as ExportedJson;
  expect(doc.schema).toBe('video-fps-probe/export@1');
  expect(doc.app.build).toMatch(/^index-[\w-]+\.js$/);
  expect(doc.settings.matroskaMode).toBe('auto');
  expect(doc.environment.userAgent).toBe(await page.evaluate(() => navigator.userAgent));
  const json = doc.results;
  const results = await page.evaluate(() => JSON.parse(JSON.stringify((window as ProbeWindow).__fpsProbe!.results)) as FileResult[]);
  expect(json).toEqual(results);
  const cards = page.locator('article.card');
  await expect(cards).toHaveCount(json.length);
  expect(await cards.locator('header h3').allInnerTexts()).toEqual(json.map((r) => r.name));
  for (const r of json) {
    const t = primaryTrack(r);
    const c = card(page, r.name);
    await expect(cell(c, 'Average FPS').locator('b')).toHaveText(fps(t?.avgFps));
    await expect(cell(c, 'Frames')).toHaveText(new RegExp(`^${count(t?.presentedFrames ?? t?.frames)}`));
  }
});

test('a probe-mode Matroska card does not claim CFR, and a card without video offers no rescan', async ({ page }) => {
  await openApp(page, 'probe');
  await addFixtures(page, ['cfr_vp9_30.webm', 'audio_only_opus.webm']);
  const [video] = await probeResults(page);
  expect(video.scan).toBe('probe');
  expect(primaryTrack(video)?.isVfr).toBe(false);
  const c = card(page, 'cfr_vp9_30.webm');
  await expect(cell(c, 'Frame timing')).toHaveText(/no VFR in sample/);
  await expect(cell(c, 'Frame timing')).not.toHaveText(/CFR/);
  await expect(c.getByRole('button', { name: 'Scan all frames' })).toBeVisible();
  await expect(card(page, 'audio_only_opus.webm').getByRole('button', { name: 'Scan all frames' })).toHaveCount(0);
});

test('a Matroska scan mode chosen while files are still analysing applies to them', async ({ page }) => {
  await openApp(page);
  const names = ['vfr_two_phase_5_200.webm', 'h264_vfr_remux.mkv'];
  await page.getByTestId('file-input').setInputFiles(names.map(fixtureFile));
  await page.getByLabel('Matroska scan').selectOption('header');
  await waitSettled(page, names.length);
  const results = await probeResults(page);
  expect(results.map((r) => r.scan)).toEqual(['header', 'header']);
});

test('Clear list moves focus to the file input, and the export note clears when the list changes', async ({ page }) => {
  await openApp(page);
  await addFixtures(page, ['cfr_h264_30.mp4']);
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
  await expect(page.locator('.export-note')).toHaveCount(1);
  await addFixtures(page, ['cfr_h264_25.mp4']);
  await expect(page.locator('.export-note')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear list' }).click();
  await expect(page.getByTestId('file-input')).toBeFocused();
});

test('no horizontal overflow at 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openApp(page);
  await loadSamples(page);
  await page.locator('article.card details.cmp > summary').first().click();
  await expect(page.locator('.cmp-body table').first()).toBeVisible();
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 0.5 && !el.closest('.scroll'))
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    return { scroll: doc.scrollWidth, client: doc.clientWidth, wide: wide.slice(0, 5) };
  });
  expect(overflow.wide).toEqual([]);
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
});

test('file input is reachable with the keyboard', async ({ page }) => {
  await openApp(page);
  const input = page.getByTestId('file-input');
  let focused = false;
  for (let i = 0; i < 5 && !focused; i++) {
    await page.keyboard.press('Tab');
    focused = await input.evaluate((el) => el === document.activeElement);
  }
  expect(focused).toBe(true);
  await expect(page.locator('label.drop')).toHaveCSS('outline-style', 'solid');
});
