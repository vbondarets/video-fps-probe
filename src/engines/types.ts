import type { FileResult } from '../core/types.ts';

export interface Mp4boxTrackNative {
  trackId: number;
  sampleCount: number;
  sttsLastDelta: number | null;
  lastSampleDuration: number | null;
  lastDurationOverridden: boolean;
  fpsFromSampleDurations: number | null;
  fpsFromMdhdDuration: number | null;
  fpsFromMovieDuration: number | null;
}

export interface Mp4boxNative {
  version: string;
  fedBuffers: number;
  fedBytes: number;
  moofsFed: number;
  tracks: Mp4boxTrackNative[];
}

export type Mp4boxResult = FileResult & { mp4box?: Mp4boxNative };

export interface MediabunnyTrackNative {
  trackId: number;
  packetCount: number;
  averagePacketRate: number | null;
  nativeCallSkipped: boolean;
  timeResolution: number;
  fpsFromTimestamps: number | null;
}

export interface MediabunnyNative {
  version: string;
  formatName: string;
  tracks: MediabunnyTrackNative[];
  nativeStatsMs: number;
}

export type MediabunnyResult = FileResult & { mediabunny?: MediabunnyNative };

export interface RvfcPass {
  rate: number;
  callbacks: number;
  fps: number;
  avg: number;
  pairs: number;
  spread: number;
  lo: number;
  hi: number;
}

export type RvfcConfidence = 'high' | 'medium' | 'low';

export interface RvfcDetails {
  displayHz: number;
  rate: number;
  passes: RvfcPass[];
  confidence: RvfcConfidence;
  flags: string[];
}

export interface RvfcOptions {
  host: HTMLElement;
  signal?: AbortSignal;
  onProgress?: (p: { phase: string; done: number; total: number }) => void;
}

export type RvfcResult = FileResult & { rvfc?: RvfcDetails };
