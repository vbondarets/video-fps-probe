import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FILES_DIR } from '../helpers/fixtures.ts';

const CAPTURE = '../../src/core/isobmff/config.ts';
const METADATA = '../../src/header/metadata.ts';

async function headerWithFailing(module: string) {
  vi.resetModules();
  vi.doMock(module, async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  return (await import('../../src/header/index.ts')).analyzeHeader;
}

async function headerWithStalled(module: string) {
  vi.resetModules();
  vi.doMock(module, () => new Promise<never>(() => {}));
  return (await import('../../src/header/index.ts')).analyzeHeader;
}

const fixture = (name: string) => openAsBlob(join(FILES_DIR, name));

afterEach(() => {
  vi.doUnmock(CAPTURE);
  vi.doUnmock(METADATA);
  vi.resetModules();
});

describe('a lazy chunk of the header entry that fails to load', () => {
  test('the codec configuration capture keeps the tracks and gives load-failed', async () => {
    const analyzeHeader = await headerWithFailing(CAPTURE);
    const blob = await fixture('hdr10_hevc10.mp4');
    const plain = await analyzeHeader(blob);
    for (const option of ['codecConfig', 'color', 'aspect'] as const) {
      const r = await analyzeHeader(blob, { [option]: true });
      expect(r.errorCode, option).toBe('load-failed');
      expect(r.error, option).toMatch(/./);
      expect(r.videoTracks, option).toEqual(plain.videoTracks);
    }
  });

  test('the capture keeps an earlier error and adds the load failure as a warning', async () => {
    const analyzeHeader = await headerWithFailing(CAPTURE);
    const r = await analyzeHeader(await fixture('fmp4_missing_fragment.mp4'), { color: true });
    expect(r.errorCode).toBe('no-duration');
    expect(r.warnings).toContainEqual(expect.stringMatching(/^codec configuration not read: ./));
    expect(r.videoTracks).toHaveLength(1);
  });

  test('the color and aspect chunk keeps the tracks, drops the bytes unless asked for and keeps an earlier error', async () => {
    const analyzeHeader = await headerWithFailing(METADATA);
    const blob = await fixture('hdr10_hevc10.mp4');
    const r = await analyzeHeader(blob, { color: true, aspect: true });
    expect(r.errorCode).toBe('load-failed');
    expect(r.videoTracks).toHaveLength(1);
    expect(r.videoTracks[0]).not.toHaveProperty('codecConfig');
    expect(r.videoTracks[0].color).toBeUndefined();
    expect((await analyzeHeader(blob, { color: true, codecConfig: true })).videoTracks[0].codecConfig?.family).toBe('isobmff');
    const limited = await analyzeHeader(await fixture('fmp4_missing_fragment.mp4'), { aspect: true });
    expect(limited.errorCode).toBe('no-duration');
    expect(limited.warnings).toContainEqual(expect.stringMatching(/^color and aspect not applied: ./));
    expect(limited.videoTracks[0]).not.toHaveProperty('codecConfig');
  });
});

describe('a lazy chunk of the header entry that never loads', () => {
  for (const [label, module, option] of [
    ['the codec configuration capture', CAPTURE, 'codecConfig'],
    ['the color and aspect chunk', METADATA, 'color'],
  ] as const) {
    test(`${label} settles at maxMs with time-limit and keeps the tracks`, async () => {
      const analyzeHeader = await headerWithStalled(module);
      const blob = await fixture('hdr10_hevc10.mp4');
      const plain = await analyzeHeader(blob);
      const t0 = performance.now();
      const r = await analyzeHeader(blob, { [option]: true, aspect: true, limits: { maxMs: 300 } });
      const ms = performance.now() - t0;
      expect(r.errorCode).toBe('time-limit');
      expect(r.error).toBe('limit reached: maxMs 300');
      expect(r.videoTracks).toEqual(plain.videoTracks);
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThan(2000);
    });

    test(`${label} keeps an earlier error and adds the deadline as a warning`, async () => {
      const analyzeHeader = await headerWithStalled(module);
      const r = await analyzeHeader(await fixture('fmp4_missing_fragment.mp4'), { [option]: true, aspect: true, fragmentedDuration: 'header', limits: { maxMs: 300 } });
      expect(r.errorCode).toBe('no-duration');
      expect(r.warnings).toContainEqual(expect.stringMatching(/^(codec configuration not read|color and aspect not applied): limit reached: maxMs 300$/));
      expect(r.videoTracks).toHaveLength(1);
      expect(r.videoTracks[0]).not.toHaveProperty('codecConfig');
    });

    test(`${label} rejects with the reason of the caller's abort`, async () => {
      const analyzeHeader = await headerWithStalled(module);
      const blob = await fixture('hdr10_hevc10.mp4');
      const controller = new AbortController();
      const reason = new Error('stop');
      setTimeout(() => controller.abort(reason), 100);
      const t0 = performance.now();
      await expect(analyzeHeader(blob, { [option]: true, aspect: true, signal: controller.signal, limits: { maxMs: Infinity } })).rejects.toBe(reason);
      expect(performance.now() - t0).toBeLessThan(2000);
    });
  }
});
