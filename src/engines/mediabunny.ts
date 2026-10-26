import { CustomSource, EncodedPacketSink, Input, Logging, LogLevel, MATROSKA, MP4, QTFF, WEBM } from 'mediabunny';
import type { InputFormat, InputVideoTrack } from 'mediabunny';
import { throwIfAborted } from '../core/abort.ts';
import { resolveOptions } from '../core/options.ts';
import type { BlobLike } from '../core/reader.ts';
import { emptyTrack } from '../core/result.ts';
import { analyzeTimeline } from '../core/stats.ts';
import type { AnalyzeOptions, ContainerKind, VideoTrackResult } from '../core/types.ts';
import type { EngineModule } from '../plugins/types.ts';
import { applyStats, approxRational, codecNameFromFourcc, errorMessage, isAbort, newResult, printableWarnings } from './common.ts';
import { CountingBlob, elapsed, now } from './counting.ts';
import type { MediabunnyNative, MediabunnyResult, MediabunnyTrackNative } from './types.ts';

export const MEDIABUNNY_VERSION = '1.62.1';

const CODEC_NAMES: Readonly<Record<string, string>> = {
  avc: 'h264',
  hevc: 'hevc',
  vp8: 'vp8',
  vp9: 'vp9',
  av1: 'av1',
  prores: 'prores',
};

const FORMATS: InputFormat[] = [MP4, QTFF, WEBM, MATROSKA];

// computePacketStats() iterates sink.packets(), whose queue stalls for tens of seconds on tracks with ~500k packets.
export const NATIVE_STATS_MAX_PACKETS = 150_000;

function containerOf(format: InputFormat): ContainerKind {
  if (format === MP4) return 'mp4';
  if (format === QTFF) return 'mov';
  if (format === WEBM) return 'webm';
  return 'matroska';
}

function internalCodecString(id: string | number | Uint8Array | null): string {
  if (id === null) return '';
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return `0x${id.toString(16)}`;
  let s = '';
  for (const b of id) s += String.fromCharCode(b);
  return s;
}

function ffprobeRotationOf(clockwise: number): number {
  return ((((-clockwise + 540) % 360) + 360) % 360) - 180 || 0;
}

interface TrackWork {
  track: InputVideoTrack;
  result: VideoTrackResult;
  native: MediabunnyTrackNative;
  derivedRate: number | null;
}

async function collectTrack(
  track: InputVideoTrack,
  quantized: boolean,
  signal: AbortSignal | null,
  maxPackets: number,
): Promise<TrackWork> {
  const result = emptyTrack(track.id);
  const codec = await track.getCodec();
  result.fourccOrCodecId = internalCodecString(await track.getInternalCodecId());
  result.codecName = (codec ? CODEC_NAMES[codec] : undefined) ?? codecNameFromFourcc(result.fourccOrCodecId);
  result.width = await track.getCodedWidth();
  result.height = await track.getCodedHeight();
  result.rotation = ffprobeRotationOf(await track.getRotation());
  const resolution = await track.getTimeResolution();
  const timescale = resolution > 0 && Number.isFinite(resolution) ? resolution : 1_000_000;
  result.timescale = timescale;
  result.provenance.codec = 'header';
  result.provenance.dimensions = 'header';
  result.provenance.rotation = 'header';

  const pts: number[] = [];
  let lastPts = -Infinity;
  let lastDuration = 0;
  let startSec = Infinity;
  let endSec = -Infinity;
  const sink = new EncodedPacketSink(track);
  const options = { metadataOnly: true };
  // getNextPacket() instead of packets(): the async iterator is quadratic on very long tracks.
  for (let packet = await sink.getFirstPacket(options); packet; packet = await sink.getNextPacket(packet, options)) {
    throwIfAborted(signal);
    if (pts.length >= maxPackets) {
      result.warnings.push(`packet walk stopped at the limit of ${maxPackets} packets`);
      break;
    }
    const ticks = Math.round(packet.timestamp * timescale);
    pts.push(ticks);
    if (ticks >= lastPts) {
      lastPts = ticks;
      lastDuration = Math.round(packet.duration * timescale);
    }
    if (packet.timestamp < startSec) startSec = packet.timestamp;
    if (packet.timestamp + packet.duration > endSec) endSec = packet.timestamp + packet.duration;
  }
  const stats = analyzeTimeline({ timescale, pts, lastDuration, tickQuantized: quantized });
  applyStats(result, stats);
  if (stats.firstPts !== null) {
    result.startSec = stats.firstPts / timescale;
    result.durationSec = stats.durationSum / timescale;
    result.provenance.startSec = 'exact';
    result.provenance.durationSec = 'exact';
  }
  if (pts.length === 0) result.warnings.push('mediabunny found no packets for this track');
  const native: MediabunnyTrackNative = {
    trackId: track.id,
    packetCount: pts.length,
    averagePacketRate: null,
    nativeCallSkipped: false,
    timeResolution: timescale,
    fpsFromTimestamps: stats.avgFps ? stats.avgFps.value : null,
  };
  const derivedRate = pts.length > 0 && endSec > startSec ? Number((pts.length / (endSec - startSec)).toPrecision(16)) : null;
  return { track, result, native, derivedRate };
}

async function applyNativeStats(work: TrackWork, signal: AbortSignal | null): Promise<void> {
  const { track, result, native, derivedRate } = work;
  try {
    let averagePacketRate = derivedRate ?? 0;
    if (native.packetCount <= NATIVE_STATS_MAX_PACKETS) {
      averagePacketRate = (await track.computePacketStats()).averagePacketRate;
    } else {
      native.nativeCallSkipped = true;
      result.warnings.push(
        `computePacketStats skipped above ${NATIVE_STATS_MAX_PACKETS} packets (its packet iterator stalls on long tracks); ` +
          'its formula was applied to the packet pass instead',
      );
    }
    native.averagePacketRate = averagePacketRate;
    const rate = approxRational(averagePacketRate);
    if (rate) {
      result.avgFps = rate;
      result.avgFpsFfprobe = `${rate.num}/${rate.den}`;
      result.provenance.avgFps = 'exact';
    }
    const exact = native.fpsFromTimestamps === null ? 'n/a' : native.fpsFromTimestamps.toFixed(4);
    result.warnings.push(
      `mediabunny native: averagePacketRate ${averagePacketRate.toFixed(4)} fps over ${native.packetCount} packets; ` +
        `average from rounded timestamps ${exact} fps`,
    );
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    result.warnings.push(`mediabunny native average unavailable: ${errorMessage(e)}`);
  }
}

async function probe(counted: CountingBlob, result: MediabunnyResult, opts: AnalyzeOptions, t0: number): Promise<void> {
  const signal = opts.signal ?? null;
  if (counted.size === 0) {
    result.error = 'not a recognised container: empty file';
    return;
  }
  const unhandled: string[] = [];
  const logged: string[] = [];
  Logging.level = LogLevel.Silent;
  const unlisten = [
    Logging.on('warn', (args) => logged.push(args.map(String).join(' '))),
    Logging.on('error', (args) => logged.push(args.map(String).join(' '))),
  ];
  const source = new CustomSource({
    getSize: () => counted.size,
    read: async (start, end) => {
      let ab: ArrayBuffer;
      try {
        ab = await counted.slice(start, end).arrayBuffer();
      } catch (e) {
        throw isAbort(e, signal) ? e : Error(`file read failed: ${e}`);
      }
      if (ab.byteLength !== end - start) throw Error(`file read failed: short read at ${start}: expected ${end - start} bytes, got ${ab.byteLength}`);
      return new Uint8Array(ab);
    },
    prefetchProfile: 'fileSystem',
    handleUnhandledError: (e) => {
      unhandled.push(errorMessage(e));
    },
  });
  const input = new Input({ source, formats: FORMATS });
  try {
    let format: InputFormat;
    try {
      format = await input.getFormat();
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      const message = errorMessage(e);
      result.error = message.startsWith('file read failed') ? message : `not a recognised container: ${message}`;
      return;
    }
    result.container = containerOf(format);
    const quantized = result.container === 'webm' || result.container === 'matroska';
    const maxPackets = resolveOptions(opts).maxExpandedSamples;
    const tracks = await input.getTracks();
    const videos = await input.getVideoTracks();
    result.audioTrackCount = (await input.getAudioTracks()).length;
    const works: TrackWork[] = [];
    for (const [index, track] of videos.entries()) {
      opts.onProgress?.({ phase: 'packets', done: index, total: videos.length });
      try {
        works.push(await collectTrack(track, quantized, signal, maxPackets));
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        result.warnings.push(`track ${track.id}: ${errorMessage(e)}`);
      }
    }
    result.videoTracks = works.map((w) => w.result);
    const primary = videos.length > 0 ? await input.getPrimaryVideoTrack().catch(() => null) : null;
    result.primaryTrackId = primary && works.some((w) => w.result.trackId === primary.id) ? primary.id : (works[0]?.result.trackId ?? null);
    result.scan = works.length > 0 ? 'exact' : null;
    try {
      result.formatDurationSec = await input.getDurationFromMetadata();
    } catch (e) {
      if (isAbort(e, signal)) throw e;
    }
    if (tracks.length === 0) result.warnings.push('no tracks found: the file may be truncated or empty');
    else if (videos.length === 0) result.warnings.push('no video track');
    if (quantized) result.warnings.push('mediabunny reads whole clusters for Matroska, so bytes read approach the file size');
    for (const message of unhandled.slice(0, 3)) result.warnings.push(`mediabunny background read failed: ${message}`);
    for (const message of new Set(logged)) result.warnings.push(`mediabunny log: ${message}`);

    result.io = counted.io(t0);
    const nativeStart = now();
    for (const work of works) await applyNativeStats(work, signal);
    const native: MediabunnyNative = {
      version: MEDIABUNNY_VERSION,
      formatName: format.name,
      tracks: works.map((w) => w.native),
      nativeStatsMs: elapsed(nativeStart),
    };
    result.mediabunny = native;
  } finally {
    for (const off of unlisten) off();
    input.dispose();
  }
}

export async function analyzeWithMediabunny(blob: BlobLike, name: string, opts: AnalyzeOptions = {}): Promise<MediabunnyResult> {
  const t0 = now();
  throwIfAborted(opts.signal);
  const counted = new CountingBlob(blob, opts.signal ?? null);
  const result: MediabunnyResult = newResult(name, blob.size, 'mediabunny');
  try {
    await probe(counted, result, opts, t0);
  } catch (e) {
    if (isAbort(e, opts.signal)) throw e;
    result.error = errorMessage(e);
  }
  if (result.mediabunny === undefined) result.io = counted.io(t0);
  printableWarnings(result);
  return result;
}

export const containers = 'any';

export const run: EngineModule<MediabunnyResult>['run'] = analyzeWithMediabunny;
