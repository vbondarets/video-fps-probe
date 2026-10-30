import { makeRational, reduceRational, toFfprobeString, INT_MAX } from './rational.ts';
import { MAX_EXPANDED_SAMPLES } from './options.ts';
import type { DeltaSource, RateProfileFn } from './segments.ts';
import type { DominantFps, NominalFps, RateProfile, Rational } from './types.ts';

export interface DurationRuns {
  counts: ArrayLike<number>;
  deltas: ArrayLike<number>;
}

export interface OffsetRuns {
  counts: ArrayLike<number>;
  offsets: ArrayLike<number>;
}

export interface TimelineSegment {
  baseDts?: number | null;
  durations: DurationRuns | ArrayLike<number>;
  cts?: OffsetRuns | ArrayLike<number> | null;
}

export interface EditWindow {
  start: number;
  end: number;
}

interface TimelineCommon {
  timescale: number;
  editWindow?: EditWindow | null;
  reorderDepth?: number;
  tickQuantized?: boolean;
  maxExpandedSamples?: number;
  forceExpand?: boolean;
}

export interface SegmentTimelineInput extends TimelineCommon {
  segments: readonly TimelineSegment[];
}

export interface PtsTimelineInput extends TimelineCommon {
  pts: ArrayLike<number>;
  lastDuration?: number | null;
  ctsRange?: { min: number; max: number } | null;
}

export type TimelineInput = SegmentTimelineInput | PtsTimelineInput;

export type ProfileJob = (impl: RateProfileFn) => RateProfile | null;

export interface TimelineStats {
  timescale: number;
  sampleCount: number;
  durationSum: number;
  avgFps: Rational | null;
  avgFpsString: string;
  presentedAvgFps: Rational | null;
  presentedFrames: number | null;
  firstPts: number | null;
  lastPts: number | null;
  deltaCount: number;
  excludedTailDeltas: number;
  reorderDepth: number;
  duplicateTimestamps: number;
  discontinuities: number;
  histogram: Array<[delta: number, count: number]>;
  distinctDeltas: number;
  minDelta: number | null;
  maxDelta: number | null;
  medianDelta: number | null;
  meanDelta: number | null;
  tolerance: number | null;
  minFps: Rational | null;
  maxFps: Rational | null;
  isVfr: boolean | null;
  vfrRatio: number;
  nominalFps: NominalFps | null;
  dominantFps: DominantFps | null;
  timestampsQuantized: boolean;
  profile: ProfileJob | null;
  fastPath: boolean;
  warnings: string[];
}

export const MAX_REORDER_DEPTH = 16;
export const SNAP_RELATIVE_TOLERANCE = 0.001;
export const VFR_RELATIVE_TOLERANCE = 0.005;
export const RATE_CHANGE_RELATIVE = 0.15;
export const CUSUM_DRIFT = RATE_CHANGE_RELATIVE / 2;
export const FREEZE_MIN_SEC = 0.5;
export const FREEZE_FACTOR = 4;

const STANDARD_RATES: readonly Rational[] = (() => {
  const out: Rational[] = [];
  for (const n of [24, 30, 48, 60, 120, 240]) out.push(makeRational(n * 1000, 1001));
  for (let n = 1; n <= 240; n++) out.push(makeRational(n, 1));
  return out;
})();

export function snapToStandardRate(fps: number, relTol: number = SNAP_RELATIVE_TOLERANCE): Rational | null {
  if (!(fps > 0)) return null;
  let best: Rational | null = null;
  let bestErr = Infinity;
  for (const r of STANDARD_RATES) {
    const err = Math.abs(fps - r.value) / r.value;
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  return bestErr <= relTol ? best : null;
}

export function msGridTicks(timescale: number, deltas: readonly number[]): number {
  if (!(timescale > 1000) || deltas.length === 0) return 0;
  for (const d of deltas) {
    const v = d * 1000;
    if (!Number.isSafeInteger(v) || v % timescale !== 0) return 0;
  }
  return timescale / 1000;
}

export function vfrTolerance(median: number, timescale: number, deltas: readonly number[]): number {
  return Math.max(1, Math.round(VFR_RELATIVE_TOLERANCE * median), msGridTicks(timescale, deltas));
}

export function reorderDepthFromCts(ctsMin: number, ctsMax: number, firstDelta: number): number {
  if (!(ctsMax > ctsMin) || !(firstDelta > 0)) return 0;
  return Math.min(MAX_REORDER_DEPTH, Math.ceil((ctsMax - ctsMin) / firstDelta));
}

function nanosecondTick(timescale: number): number | null {
  if (Number.isInteger(timescale) || !(timescale > 0)) return null;
  const ns = 1e9 / timescale;
  const n = Math.round(ns);
  return n > 0 && Math.abs(ns - n) <= 1e-6 * n ? n : null;
}

export function rateFromTicks(timescale: number, ticks: number): Rational | null {
  const ns = nanosecondTick(timescale);
  if (ns !== null && ticks > 0 && Number.isSafeInteger(ns * ticks)) return reduceRational(1_000_000_000, ns * ticks, Number.MAX_SAFE_INTEGER);
  return ratioOf(timescale, ticks, Number.MAX_SAFE_INTEGER);
}

export function intervalFromTicks(timescale: number, ticks: number | null): Rational | null {
  const r = ticks ? rateFromTicks(timescale, ticks) : null;
  return r && makeRational(r.den, r.num);
}

export function analyzeTimeline(input: TimelineInput): TimelineStats {
  const warnings: string[] = [];
  const ts = normalizeTimescale(input.timescale, warnings);
  if ('segments' in input) return segmentStats(input, ts, warnings);
  return ptsStats(input, ts, warnings);
}

interface RunsView {
  n: number;
  counts: ArrayLike<number> | null;
  values: ArrayLike<number>;
}

function durationView(d: DurationRuns | ArrayLike<number>): RunsView {
  if ('counts' in d && 'deltas' in d) return { n: Math.min(d.counts.length, d.deltas.length), counts: d.counts, values: d.deltas };
  return { n: d.length, counts: null, values: d };
}

function ctsView(c: OffsetRuns | ArrayLike<number> | null | undefined): RunsView | null {
  if (!c) return null;
  if ('counts' in c && 'offsets' in c) return { n: Math.min(c.counts.length, c.offsets.length), counts: c.counts, values: c.offsets };
  return { n: c.length, counts: null, values: c };
}

function ratioOf(num: number, den: number, max: number = INT_MAX): Rational | null {
  if (!(num > 0) || !(den > 0)) return null;
  if (Number.isSafeInteger(num) && Number.isSafeInteger(den)) return reduceRational(num, den, max);
  const scale = 1_000_000;
  const n = Math.round(num * scale);
  const d = Math.round(den * scale);
  if (Number.isSafeInteger(n) && Number.isSafeInteger(d)) return reduceRational(n, d, max);
  return makeRational(num / den, 1);
}

function averageRate(timescale: number, n: number, d: number): Rational | null {
  if (!(n > 0) || !(d > 0)) return null;
  const ns = nanosecondTick(timescale);
  if (ns !== null && Number.isSafeInteger(n) && Number.isSafeInteger(d)) return reduceRational(BigInt(n) * 1_000_000_000n, BigInt(ns) * BigInt(d), INT_MAX);
  if (Number.isSafeInteger(timescale) && Number.isSafeInteger(n) && Number.isSafeInteger(d)) {
    return reduceRational(BigInt(timescale) * BigInt(n), d, INT_MAX);
  }
  return ratioOf(timescale * n, d);
}

function normalizeTimescale(timescale: number, warnings: string[]): number {
  if (timescale > 0 && Number.isFinite(timescale)) return timescale;
  warnings.push(`invalid timescale ${timescale}, using 1`);
  return 1;
}

function windowOf(w: EditWindow | null | undefined): { ws: number; we: number } {
  if (!w) return { ws: -Infinity, we: Infinity };
  return { ws: w.start, we: w.end > w.start ? w.end : Infinity };
}

function emptyStats(timescale: number, warnings: string[]): TimelineStats {
  return {
    timescale,
    sampleCount: 0,
    durationSum: 0,
    avgFps: null,
    avgFpsString: '0/0',
    presentedAvgFps: null,
    presentedFrames: null,
    firstPts: null,
    lastPts: null,
    deltaCount: 0,
    excludedTailDeltas: 0,
    reorderDepth: 0,
    duplicateTimestamps: 0,
    discontinuities: 0,
    histogram: [],
    distinctDeltas: 0,
    minDelta: null,
    maxDelta: null,
    medianDelta: null,
    meanDelta: null,
    tolerance: null,
    minFps: null,
    maxFps: null,
    isVfr: null,
    vfrRatio: 0,
    nominalFps: null,
    dominantFps: null,
    timestampsQuantized: false,
    profile: null,
    fastPath: false,
    warnings,
  };
}

function profileJob(base: TimelineStats, lo: number, hi: number, source: DeltaSource, frames: number, span: number): ProfileJob | null {
  const ts = base.timescale;
  const jitterOnly = base.isVfr === false && hi - lo <= (base.tolerance ?? 0) && hi < 2 * lo;
  return hi > lo * (1 + CUSUM_DRIFT) && !jitterOnly ? (impl) => impl(source, ts, frames, span) : null;
}

function warnHeldLastFrame(base: TimelineStats, lastDuration: number | null | undefined): void {
  const m = base.medianDelta;
  const ts = base.timescale;
  if (!m || !lastDuration || lastDuration < FREEZE_FACTOR * m || lastDuration < FREEZE_MIN_SEC * ts) return;
  base.warnings.push(`last frame held ${(lastDuration / ts).toFixed(3)} s (${(lastDuration / m).toFixed(1)}x the median frame interval): the average is below the frame rate`);
}

function applyPresentedAverage(base: TimelineStats, lastDuration: number): void {
  warnHeldLastFrame(base, lastDuration);
  if (base.presentedFrames === null || base.presentedFrames <= 0 || base.firstPts === null || base.lastPts === null) return;
  const last = lastDuration > 0 ? lastDuration : (base.medianDelta ?? 0);
  base.presentedAvgFps = averageRate(base.timescale, base.presentedFrames, base.lastPts - base.firstPts + last);
}

function deltaAt(segments: readonly TimelineSegment[], index: number): number {
  let k = 0;
  for (const [n, d] of durationRuns(segments)) {
    if (index < k + n) return d;
    k += n;
  }
  return 0;
}

async function loadRateProfile(): Promise<RateProfileFn | null> {
  try {
    const { rateProfile } = await import('./segments.ts');
    return rateProfile;
  } catch {
    return null;
  }
}

export async function rateProfileOf(job: ProfileJob | null): Promise<RateProfile | null> {
  const impl = job && (await loadRateProfile());
  return impl ? job(impl) : null;
}

function keptDeltas(all: number, tail: number): number {
  return all - tail >= 2 ? all - tail : all;
}

function applyHistogram(base: TimelineStats, hist: Map<number, number>, tickQuantized: boolean): void {
  const ts = base.timescale;
  const keys = [...hist.keys()].sort((a, b) => a - b);
  const histogram: Array<[number, number]> = keys.map((k) => [k, hist.get(k) ?? 0]);
  let total = 0;
  let sum = 0;
  for (const [k, c] of histogram) {
    total += c;
    sum += k * c;
  }
  base.histogram = histogram;
  base.distinctDeltas = keys.length;
  if (total === 0) return;
  let acc = 0;
  let median = keys[0];
  for (const [k, c] of histogram) {
    acc += c;
    if (acc * 2 >= total) {
      median = k;
      break;
    }
  }
  let mode = keys[0];
  let modeCount = 0;
  for (const [k, c] of histogram) {
    if (c > modeCount) {
      mode = k;
      modeCount = c;
    }
  }
  const msTicks = msGridTicks(ts, keys);
  const tol = Math.max(1, Math.round(VFR_RELATIVE_TOLERANCE * median), msTicks);
  let off = 0;
  for (const [k, c] of histogram) if (Math.abs(k - median) > tol) off += c;
  const minD = keys[0];
  const maxD = keys[keys.length - 1];
  const isVfr = total >= 2 && off > 0;
  base.minDelta = minD;
  base.maxDelta = maxD;
  base.medianDelta = median;
  base.meanDelta = sum / total;
  base.tolerance = tol;
  base.minFps = rateFromTicks(ts, maxD);
  base.maxFps = rateFromTicks(ts, minD);
  base.isVfr = isVfr;
  base.vfrRatio = off / total;
  if (keys.length === 1) {
    const r = rateFromTicks(ts, minD);
    if (r) base.nominalFps = { ...r, kind: 'exact' };
  } else if (isVfr && modeCount * 2 >= total) {
    const r = rateFromTicks(ts, mode);
    if (r) base.dominantFps = { rate: r, share: modeCount / total };
  }
  base.timestampsQuantized = (tickQuantized || msTicks > 0) && !isVfr && keys.length > 1;
}

function applySnappedNominal(base: TimelineStats): void {
  if (base.nominalFps || base.isVfr !== false || base.distinctDeltas < 2 || !base.avgFps) return;
  const snapped = snapToStandardRate(base.meanDelta ? base.timescale / base.meanDelta : base.avgFps.value);
  if (snapped) base.nominalFps = { ...snapped, kind: 'snapped' };
}

interface SegmentScan {
  n: number;
  d: number;
  constantCts: boolean;
  ctsValue: number;
  ctsMin: number;
  ctsMax: number;
  firstDelta: number;
  negativeDurations: boolean;
  discontinuities: number;
  startDts: number;
  ctsMismatch: number;
}

function scanSegments(segments: readonly TimelineSegment[]): SegmentScan {
  const s: SegmentScan = {
    n: 0,
    d: 0,
    constantCts: true,
    ctsValue: 0,
    ctsMin: Infinity,
    ctsMax: -Infinity,
    firstDelta: 0,
    negativeDurations: false,
    discontinuities: 0,
    startDts: 0,
    ctsMismatch: 0,
  };
  let seenCts = false;
  const seeCts = (v: number): void => {
    if (!seenCts) {
      s.ctsValue = v;
      seenCts = true;
    } else if (v !== s.ctsValue) s.constantCts = false;
    if (v < s.ctsMin) s.ctsMin = v;
    if (v > s.ctsMax) s.ctsMax = v;
  };
  let t = 0;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.baseDts !== undefined && seg.baseDts !== null) {
      if (si === 0) s.startDts = seg.baseDts;
      else if (seg.baseDts !== t) s.discontinuities++;
      t = seg.baseDts;
    }
    const dv = durationView(seg.durations);
    let segN = 0;
    for (let i = 0; i < dv.n; i++) {
      const c = dv.counts ? dv.counts[i] : 1;
      if (c <= 0) continue;
      const delta = dv.values[i];
      segN += c;
      s.d += c * delta;
      t += c * delta;
      if (delta < 0) s.negativeDurations = true;
      if (s.firstDelta === 0 && delta > 0) s.firstDelta = delta;
    }
    s.n += segN;
    const cv = ctsView(seg.cts);
    let covered = 0;
    let listed = 0;
    if (cv) {
      for (let i = 0; i < cv.n; i++) {
        const c = cv.counts ? cv.counts[i] : 1;
        if (c <= 0) continue;
        listed += c;
        const use = Math.min(c, segN - covered);
        if (use <= 0) continue;
        covered += use;
        seeCts(cv.values[i]);
      }
      if (listed !== segN) s.ctsMismatch++;
    }
    if (covered < segN) seeCts(0);
  }
  if (!seenCts) {
    s.ctsMin = 0;
    s.ctsMax = 0;
  }
  return s;
}

function* durationRuns(segments: readonly TimelineSegment[]): Generator<[count: number, delta: number]> {
  for (const seg of segments) {
    const dv = durationView(seg.durations);
    for (let i = 0; i < dv.n; i++) {
      const c = dv.counts ? dv.counts[i] : 1;
      if (c > 0) yield [c, dv.values[i]];
    }
  }
}

function countPtsBelow(segments: readonly TimelineSegment[], p0: number, x: number, total: number): number {
  if (x === -Infinity) return 0;
  if (x === Infinity) return total;
  let t = p0;
  let k = 0;
  for (const [n, d] of durationRuns(segments)) {
    if (d === 0) {
      if (t < x) {
        k += n;
        continue;
      }
      return k;
    }
    if (t + (n - 1) * d < x) {
      k += n;
      t += n * d;
      continue;
    }
    return k + Math.max(0, Math.min(n, Math.ceil((x - t) / d)));
  }
  return k;
}

function ptsAt(segments: readonly TimelineSegment[], p0: number, index: number): number {
  let t = p0;
  let k = 0;
  for (const [n, d] of durationRuns(segments)) {
    if (index < k + n) return t + (index - k) * d;
    k += n;
    t += n * d;
  }
  return t;
}

function segmentStats(input: SegmentTimelineInput, ts: number, warnings: string[]): TimelineStats {
  const segments = input.segments;
  const scan = scanSegments(segments);
  if (scan.ctsMismatch > 0) warnings.push(`composition offsets do not match the sample count in ${scan.ctsMismatch} segment(s)`);
  if (scan.discontinuities > 0) warnings.push(`decode timestamp discontinuities: ${scan.discontinuities}`);
  if (scan.negativeDurations) warnings.push('negative sample durations');
  if (!Number.isSafeInteger(scan.d)) warnings.push('duration sum exceeds 2^53-1');
  const base = emptyStats(ts, warnings);
  base.sampleCount = scan.n;
  base.durationSum = scan.d;
  base.discontinuities = scan.discontinuities;
  base.avgFps = averageRate(ts, scan.n, scan.d);
  base.avgFpsString = toFfprobeString(base.avgFps);
  if (scan.n === 0) {
    base.presentedFrames = 0;
    return base;
  }
  const reorder = input.reorderDepth ?? reorderDepthFromCts(scan.ctsMin, scan.ctsMax, scan.firstDelta);
  base.reorderDepth = reorder;
  const tail = 1 + reorder;
  const { ws, we } = windowOf(input.editWindow);
  const tickQuantized = input.tickQuantized ?? false;

  if (!input.forceExpand && scan.constantCts && scan.discontinuities === 0 && !scan.negativeDurations) {
    base.fastPath = true;
    const p0 = scan.startDts + scan.ctsValue;
    const a = countPtsBelow(segments, p0, ws, scan.n);
    const b = Math.max(a, countPtsBelow(segments, p0, we, scan.n));
    base.presentedFrames = b - a;
    if (b === a) return base;
    const firstPts = ptsAt(segments, p0, a);
    const lastPts = ptsAt(segments, p0, b - 1);
    base.firstPts = firstPts;
    base.lastPts = lastPts;
    const all = b - a - 1;
    const keep = keptDeltas(all, tail);
    const hist = new Map<number, number>();
    let k = 0;
    let dMin = Infinity;
    let dMax = 0;
    for (const [n, d] of durationRuns(segments)) {
      if (k >= a + all) break;
      const lo = Math.max(k, a);
      const hiAll = Math.min(k + n, a + all);
      if (hiAll > lo) {
        if (d === 0) base.duplicateTimestamps += hiAll - lo;
        else {
          dMin = Math.min(dMin, d);
          dMax = Math.max(dMax, d);
          const hiKeep = Math.min(k + n, a + keep);
          if (hiKeep > lo) {
            hist.set(d, (hist.get(d) ?? 0) + (hiKeep - lo));
            base.deltaCount += hiKeep - lo;
          }
        }
      }
      k += n;
    }
    base.excludedTailDeltas = all - keep;
    applyHistogram(base, hist, tickQuantized);
    applySnappedNominal(base);
    applyPresentedAverage(base, deltaAt(segments, b - 1));
    base.profile = profileJob(
      base,
      dMin,
      dMax,
      (visit) => {
        let j = 0;
        for (const [n, d] of durationRuns(segments)) {
          if (j >= a + all) break;
          const lo = Math.max(j, a);
          const hi = Math.min(j + n, a + all);
          if (hi > lo) visit(hi - lo, d);
          j += n;
        }
      },
      b - a,
      lastPts - firstPts,
    );
    return base;
  }

  const maxExpand = input.maxExpandedSamples ?? MAX_EXPANDED_SAMPLES;
  if (scan.n > maxExpand) {
    warnings.push(`per-sample analysis skipped: ${scan.n} samples exceed the limit of ${maxExpand}`);
    return base;
  }
  const pts = new Float64Array(scan.n);
  let k = 0;
  let t = 0;
  for (const seg of segments) {
    if (seg.baseDts !== undefined && seg.baseDts !== null) t = seg.baseDts;
    const start = k;
    const dv = durationView(seg.durations);
    for (let i = 0; i < dv.n; i++) {
      const c = dv.counts ? dv.counts[i] : 1;
      const delta = dv.values[i];
      for (let j = 0; j < c; j++) {
        pts[k++] = t;
        t += delta;
      }
    }
    const cv = ctsView(seg.cts);
    if (cv) {
      let s = start;
      for (let i = 0; i < cv.n && s < k; i++) {
        const c = cv.counts ? cv.counts[i] : 1;
        const off = cv.values[i];
        for (let j = 0; j < c && s < k; j++) pts[s++] += off;
      }
    }
  }
  let lastIndex = -1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p >= ws && p < we && (lastIndex < 0 || p >= pts[lastIndex])) lastIndex = i;
  }
  const lastDuration = lastIndex >= 0 ? deltaAt(segments, lastIndex) : 0;
  const presented = presentSorted(pts, ws, we);
  histogramStage(base, presented, tail, tickQuantized);
  applyPresentedAverage(base, lastDuration);
  applySnappedNominal(base);
  return base;
}

function presentSorted(pts: Float64Array, ws: number, we: number): Float64Array {
  let m = pts.length;
  if (ws !== -Infinity || we !== Infinity) {
    m = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p >= ws && p < we) pts[m++] = p;
    }
  }
  const view = pts.subarray(0, m);
  for (let i = 1; i < m; i++) {
    if (view[i] < view[i - 1]) {
      view.sort();
      break;
    }
  }
  return view;
}

function histogramStage(base: TimelineStats, sorted: Float64Array, tail: number, tickQuantized: boolean): void {
  const m = sorted.length;
  base.presentedFrames = m;
  if (m === 0) return;
  base.firstPts = sorted[0];
  base.lastPts = sorted[m - 1];
  const all = m - 1;
  const keep = keptDeltas(all, tail);
  const hist = new Map<number, number>();
  let dMin = Infinity;
  let dMax = 0;
  for (let i = 1; i <= all; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d <= 0) {
      base.duplicateTimestamps++;
      continue;
    }
    dMin = Math.min(dMin, d);
    dMax = Math.max(dMax, d);
    if (i <= keep) {
      hist.set(d, (hist.get(d) ?? 0) + 1);
      base.deltaCount++;
    }
  }
  base.excludedTailDeltas = all - keep;
  applyHistogram(base, hist, tickQuantized);
  base.profile = profileJob(
    base,
    dMin,
    dMax,
    (visit) => {
      for (let i = 1; i <= all; i++) visit(1, sorted[i] - sorted[i - 1]);
    },
    m,
    sorted[all] - sorted[0],
  );
}

function reorderLag(pts: ArrayLike<number>): number {
  let runMax = -Infinity;
  let lag = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p > runMax) runMax = p;
    else if (runMax - p > lag) lag = runMax - p;
  }
  return lag;
}

function ptsStats(input: PtsTimelineInput, ts: number, warnings: string[]): TimelineStats {
  const src = input.pts;
  const n = src.length;
  const base = emptyStats(ts, warnings);
  base.sampleCount = n;
  if (n === 0) {
    base.presentedFrames = 0;
    return base;
  }
  let minP = Infinity;
  let maxP = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = src[i];
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
  }
  const { ws, we } = windowOf(input.editWindow);
  const presented = presentSorted(Float64Array.from(src), ws, we);
  let reorder = input.reorderDepth;
  if (reorder === undefined) {
    let firstDelta = 0;
    for (let i = 1; i < presented.length; i++) {
      const d = presented[i] - presented[i - 1];
      if (d > 0) {
        firstDelta = d;
        break;
      }
    }
    reorder = input.ctsRange
      ? reorderDepthFromCts(input.ctsRange.min, input.ctsRange.max, firstDelta)
      : reorderDepthFromCts(0, reorderLag(src), firstDelta);
  }
  base.reorderDepth = reorder;
  histogramStage(base, presented, 1 + reorder, input.tickQuantized ?? false);
  warnHeldLastFrame(base, input.lastDuration);
  const lastDur = input.lastDuration ?? base.medianDelta ?? 0;
  base.durationSum = maxP - minP + lastDur;
  base.avgFps = averageRate(ts, n, base.durationSum);
  base.avgFpsString = toFfprobeString(base.avgFps);
  base.presentedAvgFps = base.avgFps;
  applySnappedNominal(base);
  return base;
}
