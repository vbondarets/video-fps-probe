import { INT_MAX, reduceRational, toFfprobeString } from '../rational.ts';
import type { EditWindow, TimelineSegment } from '../stats.ts';
import type { Rational } from '../types.ts';
import type { IsoMovie, IsoTrack, TableRef } from './model.ts';

export function rescaleRound(a: number, b: number, c: number): number {
  if (!(c > 0)) return 0;
  const big = BigInt(Math.abs(a)) * BigInt(b);
  const C = BigInt(c);
  const r = Number((big + C / 2n) / C);
  return a < 0 ? -r : r;
}

export interface SampleTotals {
  moovSamples: number;
  moovDuration: number;
  fragmentSamples: number;
}

export function sampleTotals(tr: IsoTrack): SampleTotals {
  let moovSamples = 0;
  let moovDuration = 0;
  for (let i = 0; i < tr.sttsCounts.length; i++) {
    moovSamples += tr.sttsCounts[i];
    moovDuration += tr.sttsCounts[i] * tr.sttsDeltas[i];
  }
  let fragmentSamples = 0;
  for (const f of tr.fragments) fragmentSamples += f.count;
  return { moovSamples, moovDuration, fragmentSamples };
}

function sumBig(tr: IsoTrack, visible: (moofIndex: number, trexMissing: boolean) => boolean, moov: boolean): [bigint, bigint] {
  let n = 0n;
  let d = 0n;
  if (moov) {
    for (let i = 0; i < tr.sttsCounts.length; i++) {
      n += BigInt(tr.sttsCounts[i]);
      d += BigInt(tr.sttsCounts[i]) * BigInt(tr.sttsDeltas[i]);
    }
    if (d <= 0n) {
      n = 0n;
      d = 0n;
    }
  }
  for (const f of tr.fragments) {
    if (!visible(f.moofIndex, f.trexMissing)) continue;
    n += BigInt(f.count);
    d += BigInt(f.durationSum);
  }
  return [n, d];
}

function rateOf(ts: number, n: bigint, d: bigint): Rational | null {
  if (n <= 0n || d <= 0n) return null;
  return reduceRational(BigInt(ts) * n, d, INT_MAX);
}

export function averageRates(tr: IsoTrack, movie: IsoMovie): { avg: Rational | null; ffprobe: string | null } {
  const ts = tr.timescale;
  const visible = (moof: number, trexMissing: boolean): boolean => moof < movie.ffprobeMoofLimit && !trexMissing;
  const [n, d] = sumBig(tr, () => true, true);
  const [fn, fd] = sumBig(tr, visible, true);
  const overrun = tr.overruns.includes('stts') || tr.fragments.some((f) => f.overrun && visible(f.moofIndex, f.trexMissing));
  const ffprobe = overrun ? null : rateOf(ts, fn, fd);
  return { avg: rateOf(ts, n, d), ffprobe: ffprobe ? toFfprobeString(ffprobe) : null };
}

export function missingMandatoryAtoms(tr: IsoTrack): boolean {
  const dv = tr.dv;
  const declared = (ref: TableRef | null): number => (dv && ref && ref.start + 8 <= ref.end ? dv.getUint32(ref.start + 4) : 0);
  const chunks = declared(tr.co64 ?? tr.stco);
  const stts = tr.sttsCounts.length > 0 || tr.overruns.includes('stts');
  const samples = tr.sampleCount ?? 0;
  return (chunks > 0 && (!stts || declared(tr.stsc) === 0 || (tr.sampleSize === 0 && samples === 0))) || (samples > 0 && chunks === 0);
}

export interface EditInfo {
  emptyBefore: number;
  firstMedia: { mediaTime: number; duration: number; rate: number } | null;
  editSum: number;
  mediaEdits: number;
}

export function editInfo(tr: IsoTrack, movieTimescale: number): EditInfo {
  let emptyBefore = 0;
  let editSum = 0;
  let mediaEdits = 0;
  let firstMedia: EditInfo['firstMedia'] = null;
  for (const e of tr.edits) {
    const d = rescaleRound(e.duration, tr.timescale, movieTimescale);
    editSum += d;
    if (e.mediaTime === -1) {
      if (!firstMedia) emptyBefore += d;
      continue;
    }
    mediaEdits++;
    if (!firstMedia) firstMedia = { mediaTime: e.mediaTime, duration: d, rate: e.rate };
  }
  return { emptyBefore, firstMedia, editSum, mediaEdits };
}

export interface TrackTiming {
  durationTs: number;
  startPts: number | null;
}

export function trackTiming(tr: IsoTrack, movie: IsoMovie, totals: SampleTotals, edits: EditInfo): TrackTiming {
  let duration = tr.mdhdDuration;
  if (totals.moovDuration > 0) duration = Math.min(duration, totals.moovDuration);
  const fixIndex = tr.edits.length > 0 && totals.moovSamples > 0;
  if (fixIndex) duration = Math.min(duration, edits.editSum);
  let trackEnd = totals.moovDuration;
  let firstFragmentPts: number | null = null;
  const timeOffset = timeOffsetOf(tr, movie);
  for (const f of tr.fragments) {
    if (f.baseDts !== null) trackEnd = f.baseDts;
    if (firstFragmentPts === null && f.count > 0) firstFragmentPts = trackEnd - timeOffset + (f.cts ? f.cts[0] : 0);
    trackEnd += f.durationSum;
    if (trackEnd > duration) duration = trackEnd;
  }
  const sidxEnd = completeSidxEnd(tr, movie);
  if (sidxEnd !== null && sidxEnd > duration) duration = sidxEnd;
  let startPts: number | null = null;
  if (fixIndex) startPts = edits.emptyBefore;
  else if (totals.moovSamples > 0) startPts = tr.cttsOffsets && tr.cttsOffsets.length ? tr.cttsOffsets[0] : 0;
  else startPts = firstFragmentPts;
  return { durationTs: duration, startPts };
}

function completeSidxEnd(tr: IsoTrack, movie: IsoMovie): number | null {
  if (movie.ffprobeMoofLimit === Infinity) return null;
  let moofs = 0;
  let end: number | null = null;
  for (const b of movie.topLevel) {
    if (b.type === 'moof' && ++moofs > movie.ffprobeMoofLimit) break;
    const x = b.sidx;
    if (x && !x.hierarchical && x.referenceId === tr.id && x.timescale === tr.timescale) end = x.earliestPts + x.durationSum;
  }
  return end;
}

function timeOffsetOf(tr: IsoTrack, movie: IsoMovie): number {
  let empty = 0;
  let start = 0;
  let startIndex = 0;
  tr.edits.forEach((e, i) => {
    if (i === 0 && e.mediaTime === -1) {
      empty = e.duration;
      startIndex = 1;
    } else if (i === startIndex && e.mediaTime >= 0) start = e.mediaTime;
  });
  if (!empty && !start) return 0;
  return start - rescaleRound(empty, tr.timescale, movie.timescale);
}

export const STAGE1_WORK_LIMIT = 2_000_000;

interface Runs {
  count: number;
  starts: Float64Array;
  values: Float64Array;
  total: number;
}

function runsOf(counts: ArrayLike<number>, values: ArrayLike<number>, n: number): Runs {
  const starts = new Float64Array(counts.length + 1);
  const vals = new Float64Array(counts.length);
  let r = 0;
  let k = 0;
  for (let i = 0; i < counts.length && k < n; i++) {
    if (counts[i] <= 0) continue;
    starts[r] = k;
    vals[r] = values[i];
    k += Math.min(counts[i], n - k);
    r++;
  }
  starts[r] = k;
  return { count: r, starts, values: vals, total: k };
}

function runFinder(runs: Runs): (i: number) => number {
  const s = runs.starts;
  let last = 0;
  return (i: number): number => {
    if (i >= s[last] && i < s[last + 1]) return last;
    let lo = 0;
    let hi = runs.count - 1;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (s[m] <= i) lo = m;
      else hi = m - 1;
    }
    last = lo;
    return lo;
  };
}

interface KeyIndex {
  all: boolean;
  list: Float64Array;
}

function keyIndex(tr: IsoTrack, n: number): KeyIndex {
  const ref = tr.stss;
  if (!ref || !tr.dv) return { all: true, list: new Float64Array(0) };
  const dv = tr.dv;
  const entries = ref.start + 8 <= ref.end ? Math.min(dv.getUint32(ref.start + 4), Math.floor((ref.end - ref.start - 8) / 4)) : 0;
  if (entries === 0) return { all: false, list: Float64Array.of(0) };
  const keyOff = dv.getUint32(ref.start + 8) > 0 ? 1 : 0;
  const list = new Float64Array(entries);
  let len = 0;
  let prev = -1;
  for (let k = 0; k < entries; k++) {
    const v = dv.getUint32(ref.start + 8 + k * 4) - keyOff;
    if (v <= prev || v >= n) break;
    list[len++] = v;
    prev = v;
  }
  return { all: false, list: list.subarray(0, len) };
}

function nextKeyOf(keys: KeyIndex, n: number, i: number): number {
  if (i >= n) return -1;
  if (keys.all) return i;
  const l = keys.list;
  let lo = 0;
  let hi = l.length;
  while (lo < hi) {
    const m = Math.floor((lo + hi) / 2);
    if (l[m] < i) lo = m + 1;
    else hi = m;
  }
  return lo < l.length ? l[lo] : -1;
}

function prevKeyOf(keys: KeyIndex, i: number): number {
  if (i < 0) return -1;
  if (keys.all) return i;
  const l = keys.list;
  let lo = 0;
  let hi = l.length;
  while (lo < hi) {
    const m = Math.floor((lo + hi) / 2);
    if (l[m] <= i) lo = m + 1;
    else hi = m;
  }
  return lo > 0 ? l[lo - 1] : -1;
}

interface Kept {
  len: number;
  first: number;
  last: number;
  bad: boolean;
}

function keep(k: Kept, value: number, count: number): void {
  let c = count;
  if (c <= 0) return;
  if (k.len === 0) {
    k.first = value;
    k.last = value;
    k.len = 1;
    c--;
    if (c === 0) return;
  }
  if ((k.len >= 2 && k.last !== k.first) || (c >= 2 && value !== k.first)) k.bad = true;
  k.last = value;
  k.len += c;
}

function keepRange(k: Kept, runs: Runs, find: (i: number) => number, from: number, count: number): number {
  let p = from;
  let left = Math.min(count, runs.total - from);
  let steps = 0;
  while (left > 0 && !k.bad) {
    const r = find(p);
    const c = Math.min(runs.starts[r + 1] - p, left);
    keep(k, runs.values[r], c);
    p += c;
    left -= c;
    steps++;
  }
  return steps;
}

function keptRate(k: Kept, ts: number): Rational | null {
  if (k.bad || k.len === 0 || !(k.first > 0)) return null;
  return reduceRational(ts, k.first, INT_MAX);
}

export function ffprobeStage1Rate(tr: IsoTrack, movie: IsoMovie, moovSamples: number, maxSamples: number, warnings?: string[]): Rational | null {
  const n = Math.min(moovSamples, tr.sampleCount ?? 0);
  if (n <= 0 || tr.sttsCounts.length === 0 || tr.overruns.length > 0) return null;
  const ts = tr.timescale;
  const stts = runsOf(tr.sttsCounts, tr.sttsDeltas, n);
  const find = runFinder(stts);
  const kept: Kept = { len: 0, first: 0, last: 0, bad: false };
  if (tr.edits.length === 0) {
    keepRange(kept, stts, find, 0, n);
    return keptRate(kept, ts);
  }
  if (!tr.edits.some((e) => e.mediaTime !== -1)) return null;
  let uniform = true;
  for (let r = 1; r < stts.count && uniform; r++) uniform = stts.values[r] === stts.values[0];
  if (uniform) return stts.values[0] > 0 ? reduceRational(ts, stts.values[0], INT_MAX) : null;

  const limit = Math.min(maxSamples, STAGE1_WORK_LIMIT);
  let work = 0;
  let exhausted = false;
  const spend = (units: number): boolean => {
    work += units;
    if (work > limit) exhausted = true;
    return exhausted;
  };
  const dtsBase = new Float64Array(stts.count + 1);
  for (let r = 0; r < stts.count; r++) dtsBase[r + 1] = dtsBase[r] + (stts.starts[r + 1] - stts.starts[r]) * stts.values[r];
  const dtsAt = (i: number): number => {
    const r = find(i);
    return dtsBase[r] + (i - stts.starts[r]) * stts.values[r];
  };
  const durAt = (i: number): number => stts.values[find(i)];
  const hasCtts = !!tr.cttsCounts && tr.cttsCounts.length > 0;
  const ctts = hasCtts ? runsOf(tr.cttsCounts!, tr.cttsOffsets!, n) : null;
  const findCtts = ctts ? runFinder(ctts) : null;
  const offAt = (i: number): number => (ctts && i < ctts.total ? ctts.values[findCtts!(i)] : 0);
  const keys = keyIndex(tr, n);
  const nextKey = (i: number): number => nextKeyOf(keys, n, i);
  const prevKey = (i: number): number => prevKeyOf(keys, i);
  const shift = tr.dtsShift;

  const firstAtOrAbove = (value: number, hi: number): number => {
    let lo = 0;
    let top = hi;
    while (lo < top) {
      const m = Math.floor((lo + top) / 2);
      if (dtsAt(m) >= value) top = m;
      else lo = m + 1;
    }
    return lo;
  };
  const search = (target: number, any: boolean): number => {
    const t = shift > 0 ? target - shift : target;
    let a = -1;
    let b = n;
    if (dtsAt(n - 1) - shift < t) a = n - 1;
    while (b - a > 1) {
      const m = Math.floor((a + b) / 2);
      const v = dtsAt(m) - shift;
      if (v >= t) b = m;
      if (v <= t) a = m;
    }
    let index = any ? a : prevKey(a);
    if (index > 0) {
      const lo = firstAtOrAbove(dtsAt(index), index);
      if (lo < index) {
        if (any) index = lo;
        else {
          const k = nextKey(lo);
          if (k >= 0 && k < index) index = k;
        }
      }
    }
    if (hasCtts && index >= 0) {
      let k = prevKey(index);
      while (k >= 0 && !spend(1) && dtsAt(k) - shift + offAt(k) > t) k = prevKey(k - 1);
      index = k;
    }
    return index;
  };

  let ttsPos = 0;
  let foundMedia = false;
  for (const e of tr.edits) {
    const mt = e.mediaTime;
    if (!foundMedia && mt === -1) continue;
    foundMedia = true;
    if (spend(64)) break;
    const d = rescaleRound(e.duration, tr.timescale, movie.timescale);
    let index = search(mt, false);
    if (index < 0 && !exhausted) index = search(mt, true);
    if (exhausted) break;
    if (index < 0) {
      index = 0;
      ttsPos = 0;
    }
    if (hasCtts) ttsPos = index;
    let stop = -1;
    if (!hasCtts) {
      let lo = index;
      let hi = n;
      while (lo < hi) {
        const m = Math.floor((lo + hi) / 2);
        const end = m + 1 < n ? dtsAt(m + 1) : dtsAt(n - 1) + d;
        if (end >= d + mt) hi = m;
        else lo = m + 1;
      }
      if (lo < n) stop = nextKey(lo);
    } else {
      let keyAfter = false;
      for (let k = nextKey(index); k >= 0 && !spend(1); k = nextKey(k + 1)) {
        const frameDuration = k + 1 < n ? durAt(k) : d;
        if (dtsAt(k) + offAt(k) + frameDuration >= d + mt) {
          if (keyAfter) {
            stop = k;
            break;
          }
          keyAfter = true;
        }
      }
      if (exhausted) break;
    }
    const retained = stop < 0 ? n - index : stop - index + 1;
    const take = Math.min(retained, n - ttsPos);
    if (take > 0) {
      spend(keepRange(kept, stts, find, ttsPos, take));
      ttsPos += take;
    }
    if (kept.bad) return null;
    if (exhausted) break;
  }
  if (exhausted) {
    warnings?.push('r_frame_rate not reproduced: edit list walk limit reached');
    return null;
  }
  return keptRate(kept, ts);
}

function cutRuns(counts: ArrayLike<number>, values: ArrayLike<number>, n: number): { counts: number[]; values: number[] } {
  const c: number[] = [];
  const v: number[] = [];
  let left = n;
  for (let i = 0; i < counts.length && left > 0; i++) {
    const take = Math.min(counts[i], left);
    if (take <= 0) continue;
    c.push(take);
    v.push(values[i]);
    left -= take;
  }
  return { counts: c, values: v };
}

export function timelineSegments(tr: IsoTrack, moovKeep: number): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  if (moovKeep > 0) {
    const d = cutRuns(tr.sttsCounts, tr.sttsDeltas, moovKeep);
    const c = tr.cttsCounts && tr.cttsOffsets ? cutRuns(tr.cttsCounts, tr.cttsOffsets, moovKeep) : null;
    segments.push({ durations: { counts: d.counts, deltas: d.values }, cts: c ? { counts: c.counts, offsets: c.values } : null });
  }
  for (const f of tr.fragments) {
    const keep = f.complete;
    segments.push({
      baseDts: f.baseDts,
      durations: f.durations ? f.durations.subarray(0, keep) : { counts: [keep], deltas: [f.defaultDuration] },
      cts: f.cts ? f.cts.subarray(0, keep) : null,
    });
  }
  return segments;
}

export function presentationWindow(tr: IsoTrack, edits: EditInfo, warnings: string[]): EditWindow | null {
  const first = edits.firstMedia;
  if (!first) {
    if (tr.edits.length) warnings.push('edit list has no media edit');
    return null;
  }
  if (edits.mediaEdits > 1) warnings.push(`edit list has ${edits.mediaEdits} media edits, only the first is applied`);
  if (first.rate !== 1) warnings.push(`edit rate ${first.rate} is not applied`);
  const end = tr.fragments.length > 0 || first.duration <= 0 ? first.mediaTime : first.mediaTime + first.duration;
  return { start: first.mediaTime, end };
}

export function moovSamplesInFile(tr: IsoTrack, fileSize: number, moovSamples: number): { present: number; complete: number } | null {
  const dv = tr.dv;
  const chunks = tr.co64 ?? tr.stco;
  const sizes = tr.stsz ?? tr.stz2;
  if (!dv || !chunks || !sizes || !tr.stsc) return null;
  if (chunks.start + 8 > chunks.end || tr.stsc.start + 8 > tr.stsc.end || sizes.start + 12 > sizes.end) return null;
  const wide = !!tr.co64;
  const chunkCount = Math.min(dv.getUint32(chunks.start + 4), Math.floor((chunks.end - chunks.start - 8) / (wide ? 8 : 4)));
  const stscCount = Math.min(dv.getUint32(tr.stsc.start + 4), Math.floor((tr.stsc.end - tr.stsc.start - 8) / 12));
  const fixed = tr.stsz ? dv.getUint32(sizes.start + 4) : 0;
  const field = tr.stz2 ? dv.getUint8(sizes.start + 7) : 32;
  const tableCount = Math.min(dv.getUint32(sizes.start + 8), moovSamples);
  const tableEnd = sizes.end - sizes.start - 12;
  const sizeOf = (i: number): number => {
    if (fixed) return fixed;
    const base = sizes.start + 12;
    if (field === 32) return (i + 1) * 4 <= tableEnd ? dv.getUint32(base + i * 4) : 0;
    if (field === 16) return (i + 1) * 2 <= tableEnd ? dv.getUint16(base + i * 2) : 0;
    if (field === 8) return i < tableEnd ? dv.getUint8(base + i) : 0;
    const b = (i >> 1) < tableEnd ? dv.getUint8(base + (i >> 1)) : 0;
    return i & 1 ? b & 15 : b >> 4;
  };
  let present = 0;
  let complete = 0;
  let sample = 0;
  let run = 0;
  for (let c = 0; c < chunkCount && sample < tableCount; c++) {
    while (run + 1 < stscCount && dv.getUint32(tr.stsc.start + 8 + (run + 1) * 12) <= c + 1) run++;
    const perChunk = stscCount ? dv.getUint32(tr.stsc.start + 12 + run * 12) : 0;
    let off = wide ? Number(dv.getBigUint64(chunks.start + 8 + c * 8)) : dv.getUint32(chunks.start + 8 + c * 4);
    for (let j = 0; j < perChunk && sample < tableCount; j++, sample++) {
      const size = sizeOf(sample);
      if (off < fileSize) present++;
      if (off + size <= fileSize && complete === sample) complete++;
      off += size;
    }
  }
  return { present, complete };
}

export function displayRotation(tkhd: ArrayLike<number>, mvhd: ArrayLike<number>): number {
  const shifts = [16n, 16n, 30n];
  const m = new Int32Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let acc = 0n;
      for (let e = 0; e < 3; e++) acc += (BigInt(tkhd[i * 3 + e]) * BigInt(mvhd[e * 3 + j])) >> shifts[e];
      m[i * 3 + j] = Number(BigInt.asIntN(32, acc));
    }
  }
  if (m[0] === 65536 && m[4] === 65536 && m[8] === 1 << 30 && !m[1] && !m[2] && !m[3] && !m[5] && !m[6] && !m[7]) return 0;
  const a = m[0] / 65536;
  const b = m[1] / 65536;
  const s0 = Math.hypot(a, m[3] / 65536);
  const s1 = Math.hypot(b, m[4] / 65536);
  if (s0 === 0 || s1 === 0) return 0;
  return Math.trunc(-((Math.atan2(b / s1, a / s0) * 180) / Math.PI)) || 0;
}
