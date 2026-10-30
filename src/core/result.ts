import type { ContainerAnalysis, ContainerKind, FileResult, VideoTrackResult } from './types.ts';

export function emptyAnalysis(container: ContainerKind, error: string | null = null): ContainerAnalysis {
  return {
    container,
    brand: null,
    formatDurationSec: null,
    scan: null,
    videoTracks: [],
    audioTrackCount: 0,
    primaryTrackId: null,
    error,
    warnings: [],
  };
}

export function emptyTrack(trackId: number): VideoTrackResult {
  return {
    trackId,
    fourccOrCodecId: '',
    codecName: '',
    width: 0,
    height: 0,
    rotation: 0,
    timescale: 0,
    frames: null,
    presentedFrames: null,
    durationSec: null,
    startSec: null,
    avgFps: null,
    avgFpsFfprobe: null,
    rFpsFfprobe: null,
    nominalFps: null,
    dominantFps: null,
    minFps: null,
    maxFps: null,
    isVfr: null,
    vfrRatio: 0,
    distinctDeltas: 0,
    duplicateTimestamps: 0,
    timestampsQuantized: false,
    isStill: false,
    rateProfile: null,
    medianFrameInterval: null,
    provenance: {},
    warnings: [],
  };
}

export function primaryTrack(result: Pick<FileResult, 'videoTracks' | 'primaryTrackId'>): VideoTrackResult | null {
  if (result.primaryTrackId === null) return null;
  return result.videoTracks.find((t) => t.trackId === result.primaryTrackId) ?? null;
}
