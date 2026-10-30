import { MAX_EXPANDED_SAMPLES } from '../options.ts';
import { emptyAnalysis } from '../result.ts';
import { fourcc, whichErrorCode, type BlobReader } from '../reader.ts';
import type { ContainerAnalysis, Provenance, VideoTrackResult } from '../types.ts';
import { childBoxes, IsoBmffError, readBoxHeader, type BoxHeader } from './boxes.ts';
import { buildVideoTrack, containerOf, formatDuration, isAbort, isVideoTrack, layoutOf, MOOV_HARD_CAP, MOOV_SUSPECT_CAP, pickPrimary, readMoov, reportedIds, type Built } from './build.ts';
import { newMovie, type IsoMovie, type IsoTrack, type TopBox } from './model.ts';
import { parseMoof, parseSidx } from './moof.ts';
import { parseTfraOffsets } from './prefetch.ts';
import { editInfo, rescaleRound, sampleTotals, trackTiming } from './track.ts';

const HEADER_PEEK = 16;
const MFRA_TAIL = 64 * 1024;
const MOOF_HARD_CAP = 64 * 1024 * 1024;
const SIDE_TYPES = new Set(['moof', 'mdat', 'mfra']);

export interface HeaderBudget {
  readonly bytesLeft: number;
  checkTime(): void;
  reserve(reads: number, bytes: number, offset: number): void;
  take(): (Error & { errorCode: string }) | null;
}

export interface HeaderPlan {
  head: number;
  tail: number;
  maxTracks: number;
  maxTopLevelBoxes: number;
  index: boolean;
}

interface Walk {
  reader: BlobReader;
  budget: HeaderBudget;
  plan: HeaderPlan;
  movie: IsoMovie;
  boxes: number;
}

interface TailIndex {
  mfraSize: number;
  offsets: Map<number, Set<number>>;
}

interface Resolved {
  ticks: number;
  timescale: number;
  provenance: Provenance;
}

function visit(w: Walk): void {
  w.budget.checkTime();
  if (++w.boxes > w.plan.maxTopLevelBoxes) throw new IsoBmffError('structure-limit', `limit reached: maxTopLevelBoxes ${w.plan.maxTopLevelBoxes}`);
}

function ahead(w: Walk, pos: number, wanted: number): number {
  return Math.max(0, Math.min(wanted, w.budget.bytesLeft, w.reader.size - pos));
}

async function peekAt(w: Walk, pos: number, wanted: number): Promise<DataView> {
  const need = Math.min(HEADER_PEEK, w.reader.size - pos);
  return w.reader.peek(pos, need) ?? w.reader.view(pos, need, ahead(w, pos, wanted));
}

export function countTracks(dv: DataView, max: number): void {
  let moov: BoxHeader | null;
  try {
    moov = readBoxHeader(dv, 0, dv.byteLength);
  } catch {
    return;
  }
  if (!moov) return;
  let n = 0;
  for (let p = moov.start + moov.headerSize; p + 8 <= moov.end; ) {
    let c: BoxHeader | null;
    try {
      c = readBoxHeader(dv, p, moov.end);
    } catch {
      return;
    }
    if (!c) return;
    if (c.type === 'trak' && ++n > max) throw new IsoBmffError('structure-limit', `limit reached: maxTracks ${max}`);
    p = c.start + c.size;
  }
}

export function mehdDuration(dv: DataView): number | null {
  let moov: BoxHeader | null;
  try {
    moov = readBoxHeader(dv, 0, dv.byteLength);
  } catch {
    return null;
  }
  if (!moov) return null;
  for (const c of childBoxes(dv, moov.start + moov.headerSize, moov.end)) {
    if (c.type !== 'mvex') continue;
    for (const m of childBoxes(dv, c.start + c.headerSize, c.end)) {
      const p = m.start + m.headerSize;
      if (m.type !== 'mehd' || p + 8 > m.end) continue;
      if (dv.getUint8(p) === 1) {
        if (p + 12 > m.end) return null;
        const d = dv.getBigUint64(p + 4);
        return d === 0n || d > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(d);
      }
      const d = dv.getUint32(p + 4);
      return d === 0 || d === 0xffffffff ? null : d;
    }
  }
  return null;
}

async function readHeaderMoov(w: Walk, h: BoxHeader): Promise<DataView> {
  const size = w.reader.size;
  const beyond = h.start + h.size > size;
  w.movie.moov = [h.start, h.size];
  if (!beyond && h.size > MOOV_HARD_CAP) throw new IsoBmffError('too-large', 'unsupported: moov larger than 256 MiB');
  const dv = await w.reader.view(h.start, beyond ? Math.min(size - h.start, MOOV_SUSPECT_CAP) : h.size, 0);
  countTracks(dv, w.plan.maxTracks);
  await readMoov(w.reader, h, w.movie);
  return dv;
}

function noteTruncatedMdat(w: Walk, pos: number): void {
  const size = w.reader.size;
  if (pos + 8 > size) return;
  const hv = w.reader.peek(pos, Math.min(HEADER_PEEK, size - pos));
  if (!hv) return;
  try {
    const h = readBoxHeader(hv, 0, size - pos, pos);
    if (h && h.type === 'mdat' && h.truncated) {
      w.movie.truncated = true;
      w.movie.warnings.push(`'mdat' at ${pos} is truncated`);
    }
  } catch {
    return;
  }
}

interface Walked {
  moov: DataView | null;
  fragments: boolean;
  firstMoof: BoxHeader | null;
}

async function walkTop(w: Walk): Promise<Walked> {
  const { reader, movie } = w;
  const size = reader.size;
  let pos = 0;
  let moov: DataView | null = null;
  let afterMdat = false;
  while (pos + 8 <= size) {
    visit(w);
    const hv = await peekAt(w, pos, afterMdat && !moov ? w.plan.tail : w.plan.head);
    let rel: BoxHeader | null;
    try {
      rel = readBoxHeader(hv, 0, size - pos, pos);
    } catch (e) {
      if (!moov) throw e;
      movie.warnings.push(`ignored trailing data at ${pos}: ${(e as Error).message}`);
      return { moov, fragments: false, firstMoof: null };
    }
    if (!rel) break;
    const h: BoxHeader = { ...rel, start: pos, end: Math.min(pos + rel.size, size) };
    const trailer = rel.truncated && moov !== null && h.type !== 'mdat' && h.type !== 'moof';
    if (rel.truncated) {
      movie.truncated = true;
      movie.warnings.push(trailer ? `ignored trailing data at ${pos}: not a box` : `'${h.type}' at ${pos} is truncated`);
    }
    const top: TopBox = { type: h.type, start: pos, end: h.end, sidx: null };
    movie.topLevel.push(top);
    if (trailer || (moov && SIDE_TYPES.has(h.type))) return { moov, fragments: !trailer, firstMoof: !trailer && h.type === 'moof' ? h : null };
    if (h.type === 'ftyp') {
      const fv = await reader.view(pos, Math.min(h.size, 1024), ahead(w, pos, w.plan.head));
      const p = h.headerSize;
      if (p + 4 <= fv.byteLength) {
        movie.hasFtyp = true;
        movie.brand = fourcc(fv, p);
        for (let q = p + 8; q + 4 <= fv.byteLength; q += 4) movie.compatibleBrands.push(fourcc(fv, q));
      }
    } else if (h.type === 'moov') {
      if (moov) movie.warnings.push(`ignored a second moov at ${pos}`);
      else {
        moov = await readHeaderMoov(w, h);
        if (!movie.hasMvex) {
          noteTruncatedMdat(w, pos + rel.size);
          return { moov, fragments: false, firstMoof: null };
        }
      }
    } else if (h.type === 'moof') {
      throw new IsoBmffError('corrupt', 'corrupt file: movie fragment (moof) before moov');
    } else if (h.type === 'sidx' && !rel.truncated) {
      const dv = await reader.view(pos, h.size, 0);
      const sh = readBoxHeader(dv, 0, dv.byteLength);
      if (sh) top.sidx = parseSidx(dv, sh, pos);
    }
    afterMdat = h.type === 'mdat';
    pos += rel.size;
  }
  if (!moov) throw new IsoBmffError('no-header', 'incomplete file: no moov');
  return { moov, fragments: false, firstMoof: null };
}

async function readTailIndex(w: Walk): Promise<TailIndex | null> {
  const { reader } = w;
  const size = reader.size;
  const tailLen = Math.min(size, MFRA_TAIL);
  if (tailLen < 16) return null;
  let tail = reader.peek(size - tailLen, tailLen);
  if (!tail) {
    w.budget.reserve(2, tailLen, size - tailLen);
    tail = await reader.view(size - tailLen, tailLen, 0);
  }
  if (fourcc(tail, tailLen - 12) !== 'mfro') return null;
  const mfraSize = tail.getUint32(tailLen - 4);
  if (mfraSize < 24 || mfraSize > size) return null;
  const dv = mfraSize <= tailLen ? new DataView(tail.buffer, tail.byteOffset + tailLen - mfraSize, mfraSize) : await reader.view(size - mfraSize, mfraSize, 0);
  let h: BoxHeader | null;
  try {
    h = readBoxHeader(dv, 0, mfraSize);
  } catch {
    return null;
  }
  if (!h || h.type !== 'mfra') return null;
  const offsets = new Map<number, Set<number>>();
  for (const t of childBoxes(dv, h.headerSize, h.end)) {
    const p = t.start + t.headerSize;
    if (t.type !== 'tfra' || p + 8 > t.end) continue;
    const id = dv.getUint32(p + 4);
    const set = offsets.get(id) ?? new Set<number>();
    parseTfraOffsets(dv, t.start, t.end, set, size - mfraSize);
    if (set.size > 0) offsets.set(id, set);
  }
  return { mfraSize, offsets };
}

function parseFragment(w: Walk, dv: DataView, pos: number, parsed: Set<number>): void {
  const mh = readBoxHeader(dv, 0, dv.byteLength);
  if (mh) parseMoof(dv, mh, pos, w.movie.moofCount, w.movie, MAX_EXPANDED_SAMPLES);
  w.movie.moofCount++;
  parsed.add(pos);
}

async function walkFragments(w: Walk, from: number, end: number, parsed: Set<number>): Promise<void> {
  let pos = from;
  while (pos + 8 <= end) {
    visit(w);
    const hv = await peekAt(w, pos, w.plan.head);
    let h: BoxHeader | null;
    try {
      h = readBoxHeader(hv, 0, end - pos, pos);
    } catch {
      return;
    }
    if (!h || h.truncated || h.type === 'mfra') return;
    if (h.type === 'moof' && !parsed.has(pos)) {
      if (h.size > MOOF_HARD_CAP) throw new IsoBmffError('too-large', `corrupt file: moof larger than 64 MiB at ${pos}`);
      parseFragment(w, await w.reader.view(pos, h.size, ahead(w, pos, w.plan.head)), pos, parsed);
    }
    pos += h.size;
  }
}

function sidxEnd(movie: IsoMovie, tr: IsoTrack, ends: number[]): number | null {
  let end: number | null = null;
  for (const b of movie.topLevel) {
    const x = b.sidx;
    if (x && !x.hierarchical && x.referenceId === tr.id && x.timescale === tr.timescale && ends.includes(x.coverageEnd)) end = x.earliestPts + x.durationSum;
  }
  return end;
}

function timingOf(tr: IsoTrack, movie: IsoMovie, fragments: IsoTrack['fragments']): { durationTs: number; startPts: number | null } {
  const t = { ...tr, fragments };
  const totals = sampleTotals(t);
  return trackTiming(t, movie, totals, editInfo(t, movie.timescale, totals));
}

function hasFragmentData(tr: IsoTrack, movie: IsoMovie, index: TailIndex | null): boolean {
  return movie.trex.has(tr.id) || (index?.offsets.has(tr.id) ?? false) || movie.topLevel.some((b) => b.sidx?.referenceId === tr.id);
}

function stillFragmented(tr: IsoTrack, movie: IsoMovie, index: TailIndex | null, parsed: Set<number>, resolved: Resolved | null): boolean {
  if (!resolved) return false;
  let samples = sampleTotals({ ...tr, fragments: [] }).moovSamples;
  for (const f of tr.fragments) samples += f.count;
  if (samples > 1) return false;
  for (const o of index?.offsets.get(tr.id) ?? []) if (!parsed.has(o)) return false;
  for (const b of movie.topLevel) if (b.sidx?.referenceId === tr.id && b.sidx.subsegments.some(([o]) => !parsed.has(o))) return false;
  const first = tr.fragments[0];
  const interval = movie.trex.get(tr.id)?.duration || (first ? (first.durations?.[0] ?? first.defaultDuration) : 0);
  if (!(interval > 0)) return false;
  return resolved.ticks * tr.timescale <= interval * resolved.timescale;
}

function fragmentedPrimary(built: Built[]): number | null {
  let best: Built | null = null;
  const rank = (b: Built): number => (b.auxiliary ? 0.5 : b.enabled ? 2 : 1);
  const area = (b: Built): number => b.result.width * b.result.height;
  for (const b of built) {
    if (!best) best = b;
    else if (rank(b) !== rank(best)) best = rank(b) > rank(best) ? b : best;
    else if (b.result.isStill !== best.result.isStill) best = best.result.isStill ? b : best;
    else if (area(b) !== area(best)) best = area(b) > area(best) ? b : best;
    else if (b.result.trackId < best.result.trackId) best = b;
  }
  return best ? best.result.trackId : null;
}

function headerTrack(t: VideoTrackResult): void {
  t.presentedFrames = null;
  delete t.provenance.presentedFrames;
}

function isLimit(e: unknown): e is Error & { errorCode: string } {
  const code = (e as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === 'string' && code.endsWith('-limit');
}

function lastOffset(set: Set<number> | undefined): number | null {
  let last: number | null = null;
  for (const o of set ?? []) if (last === null || o > last) last = o;
  return last;
}

async function resolveFragmented(w: Walk, walked: Walked, videos: IsoTrack[], built: Built[], analysis: ContainerAnalysis): Promise<void> {
  const { reader, plan, movie } = w;
  const size = reader.size;
  const tracks = movie.tracks.filter((t) => videos.includes(t) || t.handler === 'soun');
  const resolved = new Map<IsoTrack, Resolved>();
  const parsed = new Set<number>();
  let index: TailIndex | null = null;
  let limit: (Error & { errorCode: string }) | null = null;
  const first = walked.firstMoof;
  const head = first && first.size <= MOOF_HARD_CAP ? reader.peek(first.start, first.size) : null;
  if (first && head) parseFragment(w, head, first.start, parsed);
  const starts = new Map(tracks.map((tr) => [tr, timingOf(tr, movie, tr.fragments).startPts]));
  const firstCount = new Map(tracks.map((tr) => [tr, tr.fragments.length]));
  const open = (): IsoTrack[] => tracks.filter((t) => !resolved.has(t) && (videos.includes(t) || hasFragmentData(t, movie, index)));
  const bySidx = (ends: number[]): void => {
    for (const tr of open()) {
      const end = sidxEnd(movie, tr, ends);
      if (end !== null) resolved.set(tr, { ticks: Math.max(timingOf(tr, movie, []).durationTs, end), timescale: tr.timescale, provenance: 'header' });
    }
  };
  bySidx([size]);
  if (plan.index && open().length > 0) {
    try {
      index = await readTailIndex(w);
      if (index) {
        bySidx([size, size - index.mfraSize]);
        let from: number | null = null;
        for (const tr of open()) {
          const last = lastOffset(index.offsets.get(tr.id));
          if (last !== null && (from === null || last < from)) from = last;
        }
        if (from !== null) {
          const whole = first !== null && from <= first.start;
          await walkFragments(w, from, size - index.mfraSize, parsed);
          for (const tr of open()) {
            const tail = tr.fragments.slice(firstCount.get(tr) ?? 0);
            if (tail.length === 0 || (!whole && tail[0].baseDts === null)) continue;
            resolved.set(tr, { ticks: timingOf(tr, movie, tr.fragments).durationTs, timescale: tr.timescale, provenance: 'header' });
          }
        }
      }
    } catch (e) {
      if (isAbort(e, reader)) throw e;
      limit = w.budget.take() ?? (isLimit(e) ? e : null);
      if (!limit) throw e;
      for (const tr of tracks) tr.fragments.length = firstCount.get(tr) ?? 0;
    }
  }
  const mehd = walked.moov ? mehdDuration(walked.moov) : null;
  if (limit && mehd !== null && open().length > 0) analysis.warnings.push(`fragment index not read: ${limit.message}`);
  for (const tr of open()) if (mehd !== null) resolved.set(tr, { ticks: mehd, timescale: movie.timescale, provenance: 'estimated' });
  for (const tr of tracks) {
    if (resolved.has(tr) || videos.includes(tr) || hasFragmentData(tr, movie, index)) continue;
    const ticks = timingOf(tr, movie, []).durationTs;
    if (ticks > 0) resolved.set(tr, { ticks, timescale: tr.timescale, provenance: 'header' });
  }
  videos.forEach((tr, i) => {
    const t = built[i].result;
    const r = resolved.get(tr) ?? null;
    const p = t.provenance;
    t.frames = null;
    t.avgFps = null;
    t.avgFpsFfprobe = null;
    t.startSec = null;
    t.durationSec = r ? r.ticks / r.timescale : null;
    t.isStill = stillFragmented(tr, movie, index, parsed, r);
    delete p.frames;
    delete p.avgFps;
    delete p.startSec;
    if (r) p.durationSec = r.provenance;
    else delete p.durationSec;
  });
  const unresolved = open();
  for (const tr of unresolved) analysis.warnings.push(`format duration unresolved: track ${tr.id}`);
  let dur = 0;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let span = true;
  for (const [tr, r] of resolved) {
    const d = rescaleRound(r.ticks, 1e6, r.timescale);
    dur = Math.max(dur, d);
    const s = starts.get(tr) ?? null;
    if (r.provenance === 'estimated' || s === null) span = false;
    else {
      const at = rescaleRound(s, 1e6, tr.timescale);
      start = Math.min(start, at);
      end = Math.max(end, at + d);
    }
  }
  if (span && end >= start) dur = Math.max(dur, end - start);
  analysis.formatDurationSec = unresolved.length === 0 && dur > 0 ? dur / 1e6 : null;
  analysis.primaryTrackId = fragmentedPrimary(built);
  if (videos.length > 0 ? !videos.some((tr) => resolved.has(tr)) : resolved.size === 0 && unresolved.length > 0) {
    const err = limit ?? new IsoBmffError('no-duration', 'incomplete header: fragmented file without a sidx, mfra or mehd duration');
    analysis.error = err.message;
    analysis.errorCode = whichErrorCode(err);
  }
}

export async function analyzeIsoBmffHeader(reader: BlobReader, budget: HeaderBudget, plan: HeaderPlan): Promise<ContainerAnalysis> {
  const movie = newMovie(reader.size);
  const w: Walk = { reader, budget, plan, movie, boxes: 0 };
  const analysis = emptyAnalysis('mp4');
  analysis.scan = 'header';
  analysis.warnings = movie.warnings;
  analysis.errorCode = null;
  try {
    const walked = await walkTop(w);
    analysis.container = containerOf(movie);
    analysis.brand = movie.brand;
    const reject = movie.ffprobeReject;
    const ffprobeFails = reject !== null && reject.moof < movie.ffprobeMoofLimit;
    if (ffprobeFails) movie.warnings.push(`ffprobe 8.1.1 ${reject.reason}`);
    const ids = reportedIds(movie.tracks);
    if ([...ids].some(([t, id]) => t.id !== id)) movie.warnings.push('duplicate track_ID values');
    const videos = movie.tracks.filter((t) => isVideoTrack(t, movie));
    const built = videos.map((t) => buildVideoTrack(t, movie, { maxExpandedSamples: 0 }, { reportedId: ids.get(t) ?? t.id, ffprobeFails }));
    for (const b of built) headerTrack(b.result);
    analysis.videoTracks = built.map((b) => b.result);
    analysis.audioTrackCount = movie.tracks.filter((t) => t.handler === 'soun').length;
    if (walked.fragments) await resolveFragmented(w, walked, videos, built, analysis);
    else {
      analysis.primaryTrackId = pickPrimary(built);
      analysis.formatDurationSec = formatDuration(movie, new Set(videos));
    }
  } catch (e) {
    if (isAbort(e, reader)) throw e;
    const limit = budget.take();
    const message = limit ? limit.message : e instanceof Error ? e.message : String(e);
    analysis.container = containerOf(movie);
    analysis.brand = movie.brand;
    analysis.error = limit || (e as { errorCode?: unknown } | null)?.errorCode ? message : `corrupt file: ${message}`;
    analysis.errorCode = whichErrorCode(limit ?? e);
    analysis.videoTracks = [];
    analysis.audioTrackCount = 0;
    analysis.primaryTrackId = null;
    analysis.formatDurationSec = null;
  }
  analysis.layout = layoutOf(movie);
  return analysis;
}
