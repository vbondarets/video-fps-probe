import { describe, expect, test } from 'vitest';
import { errorCodeOf } from '../../src/api/codes.ts';
import { primaryTrack } from '../../src/core/result.ts';
import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import { ownResultOf } from '../../scripts/own-snapshot.ts';

function usableVideoTrack(result: FileResult): VideoTrackResult | null {
  if (errorCodeOf(result) !== null) return null;
  const t = primaryTrack(result);
  return t && !t.isStill && t.enabled !== false ? t : null;
}

describe('no usable video track, from errorCode, primaryTrackId, isStill and enabled', () => {
  test('edge_single_frame.mp4: the primary track is a single frame, so isStill rejects it', async () => {
    const r = await ownResultOf('edge_single_frame.mp4');
    expect(r.errorCode).toBeNull();
    expect(r.primaryTrackId).toBe(1);
    expect(primaryTrack(r)).toMatchObject({ frames: 1, isStill: true, enabled: true });
    expect(usableVideoTrack(r)).toBeNull();
  });

  test('still_image_track_first.mp4: the still track comes first, isStill marks it, and the primary track is the moving one', async () => {
    const r = await ownResultOf('still_image_track_first.mp4');
    expect(r.errorCode).toBeNull();
    expect(r.videoTracks.map((t) => [t.trackId, t.frames, t.isStill, t.enabled])).toEqual([
      [1, 1, true, true],
      [2, 90, false, true],
    ]);
    expect(usableVideoTrack(r)?.trackId).toBe(2);
    expect(usableVideoTrack({ ...r, primaryTrackId: 1 })).toBeNull();
  });

  test('track_disabled.mp4: the only video track has the tkhd enabled bit clear, so enabled rejects it', async () => {
    const r = await ownResultOf('track_disabled.mp4');
    expect(r.errorCode).toBeNull();
    expect(r.primaryTrackId).toBe(1);
    expect(primaryTrack(r)).toMatchObject({ frames: 30, isStill: false, enabled: false });
    expect(usableVideoTrack(r)).toBeNull();
  });

  test('an ordinary MP4 and WebM have a usable track, and a failed file has none', async () => {
    expect(usableVideoTrack(await ownResultOf('cfr_h264_30.mp4'))?.enabled).toBe(true);
    expect(usableVideoTrack(await ownResultOf('cfr_vp9_30.webm'))?.enabled).toBe(true);
    const failed = await ownResultOf('corrupt_trunc_no_moov.mp4');
    expect(failed.errorCode).toBe('no-header');
    expect(usableVideoTrack(failed)).toBeNull();
  });
});
