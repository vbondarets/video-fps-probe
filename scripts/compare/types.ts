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
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

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
}

export interface LayoutTrack {
  id: number;
  handler: string | null;
  mediaDurationSec: number | null;
  samples: number | null;
  hasEditList: boolean;
}

export interface FileLayout {
  fragmented: boolean;
  hasSidx: boolean;
  topLevel: string[];
  movieDurationSec?: number | null;
  fragmentDurationSec?: number | null;
  tracks?: LayoutTrack[];
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
