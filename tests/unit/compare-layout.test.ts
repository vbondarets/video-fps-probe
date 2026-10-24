import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanMatroskaLayout } from '../../scripts/compare/layout.ts';
import { fixturePath } from '../helpers/fixtures.ts';

async function videoTracks(name: string) {
  const path = fixturePath(name);
  if (!path) throw new Error(`${name} is missing`);
  const layout = await scanMatroskaLayout(path, statSync(path).size);
  return layout?.matroskaTracks?.filter((t) => t.type === 1) ?? null;
}

describe('Matroska layout scan of the compare harness', () => {
  it('reads the DefaultDuration of a sized WebM', async () => {
    expect(await videoTracks('vp9.webm')).toEqual([{ number: 1, type: 1, defaultDurationNs: 33366666, blockDurations: 0 }]);
  });

  it('finds no DefaultDuration where an EBML Void replaced it', async () => {
    expect(await videoTracks('vp9_no_defaultduration.webm')).toEqual([{ number: 1, type: 1, defaultDurationNs: null, blockDurations: 0 }]);
  });

  it('walks the unknown-size Segment and Clusters of a chunked recording', async () => {
    expect(await videoTracks('rec_chromium_vp8_sliced.webm')).toEqual([{ number: 1, type: 1, defaultDurationNs: null, blockDurations: 0 }]);
  });

  it('counts the BlockDuration of every BlockGroup', async () => {
    expect(await videoTracks('h264_vfr_remux.mkv')).toEqual([{ number: 1, type: 1, defaultDurationNs: 23076923, blockDurations: 260 }]);
  });

  it('returns null for a file that is not Matroska', async () => {
    const path = fixturePath('cfr_h264_30.mp4');
    expect(path).not.toBeNull();
    expect(await scanMatroskaLayout(path!, statSync(path!).size)).toBeNull();
  });
});
