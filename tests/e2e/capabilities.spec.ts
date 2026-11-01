import { openAsBlob, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { bytes, ms } from '../../demo/src/ui/format.ts';
import { SAMPLES } from '../../demo/src/ui/samples.ts';
import { headerSnippet, LIMIT_PRESETS } from '../../demo/src/ui/snippets.ts';
import { errorClass, warningCodesOf } from '../../src/api/codes.ts';
import { check, type CheckRules } from '../../src/check/index.ts';
import { primaryTrack } from '../../src/core/result.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import type { FileErrorCode, FileResult, Rational } from '../../src/core/types.ts';
import { parseRef, type RefFile } from '../../scripts/compare/ref.ts';
import { FIXTURES_DIR } from '../helpers/fixtures.ts';
import { addFixtures, fixtureFile, nodeAnalyze, openApp, probeResults, waitSettled, type ProbeWindow } from './support.ts';

const TINY = LIMIT_PRESETS.find((p) => p.id === 'tiny')!.limits;
const DEFAULTS = LIMIT_PRESETS.find((p) => p.id === 'defaults')!.limits;
const BITSTREAM_ONLY: Readonly<Record<string, readonly string[]>> = {
  'cfr_vp9_59.94.webm': ['bitDepth', 'profile', 'codecString'],
};
const CODED_WARNINGS: Readonly<Record<string, string>> = {
  'corrupt_trunc_mdat_faststart.mp4': 'truncated-mdat',
  'mov_trailing_junk.mov': 'trailing-data',
  'corrupt_trunc_moov_partial.mp4': 'truncated-box',
};
const R_FPS_NOT_REPRODUCED = new Set(['vfr_concat_10_30_60.mp4', 'fmp4_frag_duration.mp4']);

interface ExportedJson {
  results: FileResult[];
  header?: { settings: { limits: Record<string, unknown> }; results: (FileResult & { io: { bytesRequested: number } })[] };
  url?: { results: { url: string; mode: string; httpRequests: number; result: FileResult }[] };
  check?: { rules: CheckRules; withColorAndAspect: boolean; reports: { name: string; report: { verdict: string } }[] };
}

async function strictWatch(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.name}: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (e) => console.error(`unhandledrejection: ${String(e.reason)}`));
  });
  return problems;
}

const card = (page: Page, name: string): Locator => page.locator('article.card', { has: page.getByRole('heading', { name, exact: true }) });
const cell = (scope: Locator, label: string): Locator => scope.locator('.c', { has: scope.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
const panel = (page: Page, id: string): Locator => page.locator(`#panel-${id}`);
const sub = (scope: Locator, name: string): Locator => scope.locator(`article.sub[data-name="${name}"]`);

async function extra<K extends 'header' | 'url' | 'check'>(page: Page, key: K, ready: (value: NonNullable<ExportedJson[K]>) => boolean): Promise<NonNullable<ExportedJson[K]>> {
  const read = () => page.evaluate((k) => (window as ProbeWindow).__fpsProbe!.extras[k], key) as Promise<ExportedJson[K]>;
  await expect.poll(async () => {
    const value = await read();
    return value !== undefined && ready(value as NonNullable<ExportedJson[K]>);
  }).toBe(true);
  return (await read()) as NonNullable<ExportedJson[K]>;
}

async function loadSamples(page: Page, cards: number = SAMPLES.length): Promise<void> {
  await page.getByRole('button', { name: 'Try sample files' }).click();
  await waitSettled(page, cards);
}

async function openTab(page: Page, name: string, id: string): Promise<Locator> {
  await page.getByRole('tab', { name }).click();
  const p = panel(page, id);
  await expect(p).toBeVisible();
  await expect(p.locator('.intro')).toBeVisible();
  return p;
}

const refOf = (name: string): { ref: RefFile; raw: Record<string, unknown>[] } => {
  const json = JSON.parse(readFileSync(join(FIXTURES_DIR, 'ref', `${name}.ref.json`), 'utf8')) as { probe: { streams: Record<string, unknown>[] } };
  return { ref: parseRef(name, json), raw: json.probe.streams };
};

const sameRatio = (a: Rational | null | undefined, b: { num: number; den: number } | null) => (a ? (b ? a.num * b.den === b.num * a.den : false) : b === null);

function againstRef(r: FileResult, ref: RefFile, raw: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  const t = primaryTrack(r);
  const s = ref.videoStreams[0];
  if (!t || !s || ref.videoStreams.length !== 1) return [`${r.name}: expected one video track, got ${r.videoTracks.length} and ${ref.videoStreams.length} streams`];
  const allowed = BITSTREAM_ONLY[r.name] ?? [];
  const eq = (field: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${r.name} ${field}: demo ${JSON.stringify(got)}, ffprobe ${JSON.stringify(want)}`);
  };
  const orBitstream = (field: string, got: unknown, want: unknown) => {
    if (got === null && allowed.includes(field)) return;
    eq(field, got, want);
  };
  eq('codec_name', t.codecName, s.codecName);
  eq('width', t.width, s.width);
  eq('height', t.height, s.height);
  eq('frames', t.presentedFrames ?? t.frames, s.nbFrames ?? s.nbReadPackets);
  eq('avg_frame_rate', t.avgFpsFfprobe, s.avgFrameRate);
  if (t.rFpsFfprobe !== null || !R_FPS_NOT_REPRODUCED.has(r.name)) eq('r_frame_rate', t.rFpsFfprobe, s.rFrameRate);
  if (Math.abs((r.formatDurationSec ?? NaN) - (ref.formatDurationSec ?? NaN)) > 1e-6) out.push(`${r.name} format duration: demo ${r.formatDurationSec}, ffprobe ${ref.formatDurationSec}`);
  const c = t.color;
  if (!c) out.push(`${r.name}: no color`);
  else {
    eq('color_range', c.range, s.colorRange);
    eq('color_primaries', c.primaries, s.colorPrimaries);
    eq('color_transfer', c.transfer, s.colorTransfer);
    eq('color_space', c.space, s.colorSpace);
    orBitstream('bitDepth', c.bitDepth, s.bitDepth);
    eq('hdr', c.hdr, s.colorTransfer === 'smpte2084' ? 'pq' : s.colorTransfer === 'arib-std-b67' ? 'hlg' : null);
    eq('dolby vision', c.dolbyVision, s.dolbyVision);
    const mime = raw.find((x) => x.index === s.index)?.mime_codec_string;
    if (typeof mime === 'string') orBitstream('codecString', c.codecString, mime);
  }
  if (!sameRatio(t.sampleAspectRatio, s.sampleAspectRatio)) out.push(`${r.name} sample_aspect_ratio: demo ${JSON.stringify(t.sampleAspectRatio)}, ffprobe ${JSON.stringify(s.sampleAspectRatio)}`);
  if (!sameRatio(t.displayAspectRatio, s.displayAspectRatio)) out.push(`${r.name} display_aspect_ratio: demo ${JSON.stringify(t.displayAspectRatio)}, ffprobe ${JSON.stringify(s.displayAspectRatio)}`);
  if (r.container === 'mp4' || r.container === 'mov') eq('disposition.default', t.enabled, s.enabled);
  const ticks = s.packets?.medianDeltaTicks ?? null;
  if (ticks !== null && t.provenance.medianFrameInterval === 'exact') {
    if (!sameRatio(t.medianFrameInterval, { num: ticks * s.timeBase.num, den: s.timeBase.den })) out.push(`${r.name} median frame interval: demo ${JSON.stringify(t.medianFrameInterval)}, ffprobe ${ticks} ticks of ${s.timeBase.num}/${s.timeBase.den}`);
  }
  return out;
}

test.describe('every 0.4.0 capability in the demo', () => {
  let problems: string[];

  test.beforeEach(async ({ page }) => {
    problems = await strictWatch(page);
    await openApp(page);
  });

  test.afterEach(() => {
    expect(problems ?? [], "no console warning or error, page error or unhandled rejection").toEqual([]);
  });

  test('the tabs are reachable by click and by arrow keys, and each one explains itself', async ({ page }) => {
    const tabs = [
      ['Files', 'files'],
      ['Header only', 'header'],
      ['From a URL', 'url'],
      ['Check rules', 'check'],
      ['Error codes', 'errors'],
    ] as const;
    for (const [name, id] of tabs) {
      await openTab(page, name, id);
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      await expect(panel(page, id).locator('details.code').first()).toBeVisible();
    }
    await page.getByRole('tab', { name: 'Error codes' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Files' })).toBeFocused();
    await expect(panel(page, 'files')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Error codes' })).toBeFocused();
    await expect(page).toHaveURL(/#errors$/);
    await page.reload();
    await expect(panel(page, 'errors')).toBeVisible();
  });

  test('the sample files show color, HDR, Dolby Vision, aspect, median interval and enabled, equal to the ffprobe references', async ({ page }) => {
    await loadSamples(page);
    const results = await probeResults(page);
    expect(results.map((r) => r.name)).toEqual([...SAMPLES]);
    const mismatches = results.flatMap((r) => {
      const { ref, raw } = refOf(r.name);
      return againstRef(r, ref, raw);
    });
    expect(mismatches).toEqual([]);
    for (const r of results) expect(r.videoTracks.some((t) => t.codecConfig !== undefined), r.name).toBe(false);

    const hdr = card(page, 'hdr10_hevc10.mp4');
    await expect(cell(hdr, 'HDR')).toHaveText('PQ');
    await expect(cell(hdr, 'Color')).toHaveText(/^bt2020, smpte2084, bt2020nc range tv, from colr$/);
    await expect(cell(hdr, 'Bit depth')).toHaveText('10-bit profile number 2');
    const dv = card(page, 'dv_p81_dvvc.mp4');
    await expect(cell(dv, 'HDR')).toHaveText('Dolby Vision, PQ');
    await expect(cell(dv, 'Dolby Vision')).toHaveText(/^profile 8, level 1 compatibility 1, limited metadata compression$/);
    const sar = card(page, 'sar_h264_4x3.mp4');
    await expect(cell(sar, 'Size')).toHaveText(/^1440x1080/);
    await expect(cell(sar, 'Aspect ratio')).toHaveText('SAR 4:3 DAR 16:9');
    await expect(cell(sar, 'Display size')).toHaveText('1920x1080 stored 1440x1080');
    const off = card(page, 'track_disabled.mp4');
    await expect(cell(off, 'Enabled')).toHaveText('no players skip this track');
    await expect(cell(card(page, 'cfr_h264_29.97.mp4'), 'Median frame interval')).toHaveText('1001/30000 s 29.970 fps');
    await expect(cell(card(page, 'cfr_h264_29.97.mp4'), 'Layout')).toHaveText(/^moov at the end moov of /);
    const webm = card(page, 'cfr_vp9_59.94.webm');
    await expect(cell(webm, 'HDR')).toHaveText('not signalled');
    await expect(cell(webm, 'Bit depth')).toHaveText('not in the container bitstream only');
    await expect(cell(webm, 'Codec string')).toHaveText('not in the container bitstream only');
    await expect(cell(webm, 'Median frame interval')).toHaveText('17/1000 s on 1 ms timestamps');
  });

  test('header only: editable limits, the read plan, the layout and a coded limit error', async ({ page }) => {
    await loadSamples(page);
    const p = await openTab(page, 'Header only', 'header');
    await expect(p.locator('article.sub')).toHaveCount(SAMPLES.length);
    const defaults = await extra(page, 'header', (h) => h.results.length === SAMPLES.length);
    expect(defaults.results.map((r) => r.name)).toEqual([...SAMPLES]);
    for (const r of defaults.results) {
      const want = await analyzeHeader(await openAsBlob(fixtureFile(r.name)), { name: r.name, limits: DEFAULTS, fragmentedDuration: 'index', color: true, aspect: true });
      expect({ ...r, io: { ...r.io, ms: 0 } }, r.name).toEqual({ ...want, io: { ...want.io, ms: 0 } });
      const reads = `${r.io.reads} read${r.io.reads === 1 ? '' : 's'}`;
      await expect(sub(p, r.name).locator('.plan')).toHaveText(`Read plan: ${reads}, ${bytes(r.io.bytesRequested)} requested, ${bytes(r.io.bytesRead)} read, ${ms(r.io.ms)}`);
    }
    await expect(cell(sub(p, 'cfr_h264_29.97.mp4'), 'Layout')).toHaveText(/^moov at the end/);
    await expect(cell(sub(p, 'fmp4_frag_duration.mp4'), 'Layout')).toHaveText(/^fragmented/);
    await expect(sub(p, 'cfr_vp9_59.94.webm').locator('.code-line')).toHaveText(/^unsupported-container file /);

    await p.getByRole('button', { name: /^Tiny/ }).click();
    await expect(p.getByLabel('maxBytes')).toHaveValue('4096');
    const limited = sub(p, 'cfr_h264_29.97.mp4');
    await expect(limited.locator('.code-line')).toHaveText(/^byte-limit limit Reading the header needs more bytes than maxBytes allows\.$/);
    await expect(limited.locator('p.err')).toHaveText(/^Error: limit reached: maxBytes 4096 /);
    const header = await extra(page, 'header', (h) => h.settings.limits.maxBytes === TINY.maxBytes && h.results.length === SAMPLES.length);
    expect(header.results).toHaveLength(SAMPLES.length);
    for (const r of header.results) {
      expect(r.io.bytesRequested, r.name).toBeLessThanOrEqual(TINY.maxBytes);
      expect(r.io.reads, r.name).toBeLessThanOrEqual(TINY.maxReads);
    }
    expect(header.results.find((r) => r.name === 'cfr_h264_29.97.mp4')?.errorCode).toBe('byte-limit');

    await p.locator('details.code > summary').click();
    const want = headerSnippet({ limits: TINY, fragmentedDuration: 'index', color: true, aspect: true });
    await expect(p.locator('.code-block[data-snippet="browser"] code')).toHaveText(want.browser);
    await expect(p.locator('.code-block[data-snippet="node"] code')).toHaveText(want.node);

    await p.getByLabel('fragmentedDuration').selectOption('header');
    await p.getByLabel('maxReads').fill('-1');
    await expect(p.locator('form .err')).toHaveText('maxReads must be a whole number of 0 or more, or Infinity, got -1');
    await p.getByRole('button', { name: 'Defaults' }).click();
    await expect(p.locator('form .err')).toHaveCount(0);
    await expect(sub(p, 'cfr_h264_29.97.mp4').locator('.code-line')).toHaveCount(0);
  });

  test('coded warnings: the warning codes of the Node result on the Files and the Header-only cards', async ({ page }) => {
    const names = Object.keys(CODED_WARNINGS);
    await addFixtures(page, names);
    const header = await openTab(page, 'Header only', 'header');
    await expect(header.locator('article.sub')).toHaveCount(names.length);
    for (const name of names) {
      const full = warningCodesOf(await nodeAnalyze(name, 'auto'));
      const head = warningCodesOf(await analyzeHeader(await openAsBlob(fixtureFile(name)), { name, limits: DEFAULTS, fragmentedDuration: 'index', color: true, aspect: true }));
      expect([full, head], name).toEqual([[CODED_WARNINGS[name]], [CODED_WARNINGS[name]]]);
      await expect(cell(sub(header, name), 'Warning codes')).toHaveText(head.join(', '));
    }
    const files = await openTab(page, 'Files', 'files');
    for (const name of names) await expect(cell(card(page, name), 'Warning codes')).toHaveText(CODED_WARNINGS[name]!);
    await expect(files.locator('article.card .code-line')).toHaveText([/^truncated file /]);
    await loadSamples(page, names.length + SAMPLES.length);
    await expect(cell(card(page, 'mov_trailing_junk.mov').last(), 'Warning codes')).toHaveText('trailing-data');
  });

  test('from a URL: a same-origin sample in header-only and full mode', async ({ page }) => {
    const p = await openTab(page, 'From a URL', 'url');
    await expect(p.getByLabel('URL', { exact: true })).toHaveValue(/\/samples\/hdr10_hevc10\.mp4$/);
    await p.getByRole('button', { name: 'Analyze URL' }).click();
    const hdr = sub(p, 'hdr10_hevc10.mp4');
    await expect(hdr).toBeVisible();
    await expect(cell(hdr, 'HDR')).toHaveText('PQ');
    await expect(hdr.locator('.plan')).toHaveText(/, 1 HTTP request \(header\)$/);

    await p.getByLabel('Sample on this site').selectOption('cfr_vp9_59.94.webm');
    await p.getByLabel('Analysis').selectOption('full');
    await p.getByRole('button', { name: 'Analyze URL' }).click();
    const webm = sub(p, 'cfr_vp9_59.94.webm');
    await expect(webm).toBeVisible();
    await expect(webm.locator('.plan')).toHaveText(/ HTTP requests? \(full\)$/);

    const url = await extra(page, 'url', (u) => u.results.length === 2);
    expect(url.results.map((r) => [r.mode, r.result.name])).toEqual([
      ['full', 'cfr_vp9_59.94.webm'],
      ['header', 'hdr10_hevc10.mp4'],
    ]);
    const [full, head] = url.results;
    expect(head!.httpRequests).toBe(head!.result.io.reads);
    expect(head!.result.errorCode).toBeNull();
    expect(primaryTrack(head!.result)?.color?.hdr).toBe('pq');
    const want = await nodeAnalyze('cfr_vp9_59.94.webm', 'auto');
    expect({ ...full!.result, io: null }).toEqual({ ...want, io: null });
  });

  test('from a URL: every sample in both modes, after the samples were fetched, equals the Node analysis', async ({ page }) => {
    test.slow();
    await loadSamples(page);
    const p = await openTab(page, 'From a URL', 'url');
    const runs = p.locator('.list > *');
    let n = 0;
    for (const mode of ['header', 'full'] as const) {
      await p.getByLabel('Analysis').selectOption(mode);
      for (const name of SAMPLES) {
        await p.getByLabel('Sample on this site').selectOption(name);
        await p.getByRole('button', { name: 'Analyze URL' }).click();
        await expect(runs).toHaveCount(++n);
      }
    }
    await expect(p.locator('.list > p.err')).toHaveCount(0);
    const url = await extra(page, 'url', (u) => u.results.length === n);
    for (const { mode, result } of url.results) {
      const blob = await openAsBlob(fixtureFile(result.name));
      const want = mode === 'header' ? await analyzeHeader(blob, { name: result.name, color: true, aspect: true }) : await nodeAnalyze(result.name, 'auto');
      expect({ ...result, io: null }, `${mode} ${result.name}`).toEqual({ ...want, io: null });
    }
  });

  test('from a URL on a browser without AbortSignal.any and AbortSignal.timeout, and a URL-only export', async ({ page }) => {
    await page.addInitScript(() => {
      delete (AbortSignal as { any?: unknown }).any;
      delete (AbortSignal as { timeout?: unknown }).timeout;
    });
    await openApp(page);
    expect(await page.evaluate(() => 'any' in AbortSignal || 'timeout' in AbortSignal)).toBe(false);
    const p = await openTab(page, 'From a URL', 'url');
    await p.getByRole('button', { name: 'Analyze URL' }).click();
    await expect(cell(sub(p, 'hdr10_hevc10.mp4'), 'HDR')).toHaveText('PQ');
    await expect(p.getByRole('button', { name: 'Analyze URL' })).toBeEnabled();
    await expect(p.locator('.list > p.err')).toHaveCount(0);
    await extra(page, 'url', (u) => u.results.length === 1);
    await page.getByRole('button', { name: 'Copy JSON' }).click();
    await expect(page.locator('.export-note')).toContainText(/Copied the URL results to the clipboard\.|The browser blocked copying\./);
  });

  test('check: presets, the rules editor with sizeBasis and hdr, verdicts, violations and unknown hints', async ({ page }) => {
    await loadSamples(page);
    const p = await openTab(page, 'Check rules', 'check');
    await expect(p.locator('article.sub')).toHaveCount(SAMPLES.length);
    const rules: CheckRules = { frameSize: { maxLongSide: 1900 }, sizeBasis: 'display', hdr: 'reject' };
    await p.getByLabel('Rules (JSON)').fill(JSON.stringify(rules));
    await expect(p.getByRole('combobox', { name: /^sizeBasis/ })).toHaveValue('display');
    await expect(p.getByRole('combobox', { name: /^hdr/ })).toHaveValue('reject');

    const sar = sub(p, 'sar_h264_4x3.mp4');
    await expect(sar.locator('.verdict')).toHaveText('fail');
    await expect(sar.locator('.violations li.fail')).toHaveText(/frameSize\.maxLongSide: 1920 px is above the maximum 1900 px/);
    const hdr = sub(p, 'hdr10_hevc10.mp4');
    await expect(hdr.locator('.verdict')).toHaveText('fail');
    await expect(hdr.locator('.violations li.fail')).toContainText('hdr: the video is HDR');

    await p.getByLabel(/Judge with color and aspect/).uncheck();
    await expect(sar.locator('.verdict')).toHaveText('unknown');
    await expect(sar.locator('.violations li.unknown')).toHaveText([
      'unknown frameSize: unknown, no display size (needs codecConfig: true and withAspect)',
      'unknown hdr: unknown, no color (needs codecConfig: true and withColor)',
    ]);

    await p.getByLabel(/Judge with color and aspect/).check();
    await p.getByLabel('Preset').selectOption('veoExtend');
    await expect(p.getByRole('combobox', { name: /^sizeBasis/ })).toHaveValue('display');
    const results = await probeResults(page);
    const shown = JSON.parse(await p.getByLabel('Rules (JSON)').inputValue()) as CheckRules;
    expect(shown).toMatchObject({ fps: { exact: 24 }, sizeBasis: 'display', hdr: 'reject' });
    for (const r of results) await expect(sub(p, r.name).locator('.verdict')).toHaveText(check(r, shown).verdict);
    await p.locator('details.code > summary').click();
    const browser = p.locator('.code-block[data-snippet="browser"] code');
    await expect(browser).toContainText("check(result, { ...veoExtend.rules, sizeBasis: 'display', hdr: 'reject' })");

    const edited: CheckRules = { ...shown, fps: { exact: 30 } };
    await p.getByLabel('Rules (JSON)').fill(JSON.stringify(edited, null, 2));
    await expect(p.getByLabel('Preset')).toHaveValue('');
    await expect(browser).toContainText("check(result, { ...rules, sizeBasis: 'display', hdr: 'reject' })");
    await expect(browser).not.toContainText('veoExtend');
    for (const r of results) await expect(sub(p, r.name).locator('.verdict')).toHaveText(check(r, edited).verdict);

    await p.getByLabel('Preset').selectOption('veoExtend');
    await expect(browser).toContainText('veoExtend.rules');
    await p.getByRole('combobox', { name: /^hdr/ }).selectOption('warn');
    await expect(p.getByLabel('Preset')).toHaveValue('veoExtend');
    await expect(browser).toContainText("check(result, { ...veoExtend.rules, sizeBasis: 'display', hdr: 'warn' })");
    await p.getByLabel('Rules (JSON)').fill(JSON.stringify({ ...edited, sizeBasis: "fo'o" }));
    await expect(p.getByLabel('Preset')).toHaveValue('');
    await expect(p.locator('form .err')).toHaveText(`sizeBasis must be stored or display, got "fo'o"`);
    await expect(p.getByRole('combobox', { name: /^sizeBasis/ })).toHaveValue('');
    await expect(browser).not.toContainText("fo'o");
    await expect(browser).toContainText("check(result, { ...rules, hdr: 'reject' })");

    await p.getByLabel('Rules (JSON)').fill('{"fps": ');
    await expect(p.locator('form .err')).toHaveText(/^Not valid JSON: /);
  });

  test('the address hash switches the tab while the page is open', async ({ page }) => {
    for (const [hash, id, name] of [
      ['check', 'check', 'Check rules'],
      ['header', 'header', 'Header only'],
      ['', 'files', 'Files'],
    ] as const) {
      await page.evaluate((h) => {
        location.hash = h;
      }, hash);
      await expect(panel(page, id)).toBeVisible();
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('error codes: every code with its errorClass and meaning, and the warning codes', async ({ page }) => {
    const p = await openTab(page, 'Error codes', 'errors');
    const rows = p.locator('table[aria-label="Error codes"] tbody tr');
    const codes = (await rows.locator('th').allInnerTexts()) as FileErrorCode[];
    expect(codes).toHaveLength(17);
    expect(await rows.locator('td:nth-of-type(1)').allInnerTexts()).toEqual(codes.map((c) => errorClass(c)));
    for (const text of await rows.locator('td:nth-of-type(2)').allInnerTexts()) expect(text).toMatch(/\.$/);
    await expect(p.locator('table[aria-label="Warning codes"] tbody tr')).toHaveCount(10);
    await expect(p.locator('.classes dt')).toHaveText(['file', 'limit', 'io', 'environment', 'internal']);
  });

  test('copy buttons and the JSON export hold every tab', async ({ page }) => {
    await loadSamples(page);
    await openTab(page, 'Header only', 'header');
    await expect(panel(page, 'header').locator('article.sub')).toHaveCount(SAMPLES.length);
    const url = await openTab(page, 'From a URL', 'url');
    await url.getByRole('button', { name: 'Analyze URL' }).click();
    await expect(url.locator('article.sub')).toHaveCount(1);
    const checks = await openTab(page, 'Check rules', 'check');
    await expect(checks.locator('article.sub')).toHaveCount(SAMPLES.length);

    await checks.locator('details.code > summary').click();
    await checks.locator('.code-block[data-snippet="node"]').getByRole('button', { name: 'Copy' }).click();
    await expect(checks.locator('.code-block[data-snippet="node"] [aria-live]')).toHaveText(/^(Copied\.|Copying is blocked here: the code is selected, press Ctrl\+C or Cmd\+C\.)$/);

    await extra(page, 'check', (c) => c.reports.length === SAMPLES.length);
    await extra(page, 'header', (h) => h.results.length === SAMPLES.length);
    await extra(page, 'url', (u) => u.results.length === 1);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
    const doc = JSON.parse(await readFile((await download.path())!, 'utf8')) as ExportedJson;
    expect(doc.results.map((r) => r.name)).toEqual([...SAMPLES]);
    expect(doc.header?.results.map((r) => r.name)).toEqual([...SAMPLES]);
    expect(doc.url?.results.map((r) => r.result.name)).toEqual(['hdr10_hevc10.mp4']);
    expect(doc.check?.reports.map((r) => r.name)).toEqual([...SAMPLES]);
    expect(doc.check?.withColorAndAspect).toBe(true);

    await page.getByRole('button', { name: 'Copy JSON' }).click();
    const note = page.locator('.export-note');
    await expect(note).toContainText(new RegExp(`Copied ${SAMPLES.length} file results, the header-only results, the URL results and the check reports to the clipboard\\.|The browser blocked copying\\.`));
    const area = note.locator('textarea');
    if ((await area.count()) > 0) {
      const copied = JSON.parse(await area.inputValue()) as ExportedJson;
      expect(copied.check?.reports).toEqual(doc.check?.reports);
    }
  });

  test('no horizontal overflow at 360 px in any tab', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await loadSamples(page);
    for (const [name, id] of [
      ['Files', 'files'],
      ['Header only', 'header'],
      ['From a URL', 'url'],
      ['Check rules', 'check'],
      ['Error codes', 'errors'],
    ] as const) {
      const p = await openTab(page, name, id);
      if (id === 'url') {
        await p.getByRole('button', { name: 'Analyze URL' }).click();
        await expect(p.locator('article.sub')).toHaveCount(1);
      }
      if (id === 'header' || id === 'check') await expect(p.locator('article.sub')).toHaveCount(SAMPLES.length);
      await p.locator('details.code > summary').first().click();
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 0.5 && !el.closest('.scroll, pre') && el.getClientRects().length > 0)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
        return { scroll: doc.scrollWidth, client: doc.clientWidth, wide: wide.slice(0, 5) };
      });
      expect(overflow.wide, name).toEqual([]);
      expect(overflow.scroll, name).toBeLessThanOrEqual(overflow.client);
    }
  });
});
