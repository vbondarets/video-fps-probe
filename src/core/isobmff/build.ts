import { emptyTrack } from '../result.ts';
import type { analyzeTimeline, ProfileJob } from '../stats.ts';
import { toFfprobeString } from '../rational.ts';
import type { ContainerKind, ContainerLayout, ResolvedAnalyzeOptions, VideoTrackResult } from '../types.ts';
import { IsoBmffError, readBoxHeader, type BoxHeader } from './boxes.ts';
import type { BlobReader } from '../reader.ts';
import { codecNameFor, isVideoFourcc } from './codecs.ts';
import type { IsoMovie, IsoTrack, TopBox } from './model.ts';
import { parseMoof, parseSidx } from './moof.ts';
import { parseMoov } from './moov.ts';
import { mfraMoofOffsets, newPrefetch, prefetchNext, prefetched } from './prefetch.ts';
import {
  averageRates,
  displayRotation,
  editInfo,
  ffprobeStage1Rate,
  missingMandatoryAtoms,
  moovSamplesInFile,
  presentationWindow,
  rescaleRound,
  sampleTotals,
  timelineSegments,
  trackTiming,
} from './track.ts';

export const MOOV_SUSPECT_CAP = 16 * 1024 * 1024;
export const MOOV_HARD_CAP = 256 * 1024 * 1024;
export const MOOF_HARD_CAP = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 4_000_000;
const SMALL_MDAT = 64 * 1024;
const HEADER_PEEK = 16;

export function isAbort(e: unknown, reader: BlobReader): boolean {
  return reader.signal?.aborted === true || (e as { name?: unknown } | null)?.name === 'AbortError';
}

export function containerOf(movie: IsoMovie): ContainerKind {
  return movie.brand === 'qt  ' || (!movie.hasFtyp && movie.topLevel.length > 0) ? 'mov' : 'mp4';
}

export async function readMoov(reader: BlobReader, h: BoxHeader, movie: IsoMovie, copyMoov?: boolean): Promise<void> {
  const size = reader.size;
  const beyond = h.start + h.size > size;
  if (!beyond && h.size > MOOV_HARD_CAP) throw new IsoBmffError('too-large', 'unsupported: moov larger than 256 MiB');
  const len = beyond ? Math.min(size - h.start, MOOV_SUSPECT_CAP) : h.size;
  const read = await reader.view(h.start, len, 0);
  const dv = copyMoov ? new DataView(read.buffer.slice(read.byteOffset, read.byteOffset + len)) : read;
  const mh = readBoxHeader(dv, 0, dv.byteLength);
  if (!mh) throw new IsoBmffError('truncated', 'incomplete file: moov is truncated');
  parseMoov(dv, mh, movie, beyond, h.start);
  if (beyond) movie.warnings.push('moov size exceeds the file; parsed what is there');
}

export async function walk(reader: BlobReader, opts: ResolvedAnalyzeOptions, movie: IsoMovie): Promise<void> {
  const size = reader.size;
  let pos = 0;
  let ahead = opts.readAhead.head;
  let sawMoov = false;
  let boxes = 0;
  let afterMdat = false;
  const pf = newPrefetch();
  const look = async (at: number, need: number, readAhead: number): Promise<DataView> => prefetched(pf, at, need) ?? reader.view(at, need, readAhead);
  while (pos + 8 <= size) {
    reader.checkAbort();
    if (++boxes > MAX_TOP_LEVEL_BOXES) {
      movie.warnings.push('too many top-level boxes');
      break;
    }
    const tailRead = afterMdat && !sawMoov && size - pos <= MOOV_SUSPECT_CAP ? size - pos : ahead;
    const hv = await look(pos, Math.min(HEADER_PEEK, size - pos), tailRead);
    let rel: BoxHeader | null;
    try {
      rel = readBoxHeader(hv, 0, size - pos, pos);
    } catch (e) {
      if (!sawMoov) throw e;
      movie.warnings.push(`ignored trailing data at ${pos}: ${(e as Error).message}`);
      break;
    }
    if (!rel) break;
    const h: BoxHeader = { ...rel, start: pos, end: Math.min(pos + rel.size, size) };
    const boxEnd = pos + rel.size;
    const trailer = rel.truncated && sawMoov && h.type !== 'mdat' && h.type !== 'moof';
    if (rel.truncated) {
      movie.truncated = true;
      movie.warnings.push(trailer ? `ignored trailing data at ${pos}: not a box` : `'${h.type}' at ${pos} is truncated`);
    }
    const top: TopBox = { type: h.type, start: pos, end: h.end, sidx: null };
    movie.topLevel.push(top);
    if (trailer) break;
    if (h.type === 'ftyp') {
      const fv = await reader.view(pos, Math.min(h.size, 1024));
      const p = h.headerSize;
      if (p + 4 <= fv.byteLength) {
        movie.hasFtyp = true;
        movie.brand = String.fromCharCode(fv.getUint8(p), fv.getUint8(p + 1), fv.getUint8(p + 2), fv.getUint8(p + 3));
        for (let q = p + 8; q + 4 <= fv.byteLength; q += 4) {
          movie.compatibleBrands.push(String.fromCharCode(fv.getUint8(q), fv.getUint8(q + 1), fv.getUint8(q + 2), fv.getUint8(q + 3)));
        }
      }
    } else if (h.type === 'moov') {
      if (sawMoov) movie.warnings.push(`ignored a second moov at ${pos}`);
      else {
        movie.moov = [pos, rel.size];
        await readMoov(reader, h, movie, opts.codecConfig);
        sawMoov = true;
      }
    } else if (h.type === 'moof') {
      if (!sawMoov) throw new IsoBmffError('corrupt', 'corrupt file: movie fragment (moof) before moov');
      if (h.size > MOOF_HARD_CAP) throw new IsoBmffError('too-large', `corrupt file: moof larger than 64 MiB at ${pos}`);
      const want = Math.min(h.size + HEADER_PEEK, size - pos);
      const dv = await look(pos, want, 0);
      const mh = readBoxHeader(dv, 0, Math.min(h.size, dv.byteLength));
      if (mh) parseMoof(dv, mh, pos, movie.moofCount, movie, opts.maxExpandedSamples);
      movie.moofCount++;
      let gap = 0;
      try {
        const next = readBoxHeader(dv, h.size, dv.byteLength);
        if (next && next.type === 'mdat') gap = next.size;
      } catch {
        gap = 0;
      }
      ahead = gap <= SMALL_MDAT ? opts.readAhead.fragment : Math.min(65536, Math.max(1024, 2 * h.size + 64));
      if (gap > SMALL_MDAT) {
        if (!pf.hints.length && !pf.mfraTried && (size - pos) / (h.size + gap) > 16) {
          pf.mfraTried = true;
          pf.hints = await mfraMoofOffsets(reader);
        }
        if (pf.next < pf.hints.length && !prefetched(pf, pos + h.size + gap, HEADER_PEEK)) await prefetchNext(reader, pf, pos, ahead);
      }
      if (opts.onProgress && movie.moofCount % 64 === 0) opts.onProgress({ phase: 'fragments', done: pos, total: size });
    } else if (h.type === 'sidx' && !rel.truncated) {
      const dv = await look(pos, h.size, 0);
      const sh = readBoxHeader(dv, 0, dv.byteLength);
      if (sh) top.sidx = parseSidx(dv, sh, pos);
      if (top.sidx && top.sidx.subsegments.length > 1 && !pf.hints.length) pf.hints = top.sidx.subsegments.map(([o]) => o);
    } else if (h.type === 'mfra') {
      break;
    }
    afterMdat = h.type === 'mdat';
    pos = boxEnd;
  }
  if (!sawMoov) throw new IsoBmffError('no-header', 'incomplete file: no moov');
}

export async function emulateFfprobeExtent(reader: BlobReader, movie: IsoMovie): Promise<void> {
  const size = reader.size;
  const ids = new Set(movie.tracks.map((t) => t.id));
  let foundMoov = false;
  let foundMdat = false;
  let complete = false;
  let mfraSize: number | null = null;
  let moofs = 0;
  for (const b of movie.topLevel) {
    if (b.type === 'moof') moofs++;
    else if (b.type === 'moov') foundMoov = true;
    else if (b.type === 'mdat' && b.end - b.start > 8) foundMdat = true;
    else if (b.type === 'sidx' && foundMoov && b.sidx && !b.sidx.hierarchical && ids.has(b.sidx.referenceId)) {
      let whole = b.sidx.coverageEnd === size;
      if (!whole && size >= 4) {
        if (mfraSize === null) mfraSize = (await reader.view(size - 4, 4, 0)).getUint32(0);
        whole = b.sidx.coverageEnd === size - mfraSize;
      }
      if (whole && b.sidx.firstOffset === 0) complete = true;
    }
    if (foundMoov && foundMdat && (complete || b.end === size)) {
      movie.ffprobeMoofLimit = moofs;
      return;
    }
  }
}

export function layoutOf(movie: IsoMovie): ContainerLayout | null {
  let mdat = Infinity;
  let moof = false;
  let sidx = false;
  for (const b of movie.topLevel) {
    if (b.type === 'mdat') mdat = Math.min(mdat, b.start);
    moof ||= b.type === 'moof';
    sidx ||= !moof && b.type === 'sidx';
  }
  const moov = movie.moov;
  const moovAt = moov ? moov[0] : Infinity;
  if (moovAt === mdat) return null;
  const kind = movie.hasMvex ? 'fragmented' : mdat < moovAt ? 'moov-at-end' : 'faststart';
  return {
    kind,
    moovOffset: moov ? moovAt : null,
    moovSize: moov ? moov[1] : null,
    sidx,
    emptyMoov: kind === 'fragmented' && movie.tracks.every((t) => !isVideoTrack(t, movie) || !t.sampleCount),
  };
}

export function isVideoTrack(tr: IsoTrack, movie: IsoMovie): boolean {
  if (movie.chapterTrackIds.has(tr.id)) return false;
  if (tr.handler === 'vide') return true;
  if (tr.handler === 'soun') return false;
  return isVideoFourcc(tr.originalFormat ?? tr.sampleEntry);
}

const STATS_FIELDS = ['presentedFrames', 'minFps', 'maxFps', 'medianFrameInterval', 'isVfr', 'vfrRatio', 'distinctDeltas', 'duplicateTimestamps', 'nominalFps', 'dominantFps', 'timestampsQuantized'] as const;
type StatsField = (typeof STATS_FIELDS)[number];

export interface Built {
  result: VideoTrackResult;
  enabled: boolean;
  auxiliary: boolean;
  profile?: ProfileJob | null;
}

export interface BuildContext {
  reportedId: number;
  ffprobeFails: boolean;
}

export function buildVideoTrack(tr: IsoTrack, movie: IsoMovie, opts: Pick<ResolvedAnalyzeOptions, 'maxExpandedSamples' | 'codecConfig'>, ctx: BuildContext, timeline?: typeof analyzeTimeline): Built {
  const t = emptyTrack(ctx.reportedId);
  const w = t.warnings;
  if (ctx.reportedId !== tr.id) w.push(`duplicate track_ID ${tr.id}: reported as ${ctx.reportedId}`);
  w.push(...tr.warnings);
  const auxiliary = tr.handler === 'auxv';
  if (auxiliary) w.push("auxiliary video track (handler 'auxv')");
  const broken = missingMandatoryAtoms(tr);
  if (broken) w.push('missing mandatory sample tables: ffprobe ignores the samples and timing of this track');
  const ts = tr.hasMdhd ? tr.timescale : movie.timescale;
  if (!tr.hasMdhd) {
    w.push('no mdhd: using the movie timescale');
    tr.timescale = ts;
  }
  t.fourccOrCodecId = tr.sampleEntry;
  t.codecName = codecNameFor(tr.originalFormat ?? tr.sampleEntry, tr.esdsObjectType, tr.hasHvcc);
  if (tr.originalFormat) w.push(`encrypted: ${tr.sampleEntry} of ${tr.originalFormat}`);
  if (tr.stsdCount > 1) w.push(`${tr.stsdCount} sample descriptions, first used`);
  t.width = tr.width;
  t.height = tr.height;
  t.rotation = displayRotation(tr.matrix, movie.matrix);
  t.enabled = tr.enabled;
  t.timescale = ts;
  if (opts.codecConfig) t.codecConfig = { family: 'isobmff-moov', moov: tr.dv as DataView, trak: movie.tracks.indexOf(tr) };

  const totals = sampleTotals(tr);
  const truncated = movie.truncated;
  let presentFragments = 0;
  for (const f of tr.fragments) presentFragments += f.present;
  const total = totals.moovSamples + totals.fragmentSamples;
  const frames = totals.moovSamples + presentFragments;
  t.frames = frames;
  t.isStill = frames <= 1;
  if (totals.moovSamples > 0 && tr.fragments.length > 0) {
    w.push(`hybrid fragmented file: moov holds ${totals.moovSamples} of ${total} samples`);
  }
  if (frames < total) w.push(`truncated: ${total - frames} of ${total} samples missing`);

  const rates = averageRates(tr, movie);
  t.avgFps = rates.avg;
  t.avgFpsFfprobe = ctx.ffprobeFails ? null : rates.ffprobe;
  if (t.avgFpsFfprobe !== null && t.avgFpsFfprobe !== toFfprobeString(rates.avg)) {
    w.push(`ffprobe reads part of the fragments: avg_frame_rate ${t.avgFpsFfprobe}`);
  }
  if (rates.ffprobe === null && !ctx.ffprobeFails && total > 0) w.push('avg_frame_rate of ffprobe is not reproduced: its header values are incomplete or overrun a box');
  const r = !timeline || ctx.ffprobeFails || broken ? null : ffprobeStage1Rate(tr, movie, totals.moovSamples, opts.maxExpandedSamples, w);
  t.rFpsFfprobe = r ? toFfprobeString(r) : null;

  const edits = editInfo(tr, movie.timescale, totals);
  if (!broken) {
    const timing = trackTiming(tr, movie, totals, edits);
    t.durationSec = timing.durationTs / ts;
    t.startSec = timing.startPts === null ? null : timing.startPts / ts;
  }

  let moovKeep = totals.moovSamples;
  if (tr.sampleCount !== null && tr.sampleCount < moovKeep) {
    w.push(`stts describes ${moovKeep} samples but the sample size table holds ${tr.sampleCount}`);
    moovKeep = tr.sampleCount;
  }
  if (broken || !timeline) {
    t.presentedFrames = 0;
    finishProvenance(t);
    return { result: t, enabled: tr.enabled, auxiliary };
  }
  if (truncated && moovKeep > 0) {
    const inFile = moovSamplesInFile(tr, movie.fileSize, totals.moovSamples);
    if (inFile && inFile.complete < moovKeep) {
      w.push(`truncated: ${inFile.complete} of ${moovKeep} samples complete`);
      moovKeep = inFile.complete;
    }
  }
  let window = presentationWindow(tr, edits, w);
  if (window && !tr.cttsCounts && !tr.fragments.length && window.start <= 0 && (window.end <= window.start || window.end >= totals.moovDuration)) window = null;
  const stats = timeline({
    segments: timelineSegments(tr, moovKeep),
    timescale: ts,
    editWindow: window,
    maxExpandedSamples: opts.maxExpandedSamples,
  });
  w.push(...stats.warnings);
  for (const k of STATS_FIELDS) (t as Record<StatsField, unknown>)[k] = stats[k];
  if (stats.presentedAvgFps) t.avgFps = stats.presentedAvgFps;
  if (t.duplicateTimestamps > 0) w.push(`${t.duplicateTimestamps} duplicate timestamps`);
  finishProvenance(t);
  if (stats.presentedAvgFps) t.provenance.avgFps = 'exact';
  return { result: t, enabled: tr.enabled, auxiliary, profile: stats.profile };
}

export function finishProvenance(t: VideoTrackResult): void {
  const p = t.provenance;
  for (const k of ['codec', 'dimensions', 'rotation', 'frames', 'avgFps'] as const) p[k] = 'header';
  if (t.durationSec !== null) p.durationSec = 'header';
  if (t.startSec !== null) p.startSec = 'header';
  if (t.presentedFrames !== null) p.presentedFrames = 'exact';
  if (t.isVfr !== null) {
    p.minFps = 'exact';
    p.maxFps = 'exact';
    p.isVfr = 'exact';
    p.duplicateTimestamps = 'exact';
    p.medianFrameInterval = 'exact';
  }
  if (t.nominalFps) p.nominalFps = 'exact';
  if (t.dominantFps) p.dominantFps = 'exact';
}

export function pickPrimary(built: Built[]): number | null {
  let best: Built | null = null;
  const score = (b: Built): number => ((b.result.frames ?? 0) > 1 ? (b.auxiliary ? 0.5 : b.enabled ? 2 : 1) : 0);
  for (const b of built) {
    if (!best || score(b) > score(best) || (score(b) === score(best) && (b.result.frames ?? 0) > (best.result.frames ?? 0))) best = b;
  }
  return best ? best.result.trackId : null;
}

const DEFAULT_STREAM_TIMEBASE = 90000;

export function formatDuration(movie: IsoMovie, videoTracks: Set<IsoTrack>): number | null {
  const NONE = Number.MAX_SAFE_INTEGER;
  let start = NONE;
  let startText = NONE;
  let end = -NONE;
  let endText = -NONE;
  let dur = -NONE;
  let durText = -NONE;
  for (const tr of movie.tracks) {
    if (!tr.hasMdhd) continue;
    const main = videoTracks.has(tr) || tr.handler === 'soun';
    if (missingMandatoryAtoms(tr)) {
      const d = rescaleRound(tr.mdhdDuration, 1e6, DEFAULT_STREAM_TIMEBASE);
      if (main) dur = Math.max(dur, d);
      else durText = Math.max(durText, d);
      continue;
    }
    const totals = sampleTotals(tr);
    const timing = trackTiming(tr, movie, totals, editInfo(tr, movie.timescale, totals));
    const d = rescaleRound(timing.durationTs, 1e6, tr.timescale);
    if (timing.startPts !== null) {
      const s = rescaleRound(timing.startPts, 1e6, tr.timescale);
      if (main) {
        start = Math.min(start, s);
        end = Math.max(end, s + d);
      } else {
        startText = Math.min(startText, s);
        endText = Math.max(endText, s + d);
      }
    }
    if (main) dur = Math.max(dur, d);
    else durText = Math.max(durText, d);
  }
  if (start === NONE || (start > startText && start - startText < 1e6)) start = startText;
  if (end === -NONE || (end < endText && endText - end < 1e6)) end = endText;
  if (dur === -NONE || (dur < durText && durText - dur < 1e6)) dur = durText;
  if (start !== NONE && end !== -NONE && end >= start) dur = Math.max(dur, end - start);
  return dur > 0 ? dur / 1e6 : null;
}

export function reportedIds(tracks: IsoTrack[]): Map<IsoTrack, number> {
  const out = new Map<IsoTrack, number>();
  const seen = new Set<number>();
  let next = tracks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  for (const t of tracks) {
    if (seen.has(t.id)) out.set(t, next++);
    else {
      seen.add(t.id);
      out.set(t, t.id);
    }
  }
  return out;
}
