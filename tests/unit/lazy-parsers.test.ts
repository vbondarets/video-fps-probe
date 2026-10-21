import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';

const loads = vi.hoisted(() => ({ isobmff: 0, matroska: 0 }));

vi.mock('../../src/core/isobmff/index.ts', async (importOriginal) => {
  loads.isobmff++;
  return importOriginal();
});

vi.mock('../../src/core/matroska/index.ts', async (importOriginal) => {
  loads.matroska++;
  return importOriginal();
});

import { analyze } from '../../src/core/analyze.ts';

const MP4 = join(FILES_DIR, 'cfr_h264_30.mp4');
const WEBM = join(FILES_DIR, 'cfr_vp9_30.webm');

describe('lazy container parsers', () => {
  it('loads no parser when the analyze module is imported', () => {
    expect(loads).toEqual({ isobmff: 0, matroska: 0 });
  });

  it('loads no parser for files that are not a known container', async () => {
    const r = await analyze(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])]), 'a.mp4');
    expect(r.error).toMatch(/not a recognised container/);
    expect(loads).toEqual({ isobmff: 0, matroska: 0 });
  });

  it('loads only the ISO BMFF parser for an MP4 and loads it once', async () => {
    const concurrent = await Promise.all([1, 2, 3].map((n) => withFixture(MP4, (blob) => analyze(blob, `${n}.mp4`))));
    expect(loads).toEqual({ isobmff: 1, matroska: 0 });
    for (const r of concurrent) {
      expect(r.error).toBeNull();
      expect(r.container).toBe('mp4');
      expect(r.videoTracks[0].avgFps?.value).toBeCloseTo(30, 6);
    }
    const later = await withFixture(MP4, (blob) => analyze(blob, 'later.mp4'));
    expect(later.videoTracks[0].frames).toBe(concurrent[0].videoTracks[0].frames);
    expect(loads).toEqual({ isobmff: 1, matroska: 0 });
  });

  it('loads the Matroska parser on the first WebM and loads it once', async () => {
    const first = await withFixture(WEBM, (blob) => analyze(blob, 'a.webm'));
    expect(first.error).toBeNull();
    expect(first.container).toBe('webm');
    expect(first.videoTracks[0].avgFps?.value).toBeCloseTo(30, 6);
    await withFixture(WEBM, (blob) => analyze(blob, 'b.webm'));
    expect(loads).toEqual({ isobmff: 1, matroska: 1 });
  });
});
