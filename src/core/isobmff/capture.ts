import { throwIfAborted } from '../abort.ts';
import type { BlobLike } from '../reader.ts';
import type { FileResult } from '../types.ts';
import { IsoBmffError, readBoxHeader } from './boxes.ts';
import { isVideoTrack, MOOV_SUSPECT_CAP } from './build.ts';
import { isoCodecConfig } from './config.ts';
import { newMovie } from './model.ts';
import { parseMoov } from './moov.ts';

const UNCAPTURED = 'codec configuration unavailable';

function moovViewOf(result: FileResult, fileSize: number): readonly [start: number, end: number, beyond: boolean] {
  const start = result.layout?.moovOffset;
  const size = result.layout?.moovSize;
  if (typeof start !== 'number' || typeof size !== 'number') throw new IsoBmffError('no-header', 'the result locates no moov');
  const beyond = start + size > fileSize;
  return [start, beyond ? start + Math.min(fileSize - start, MOOV_SUSPECT_CAP) : start + size, beyond];
}

function capturedTracks(dv: DataView, result: FileResult, start: number, beyond: boolean, fileSize: number): FileResult['videoTracks'] {
  const moov = readBoxHeader(dv, 0, dv.byteLength);
  if (moov?.type !== 'moov') throw new IsoBmffError('no-header', `no moov at ${start}`);
  const movie = newMovie(fileSize);
  parseMoov(dv, moov, movie, beyond, start);
  const videos = movie.tracks.filter((t) => isVideoTrack(t, movie));
  if (videos.length !== result.videoTracks.length) throw new IsoBmffError('corrupt', `the moov at ${start} holds ${videos.length} video tracks, the result ${result.videoTracks.length}`);
  return result.videoTracks.map((t, i) => ({ ...t, codecConfig: isoCodecConfig(movie, videos[i]) }));
}

export async function withIsoCodecConfig<R extends FileResult>(source: BlobLike, result: R, signal: AbortSignal | null = null): Promise<R> {
  const at = result.warnings.indexOf(UNCAPTURED);
  if (at < 0) return result;
  const warnings = result.warnings.filter((_, i) => i !== at);
  const t0 = performance.now();
  let reads = 0;
  let bytes = 0;
  const io = () => ({ reads: result.io.reads + reads, bytesRead: result.io.bytesRead + bytes, ms: result.io.ms + performance.now() - t0 });
  try {
    const [start, end, beyond] = moovViewOf(result, source.size);
    throwIfAborted(signal);
    const buffer = await source.slice(start, end).arrayBuffer();
    throwIfAborted(signal);
    reads = 1;
    bytes = buffer.byteLength;
    if (bytes !== end - start) throw new IsoBmffError('read-failed', `file read failed: short read at ${start}: expected ${end - start} bytes, got ${bytes}`);
    const videoTracks = capturedTracks(new DataView(buffer), result, start, beyond, source.size);
    return { ...result, videoTracks, warnings, io: io() };
  } catch (e) {
    if (signal?.aborted || (e as { name?: unknown } | null)?.name === 'AbortError') throw e;
    return { ...result, warnings: [...warnings, `${UNCAPTURED}: ${e instanceof Error ? e.message : String(e)}`], io: io() };
  }
}
