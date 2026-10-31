import type { FileErrorCode, FileResult, WarningCode } from '../core/types.ts';

export type ErrorClass = 'file' | 'limit' | 'io' | 'environment' | 'internal';

const ERROR_PREFIXES: ReadonlyArray<readonly [prefix: string, code: FileErrorCode]> = [
  ['not a recognised container: empty file', 'empty-file'],
  ['not a recognised container', 'unrecognised'],
  ['unsupported: moov larger', 'too-large'],
  ['corrupt file: moof larger', 'too-large'],
  ['unsupported:', 'unsupported'],
  ['incomplete file: moov is truncated', 'truncated'],
  ['incomplete file: no moov', 'no-header'],
  ['incomplete header:', 'no-duration'],
  ['limit reached: maxBytes', 'byte-limit'],
  ['limit reached: maxReads', 'read-limit'],
  ['limit reached: maxMs', 'time-limit'],
  ['limit reached: maxTracks', 'structure-limit'],
  ['limit reached: maxTopLevelBoxes', 'structure-limit'],
  ['corrupt file:', 'corrupt'],
  ['file read failed', 'read-failed'],
  ['the own ', 'unsupported-container'],
  ['unsupported by ', 'unsupported-container'],
  ['container not read by', 'unsupported-container'],
  ['invalid EBML header', 'corrupt'],
  ['no Segment element', 'no-header'],
  ['no complete TrackEntry in Tracks', 'truncated'],
  ['no Tracks element found', 'no-header'],
];

const CLASS_OF: Readonly<Record<FileErrorCode, ErrorClass>> = {
  'empty-file': 'file',
  unrecognised: 'file',
  'unsupported-container': 'file',
  unsupported: 'file',
  'too-large': 'file',
  'no-header': 'file',
  truncated: 'file',
  corrupt: 'file',
  'no-duration': 'file',
  'engine-failed': 'file',
  'byte-limit': 'limit',
  'read-limit': 'limit',
  'time-limit': 'limit',
  'structure-limit': 'limit',
  'read-failed': 'io',
  'load-failed': 'environment',
  internal: 'internal',
};

const WARNING_PREFIXES: ReadonlyArray<readonly [prefix: string, code: WarningCode]> = [
  ['invalid mdhd timescale ', 'invalid-timescale'],
  ['invalid timescale ', 'invalid-timescale'],
  ['ignored trailing data at ', 'trailing-data'],
  ['fragment index not read: ', 'fragment-index-unread'],
  ['format duration unresolved: ', 'duration-unresolved'],
  ['fragments ignored: ', 'fragments-ignored'],
  ['too many top-level boxes', 'structure-limit'],
  ['codec configuration unavailable', 'codec-config-unavailable'],
  ['color and aspect unavailable', 'metadata-unavailable'],
];

const TRUNCATED_BOX = /^'(.{4})' at \d+ is truncated/;

export function errorCodeOf(result: Pick<FileResult, 'error'> & Partial<Pick<FileResult, 'errorCode' | 'engine'>>): FileErrorCode | null {
  if (result?.errorCode !== undefined) return result.errorCode;
  const error = result?.error;
  if (error === null) return null;
  if (typeof error !== 'string') return 'internal';
  for (const [prefix, code] of ERROR_PREFIXES) if (error.startsWith(prefix)) return code;
  return result.engine !== undefined && result.engine !== 'own' ? 'engine-failed' : 'internal';
}

export function errorClass(code: FileErrorCode): ErrorClass {
  return Object.hasOwn(CLASS_OF, code) ? CLASS_OF[code] : 'internal';
}

export function warningCodeOf(warning: string): WarningCode | null {
  if (typeof warning !== 'string') return null;
  for (const [prefix, code] of WARNING_PREFIXES) if (warning.startsWith(prefix)) return code;
  const box = TRUNCATED_BOX.exec(warning);
  return box ? (box[1] === 'mdat' ? 'truncated-mdat' : 'truncated-box') : null;
}

export function warningCodesOf(result: Pick<FileResult, 'warnings' | 'videoTracks'>): WarningCode[] {
  const codes = new Set<WarningCode>();
  const listOf = <T>(value: readonly T[] | null | undefined): readonly T[] => (Array.isArray(value) ? value : []);
  for (const w of [...listOf(result?.warnings), ...listOf(result?.videoTracks).flatMap((t) => listOf(t?.warnings))]) {
    const code = warningCodeOf(w);
    if (code) codes.add(code);
  }
  return [...codes];
}
