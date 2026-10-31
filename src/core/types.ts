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
  | 'duplicateTimestamps'
  | 'medianFrameInterval';

export type RateSegmentKind = 'steady' | 'variable';

export interface RateSegment {
  startSec: number;
  endSec: number;
  frames: number;
  fps: number;
  kind: RateSegmentKind;
}

export type RateAnomalyKind = 'rate-change' | 'freeze' | 'burst' | 'gap';

export interface RateAnomaly {
  kind: RateAnomalyKind;
  atSec: number;
  durationSec: number;
  fromFps: number;
  toFps: number;
}

export interface RateBuckets {
  bucketSec: number;
  fps: number[];
}

export interface RateProfile {
  segments: RateSegment[];
  moreSegments: number;
  anomalies: RateAnomaly[];
  moreAnomalies: number;
  buckets: RateBuckets;
  uneven: boolean;
  dominantShare: number;
  summary: string;
}

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
  rateProfile?: RateProfile | null;
  medianFrameInterval?: Rational | null;
  enabled?: boolean;
  codecConfig?: CodecConfig;
  color?: ColorInfo | null;
  sampleAspectRatio?: Rational | null;
  displayAspectRatio?: Rational | null;
  displayWidth?: number | null;
  displayHeight?: number | null;
  provenance: Partial<Record<TrackField, Provenance>>;
  warnings: string[];
}

export type CodecConfig =
  | { family: 'isobmff'; stsd: Uint8Array | null; tkhd: Uint8Array | null; mvhd: Uint8Array | null }
  | { family: 'isobmff'; moov: DataView; trak: number }
  | { family: 'matroska'; trackEntry: Uint8Array | null };

export type ColorSource = 'sps' | 'colr' | 'vpcC' | 'Colour';

export interface DolbyVisionConfig {
  versionMajor: number;
  versionMinor: number;
  profile: number;
  level: number;
  rpu: boolean;
  el: boolean;
  bl: boolean;
  compatibilityId: number;
  mdCompression: number;
}

export interface ColorInfo {
  range: 'tv' | 'pc' | null;
  primaries: string | null;
  transfer: string | null;
  space: string | null;
  source: ColorSource | null;
  bitDepth: number | null;
  profile: number | null;
  codecString: string | null;
  hdr: 'pq' | 'hlg' | null;
  dolbyVision: DolbyVisionConfig | null;
}

export interface IoStats {
  reads: number;
  bytesRead: number;
  ms: number;
}

export type FileErrorCode =
  | 'empty-file'
  | 'unrecognised'
  | 'unsupported-container'
  | 'unsupported'
  | 'too-large'
  | 'no-header'
  | 'truncated'
  | 'corrupt'
  | 'no-duration'
  | 'byte-limit'
  | 'read-limit'
  | 'time-limit'
  | 'structure-limit'
  | 'read-failed'
  | 'load-failed'
  | 'engine-failed'
  | 'internal';

export type LayoutKind = 'faststart' | 'moov-at-end' | 'fragmented';

export interface ContainerLayout {
  kind: LayoutKind;
  moovOffset: number | null;
  moovSize: number | null;
  sidx: boolean;
  emptyMoov: boolean;
}

export type WarningCode = 'invalid-timescale' | 'truncated-mdat' | 'truncated-box' | 'trailing-data' | 'fragment-index-unread' | 'duration-unresolved' | 'fragments-ignored' | 'structure-limit' | 'codec-config-unavailable' | 'metadata-unavailable';

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
  errorCode?: FileErrorCode | null;
  layout?: ContainerLayout | null;
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
  codecConfig?: boolean;
}

export interface ResolvedAnalyzeOptions {
  signal: AbortSignal | null;
  matroskaMode: MatroskaMode;
  exactBudgetMs: number;
  readAhead: ReadAheadSizes;
  costModel: CostModel;
  maxExpandedSamples: number;
  onProgress: ((progress: AnalyzeProgress) => void) | null;
  codecConfig?: boolean;
}

export type ContainerAnalyzer = (reader: BlobReader, opts: ResolvedAnalyzeOptions) => Promise<ContainerAnalysis>;
