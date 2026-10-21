import type { BlobReader } from './reader.ts';

export type Provenance = 'header' | 'exact' | 'sampled' | 'estimated' | 'computed';

export interface Rational {
  num: number;
  den: number;
  value: number;
}

export type NominalKind = 'exact' | 'snapped' | 'declared';

export interface NominalFps extends Rational {
  kind: NominalKind;
}

export interface DominantFps {
  rate: Rational;
  share: number;
}

export type ContainerKind = 'mp4' | 'mov' | 'webm' | 'matroska' | 'unknown';

export type EngineId = 'own' | 'mediabunny' | 'mp4box' | 'rvfc';

export type MatroskaMode = 'header' | 'probe' | 'exact' | 'auto';

export type ScanDepth = 'header' | 'probe' | 'exact';

export type TrackField =
  | 'codec'
  | 'dimensions'
  | 'rotation'
  | 'frames'
  | 'presentedFrames'
  | 'durationSec'
  | 'startSec'
  | 'avgFps'
  | 'nominalFps'
  | 'dominantFps'
  | 'minFps'
  | 'maxFps'
  | 'isVfr'
  | 'duplicateTimestamps';

export interface VideoTrackResult {
  trackId: number;
  fourccOrCodecId: string;
  codecName: string;
  width: number;
  height: number;
  rotation: number;
  timescale: number;
  frames: number | null;
  presentedFrames: number | null;
  durationSec: number | null;
  startSec: number | null;
  avgFps: Rational | null;
  avgFpsFfprobe: string | null;
  rFpsFfprobe: string | null;
  nominalFps: NominalFps | null;
  dominantFps: DominantFps | null;
  minFps: Rational | null;
  maxFps: Rational | null;
  isVfr: boolean | null;
  vfrRatio: number;
  distinctDeltas: number;
  duplicateTimestamps: number;
  timestampsQuantized: boolean;
  isStill: boolean;
  provenance: Partial<Record<TrackField, Provenance>>;
  warnings: string[];
}

export interface IoStats {
  reads: number;
  bytesRead: number;
  ms: number;
}

export interface FileResult {
  name: string;
  size: number;
  container: ContainerKind;
  brand: string | null;
  formatDurationSec: number | null;
  scan: ScanDepth | null;
  videoTracks: VideoTrackResult[];
  audioTrackCount: number;
  primaryTrackId: number | null;
  error: string | null;
  warnings: string[];
  io: IoStats;
  engine: EngineId;
}

export type ContainerAnalysis = Omit<FileResult, 'name' | 'size' | 'io' | 'engine'>;

export interface ReadAheadSizes {
  head: number;
  fragment: number;
  matroskaScan: number;
  tail: number;
}

export interface CostModel {
  perReadMs: number;
  bytesPerMs: number;
  perBlockMs: number;
}

export interface AnalyzeProgress {
  phase: string;
  done: number;
  total: number;
}

export interface AnalyzeOptions {
  signal?: AbortSignal | null;
  matroskaMode?: MatroskaMode;
  exactBudgetMs?: number;
  readAhead?: Partial<ReadAheadSizes>;
  costModel?: Partial<CostModel>;
  maxExpandedSamples?: number;
  onProgress?: ((progress: AnalyzeProgress) => void) | null;
}

export interface ResolvedAnalyzeOptions {
  signal: AbortSignal | null;
  matroskaMode: MatroskaMode;
  exactBudgetMs: number;
  readAhead: ReadAheadSizes;
  costModel: CostModel;
  maxExpandedSamples: number;
  onProgress: ((progress: AnalyzeProgress) => void) | null;
}

export type ContainerAnalyzer = (reader: BlobReader, opts: ResolvedAnalyzeOptions) => Promise<ContainerAnalysis>;
