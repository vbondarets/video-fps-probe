import type { ContainerLayout, FileErrorCode } from '../../src/core/types.ts';

export type Verdict = 'exact' | 'within-tol' | 'known-deviation' | 'mismatch' | 'n/a';

export const VERDICTS: readonly Verdict[] = ['exact', 'within-tol', 'known-deviation', 'mismatch', 'n/a'];

export type OutcomeClass = 'wrong' | 'definition-differs' | 'unverified' | 'not-provided' | 'unsupported-container';

export const OUTCOME_CLASSES: readonly OutcomeClass[] = ['wrong', 'definition-differs', 'unverified', 'not-provided', 'unsupported-container'];

export const FIELD_NAMES = [
  'avgFps',
  'nominalFps',
  'frames',
  'presentedFrames',
  'durationSec',
  'startSec',
  'formatDurationSec',
  'minFps',
  'maxFps',
  'isVfr',
  'duplicateTimestamps',
  'width',
  'height',
  'codecName',
  'error',
  'trackSelection',
  'medianFrameInterval',
  'sampleAspectRatio',
  'displayAspectRatio',
  'enabled',
  'colorRange',
  'colorPrimaries',
  'colorTransfer',
  'colorSpace',
  'bitDepth',
  'profile',
  'codecString',
  'dolbyVision',
  'layout',
  'errorCode',
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

export const FILE_ERROR_CODES = ['empty-file', 'unrecognised', 'unsupported-container', 'unsupported', 'too-large', 'no-header', 'truncated', 'corrupt', 'no-duration'] as const;

export const FIELD_SUBS: Partial<Record<FieldName, readonly string[]>> = {
  avgFps: ['declared', 'measured'],
};

export type ContainerFamily = 'isobmff' | 'matroska';

export type CheckScope = 'file' | 'track';

export type DeviationSource = 'file' | 'built-in';

export interface CheckResult {
  field: FieldName;
  sub: string | null;
  id: string;
  scope: CheckScope;
  trackId: number | null;
  verdict: Verdict;
  app: string | null;
  ffprobe: string | null;
  rule: string;
  detail: string | null;
  deviation: string | null;
  deviationSource: DeviationSource | null;
  outcome?: OutcomeClass;
  outcomeWhy?: string;
}

export interface FixtureInfo {
  name: string;
  container: string;
  category: string;
  expect: string;
  notes: string;
  code?: string;
}

export interface ContainerColor {
  kind: 'nclx' | 'nclc' | 'vpcC' | 'Colour';
  primaries: number | null;
  transfer: number | null;
  matrix: number | null;
  fullRange: boolean | null;
}

export interface CodecConfigFacts {
  kind: 'avcC' | 'hvcC' | 'av1C' | 'vpcC' | 'vp9-private';
  profile: number | null;
  constraints: number | null;
  bitDepth: number | null;
  hasSps: boolean | null;
}

export interface SampleEntryFacts {
  type: string;
  width: number;
  height: number;
  pasp: { num: number; den: number } | null;
  colr: ContainerColor | null;
  vpcC: ContainerColor | null;
  config: CodecConfigFacts | null;
  dolbyVision: string | null;
}

export interface LayoutTrack {
  id: number;
  handler: string | null;
  mediaDurationSec: number | null;
  samples: number | null;
  hasEditList: boolean;
  lastSampleTicks?: number | null;
  enabled?: boolean;
  tkhdWidth?: number;
  tkhdHeight?: number;
  matrix?: number[] | null;
  displayMatrix?: number[] | null;
  entry?: SampleEntryFacts | null;
}

export interface MatroskaLayoutTrack {
  number: number | null;
  type: number | null;
  defaultDurationNs: number | null;
  blockDurations: number;
  codecId?: string | null;
  flagEnabled?: boolean;
  flagDefault?: boolean;
  pixelWidth?: number | null;
  pixelHeight?: number | null;
  displayWidth?: number | null;
  displayHeight?: number | null;
  displayUnit?: number | null;
  colour?: ContainerColor | null;
  config?: CodecConfigFacts | null;
  blockAdditionTypes?: string[];
}

export interface FileLayout {
  fragmented: boolean;
  hasSidx: boolean;
  topLevel: string[];
  movieDurationSec?: number | null;
  fragmentDurationSec?: number | null;
  tracks?: LayoutTrack[];
  matroskaTracks?: MatroskaLayoutTrack[];
  hasMvex?: boolean;
  moovOffset?: number | null;
  moovSize?: number | null;
  firstMdatOffset?: number | null;
  sidxBeforeFirstMoof?: boolean;
}

export interface RationalLike {
  num: number;
  den: number;
}

export interface DolbyVisionLike {
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

export interface ColorLike {
  range: string | null;
  primaries: string | null;
  transfer: string | null;
  space: string | null;
  bitDepth: number | null;
  profile: number | null;
  codecString: string | null;
  dolbyVision: DolbyVisionLike | null;
}

export type ContainerLayoutLike = ContainerLayout;

export interface TrackFields040 {
  medianFrameInterval?: RationalLike | null;
  sampleAspectRatio?: RationalLike | null;
  displayWidth?: number | null;
  displayHeight?: number | null;
  enabled?: boolean | null;
  color?: ColorLike | null;
}

export interface FileFields040 {
  errorCode?: FileErrorCode | null;
  layout?: ContainerLayoutLike | null;
}

export type FixtureDeviations = Readonly<Record<string, string>>;

export function checkId(field: FieldName, sub: string | null): string {
  return sub ? `${field}.${sub}` : field;
}

export function isFieldName(s: string): s is FieldName {
  return (FIELD_NAMES as readonly string[]).includes(s);
}

export function isValidDeviationKey(key: string): boolean {
  const dot = key.indexOf('.');
  const base = dot < 0 ? key : key.slice(0, dot);
  if (!isFieldName(base)) return false;
  if (dot < 0) return true;
  return (FIELD_SUBS[base] ?? []).includes(key.slice(dot + 1));
}
