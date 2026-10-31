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
