import { ALL_FORMATS, BlobSource, Input, MATROSKA, MP4, QTFF, WEBM, type InputFormat, type InputVideoTrack } from 'mediabunny';
import { createFile, Log, MP4BoxBuffer, type Movie } from 'mp4box';
import type { BlobLike } from '../../src/core/reader.ts';
import { emptyTrack } from '../../src/core/result.ts';
import type { ContainerKind, FileResult, NominalFps, Rational, VideoTrackResult } from '../../src/core/types.ts';
import { approxRational, codecNameFromFourcc, errorMessage, newResult } from '../../src/engines/common.ts';

export const MP4BOX_CHUNK = 1024 * 1024;

const MEDIABUNNY_CODECS: Readonly<Record<string, string>> = { avc: 'h264', hevc: 'hevc', vp8: 'vp8', vp9: 'vp9', av1: 'av1', prores: 'prores' };

class IoTally {
  reads = 0;
  #ranges: Array<[number, number]> = [];

  add(start: number, end: number): void {
    this.reads++;
    if (end > start) this.#ranges.push([start, end]);
  }

  unique(): number {
    const sorted = [...this.#ranges].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let reach = -1;
    for (const [s, e] of sorted) {
      if (e <= reach) continue;
      total += e - Math.max(s, reach);
      reach = e;
    }
    return total;
  }

  io(t0: number): FileResult['io'] {
    return { reads: this.reads, bytesRead: this.unique(), ms: performance.now() - t0 };
  }
}

function rationalOf(value: number | null): Rational | null {
  return value === null ? null : approxRational(value);
}

function containerOf(format: InputFormat): ContainerKind {
  if (format === MP4) return 'mp4';
  if (format === QTFF) return 'mov';
  if (format === WEBM) return 'webm';
  if (format === MATROSKA) return 'matroska';
  return 'unknown';
}

async function mediabunnyTrack(track: InputVideoTrack, targetPacketCount: number | undefined): Promise<VideoTrackResult> {
  const t = emptyTrack(track.id);
  const codec = await track.getCodec();
  t.codecName = codec ? (MEDIABUNNY_CODECS[codec] ?? codec) : '';
  t.width = await track.getCodedWidth();
  t.height = await track.getCodedHeight();
  t.startSec = await track.getFirstTimestamp();
  t.durationSec = await track.computeDuration();
  const m = await track.computeFrameRateMetrics(targetPacketCount === undefined ? undefined : { targetPacketCount });
  t.avgFps = rationalOf(m.averageFrameRate);
  t.minFps = rationalOf(m.minFrameRate);
  t.maxFps = rationalOf(m.maxFrameRate);
  const nominal = rationalOf(m.underlyingFrameRate ?? m.bestGuessFrameRate);
  const constant = m.underlyingFrameRate !== null && m.frameRateIsConstant;
  if (nominal) t.nominalFps = { ...nominal, kind: constant ? 'exact' : 'snapped' } satisfies NominalFps;
  if (nominal && constant) t.rFpsFfprobe = `${nominal.num}/${nominal.den}`;
  t.isVfr = !m.frameRateIsConstant;
  t.isStill = m.probedPacketCount <= 1;
  const full = targetPacketCount === Infinity;
  if (full) t.frames = m.probedPacketCount;
  const sampled = full ? 'exact' : 'sampled';
  Object.assign(t.provenance, { codec: 'header', dimensions: 'header', startSec: 'exact', durationSec: 'exact', avgFps: sampled, nominalFps: sampled, minFps: sampled, maxFps: sampled, isVfr: sampled });
  if (full) t.provenance.frames = 'exact';
  t.warnings.push(
    `computeFrameRateMetrics: average ${m.averageFrameRate}, median ${m.medianFrameRate}, best guess ${m.bestGuessFrameRate}, underlying ${m.underlyingFrameRate}, min ${m.minFrameRate}, max ${m.maxFrameRate}, constant ${m.frameRateIsConstant}, ${m.probedPacketCount} packets probed`,
  );
  return t;
}

export async function analyzeMediabunnyRecipe(blob: BlobLike, name: string, targetPacketCount?: number): Promise<FileResult> {
  const t0 = performance.now();
  const tally = new IoTally();
  const result = newResult(name, blob.size, 'mediabunny');
  if (!(blob instanceof Blob)) {
    result.error = 'BlobSource needs a Blob';
    return result;
  }
  const source = new BlobSource(blob);
  source.onread = (start, end) => tally.add(start, end);
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const format = await input.getFormat();
    result.container = containerOf(format);
    result.audioTrackCount = (await input.getAudioTracks()).length;
    result.formatDurationSec = await input.computeDuration();
    const primary = await input.getPrimaryVideoTrack();
    if (primary) {
      result.videoTracks = [await mediabunnyTrack(primary, targetPacketCount)];
      result.primaryTrackId = primary.id;
      result.scan = targetPacketCount === undefined ? 'probe' : 'exact';
    } else {
      result.warnings.push('no video track');
    }
  } catch (e) {
    result.error = errorMessage(e);
  } finally {
    input.dispose();
  }
  result.io = tally.io(t0);
  return result;
}

function mp4boxTrack(t: Movie['tracks'][number]): VideoTrackResult {
  const out = emptyTrack(t.id);
  out.fourccOrCodecId = t.codec.split('.')[0];
  out.codecName = codecNameFromFourcc(out.fourccOrCodecId);
  out.width = t.video?.width ?? t.track_width;
  out.height = t.video?.height ?? t.track_height;
  out.timescale = t.timescale;
  out.frames = t.nb_samples;
  out.durationSec = t.timescale > 0 ? t.duration / t.timescale : null;
  out.isStill = t.nb_samples <= 1;
  Object.assign(out.provenance, { codec: 'header', dimensions: 'header', frames: 'header', durationSec: 'header' });
  return out;
}

export async function analyzeMp4boxRecipe(blob: BlobLike, name: string, codecStrings?: Map<number, string>): Promise<FileResult> {
  const t0 = performance.now();
  const tally = new IoTally();
  const result = newResult(name, blob.size, 'mp4box');
  const logError = Log.error;
  Log.error = (module: string, message?: string) => {
    result.warnings.push(`mp4box log: ${module}: ${message}`);
  };
  const file = createFile();
  let info: Movie | null = null;
  let failure: string | null = null;
  file.onReady = (movie) => {
    info = movie;
  };
  file.onError = (module, message) => {
    failure ??= `${module}: ${message}`;
  };
  try {
    let pos = 0;
    while (info === null && failure === null && pos < blob.size) {
      const end = Math.min(blob.size, pos + MP4BOX_CHUNK);
      const bytes = await blob.slice(pos, end).arrayBuffer();
      tally.add(pos, end);
      const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, pos), end === blob.size);
      pos = typeof next === 'number' && next > pos ? next : end;
    }
    file.flush();
  } catch (e) {
    failure ??= errorMessage(e);
  } finally {
    Log.error = logError;
  }
  const movie = info as Movie | null;
  if (!movie) {
    result.error = failure ?? (blob.size === 0 ? 'empty file' : 'mp4box found no moov');
  } else {
    result.container = movie.brands.includes('qt  ') ? 'mov' : 'mp4';
    result.videoTracks = movie.tracks.filter((t) => t.video !== undefined).map(mp4boxTrack);
    for (const t of movie.tracks) if (t.video !== undefined) codecStrings?.set(t.id, t.codec);
    result.audioTrackCount = movie.audioTracks.length;
    result.primaryTrackId = result.videoTracks[0]?.trackId ?? null;
    const fragmented = movie.fragment_duration && movie.fragment_duration.den > 0 ? movie.fragment_duration.num / movie.fragment_duration.den : null;
    result.formatDurationSec = movie.duration > 0 && movie.timescale > 0 ? movie.duration / movie.timescale : fragmented;
    if (failure) result.warnings.push(`mp4box error after onReady: ${failure}`);
  }
  result.io = tally.io(t0);
  return result;
}

export async function mp4boxCodecStrings(blob: BlobLike): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  await analyzeMp4boxRecipe(blob, '', out);
  return out;
}
