import { describe, expect, it } from 'vitest';
import {
  analyzeTimeline,
  reorderDepthFromCts,
  snapToStandardRate,
  type TimelineSegment,
  type TimelineStats,
} from '../../src/core/stats.ts';
import { rateProfile } from '../../src/core/segments.ts';

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

function comparable(s: TimelineStats) {
  const { fastPath: _f, warnings: _w, profile, ...rest } = s;
  return { ...rest, profile: profile?.(rateProfile) ?? null };
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
    expect(s.warnings.join(' ')).toMatch(/exceed the limit of 5000000/);
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

describe('analyzeTimeline: millisecond-grid timestamps at a fine timescale', () => {
  const remux = (fps: number, frames: number, timescale: number): TimelineSegment => {
    const pts = Array.from({ length: frames + 1 }, (_, i) => Math.round((i * 1000) / fps) * (timescale / 1000));
    return { durations: pts.slice(1).map((p, i) => p - pts[i]) };
  };

  it('treats a 120 fps MKV-to-MP4 remux at timescale 16000 (8/9 ms) as quantized CFR', () => {
    const s = analyzeTimeline({ timescale: 16000, segments: [remux(120, 360, 16000)] });
    expect(s.isVfr).toBe(false);
    expect(s.timestampsQuantized).toBe(true);
    expect(s.tolerance).toBe(16);
    expect(s.dominantFps).toBeNull();
    expect(rat(s.nominalFps)).toBe('120/1');
    expect(s.nominalFps?.kind).toBe('snapped');
    expect(s.profile).toBeNull();
  });

  it('snaps NTSC rates on a 1 ms grid to the 1001 rationals', () => {
    for (const [fps, want] of [[60000 / 1001, '60000/1001'], [24000 / 1001, '24000/1001'], [30000 / 1001, '30000/1001'], [240, '240/1']] as const) {
      const s = analyzeTimeline({ timescale: 16000, segments: [remux(fps, 300, 16000)] });
      expect(s.isVfr, want).toBe(false);
      expect(rat(s.nominalFps), want).toBe(want);
    }
  });

  it('keeps a real 1 ms jump VFR when the deltas are not on a millisecond grid', () => {
    const s = analyzeTimeline({ timescale: 90000, segments: [runs([50, 3000], [50, 3090])] });
    expect(s.isVfr).toBe(true);
    expect(s.timestampsQuantized).toBe(false);
  });

  it('keeps a freeze VFR on a millisecond grid', () => {
    const s = analyzeTimeline({ timescale: 16000, segments: [runs([30, 528], [1, 16000], [30, 544])] });
    expect(s.isVfr).toBe(true);
    expect(s.profile).not.toBeNull();
  });
});

describe('analyzeTimeline: Matroska TimestampScale that does not divide 1e9', () => {
  it('keeps min and max as exact rationals of 1e9 / (delta x TimestampScale)', () => {
    const s = analyzeTimeline({ timescale: 1e9 / 333333, pts: roundedPts(90, 100), tickQuantized: true });
    expect(rat(s.minFps)).toBe('10000000/333333');
    expect(rat(s.maxFps)).toBe('10000000/333333');
    expect(rat(s.avgFps)).toBe('10000000/333333');
    const ntsc = analyzeTimeline({ timescale: 1e9 / 41708333, pts: roundedPts(48, 1), tickQuantized: true });
    expect(rat(ntsc.minFps)).toBe('1000000000/41708333');
  });
});

describe('analyzeTimeline: presented average', () => {
  it('equals presented frames over the presentation span when an edit window trims VFR samples', () => {
    const seg = runs([20, 18000], [800, 450]);
    const s = analyzeTimeline({ timescale: 90000, segments: [seg], editWindow: { start: 18000 * 5, end: 18000 * 20 + 450 * 800 } });
    expect(rat(s.avgFps)).toBe('205/2');
    expect(s.presentedFrames).toBe(815);
    expect(rat(s.presentedAvgFps)).toBe('815/7');
  });

  it('follows decode time gaps between fragments instead of the duration sum', () => {
    const s = analyzeTimeline({
      timescale: 15360,
      segments: [
        { baseDts: 0, durations: runs([60, 512]).durations },
        { baseDts: 90 * 512, durations: runs([90, 512]).durations },
      ],
    });
    expect(rat(s.avgFps)).toBe('30/1');
    expect(rat(s.presentedAvgFps)).toBe('25/1');
  });

  it('uses the stored duration of the last presented sample, or the median when it is zero', () => {
    const held = analyzeTimeline({ timescale: 15360, segments: [runs([149, 512], [1, 30720])] });
    expect(rat(held.presentedAvgFps)).toBe(rat(held.avgFps));
    const zero = analyzeTimeline({ timescale: 15360, segments: [runs([149, 512], [1, 0])] });
    expect(rat(zero.avgFps)).not.toBe('30/1');
    expect(rat(zero.presentedAvgFps)).toBe('30/1');
  });

  it('warns when the stored duration of the last frame is a long hold (screen recordings)', () => {
    const held = analyzeTimeline({ timescale: 15360, segments: [runs([149, 512], [1, 30720])] });
    expect(held.isVfr).toBe(false);
    expect(held.warnings.join(' ')).toMatch(/last frame held 2\.000 s \(60\.0x the median frame interval\)/);
    const block = analyzeTimeline({ timescale: 1000, pts: roundedPts(100, 40), lastDuration: 2000, tickQuantized: true });
    expect(block.warnings.join(' ')).toMatch(/last frame held 2\.000 s/);
    const normal = analyzeTimeline({ timescale: 15360, segments: [runs([150, 512])] });
    expect(normal.warnings.join(' ')).not.toMatch(/last frame held/);
    const short = analyzeTimeline({ timescale: 1000, pts: roundedPts(100, 40), lastDuration: 200 });
    expect(short.warnings.join(' ')).not.toMatch(/last frame held/);
  });

  it('snaps 240 fps at timescale 600 (deltas 3 and 2) from the kept deltas, not the odd last tick', () => {
    const s = analyzeTimeline({ timescale: 600, segments: [{ durations: [...Array.from({ length: 479 }, (_, i) => (i % 2 ? 2 : 3)), 3] }] });
    expect(s.isVfr).toBe(false);
    expect(rat(s.nominalFps)).toBe('240/1');
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
