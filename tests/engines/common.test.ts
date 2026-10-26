import { describe, expect, it } from 'vitest';
import { analyzeTimeline } from '../../src/core/stats.ts';
import { emptyTrack } from '../../src/core/result.ts';
import { applyStats, approxRational, codecNameFromFourcc, errorMessage, ffprobeRotation, isAbort, newResult, printableWarnings } from '../../src/engines/common.ts';

describe('approxRational', () => {
  it('recovers common frame rates from doubles', () => {
    expect(approxRational(30000 / 1001)).toMatchObject({ num: 30000, den: 1001 });
    expect(approxRational(24000 / 1001)).toMatchObject({ num: 24000, den: 1001 });
    expect(approxRational(25)).toMatchObject({ num: 25, den: 1 });
    expect(approxRational(100 / 3)).toMatchObject({ num: 100, den: 3 });
    expect(approxRational(4200 / 149)).toMatchObject({ num: 4200, den: 149 });
  });

  it('rejects non-positive and non-finite values', () => {
    expect(approxRational(0)).toBeNull();
    expect(approxRational(-1)).toBeNull();
    expect(approxRational(Number.NaN)).toBeNull();
    expect(approxRational(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('ffprobeRotation', () => {
  const fixed = (v: number): number => Math.round(v * 65536);
  const matrix = (a: number, b: number, c: number, d: number): number[] => [fixed(a), fixed(b), 0, fixed(c), fixed(d), 0, 0, 0, 1 << 30];

  it('is zero for the identity matrix', () => {
    expect(ffprobeRotation(matrix(1, 0, 0, 1))).toBe(0);
  });

  it('follows the display matrix convention of ffprobe', () => {
    expect(ffprobeRotation(matrix(0, 1, -1, 0))).toBe(-90);
    expect(ffprobeRotation(matrix(0, -1, 1, 0))).toBe(90);
    expect(Math.abs(ffprobeRotation(matrix(-1, 0, 0, -1)))).toBe(180);
  });

  it('returns zero for a degenerate matrix', () => {
    expect(ffprobeRotation(matrix(0, 0, 0, 0))).toBe(0);
  });
});

describe('codecNameFromFourcc', () => {
  it('maps sample entries and Matroska ids to ffprobe names', () => {
    expect(codecNameFromFourcc('avc1')).toBe('h264');
    expect(codecNameFromFourcc('hev1')).toBe('hevc');
    expect(codecNameFromFourcc('apch')).toBe('prores');
    expect(codecNameFromFourcc('V_VP9')).toBe('vp9');
    expect(codecNameFromFourcc('zzzz ')).toBe('zzzz');
  });
});

describe('result helpers', () => {
  it('builds an empty result for an engine', () => {
    const r = newResult('a.mp4', 10, 'mp4box');
    expect(r).toMatchObject({ name: 'a.mp4', size: 10, engine: 'mp4box', container: 'unknown', error: null, videoTracks: [] });
    expect(r.io).toEqual({ reads: 0, bytesRead: 0, ms: 0 });
  });

  it('copies timeline statistics into a track with provenance', () => {
    const stats = analyzeTimeline({ timescale: 1000, pts: [0, 33, 67, 100, 133, 167, 200, 233], lastDuration: 33 });
    const track = emptyTrack(1);
    applyStats(track, stats);
    expect(track.frames).toBe(8);
    expect(track.presentedFrames).toBe(8);
    expect(track.avgFpsFfprobe).toBe(track.avgFps ? `${track.avgFps.num}/${track.avgFps.den}` : null);
    expect(track.isVfr).toBe(false);
    expect(track.isStill).toBe(false);
    expect(track.provenance.minFps).toBe('exact');
  });

  it('replaces NUL and other control characters in the file and track warnings, and keeps other text', () => {
    const r = newResult('a.webm', 10, 'mediabunny');
    const track = emptyTrack(1);
    track.warnings.push('codec V_\u0007X', 'tag \u00a9day \u4e2d\u6587');
    r.videoTracks.push(track);
    r.warnings.push('mediabunny log: box \u0000\u0001ab\u007f\u0085');
    printableWarnings(r);
    expect(r.warnings).toEqual(['mediabunny log: box ??ab??']);
    expect(r.videoTracks[0].warnings).toEqual(['codec V_?X', 'tag \u00a9day \u4e2d\u6587']);
  });

  it('marks single-sample tracks as stills', () => {
    const track = emptyTrack(1);
    applyStats(track, analyzeTimeline({ timescale: 1000, pts: [0], lastDuration: 40 }));
    expect(track.isStill).toBe(true);
  });

  it('detects aborts and formats errors', () => {
    const controller = new AbortController();
    expect(isAbort(new Error('x'), controller.signal)).toBe(false);
    controller.abort();
    expect(isAbort(new Error('x'), controller.signal)).toBe(true);
    expect(isAbort({ name: 'AbortError' }, null)).toBe(true);
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});
