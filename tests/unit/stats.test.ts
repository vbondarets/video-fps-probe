import { describe, expect, it } from 'vitest';
import {
  analyzeTimeline,
  reorderDepthFromCts,
  snapToStandardRate,
  type TimelineSegment,
  type TimelineStats,
} from '../../src/core/stats.ts';

function runs(...pairs: Array<[count: number, delta: number]>): TimelineSegment {
  return { durations: { counts: pairs.map((p) => p[0]), deltas: pairs.map((p) => p[1]) } };
}

function roundedPts(n: number, period: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(i * period));
}

function durationsFromPts(pts: number[], last: number): number[] {
  return pts.map((p, i) => (i + 1 < pts.length ? pts[i + 1] - p : last));
}

function rat(r: { num: number; den: number } | null): string | null {
  return r ? `${r.num}/${r.den}` : null;
}

function comparable(s: TimelineStats): Omit<TimelineStats, 'fastPath' | 'warnings'> {
  const { fastPath: _f, warnings: _w, ...rest } = s;
  return rest;
}

describe('analyzeTimeline: CFR', () => {
  it('30 fps at timescale 15360 is exact CFR on the run-length fast path', () => {
    const s = analyzeTimeline({ timescale: 15360, segments: [runs([90, 512])] });
    expect(s.fastPath).toBe(true);
    expect(s.sampleCount).toBe(90);
    expect(s.durationSum).toBe(90 * 512);
    expect(s.avgFpsString).toBe('30/1');
    expect(s.presentedFrames).toBe(90);
    expect(s.deltaCount).toBe(88);
    expect(s.excludedTailDeltas).toBe(1);
    expect(s.isVfr).toBe(false);
    expect(s.vfrRatio).toBe(0);
    expect(rat(s.minFps)).toBe('30/1');
    expect(rat(s.maxFps)).toBe('30/1');
    expect(s.nominalFps).toMatchObject({ num: 30, den: 1, kind: 'exact' });
    expect(s.dominantFps).toBeNull();
    expect(s.duplicateTimestamps).toBe(0);
  });

  it('29.97 fps at timescale 1000 with {33, 34} jitter is not VFR', () => {
    const pts = roundedPts(90, 1000 / (30000 / 1001));
    const durations = durationsFromPts(pts, 33);
    const s = analyzeTimeline({ timescale: 1000, segments: [{ durations }] });
    expect(s.histogram.map(([d]) => d)).toEqual([33, 34]);
    expect(s.tolerance).toBe(1);
    expect(s.isVfr).toBe(false);
    expect(rat(s.minFps)).toBe('500/17');
    expect(rat(s.maxFps)).toBe('1000/33');
    expect(s.avgFpsString).toBe('30000/1001');
    expect(s.nominalFps).toMatchObject({ num: 30000, den: 1001, kind: 'snapped' });
  });

  it('a 2-tick spread at timescale 1000 is VFR', () => {
    const durations = Array.from({ length: 60 }, (_, i) => (i % 2 ? 35 : 33));
    const s = analyzeTimeline({ timescale: 1000, segments: [{ durations }] });
    expect(s.isVfr).toBe(true);
  });

  it('23.976 fps at 90 kHz with {3753, 3754} is not VFR and snaps to 24000/1001', () => {
    const pts = roundedPts(72, 90000 / (24000 / 1001));
    const durations = durationsFromPts(pts, 3754);
    const s = analyzeTimeline({ timescale: 90000, segments: [{ durations }] });
    expect(s.histogram.map(([d]) => d)).toEqual([3753, 3754]);
    expect(s.isVfr).toBe(false);
    expect(s.nominalFps).toMatchObject({ num: 24000, den: 1001, kind: 'snapped' });
  });

  it('handles 60 million samples in one stts run without expansion', () => {
    const s = analyzeTimeline({ timescale: 60000, segments: [runs([60_000_000, 1001])] });
    expect(s.fastPath).toBe(true);
    expect(s.avgFpsString).toBe('60000/1001');
    expect(s.presentedFrames).toBe(60_000_000);
    expect(s.isVfr).toBe(false);
    expect(s.nominalFps).toMatchObject({ num: 60000, den: 1001, kind: 'exact' });
  });
});

describe('analyzeTimeline: VFR', () => {
  it('concat 10/30/60 fps at 90 kHz: avg 100/3, range 10..60, dominant 60', () => {
    const s = analyzeTimeline({ timescale: 90000, segments: [runs([20, 9000], [60, 3000], [120, 1500])] });
    expect(s.avgFpsString).toBe('100/3');
    expect(s.isVfr).toBe(true);
    expect(rat(s.minFps)).toBe('10/1');
    expect(rat(s.maxFps)).toBe('60/1');
    expect(s.histogram).toEqual([
      [1500, 118],
      [3000, 60],
      [9000, 20],
    ]);
    expect(s.medianDelta).toBe(1500);
    expect(s.vfrRatio).toBeCloseTo(80 / 198, 12);
    expect(s.nominalFps).toBeNull();
    expect(rat(s.dominantFps?.rate ?? null)).toBe('60/1');
    expect(s.dominantFps?.share).toBeCloseTo(118 / 198, 12);
  });

  it('VFR without a majority delta has no dominant rate', () => {
    const s = analyzeTimeline({ timescale: 90000, segments: [runs([30, 3000], [30, 4500], [30, 1500])] });
    expect(s.isVfr).toBe(true);
    expect(s.dominantFps).toBeNull();
    expect(s.nominalFps).toBeNull();
  });
});

describe('analyzeTimeline: duplicates', () => {
  it('counts and excludes non-positive PTS deltas', () => {
    const s = analyzeTimeline({ timescale: 1000, pts: [0, 33, 33, 67, 100, 133, 167, 200] });
    expect(s.duplicateTimestamps).toBe(1);
    expect(s.histogram).toEqual([
      [33, 3],
      [34, 2],
    ]);
    expect(s.isVfr).toBe(false);
  });

  it('counts zero stts deltas as duplicates on the fast path', () => {
    const s = analyzeTimeline({ timescale: 30000, segments: [runs([10, 1001], [2, 0], [20, 1001])] });
    expect(s.fastPath).toBe(true);
    expect(s.duplicateTimestamps).toBe(2);
    expect(s.histogram).toEqual([[1001, 28]]);
    expect(s.isVfr).toBe(false);
  });
});

describe('analyzeTimeline: B-frame tail exclusion', () => {
  function pyramidCut(groups: number): { durations: number[]; cts: number[] } {
    const display = [0];
    for (let g = 1; g <= groups; g++) display.push(4 * g, 4 * g - 2, 4 * g - 3, 4 * g - 1);
    const g = groups + 1;
    display.push(4 * g, 4 * g - 2);
    const shift = -Math.min(...display.map((d, k) => d - k));
    return {
      durations: display.map(() => 1001),
      cts: display.map((d, k) => (d - k + shift) * 1001),
    };
  }

  it('a stream-copy cut that drops trailing B-frames is not reported as VFR', () => {
    const { durations, cts } = pyramidCut(22);
    const s = analyzeTimeline({ timescale: 30000, segments: [{ durations, cts }] });
    expect(s.fastPath).toBe(false);
    expect(s.reorderDepth).toBe(5);
    expect(s.excludedTailDeltas).toBe(6);
    expect(s.isVfr).toBe(false);
    expect(s.nominalFps).toMatchObject({ num: 30000, den: 1001, kind: 'exact' });
  });

  it('the same cut reads as VFR without the reorder-depth tail', () => {
    const { durations, cts } = pyramidCut(22);
    const s = analyzeTimeline({ timescale: 30000, segments: [{ durations, cts }], reorderDepth: 0 });
    expect(s.isVfr).toBe(true);
  });

  it('reorderDepthFromCts is capped at 16 and 0 without a range', () => {
    expect(reorderDepthFromCts(0, 3003, 1001)).toBe(3);
    expect(reorderDepthFromCts(0, 3004, 1001)).toBe(4);
    expect(reorderDepthFromCts(0, 1e9, 1001)).toBe(16);
    expect(reorderDepthFromCts(5, 5, 1001)).toBe(0);
    expect(reorderDepthFromCts(0, 3003, 0)).toBe(0);
  });
});

describe('analyzeTimeline: Matroska 1 ms quantization', () => {
  it('29.97 fps shows 29.41..30.30 and stays CFR', () => {
    const pts = roundedPts(90, 1000 / (30000 / 1001));
    const s = analyzeTimeline({ timescale: 1000, pts, lastDuration: 33, tickQuantized: true });
    expect(s.isVfr).toBe(false);
    expect(s.timestampsQuantized).toBe(true);
    expect(s.minFps?.value).toBeCloseTo(29.41, 2);
    expect(s.maxFps?.value).toBeCloseTo(30.3, 2);
    expect(s.durationSum).toBe(3003);
    expect(s.avgFpsString).toBe('30000/1001');
    expect(s.nominalFps).toMatchObject({ num: 30000, den: 1001, kind: 'snapped' });
  });

  it('240 fps shows 200..250 and stays CFR', () => {
    const pts = roundedPts(720, 1000 / 240);
    const s = analyzeTimeline({ timescale: 1000, pts, lastDuration: 4, tickQuantized: true });
    expect(s.isVfr).toBe(false);
    expect(rat(s.minFps)).toBe('200/1');
    expect(rat(s.maxFps)).toBe('250/1');
    expect(s.avgFpsString).toBe('240/1');
    expect(s.timestampsQuantized).toBe(true);
  });

  it('only flags quantization when asked', () => {
    const pts = roundedPts(90, 1000 / (30000 / 1001));
    expect(analyzeTimeline({ timescale: 1000, pts }).timestampsQuantized).toBe(false);
  });

  it('uses the median delta as the last duration when none is given', () => {
    const s = analyzeTimeline({ timescale: 1000, pts: roundedPts(30, 40) });
    expect(s.durationSum).toBe(29 * 40 + 40);
    expect(s.avgFpsString).toBe('25/1');
  });

  it('sorts out-of-order block timestamps and derives a reorder depth', () => {
    const pts = [0, 120, 40, 80, 240, 160, 200, 360, 280, 320, 480, 400, 440];
    const s = analyzeTimeline({ timescale: 1000, pts, lastDuration: 40 });
    expect(s.reorderDepth).toBe(2);
    expect(s.isVfr).toBe(false);
    expect(s.firstPts).toBe(0);
    expect(s.lastPts).toBe(480);
  });
});

describe('analyzeTimeline: edit windows, fragments, limits', () => {
  it('counts presented frames inside the edit window', () => {
    const s = analyzeTimeline({ timescale: 30000, segments: [runs([90, 1001])], editWindow: { start: 21 * 1001, end: Infinity } });
    expect(s.fastPath).toBe(true);
    expect(s.sampleCount).toBe(90);
    expect(s.presentedFrames).toBe(69);
    expect(s.firstPts).toBe(21 * 1001);
    expect(s.avgFpsString).toBe('30000/1001');
  });

  it('applies a constant composition offset before the window', () => {
    const seg: TimelineSegment = { ...runs([90, 1001]), cts: { counts: [90], offsets: [2002] } };
    const s = analyzeTimeline({ timescale: 30000, segments: [seg], editWindow: { start: 2002, end: 2002 + 60 * 1001 } });
    expect(s.fastPath).toBe(true);
    expect(s.presentedFrames).toBe(60);
    expect(s.firstPts).toBe(2002);
    expect(s.lastPts).toBe(2002 + 59 * 1001);
  });

  it('matches the expanded path on the fast-path inputs', () => {
    const inputs = [
      { timescale: 15360, segments: [runs([90, 512])] },
      { timescale: 90000, segments: [runs([20, 9000], [60, 3000], [120, 1500])] },
      { timescale: 30000, segments: [runs([10, 1001], [2, 0], [20, 1001])] },
      { timescale: 30000, segments: [runs([90, 1001])], editWindow: { start: 21 * 1001, end: 70 * 1001 } },
      { timescale: 30000, segments: [runs([5, 1001]), { baseDts: 5 * 1001, durations: [1001, 1001, 2002] }, runs([40, 1001])] },
      { timescale: 1000, segments: [{ durations: durationsFromPts(roundedPts(90, 33.3667), 33) }] },
      { timescale: 30000, segments: [runs([1, 1001])] },
      { timescale: 30000, segments: [runs([3, 1001])] },
    ];
    for (const input of inputs) {
      const fast = analyzeTimeline(input);
      const slow = analyzeTimeline({ ...input, forceExpand: true });
      expect(fast.fastPath).toBe(true);
      expect(slow.fastPath).toBe(false);
      expect(comparable(fast)).toEqual(comparable(slow));
    }
  });

  it('merges fragments and reports a tfdt discontinuity', () => {
    const s = analyzeTimeline({
      timescale: 30000,
      segments: [
        { baseDts: 0, durations: { counts: [30], deltas: [1001] } },
        { baseDts: 30 * 1001, durations: { counts: [30], deltas: [1001] } },
        { baseDts: 70 * 1001, durations: { counts: [30], deltas: [1001] } },
      ],
    });
    expect(s.fastPath).toBe(false);
    expect(s.discontinuities).toBe(1);
    expect(s.sampleCount).toBe(90);
    expect(s.isVfr).toBe(true);
    expect(rat(s.minFps)).toBe('30000/11011');
    expect(s.warnings.join(' ')).toMatch(/discontinuit/);
  });

  it('refuses per-sample expansion above the limit and keeps the average', () => {
    const seg: TimelineSegment = { ...runs([60_000_000, 1]), cts: { counts: [30_000_000, 30_000_000], offsets: [0, 1] } };
    const s = analyzeTimeline({ timescale: 1, segments: [seg] });
    expect(s.avgFpsString).toBe('1/1');
    expect(s.presentedFrames).toBeNull();
    expect(s.isVfr).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/exceed the limit of 50000000/);
  });

  it('honours a custom expansion limit', () => {
    const seg: TimelineSegment = { durations: new Array(20).fill(1001), cts: Array.from({ length: 20 }, (_, i) => (i % 2) * 1001) };
    const s = analyzeTimeline({ timescale: 30000, segments: [seg], maxExpandedSamples: 10 });
    expect(s.isVfr).toBeNull();
    expect(s.warnings.length).toBe(1);
  });

  it('a single frame has an average but no instantaneous range', () => {
    const s = analyzeTimeline({ timescale: 30000, segments: [runs([1, 1001])] });
    expect(s.avgFpsString).toBe('30000/1001');
    expect(s.presentedFrames).toBe(1);
    expect(s.isVfr).toBeNull();
    expect(s.minFps).toBeNull();
    expect(s.maxFps).toBeNull();
    expect(s.nominalFps).toBeNull();
  });

  it('an empty timeline gives 0/0', () => {
    const s = analyzeTimeline({ timescale: 30000, segments: [] });
    expect(s.avgFps).toBeNull();
    expect(s.avgFpsString).toBe('0/0');
    expect(s.presentedFrames).toBe(0);
    expect(analyzeTimeline({ timescale: 1000, pts: [] }).avgFpsString).toBe('0/0');
  });

  it('replaces an invalid timescale with 1', () => {
    const s = analyzeTimeline({ timescale: 0, segments: [runs([10, 1])] });
    expect(s.timescale).toBe(1);
    expect(s.avgFpsString).toBe('1/1');
    expect(s.warnings[0]).toMatch(/invalid timescale/);
  });
});

describe('snapToStandardRate', () => {
  it.each([
    [29.97002997, '30000/1001'],
    [23.976, '24000/1001'],
    [59.94, '60000/1001'],
    [25.01, '25/1'],
    [119.88, '120000/1001'],
    [7, '7/1'],
  ])('%f snaps to %s', (fps, expected) => {
    expect(rat(snapToStandardRate(fps))).toBe(expected);
  });

  it.each([25.1, 0, -5, 300, 33.33])('%f does not snap', (fps) => {
    expect(snapToStandardRate(fps)).toBeNull();
  });
});
