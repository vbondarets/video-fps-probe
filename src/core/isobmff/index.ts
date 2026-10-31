import { emptyAnalysis } from '../result.ts';
import { analyzeTimeline, rateProfileOf } from '../stats.ts';
import { buildVideoTrack, containerOf, emulateFfprobeExtent, formatDuration, isAbort, isVideoTrack, layoutOf, pickPrimary, reportedIds, walk } from './build.ts';
import type { ContainerAnalysis, ResolvedAnalyzeOptions } from '../types.ts';
import { whichErrorCode, type BlobReader } from '../reader.ts';
import { newMovie, type IsoMovie } from './model.ts';

export { IsoBmffError } from './boxes.ts';
export { MOOF_HARD_CAP, MOOV_HARD_CAP, MOOV_SUSPECT_CAP } from './build.ts';
export type { IsoMovie, IsoTrack } from './model.ts';

export interface IsoBmffDetails {
  analysis: ContainerAnalysis;
  movie: IsoMovie;
}

export async function analyzeIsoBmffDetailed(reader: BlobReader, opts: ResolvedAnalyzeOptions): Promise<IsoBmffDetails> {
  const movie = newMovie(reader.size);
  const fail = (e: unknown): IsoBmffDetails => {
    if (isAbort(e, reader)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    const analysis = emptyAnalysis(containerOf(movie), (e as { errorCode?: unknown } | null)?.errorCode ? message : `corrupt file: ${message}`);
    analysis.errorCode = whichErrorCode(e);
    analysis.layout = layoutOf(movie);
    analysis.brand = movie.brand;
    analysis.warnings = movie.warnings;
    return { analysis, movie };
  };
  try {
    await walk(reader, opts, movie);
    await emulateFfprobeExtent(reader, movie);
    const analysis = emptyAnalysis(containerOf(movie));
    analysis.brand = movie.brand;
    analysis.scan = 'exact';
    analysis.warnings = movie.warnings;
    const reject = movie.ffprobeReject;
    const ffprobeFails = reject !== null && reject.moof < movie.ffprobeMoofLimit;
    if (ffprobeFails) movie.warnings.push(`ffprobe 8.1.1 ${reject.reason}`);
    const ids = reportedIds(movie.tracks);
    if ([...ids].some(([t, id]) => t.id !== id)) movie.warnings.push('duplicate track_ID values');
    const videos = movie.tracks.filter((t) => isVideoTrack(t, movie));
    if (opts.codecConfig && videos.length) movie.warnings.push('codec configuration unavailable');
    const built = videos.map((t) => buildVideoTrack(t, movie, opts, { reportedId: ids.get(t) ?? t.id, ffprobeFails }, analyzeTimeline));
    for (const b of built) b.result.rateProfile = await rateProfileOf(b.profile ?? null);
    analysis.videoTracks = built.map((b) => b.result);
    analysis.audioTrackCount = movie.tracks.filter((t) => t.handler === 'soun').length;
    analysis.primaryTrackId = pickPrimary(built);
    analysis.formatDurationSec = formatDuration(movie, new Set(videos));
    analysis.layout = layoutOf(movie);
    return { analysis, movie };
  } catch (e) {
    return fail(e);
  }
}

export async function analyzeIsoBmff(reader: BlobReader, opts: ResolvedAnalyzeOptions): Promise<ContainerAnalysis> {
  return (await analyzeIsoBmffDetailed(reader, opts)).analysis;
}
