import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_ANOMALIES, MAX_BUCKETS, MAX_SEGMENTS, rateProfile, type DeltaSource } from '../../src/core/segments.ts';
import { analyzeTimeline, rateProfileOf, type TimelineInput, type TimelineSegment, type TimelineStats } from '../../src/core/stats.ts';
import type { RateProfile } from '../../src/core/types.ts';
import { clock, rate } from '../../src/ui/format.ts';

function runs(...pairs: Array<[count: number, delta: number]>): TimelineSegment {
  return { durations: { counts: pairs.map((p) => p[0]), deltas: pairs.map((p) => p[1]) } };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function prof(s: TimelineStats): RateProfile | null {
  return s.profile?.(rateProfile) ?? null;
}

function profileOf(input: TimelineInput): RateProfile {
  const p = prof(analyzeTimeline(input));
  expect(p).not.toBeNull();
  return p!;
}

function bothPaths(input: TimelineInput & { segments: readonly TimelineSegment[] }): RateProfile {
  const fast = analyzeTimeline(input);
  const slow = analyzeTimeline({ ...input, forceExpand: true });
  expect(fast.fastPath).toBe(true);
  expect(slow.fastPath).toBe(false);
  expect(prof(fast)).toEqual(prof(slow));
  expect(prof(fast)).not.toBeNull();
  return prof(fast)!;
}

function direct(timescale: number, ...pairs: Array<[count: number, delta: number]>): RateProfile {
  let deltas = 0;
  let span = 0;
  for (const [c, d] of pairs) {
    deltas += c;
    span += c * Math.max(0, d);
  }
  const p = rateProfile((visit) => pairs.forEach(([c, d]) => visit(c, d)), timescale, deltas + 1, span);
  expect(p).not.toBeNull();
  return p!;
}

function framesOf(p: RateProfile): number {
  return p.segments.reduce((n, s) => n + s.frames, 0);
}

function expectContiguous(p: RateProfile): void {
  expect(p.segments[0].startSec).toBe(0);
  for (let i = 1; i < p.segments.length; i++) expect(p.segments[i].startSec).toBeCloseTo(p.segments[i - 1].endSec, 12);
}

function jitteredPts(n: number, period: number, jitter: number, seed: number, from = 0): number[] {
  const rnd = lcg(seed);
  return Array.from({ length: n }, (_, i) => Math.round(from + i * period + rnd() * jitter));
}

function noise(seed: number, ms: number): Array<[number, number]> {
  const rnd = lcg(seed);
  const out: Array<[number, number]> = [];
  let total = 0;
  while (total < ms) {
    const d = out.length % 2 ? 20 : 100;
    const c = d === 100 ? 3 + Math.floor(rnd() * 2) : 10 + Math.floor(rnd() * 11);
    out.push([c, d]);
    total += c * d;
  }
  return out;
}

describe('rate profile: gate and lazy loading', () => {
  it('has no profile job when every interval is within the CUSUM drift of the shortest one', () => {
    expect(analyzeTimeline({ timescale: 15360, segments: [runs([90, 512])] }).profile).toBeNull();
    const ntsc = Array.from({ length: 300 }, (_, i) => Math.round((i * 1001) / 30));
    expect(analyzeTimeline({ timescale: 1000, pts: ntsc, tickQuantized: true }).profile).toBeNull();
    const film = Array.from({ length: 240 }, (_, i) => Math.round((i * 90000 * 1001) / 24000));
    expect(analyzeTimeline({ timescale: 90000, segments: [{ durations: film.map((x, i) => (i + 1 < film.length ? film[i + 1] - x : 3754)) }] }).profile).toBeNull();
    const order = [0];
    for (let g = 0; g < 29; g++) order.push(3 * g + 3, 3 * g + 1, 3 * g + 2);
    const bframes = analyzeTimeline({ timescale: 30000, segments: [{ durations: order.map(() => 1001), cts: order.map((p, i) => p * 1001 + 2002 - i * 1001) }] });
    expect(bframes.fastPath).toBe(false);
    expect(bframes.profile).toBeNull();
    expect(analyzeTimeline({ timescale: 31000, segments: [runs([90, 1033], [93, 1000])] }).profile).toBeNull();
  });

  it('the skipped profile would have been a single steady segment', () => {
    const p = direct(15360, [89, 512]);
    expect(p.segments).toEqual([{ startSec: 0, endSec: 3, frames: 90, fps: 30, kind: 'steady' }]);
    expect(p.anomalies).toEqual([]);
    expect(p.uneven).toBe(false);
    expect(p.dominantShare).toBe(1);
    expect(p.summary).toBe('Steady: 30 fps for 3 s');
    expect(p.buckets.fps).toHaveLength(45);
    for (const v of p.buckets.fps) expect(v).toBeCloseTo(30, 9);
    const q = direct(31000, [90, 1033], [92, 1000]);
    expect(q.segments).toHaveLength(1);
    expect(q.anomalies).toEqual([]);
  });

  it('rateProfileOf loads the segments module on demand and returns the same profile', async () => {
    expect(await rateProfileOf(null)).toBeNull();
    const s = analyzeTimeline({ timescale: 90000, segments: [runs([20, 18000], [800, 450])] });
    expect(s.profile).not.toBeNull();
    expect(await rateProfileOf(s.profile)).toEqual(prof(s));
  });

  it('keeps the segments module out of the worker entry: stats.ts imports it only dynamically', () => {
    const src = readFileSync(new URL('../../src/core/stats.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/import\('\.\/segments\.ts'\)/);
    expect(src).not.toMatch(/^import (?!type )[^;]*'\.\/segments\.ts'/m);
  });
});

describe('rate profile: steady input', () => {
  it('caps the sparkline at MAX_BUCKETS buckets that cover the whole span', () => {
    const p = direct(60, [35_999, 1]);
    expect(p.buckets.fps).toHaveLength(MAX_BUCKETS);
    expect(p.buckets.bucketSec * MAX_BUCKETS).toBeCloseTo(35_999 / 60, 9);
    for (const v of p.buckets.fps) expect(v).toBeCloseTo(60, 9);
  });

  it('29.97 fps quantized to 1 ms ticks is not segmented', () => {
    const pts = Array.from({ length: 300 }, (_, i) => Math.round((i * 1001) / 30));
    const p = rateProfile((visit) => pts.forEach((x, i) => i && visit(1, x - pts[i - 1])), 1000, 300, pts[299]);
    expect(p?.segments).toHaveLength(1);
    expect(p?.segments[0].kind).toBe('steady');
    expect(p?.segments[0].fps).toBeCloseTo(29.97, 2);
    expect(p?.anomalies).toEqual([]);
    expect(p?.uneven).toBe(false);
  });

  it('240 fps at 1 ms ticks ({4, 5} ms) is not segmented', () => {
    const pts = Array.from({ length: 720 }, (_, i) => Math.round((i * 1000) / 240));
    const p = profileOf({ timescale: 1000, pts });
    expect(p.segments).toHaveLength(1);
    expect(p.anomalies).toEqual([]);
  });

  it('screen-recorder jitter of 0-7 ms at timescale 1000 is not over-segmented', () => {
    for (const seed of [1, 2, 3, 42, 1234]) {
      const pts = jitteredPts(600, 1000 / 60, 7, seed);
      const p = profileOf({ timescale: 1000, pts });
      expect(p.segments, `seed ${seed}`).toHaveLength(1);
      expect(p.segments[0].kind).toBe('steady');
      expect(p.segments[0].fps).toBeCloseTo(60, 0);
      expect(p.anomalies).toEqual([]);
      expect(p.uneven).toBe(false);
    }
  });

  it('jittered 60 fps then jittered 30 fps still splits at the rate change', () => {
    const a = jitteredPts(300, 1000 / 60, 7, 7);
    const b = jitteredPts(150, 1000 / 30, 7, 8, 5000);
    const p = profileOf({ timescale: 1000, pts: [...a, ...b] });
    expect(p.segments.map((s) => Math.round(s.fps))).toEqual([60, 30]);
    expect(p.segments[1].startSec).toBeCloseTo(5, 1);
    expect(p.anomalies.map((x) => x.kind)).toEqual(['rate-change']);
  });
});

describe('rate profile: rate changes', () => {
  it('4 s at 5 fps then 4 s at 200 fps gives two steady segments and one rate change', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([20, 18000], [800, 450])] });
    expect(p.segments).toEqual([
      { startSec: 0, endSec: 4, frames: 20, fps: 5, kind: 'steady' },
      { startSec: 4, endSec: 8, frames: 800, fps: 200, kind: 'steady' },
    ]);
    expect(p.anomalies).toEqual([{ kind: 'rate-change', atSec: 4, durationSec: 0, fromFps: 5, toFps: 200 }]);
    expect(p.uneven).toBe(true);
    expect(p.dominantShare).toBeCloseTo(0.5, 9);
    expect(p.summary).toBe('Uneven: 5 fps for 4 s, 200 fps for 4 s');
    expect(p.buckets.fps[0]).toBeCloseTo(5, 9);
    expect(p.buckets.fps[p.buckets.fps.length - 1]).toBeCloseTo(200, 9);
  });

  it('the reverse order (200 then 5 fps) is split at the same boundary', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([800, 450], [20, 18000])] });
    expect(p.segments.map((s) => [s.startSec, s.fps])).toEqual([
      [0, 200],
      [4, 5],
    ]);
  });

  it('three 2 s phases at 10/30/60 fps give three steady segments and two rate changes', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([20, 9000], [60, 3000], [120, 1500])] });
    expect(p.segments.map((s) => [s.startSec, s.endSec, s.frames, s.fps])).toEqual([
      [0, 2, 20, 10],
      [2, 4, 60, 30],
      [4, 6, 120, 60],
    ]);
    expect(p.anomalies.map((a) => [a.kind, a.atSec, a.fromFps, a.toFps])).toEqual([
      ['rate-change', 2, 10, 30],
      ['rate-change', 4, 30, 60],
    ]);
    expect(p.dominantShare).toBeCloseTo(1 / 3, 9);
    expect(p.summary).toBe('Uneven: 10 fps for 2 s, 30 fps for 2 s, 60 fps for 2 s');
  });

  it('25 to 30 fps (20%) is a rate change', () => {
    const a = bothPaths({ timescale: 15000, segments: [runs([75, 600], [90, 500])] });
    expect(a.segments.map((s) => s.fps)).toEqual([25, 30]);
  });

  it('a 3-frame burst inside a steady stream is reported, not segmented, and does not make it uneven', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([90, 3000], [3, 450], [90, 3000])] });
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0].fps).toBe(30);
    expect(p.segments[0].frames).toBe(183);
    expect(p.anomalies.map((a) => a.kind)).toEqual(['burst']);
    expect(p.anomalies[0].atSec).toBeCloseTo(3, 9);
    expect(p.uneven).toBe(false);
    expect(p.summary).toBe('Steady: 30 fps for 6.015 s; 1 burst');
  });

  it('a 0.3 s burst holding over 20% of the frames makes the stream uneven', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([90, 3000], [72, 375], [90, 3000])] });
    expect(p.segments).toHaveLength(1);
    expect(p.anomalies.map((a) => [a.kind, a.atSec, a.toFps])).toEqual([['burst', 3, 240]]);
    expect(p.dominantShare).toBeGreaterThan(0.9);
    expect(p.uneven).toBe(true);
    expect(p.summary).toBe('Uneven: 30 fps for 6.3 s; 1 burst');
  });

  it('interleaved bursts that hold half of the frames are uneven, not steady', () => {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < 200; i++) pairs.push([6, 200], [6, 5]);
    const p = bothPaths({ timescale: 1000, segments: [runs(...pairs)] });
    expect(p.segments.filter((s) => s.kind === 'steady').map((s) => s.fps)).toEqual([5]);
    expect(p.anomalies.length + p.moreAnomalies).toBe(200);
    expect(p.anomalies.every((a) => a.kind === 'burst')).toBe(true);
    expect(p.dominantShare).toBeGreaterThan(0.9);
    expect(p.uneven).toBe(true);
    expect(p.summary).toMatch(/^Uneven: 5 fps for [\d.]+ s; 200 bursts$/);
  });

  it('a few dropped frames are a gap, a single slightly long frame is ignored', () => {
    const gap = bothPaths({ timescale: 30, segments: [runs([90, 1], [1, 5], [90, 1])] });
    expect(gap.segments).toHaveLength(1);
    expect(gap.anomalies.map((a) => [a.kind, a.atSec, a.durationSec])).toEqual([['gap', 3, 5 / 30]]);
    const small = bothPaths({ timescale: 30, segments: [runs([90, 1], [1, 2], [90, 1])] });
    expect(small.segments).toHaveLength(1);
    expect(small.anomalies).toEqual([]);
  });
});

describe('rate profile: freezes', () => {
  it('a 2 s frame in a 30 fps stream is one freeze inside one steady segment', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([60, 3000], [1, 180000], [59, 3000])] });
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ startSec: 0, frames: 120, fps: 30, kind: 'steady' });
    expect(p.segments[0].endSec).toBeCloseTo(119 / 30 + 2, 9);
    expect(p.anomalies).toEqual([{ kind: 'freeze', atSec: 2, durationSec: 2, fromFps: 30, toFps: 0.5 }]);
    expect(p.uneven).toBe(true);
    expect(p.dominantShare).toBeCloseTo((p.segments[0].endSec - 2) / p.segments[0].endSec, 9);
    expect(p.summary).toBe('Uneven: 30 fps for 5.967 s; 1 freeze');
    const dip = Math.min(...p.buckets.fps);
    expect(dip).toBeCloseTo(0.5, 9);
  });

  it('a freeze on the very first frame is still a freeze', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([1, 90000], [90, 3000])] });
    expect(p.segments).toHaveLength(1);
    expect(p.anomalies.map((a) => [a.kind, a.atSec, a.durationSec])).toEqual([['freeze', 0, 1]]);
  });

  it('a 10 minute last interval is a freeze, although the VFR rule excludes it and calls the track CFR', () => {
    const input = { timescale: 90000, segments: [runs([180, 3000], [1, 54_000_000], [1, 3000])] };
    const s = analyzeTimeline(input);
    expect(s.isVfr).toBe(false);
    const p = bothPaths(input);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ startSec: 0, frames: 182, fps: 30, kind: 'steady' });
    expect(p.segments[0].endSec).toBeCloseTo(6 + 600 + 1 / 30, 9);
    expect(p.anomalies.map((a) => [a.kind, a.atSec, a.durationSec])).toEqual([['freeze', 6, 600]]);
    expect(p.uneven).toBe(true);
    expect(p.summary).toBe('Uneven: 30 fps for 606 s; 1 freeze');
    expect(Math.min(...p.buckets.fps)).toBeLessThan(0.01);
  });

  it('a long interval among the tail deltas excluded for B-frames is still a freeze', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([180, 3000], [1, 450000], [3, 3000])], reorderDepth: 2 });
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ frames: 184, fps: 30 });
    expect(p.anomalies.map((a) => [a.kind, a.atSec, a.durationSec])).toEqual([['freeze', 6, 5]]);
    expect(p.summary).toBe('Uneven: 30 fps for 11.1 s; 1 freeze');
  });

  it('a final held frame in presentation timestamps is a freeze', () => {
    const pts = [...Array.from({ length: 92 }, (_, i) => i * 3000), 720000];
    const s = analyzeTimeline({ timescale: 90000, pts });
    expect(s.isVfr).toBe(false);
    const p = prof(s)!;
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ frames: 93, fps: 30 });
    expect(p.anomalies.map((a) => [a.kind, a.atSec])).toEqual([['freeze', 91 / 30]]);
    expect(p.anomalies[0].durationSec).toBeCloseTo(8 - 91 / 30, 9);
    expect(p.uneven).toBe(true);
  });

  it('a burst followed by a final hold reports both, and the segment row stays consistent', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([90, 3000], [72, 375], [1, 450000], [1, 3000])] });
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ frames: 164, fps: 30, kind: 'steady' });
    expect(p.anomalies.map((a) => [a.kind, a.atSec, a.durationSec, a.toFps])).toEqual([
      ['burst', 3, 0.3, 240],
      ['freeze', 3.3, 5, 0.2],
    ]);
    expect(p.summary).toBe('Uneven: 30 fps for 8.333 s; 1 freeze, 1 burst');
  });

  it('two long holds in a row are one stall, not a burst or a segment', () => {
    const p = bothPaths({ timescale: 1000, segments: [runs([90, 33], [1, 3000], [1, 3200], [1, 33])] });
    expect(p.segments).toHaveLength(1);
    expect(p.anomalies.map((a) => a.kind)).toEqual(['freeze']);
    expect(p.anomalies[0].durationSec).toBeCloseTo(6.2, 9);
  });

  it('a long frame shorter than FREEZE_MIN_SEC is a gap, not a freeze', () => {
    const p = bothPaths({ timescale: 90000, segments: [runs([60, 3000], [1, 30000], [60, 3000])] });
    expect(p.anomalies.map((a) => a.kind)).toEqual(['gap']);
  });

  it('a slideshow of 2 s frames is a steady 0.5 fps stream, not a series of freezes', () => {
    const p = bothPaths({ timescale: 1000, segments: [runs(...Array.from({ length: 10 }, (_, i): [number, number] => [1, i % 2 ? 2300 : 2000]))] });
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ startSec: 0, frames: 10, kind: 'steady' });
    expect(p.segments[0].fps).toBeCloseTo(9000 / 19200, 9);
    expect(p.anomalies).toEqual([]);
  });
});

describe('rate profile: variable input, duplicates and limits', () => {
  it('tiny noise pieces merge into one variable segment and its rate changes are reported', () => {
    const p = bothPaths({ timescale: 1000, segments: [runs([90, 33], ...noise(99, 3000), [180, 17])] });
    expect(p.segments.map((s) => s.kind)).toEqual(['steady', 'variable', 'steady']);
    expect(p.segments[1].endSec - p.segments[1].startSec).toBeGreaterThan(2.5);
    expect(p.uneven).toBe(true);
    expect(p.summary).toMatch(/^Uneven: 30\.\d+ fps for 2\.\d+ s, ~[\d.]+ fps for [\d.]+ s, 58\.\d+ fps for 3\.\d+ s$/);
    expect(p.segments[1].fps / p.segments[0].fps).toBeLessThan(1 / 1.15);
    expect(p.anomalies.map((a) => [a.kind, a.atSec])).toEqual([
      ['rate-change', p.segments[1].startSec],
      ['rate-change', p.segments[2].startSec],
    ]);
    expectContiguous(p);
  });

  it('a variable segment next to a steady one at a very different rate is a rate change', () => {
    const p = bothPaths({ timescale: 1000, segments: [runs([30, 100], ...noise(5, 3000), [30, 100])] });
    expect(p.segments.map((s) => s.kind)).toEqual(['steady', 'variable', 'steady']);
    expect(p.anomalies.map((a) => [a.kind, a.atSec])).toEqual([
      ['rate-change', p.segments[1].startSec],
      ['rate-change', p.segments[2].startSec],
    ]);
  });

  it('a stream without any steady stretch has no dominant rate', () => {
    const p = bothPaths({ timescale: 1000, segments: [runs(...noise(7, 4000))] });
    expect(p.segments.map((s) => s.kind)).toEqual(['variable']);
    expect(p.dominantShare).toBe(0);
    expect(p.uneven).toBe(true);
    expect(p.summary).toMatch(/^Uneven: ~[\d.]+ fps for [\d.]+ s$/);
  });

  it('duplicate timestamps are counted as frames and named in the summary', () => {
    const pts: number[] = [];
    for (let i = 0; i < 300; i++) pts.push(i % 5 === 4 ? pts[i - 1] : Math.round(i * 33.3333) + (i > 150 ? 400 : 0));
    const s = analyzeTimeline({ timescale: 1000, pts });
    expect(s.duplicateTimestamps).toBe(60);
    const p = prof(s)!;
    expect(framesOf(p)).toBe(300);
    expect(p.summary).toMatch(/; 1 gap, 60 duplicate timestamps$/);
    const one = rateProfile((visit) => [33, 0, 33, 33, 33, 33, 500, 33, 33].forEach((d) => visit(1, d)), 1000, 10, 731);
    expect(one?.summary).toMatch(/, 1 duplicate timestamp$/);
  });

  it('caps the segment and anomaly lists and counts the rest', () => {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < 60; i++) pairs.push([10, 6000], [60, 1000]);
    const p = bothPaths({ timescale: 60000, segments: [runs(...pairs)] });
    expect(p.segments).toHaveLength(MAX_SEGMENTS);
    expect(p.moreSegments).toBe(120 - MAX_SEGMENTS);
    expect(p.anomalies).toHaveLength(MAX_ANOMALIES);
    expect(p.moreAnomalies).toBe(119 - MAX_ANOMALIES);
    expect(p.anomalies.every((a) => a.kind === 'rate-change')).toBe(true);
    expect(p.dominantShare).toBeCloseTo(0.5, 2);
    expect(p.summary).toBe('Uneven: 10 fps for 1 s, 60 fps for 1 s, 10 fps for 1 s, +117 more');
  });

  it('segments add up to the presented frames and tile the timeline', () => {
    const inputs: TimelineInput[] = [
      { timescale: 90000, segments: [runs([20, 9000], [60, 3000], [120, 1500])] },
      { timescale: 1000, pts: jitteredPts(500, 1000 / 60, 7, 5) },
      { timescale: 90000, segments: [runs([60, 3000], [1, 180000], [59, 3000])] },
      { timescale: 1000, pts: [0, 33, 33, 67, 100, 133, 167, 600, 633, 667, 700] },
      { timescale: 90000, segments: [runs([180, 3000], [1, 450000], [3, 3000])], reorderDepth: 2 },
    ];
    for (const input of inputs) {
      const s = analyzeTimeline(input);
      expect(framesOf(prof(s)!)).toBe(s.presentedFrames);
      expectContiguous(prof(s)!);
    }
  });

  it('returns null without at least two distinct timestamps', () => {
    expect(analyzeTimeline({ timescale: 1000, pts: [] }).profile).toBeNull();
    expect(analyzeTimeline({ timescale: 1000, pts: [5] }).profile).toBeNull();
    expect(analyzeTimeline({ timescale: 1000, pts: [5, 5, 5] }).profile).toBeNull();
    expect(analyzeTimeline({ timescale: 1000, segments: [runs([1, 33])] }).profile).toBeNull();
    expect(analyzeTimeline({ timescale: 1000, segments: [] }).profile).toBeNull();
    expect(rateProfile(() => {}, 1000, 0, 0)).toBeNull();
    expect(rateProfile((visit) => visit(3, 0), 1000, 4, 0)).toBeNull();
  });

  it('a two-frame clip is a single steady segment', () => {
    const p = direct(1000, [1, 40]);
    expect(p.segments).toEqual([{ startSec: 0, endSec: 0.08, frames: 2, fps: 25, kind: 'steady' }]);
    expect(p.buckets.fps).toEqual([25]);
  });

  it('merges split runs of the same delta so both paths see the same stream', () => {
    const source: DeltaSource = (visit) => {
      visit(10, 1000);
      visit(0, 5);
      visit(10, 1000);
    };
    const p = rateProfile(source, 30000, 21, 20 * 1000);
    expect(p?.segments).toEqual([{ startSec: 0, endSec: 0.7, frames: 21, fps: 30, kind: 'steady' }]);
  });

  it('stays linear on a 1 h fast-path stream and on a 2 million frame expanded stream', () => {
    const t0 = performance.now();
    const fast = analyzeTimeline({ timescale: 60, segments: [runs([108_000, 1], [1, 30], [108_000, 1])] });
    const pf = prof(fast);
    const t1 = performance.now();
    expect(fast.fastPath).toBe(true);
    expect(pf?.segments).toHaveLength(1);
    expect(pf?.anomalies.map((a) => a.kind)).toEqual(['freeze']);
    expect(t1 - t0).toBeLessThan(50);
    const pts = jitteredPts(2_000_000, 1000 / 60, 7, 3);
    const t2 = performance.now();
    const slow = analyzeTimeline({ timescale: 1000, pts });
    const ps = prof(slow);
    const t3 = performance.now();
    expect(ps?.segments).toHaveLength(1);
    expect(t3 - t2).toBeLessThan(5000);
  });
});

describe('rate profile formatting', () => {
  it('clock prints m:ss with tenths only when needed, and h:mm:ss past an hour', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(4)).toBe('0:04');
    expect(clock(1.9667)).toBe('0:02');
    expect(clock(3.48)).toBe('0:03.5');
    expect(clock(61.25)).toBe('1:01.3');
    expect(clock(599.96)).toBe('10:00');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(10800)).toBe('3:00:00');
  });

  it('rate prints at most four significant digits', () => {
    expect(rate(5)).toBe('5');
    expect(rate(200)).toBe('200');
    expect(rate(30000 / 1001)).toBe('29.97');
    expect(rate(0.5)).toBe('0.5');
    expect(rate(119.88)).toBe('119.9');
  });
});
