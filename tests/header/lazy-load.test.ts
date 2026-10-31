import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { warningCodesOf } from '../../src/api/codes.ts';
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
  test('the codec configuration capture keeps the result and adds codec-config-unavailable', async () => {
    const analyzeHeader = await headerWithFailing(CAPTURE);
    const blob = await fixture('hdr10_hevc10.mp4');
    const plain = await analyzeHeader(blob);
    for (const option of ['codecConfig', 'color', 'aspect'] as const) {
      const r = await analyzeHeader(blob, { [option]: true });
      expect(r.errorCode, option).toBeNull();
      expect(r.error, option).toBeNull();
      expect(r.videoTracks, option).toEqual(plain.videoTracks);
      expect(r.warnings, option).toEqual([...plain.warnings, expect.stringMatching(/^codec configuration unavailable: ./)]);
      expect(warningCodesOf(r), option).toEqual(['codec-config-unavailable']);
    }
  });

  test('the capture keeps an earlier error and adds the load failure as a warning', async () => {
    const analyzeHeader = await headerWithFailing(CAPTURE);
    const r = await analyzeHeader(await fixture('fmp4_missing_fragment.mp4'), { color: true });
    expect(r.errorCode).toBe('no-duration');
    expect(r.warnings).toContainEqual(expect.stringMatching(/^codec configuration unavailable: ./));
    expect(r.videoTracks).toHaveLength(1);
  });

  test('the color and aspect chunk keeps the result, drops the bytes unless asked for and adds metadata-unavailable', async () => {
    const analyzeHeader = await headerWithFailing(METADATA);
    const blob = await fixture('hdr10_hevc10.mp4');
    const r = await analyzeHeader(blob, { color: true, aspect: true });
    expect(r.errorCode).toBeNull();
    expect(r.error).toBeNull();
    expect(warningCodesOf(r)).toEqual(['metadata-unavailable']);
    expect(r.videoTracks).toHaveLength(1);
    expect(r.videoTracks[0]).not.toHaveProperty('codecConfig');
    expect(r.videoTracks[0].color).toBeUndefined();
    expect((await analyzeHeader(blob, { color: true, codecConfig: true })).videoTracks[0].codecConfig?.family).toBe('isobmff');
    const limited = await analyzeHeader(await fixture('fmp4_missing_fragment.mp4'), { aspect: true });
    expect(limited.errorCode).toBe('no-duration');
    expect(limited.warnings).toContainEqual(expect.stringMatching(/^color and aspect unavailable: ./));
    expect(limited.videoTracks[0]).not.toHaveProperty('codecConfig');
  });
});

describe('a lazy chunk of the header entry that never loads', () => {
  for (const [label, module, option] of [
    ['the codec configuration capture', CAPTURE, 'codecConfig'],
    ['the color and aspect chunk', METADATA, 'color'],
  ] as const) {
    test(`${label} settles at maxMs with a coded warning and keeps the result`, async () => {
      const analyzeHeader = await headerWithStalled(module);
      const blob = await fixture('hdr10_hevc10.mp4');
      const plain = await analyzeHeader(blob);
      const t0 = performance.now();
      const r = await analyzeHeader(blob, { [option]: true, aspect: true, limits: { maxMs: 300 } });
      const ms = performance.now() - t0;
      expect(r.errorCode).toBeNull();
      expect(r.error).toBeNull();
      expect(r.videoTracks).toEqual(plain.videoTracks);
      expect(r.warnings).toEqual([...plain.warnings, expect.stringMatching(/^(codec configuration|color and aspect) unavailable: limit reached: maxMs 300$/)]);
      expect(warningCodesOf(r)).toEqual([module === CAPTURE ? 'codec-config-unavailable' : 'metadata-unavailable']);
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThan(2000);
    });

    test(`${label} keeps an earlier error and adds the deadline as a warning`, async () => {
      const analyzeHeader = await headerWithStalled(module);
      const r = await analyzeHeader(await fixture('fmp4_missing_fragment.mp4'), { [option]: true, aspect: true, fragmentedDuration: 'header', limits: { maxMs: 300 } });
      expect(r.errorCode).toBe('no-duration');
      expect(r.warnings).toContainEqual(expect.stringMatching(/^(codec configuration|color and aspect) unavailable: limit reached: maxMs 300$/));
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

function stalledAfter(blob: Blob, reads: number) {
  let n = 0;
  return { size: blob.size, slice: (start: number, end: number) => ({ arrayBuffer: () => (++n > reads ? new Promise<ArrayBuffer>(() => {}) : blob.slice(start, end).arrayBuffer()) }) };
}

async function freshHeader() {
  vi.resetModules();
  return (await import('../../src/header/index.ts')).analyzeHeader;
}

const ASPECT_FIELDS = ['sampleAspectRatio', 'displayAspectRatio', 'displayWidth', 'displayHeight'] as const;

function withoutMetadata(track: Record<string, unknown>) {
  const rest = { ...track };
  for (const key of ['codecConfig', 'color', ...ASPECT_FIELDS]) delete rest[key];
  return rest;
}

const fileFields = (r: { errorCode?: unknown; error: unknown; formatDurationSec: unknown; warnings: unknown }) => ({ errorCode: r.errorCode, error: r.error, formatDurationSec: r.formatDurationSec, warnings: r.warnings });

describe('a lazy chunk of the header entry after a deadline that the walk tolerated', () => {
  const LATE = { limits: { maxMs: 200 } };

  for (const name of ['fmp4_mehd_valid.mp4', 'fmp4_global_sidx.mp4', 'fmp4_frag_duration.mp4']) {
    test(`an already loaded color and aspect chunk is still applied to ${name}`, async () => {
      const analyzeHeader = await freshHeader();
      await analyzeHeader(await fixture('hdr10_hevc10.mp4'), { color: true, aspect: true });
      const blob = await fixture(name);
      const full = (await analyzeHeader(blob, { color: true, aspect: true })).videoTracks[0];
      const plain = await analyzeHeader(stalledAfter(blob, 1), LATE);
      if (name === 'fmp4_mehd_valid.mp4') expect(fileFields(plain)).toEqual({ errorCode: null, error: null, formatDurationSec: 4.004, warnings: ['fragment index not read: limit reached: maxMs 200'] });
      for (const options of [{ color: true }, { aspect: true }, { color: true, aspect: true }, { codecConfig: true, color: true }] as const) {
        const label = JSON.stringify(options);
        const r = await analyzeHeader(stalledAfter(blob, 1), { ...options, ...LATE });
        expect(fileFields(r), label).toEqual(fileFields(plain));
        const t = r.videoTracks[0];
        expect(withoutMetadata(t as unknown as Record<string, unknown>), label).toEqual(plain.videoTracks[0]);
        expect(t.color, label).toEqual('color' in options ? full.color : undefined);
        for (const key of ASPECT_FIELDS) expect(t[key], `${label} ${key}`).toEqual('aspect' in options ? full[key] : undefined);
        expect(t.codecConfig?.family, label).toBe('codecConfig' in options ? 'isobmff' : undefined);
      }
    });

    test(`a color and aspect chunk that has not loaded gives metadata-unavailable on ${name}`, async () => {
      const analyzeHeader = await headerWithStalled(METADATA);
      await analyzeHeader(await fixture('hdr10_hevc10.mp4'), { codecConfig: true });
      const blob = await fixture(name);
      const plain = await analyzeHeader(stalledAfter(blob, 1), LATE);
      const t0 = performance.now();
      const r = await analyzeHeader(stalledAfter(blob, 1), { color: true, aspect: true, ...LATE });
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(fileFields(r)).toEqual({ ...fileFields(plain), warnings: [...plain.warnings, 'color and aspect unavailable: limit reached: maxMs 200'] });
      expect(r.videoTracks).toEqual(plain.videoTracks);
      expect(warningCodesOf(r)).toContain('metadata-unavailable');
    });
  }

  const STALLED_WALK = { readAhead: { head: 1024 }, ...LATE };

  test('an already loaded codec configuration capture is still applied after the walk stalled', async () => {
    const analyzeHeader = await freshHeader();
    await analyzeHeader(await fixture('hdr10_hevc10.mp4'), { codecConfig: true });
    const blob = await fixture('fmp4_global_sidx.mp4');
    const expected = (await analyzeHeader(blob, { codecConfig: true })).videoTracks[0].codecConfig;
    const plain = await analyzeHeader(stalledAfter(blob, 1), STALLED_WALK);
    expect(plain.errorCode).toBe('time-limit');
    expect(plain.videoTracks).toHaveLength(1);
    const r = await analyzeHeader(stalledAfter(blob, 1), { codecConfig: true, ...STALLED_WALK });
    expect(fileFields(r)).toEqual(fileFields(plain));
    const { codecConfig, ...track } = r.videoTracks[0];
    expect(track).toEqual(plain.videoTracks[0]);
    expect(codecConfig).toEqual(expected);
  });

  for (const [label, module, first, options, name, expectedWarnings] of [
    ['codec configuration capture', CAPTURE, { codecConfig: true }, { codecConfig: true, ...STALLED_WALK }, 'fmp4_global_sidx.mp4', null],
    ['color and aspect chunk', METADATA, { color: true }, { color: true, ...LATE }, 'fmp4_mehd_valid.mp4', ['fragment index not read: limit reached: maxMs 200']],
  ] as const) {
    test(`a ${label} that lost its first race to the deadline is applied once it has loaded`, async () => {
      const blob = await fixture(name);
      const full = (await (await freshHeader())(blob, { codecConfig: true, color: true })).videoTracks[0];
      vi.resetModules();
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      vi.doMock(module, async (importOriginal) => {
        await gate;
        return importOriginal();
      });
      const { LimitedSource } = await import('../../src/header/limits.ts');
      const race = vi.spyOn(LimitedSource.prototype, 'race');
      const { analyzeHeader } = await import('../../src/header/index.ts');
      const lost = await analyzeHeader(await fixture('hdr10_hevc10.mp4'), { ...first, limits: { maxMs: 200 } });
      expect(lost.errorCode).toBeNull();
      expect(warningCodesOf(lost)).toEqual([module === CAPTURE ? 'codec-config-unavailable' : 'metadata-unavailable']);
      release();
      await import(module);
      await new Promise((r) => setTimeout(r, 0));
      const races = race.mock.calls.length;
      const r = await analyzeHeader(stalledAfter(blob, 1), options);
      expect(race.mock.calls.length, 'a loaded chunk is applied without a race').toBe(races);
      if (expectedWarnings) expect(r.warnings).toEqual(expectedWarnings);
      else expect(r.errorCode).toBe('time-limit');
      expect(warningCodesOf(r)).not.toContain(module === CAPTURE ? 'codec-config-unavailable' : 'metadata-unavailable');
      const t = r.videoTracks[0];
      if (module === CAPTURE) expect(t.codecConfig).toEqual(full.codecConfig);
      else expect(t.color).toEqual(full.color);
      race.mockRestore();
    });
  }

  test('a codec configuration capture that has not loaded after the walk stalled gives codec-config-unavailable', async () => {
    const blob = await fixture('fmp4_global_sidx.mp4');
    for (const option of ['codecConfig', 'color', 'aspect'] as const) {
      const analyzeHeader = await headerWithStalled(CAPTURE);
      const plain = await analyzeHeader(stalledAfter(blob, 1), STALLED_WALK);
      const t0 = performance.now();
      const r = await analyzeHeader(stalledAfter(blob, 1), { [option]: true, ...STALLED_WALK });
      expect(performance.now() - t0, option).toBeLessThan(1000);
      expect(fileFields(r), option).toEqual({ ...fileFields(plain), warnings: [...plain.warnings, 'codec configuration unavailable: limit reached: maxMs 200'] });
      expect(r.videoTracks, option).toEqual(plain.videoTracks);
      expect(warningCodesOf(r), option).toEqual(['codec-config-unavailable']);
    }
  });
});
