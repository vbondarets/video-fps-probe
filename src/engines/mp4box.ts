import { createFile, Log, MP4BoxBuffer } from 'mp4box';
import type { ISOFile } from 'mp4box';
import { throwIfAborted } from '../core/abort.ts';
import { resolveOptions } from '../core/options.ts';
import { BlobReader, fourcc, u32, u64, type BlobLike } from '../core/reader.ts';
import { emptyTrack } from '../core/result.ts';
import { sniff } from '../core/sniff.ts';
import { analyzeTimeline, type EditWindow, type TimelineSegment } from '../core/stats.ts';
import type { AnalyzeOptions, ContainerKind, VideoTrackResult } from '../core/types.ts';
import type { ContainerFamily, EngineModule } from '../plugins/types.ts';
import { applyStats, codecNameFromFourcc, errorMessage, ffprobeRotation, isAbort, newResult } from './common.ts';
import { CountingBlob, now } from './counting.ts';
import type { Mp4boxNative, Mp4boxResult, Mp4boxTrackNative } from './types.ts';

export const MP4BOX_VERSION = '2.4.1';

type Moov = NonNullable<ISOFile['moov']>;
type Trak = Moov['traks'][number];
type Moof = ISOFile['moofs'][number];

interface TopBox {
  type: string;
  start: number;
  size: number;
  headerSize: number;
}

interface WalkState {
  file: ISOFile;
  reader: BlobReader;
  fedBuffers: number;
  fedBytes: number;
  moofsFed: number;
  warnings: string[];
}

const MAX_TOP_LEVEL_BOXES = 5_000_000;
const MDAT_PEEK = 16;
const HEADER_PROBE = 32;
const logSinks = new Set<string[]>();
let logHooked = false;

// mp4box prints parse errors with console.error and offers no switch to silence them.
function hookLog(): void {
  if (logHooked) return;
  logHooked = true;
  Log.setLogLevel(Log.error);
  Log.error = (module: string, message?: string): void => {
    for (const sink of logSinks) sink.push(`${module}: ${message}`);
  };
}

async function readTopBox(reader: BlobReader, pos: number): Promise<TopBox | null> {
  const dv = await reader.view(pos, HEADER_PROBE);
  if (dv.byteLength < 8) return null;
  let size = u32(dv, 0);
  let headerSize = 8;
  const type = fourcc(dv, 4);
  if (size === 1) {
    if (dv.byteLength < 16) return null;
    size = u64(dv, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = reader.size - pos;
  }
  if (size < headerSize) return null;
  return { type, start: pos, size, headerSize };
}

async function feed(st: WalkState, start: number, length: number): Promise<void> {
  const end = Math.min(start + length, st.reader.size);
  if (end <= start) return;
  const bytes = await st.reader.bytes(start, end - start);
  const buffer = new MP4BoxBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  buffer.fileStart = start;
  st.file.appendBuffer(buffer);
  st.fedBuffers++;
  st.fedBytes += bytes.byteLength;
}

async function nextIsMdat(reader: BlobReader, pos: number): Promise<TopBox | null> {
  if (pos + 8 > reader.size) return null;
  const next = await readTopBox(reader, pos);
  return next && next.type === 'mdat' ? next : null;
}

// mp4box parses a contiguous byte stream, so every skipped mdat still needs its header fed to let it jump over the payload.
async function walk(st: WalkState): Promise<void> {
  const { reader, file } = st;
  let pos = 0;
  let fedUntil = 0;
  let sawMoov = false;
  for (let count = 0; pos + 8 <= reader.size; count++) {
    if (count > MAX_TOP_LEVEL_BOXES) {
      st.warnings.push('walk stopped: too many top-level boxes');
      return;
    }
    reader.checkAbort();
    const box = await readTopBox(reader, pos);
    if (!box) {
      st.warnings.push(`walk stopped at ${pos}: invalid box header`);
      return;
    }
    const end = box.start + box.size;
    if (box.type === 'mfra') return;
    if (box.type === 'mdat') {
      if (box.start >= fedUntil) {
        const peek = Math.min(MDAT_PEEK, box.size);
        await feed(st, box.start, peek);
        fedUntil = box.start + peek;
      }
    } else if (box.type === 'moof') {
      if (!sawMoov) {
        st.warnings.push('moof before moov ignored');
      } else {
        const mdat = await nextIsMdat(reader, end);
        const tail = mdat ? Math.min(MDAT_PEEK, mdat.size) : 0;
        await feed(st, box.start, box.size + tail);
        st.moofsFed++;
        fedUntil = end + tail;
      }
    } else {
      await feed(st, box.start, box.size);
      fedUntil = end;
      if (box.type === 'moov') {
        sawMoov = true;
        if (!file.moov || !file.moov.mvex) return;
      }
    }
    if (end <= pos) return;
    pos = end;
  }
}

function editInfo(
  entries: ReadonlyArray<{ segment_duration: number; media_time: number; media_rate_integer: number }>,
  mediaTimescale: number,
  movieTimescale: number,
  warnings: string[],
): { window: EditWindow | null; leadingEmptySec: number } {
  let window: EditWindow | null = null;
  let leadingEmpty = 0;
  for (const e of entries) {
    if (e.media_time === -1) {
      if (window) warnings.push('empty edit after a media edit ignored');
      else leadingEmpty += e.segment_duration;
      continue;
    }
    if (window) {
      warnings.push('multiple media edits: only the first is applied');
      break;
    }
    if (e.media_rate_integer !== 1) warnings.push(`edit rate ${e.media_rate_integer} not applied`);
    const end =
      e.segment_duration > 0 && movieTimescale > 0
        ? e.media_time + Math.round((e.segment_duration * mediaTimescale) / movieTimescale)
        : Infinity;
    window = { start: e.media_time, end };
  }
  return { window, leadingEmptySec: movieTimescale > 0 ? leadingEmpty / movieTimescale : 0 };
}

function trexDefaultDuration(moov: Moov, trackId: number): number {
  const trex = moov.mvex?.trexs?.find((t) => t.track_id === trackId);
  return trex ? trex.default_sample_duration : 0;
}

function buildSegments(trak: Trak, moov: Moov, moofs: readonly Moof[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  const trackId = trak.tkhd.track_id;
  const stbl = trak.mdia.minf.stbl;
  const stts = stbl.stts;
  const ctts = stbl.ctts;
  if (stts && stts.sample_counts.length > 0) {
    segments.push({
      baseDts: 0,
      durations: { counts: stts.sample_counts, deltas: stts.sample_deltas },
      cts: ctts ? { counts: ctts.sample_counts, offsets: ctts.sample_offsets } : null,
    });
  }
  const trexDuration = trexDefaultDuration(moov, trackId);
  for (const moof of moofs) {
    for (const traf of moof.trafs) {
      if (traf.tfhd.track_id !== trackId) continue;
      const defaultDuration = traf.tfhd.flags & 0x08 ? traf.tfhd.default_sample_duration : trexDuration;
      const durations: number[] = [];
      const cts: number[] = [];
      let hasCts = false;
      for (const trun of traf.truns) {
        const perSampleDuration = (trun.flags & 0x100) !== 0;
        const perSampleCts = (trun.flags & 0x800) !== 0;
        if (perSampleCts) hasCts = true;
        for (let k = 0; k < trun.sample_count; k++) {
          durations.push(perSampleDuration ? (trun.sample_duration[k] ?? defaultDuration) : defaultDuration);
          cts.push(perSampleCts ? (trun.sample_composition_time_offset[k] ?? 0) : 0);
        }
      }
      if (durations.length === 0) continue;
      segments.push({ baseDts: traf.tfdt ? traf.tfdt.baseMediaDecodeTime : undefined, durations, cts: hasCts ? cts : null });
    }
  }
  return segments;
}

function segmentTicks(d: TimelineSegment['durations']): number {
  let n = 0;
  if ('counts' in d) for (let i = 0; i < d.counts.length; i++) n += d.counts[i] * d.deltas[i];
  else for (let i = 0; i < d.length; i++) n += d[i];
  return n;
}

function trackEndTicks(segments: readonly TimelineSegment[]): number {
  let end = 0;
  let max = 0;
  for (const s of segments) {
    if (s.baseDts !== undefined && s.baseDts !== null) end = s.baseDts;
    end += segmentTicks(s.durations);
    if (end > max) max = end;
  }
  return max;
}

function sumCounts(counts: ArrayLike<number> | undefined): number {
  let n = 0;
  if (counts) for (let i = 0; i < counts.length; i++) n += counts[i];
  return n;
}

function nativeView(trak: Trak, moov: Moov): Mp4boxTrackNative {
  const samples = trak.samples ?? [];
  const stts = trak.mdia.minf.stbl.stts;
  const ts = trak.mdia.mdhd.timescale;
  const n = samples.length;
  const sttsLastDelta = stts && stts.sample_deltas.length > 0 ? stts.sample_deltas[stts.sample_deltas.length - 1] : null;
  const moovCount = sumCounts(stts?.sample_counts);
  const moovLast = moovCount > 0 ? samples[moovCount - 1] : undefined;
  const mdhdDuration = trak.mdia.mdhd.duration;
  const movieDuration = moov.mvhd.duration;
  const rate = (duration: number, timescale: number): number | null =>
    n > 0 && duration > 0 && timescale > 0 ? (n * timescale) / duration : null;
  return {
    trackId: trak.tkhd.track_id,
    sampleCount: n,
    sttsLastDelta,
    lastSampleDuration: n > 0 ? samples[n - 1].duration : null,
    lastDurationOverridden: !!moovLast && sttsLastDelta !== null && moovLast.duration !== sttsLastDelta,
    fpsFromSampleDurations: rate(trak.samples_duration, ts),
    fpsFromMdhdDuration: rate(mdhdDuration, ts),
    fpsFromMovieDuration: rate(movieDuration, moov.mvhd.timescale),
  };
}

function nativeWarning(native: Mp4boxTrackNative): string {
  const f = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(4));
  const override = native.lastDurationOverridden
    ? `, last sample duration ${native.lastSampleDuration} overrides stts delta ${native.sttsLastDelta}`
    : '';
  return (
    `mp4box native: ${native.sampleCount} samples, ${f(native.fpsFromSampleDurations)} fps from sample durations, ` +
    `${f(native.fpsFromMdhdDuration)} fps from mdhd duration, ${f(native.fpsFromMovieDuration)} fps from movie duration${override}`
  );
}

function buildTrack(
  trak: Trak,
  moov: Moov,
  moofs: readonly Moof[],
  maxExpandedSamples: number,
): { track: VideoTrackResult; native: Mp4boxTrackNative } {
  const trackId = trak.tkhd.track_id;
  const track = emptyTrack(trackId);
  const mdhd = trak.mdia.mdhd;
  const ts = mdhd.timescale;
  const entry = trak.mdia.minf.stbl.stsd?.entries?.[0] as { type?: string; width?: number; height?: number } | undefined;
  track.fourccOrCodecId = entry?.type ?? '';
  track.codecName = codecNameFromFourcc(track.fourccOrCodecId);
  track.width = entry?.width ?? 0;
  track.height = entry?.height ?? 0;
  if ((!track.width || !track.height) && trak.tkhd.width > 0 && trak.tkhd.height > 0) {
    track.width = Math.round(trak.tkhd.width / 65536);
    track.height = Math.round(trak.tkhd.height / 65536);
    track.warnings.push('dimensions taken from tkhd: the sample entry was not parsed by mp4box');
  }
  track.rotation = trak.tkhd.matrix ? ffprobeRotation(trak.tkhd.matrix) : 0;
  track.timescale = ts;
  track.provenance.codec = 'header';
  track.provenance.dimensions = 'header';
  track.provenance.rotation = 'header';

  const edits = trak.edts?.elst?.entries ?? [];
  const edit = editInfo(edits, ts, moov.mvhd.timescale, track.warnings);
  const segments = buildSegments(trak, moov, moofs);
  const stats = analyzeTimeline({
    timescale: ts,
    segments,
    editWindow: edit.window,
    maxExpandedSamples,
  });
  applyStats(track, stats);

  const windowStart = edit.window ? edit.window.start : 0;
  if (stats.firstPts !== null && ts > 0) {
    track.startSec = (stats.firstPts - windowStart) / ts + edit.leadingEmptySec;
    track.provenance.startSec = 'header';
  }
  const fragmented = moofs.length > 0;
  let ticks = edit.window && edit.window.end !== Infinity ? edit.window.end - edit.window.start : fragmented ? trackEndTicks(segments) : stats.durationSum;
  if (!fragmented) {
    if (mdhd.duration > 0) ticks = Math.min(ticks, mdhd.duration);
    if (stats.durationSum > 0) ticks = Math.min(ticks, stats.durationSum);
  }
  if (ts > 0 && ticks > 0) {
    track.durationSec = ticks / ts;
    track.provenance.durationSec = 'header';
  }

  const native = nativeView(trak, moov);
  track.warnings.push(nativeWarning(native));
  return { track, native };
}

function pickPrimary(tracks: VideoTrackResult[], enabled: ReadonlyMap<number, boolean>): number | null {
  let best: VideoTrackResult | null = null;
  const rank = (t: VideoTrackResult): number[] => [(t.frames ?? 0) > 1 ? 1 : 0, enabled.get(t.trackId) ? 1 : 0, t.frames ?? 0];
  for (const t of tracks) {
    if (!best) {
      best = t;
      continue;
    }
    const a = rank(t);
    const b = rank(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (a[i] > b[i]) best = t;
        break;
      }
    }
  }
  return best ? best.trackId : null;
}

function containerOf(brand: string | null): ContainerKind {
  return brand === 'qt  ' ? 'mov' : 'mp4';
}

async function probe(counted: CountingBlob, result: Mp4boxResult, opts: AnalyzeOptions): Promise<void> {
  const resolved = resolveOptions(opts);
  const reader = new BlobReader(counted, { headWindow: resolved.readAhead.head, signal: resolved.signal });
  if (reader.size === 0) {
    result.error = 'not a recognised container: empty file';
    return;
  }
  const sniffed = sniff(await reader.bytes(0, Math.min(1024, reader.size)));
  if (sniffed.kind === 'unknown') {
    result.error = `not a recognised container: ${sniffed.reason}`;
    return;
  }
  if (sniffed.kind === 'matroska') {
    result.container = 'matroska';
    result.error = 'unsupported by mp4box';
    return;
  }
  result.container = 'mp4';

  hookLog();
  const file = createFile();
  const parseErrors: string[] = [];
  const st: WalkState = { file, reader, fedBuffers: 0, fedBytes: 0, moofsFed: 0, warnings: [] };
  logSinks.add(parseErrors);
  try {
    await walk(st);
  } catch (e) {
    if (isAbort(e, resolved.signal)) throw e;
    if (!file.moov) throw e;
    st.warnings.push(`walk stopped: ${errorMessage(e)}`);
  } finally {
    logSinks.delete(parseErrors);
  }
  resolved.onProgress?.({ phase: 'read', done: 1, total: 2 });
  result.warnings.push(...st.warnings);
  for (const m of parseErrors.slice(0, 3)) result.warnings.push(`mp4box log: ${m}`);

  const moov = file.moov;
  if (!moov) throw new Error(parseErrors.length > 0 ? `mp4box could not parse moov: ${parseErrors[0]}` : 'incomplete file: no moov');

  const brand = file.ftyp ? file.ftyp.major_brand : null;
  result.brand = brand;
  result.container = containerOf(brand);

  const tracks: VideoTrackResult[] = [];
  const enabled = new Map<number, boolean>();
  let audio = 0;
  let formatTicks = 0;
  const natives: Mp4boxTrackNative[] = [];
  for (const trak of moov.traks) {
    const handler = trak.mdia?.hdlr?.handler;
    if (handler === 'soun') {
      audio++;
      const mdhd = trak.mdia.mdhd;
      const d = Math.min(mdhd?.duration || Infinity, trak.samples_duration || Infinity);
      if (mdhd && mdhd.timescale > 0 && Number.isFinite(d)) formatTicks = Math.max(formatTicks, d / mdhd.timescale);
      continue;
    }
    if (handler !== 'vide') continue;
    try {
      const { track, native } = buildTrack(trak, moov, file.moofs, resolved.maxExpandedSamples);
      tracks.push(track);
      enabled.set(track.trackId, (trak.tkhd.flags & 1) !== 0);
      natives.push(native);
      if (track.durationSec !== null) formatTicks = Math.max(formatTicks, track.durationSec + (track.startSec ?? 0));
    } catch (e) {
      if (isAbort(e, resolved.signal)) throw e;
      result.warnings.push(`track ${trak.tkhd.track_id}: ${errorMessage(e)}`);
    }
  }
  resolved.onProgress?.({ phase: 'analyze', done: 2, total: 2 });
  result.videoTracks = tracks;
  result.audioTrackCount = audio;
  result.primaryTrackId = pickPrimary(tracks, enabled);
  result.formatDurationSec = formatTicks > 0 ? formatTicks : null;
  result.scan = tracks.length > 0 ? 'exact' : null;
  if (tracks.length === 0) result.warnings.push('no video track');

  const native: Mp4boxNative = {
    version: MP4BOX_VERSION,
    fedBuffers: st.fedBuffers,
    fedBytes: st.fedBytes,
    moofsFed: st.moofsFed,
    tracks: natives,
  };
  result.mp4box = native;
}

export async function analyzeWithMp4box(blob: BlobLike, name: string, opts: AnalyzeOptions = {}): Promise<Mp4boxResult> {
  const t0 = now();
  throwIfAborted(opts.signal);
  const counted = new CountingBlob(blob, opts.signal ?? null);
  const result: Mp4boxResult = newResult(name, blob.size, 'mp4box');
  try {
    await probe(counted, result, opts);
  } catch (e) {
    if (isAbort(e, opts.signal)) throw e;
    result.error = errorMessage(e);
  }
  result.io = counted.io(t0);
  return result;
}

export const containers = ['isobmff'] as const satisfies readonly ContainerFamily[];

export const run: EngineModule<Mp4boxResult>['run'] = analyzeWithMp4box;
