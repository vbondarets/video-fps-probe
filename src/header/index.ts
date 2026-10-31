import { throwIfAborted } from '../core/abort.ts';
import { analyzeIsoBmffHeader } from '../core/isobmff/header.ts';
import { DEFAULT_READ_AHEAD } from '../core/options.ts';
import { BlobReader, whichErrorCode, type BlobLike } from '../core/reader.ts';
import { emptyAnalysis } from '../core/result.ts';
import { sniff } from '../core/sniff.ts';
import type { ContainerAnalysis, FileErrorCode, FileResult, IoStats } from '../core/types.ts';
import { HEADER_DEFAULT_LIMITS, LimitedSource, type HeaderLimits } from './limits.ts';

export { errorClass, errorCodeOf, warningCodeOf, warningCodesOf, type ErrorClass } from '../api/codes.ts';
export { isAbortError, isTimeoutError } from '../api/guards.ts';
export { HEADER_DEFAULT_LIMITS, type HeaderLimits } from './limits.ts';
export type { BlobLike, BlobSlice } from '../core/reader.ts';
export type * from '../core/types.ts';

export type FragmentedDuration = 'header' | 'index';

export interface HeaderOptions {
  name?: string;
  signal?: AbortSignal | null;
  limits?: HeaderLimits;
  readAhead?: { head?: number; tail?: number };
  fragmentedDuration?: FragmentedDuration;
  codecConfig?: boolean;
  color?: boolean;
  aspect?: boolean;
}

export type HeaderResult = FileResult & { io: IoStats & { bytesRequested: number } };

const SNIFF_BYTES = 1024;
const MIN_HEAD = SNIFF_BYTES;
const MIN_TAIL = 16;

function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

function count(value: unknown, what: string, min = 0, infinite = false): number {
  if (infinite && value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${what} must be a non-negative safe integer${min > 0 ? ` of at least ${min}` : ''}${infinite ? ' or Infinity' : ''}, got ${shown(value)}`);
  }
  return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object, got ${shown(value)}`);
  return value as Record<string, unknown>;
}

interface Resolved {
  name: string;
  size: number;
  signal: AbortSignal | null;
  limits: Required<HeaderLimits>;
  head: number;
  tail: number;
  index: boolean;
  codecConfig: boolean;
  color: boolean;
  aspect: boolean;
}

function flag(value: unknown, what: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${what} must be a boolean, got ${shown(value)}`);
  return value === true;
}

function resolveHeaderOptions(source: unknown, options: unknown): Resolved {
  const src = source as Partial<BlobLike> | null;
  if (typeof src !== 'object' || src === null || typeof src.slice !== 'function') throw new TypeError(`source must be a Blob or a BlobLike with a size and a slice method, got ${shown(source)}`);
  const size = count(src.size, 'source.size');
  const o = record(options, 'options');
  if (o.name !== undefined && typeof o.name !== 'string') throw new TypeError(`name must be a string, got ${shown(o.name)}`);
  const signal = o.signal ?? null;
  if (signal !== null) {
    const s = signal as Partial<AbortSignal>;
    if (typeof s !== 'object' || typeof s.aborted !== 'boolean' || typeof s.addEventListener !== 'function' || typeof s.removeEventListener !== 'function') throw new TypeError(`signal must be an AbortSignal, got ${shown(signal)}`);
  }
  const l = record(o.limits, 'limits');
  const limits = { ...HEADER_DEFAULT_LIMITS };
  for (const key of Object.keys(HEADER_DEFAULT_LIMITS) as (keyof HeaderLimits)[]) if (l[key] !== undefined) limits[key] = count(l[key], `limits.${key}`, 0, true);
  const r = record(o.readAhead, 'readAhead');
  for (const key of Object.keys(r)) if (key !== 'head' && key !== 'tail' && r[key] !== undefined) throw new TypeError(`readAhead takes only head and tail, got ${key}`);
  const head = r.head === undefined ? DEFAULT_READ_AHEAD.head : count(r.head, 'readAhead.head', MIN_HEAD);
  const tail = r.tail === undefined ? DEFAULT_READ_AHEAD.tail : count(r.tail, 'readAhead.tail', MIN_TAIL);
  const mode = o.fragmentedDuration ?? 'index';
  if (mode !== 'index' && mode !== 'header') throw new TypeError(`fragmentedDuration must be 'header' or 'index', got ${shown(mode)}`);
  const name = (o.name as string | undefined) ?? (typeof File !== 'undefined' && source instanceof File ? source.name : '');
  return { name, size, signal: signal as AbortSignal | null, limits, head, tail, index: mode === 'index', codecConfig: flag(o.codecConfig, 'codecConfig'), color: flag(o.color, 'color'), aspect: flag(o.aspect, 'aspect') };
}

function docTypeOf(head: Uint8Array): string | null {
  let p = 4;
  const vint = (marker: boolean): number | null => {
    if (p >= head.length) return null;
    const first = head[p];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || p + len > head.length) return null;
    let v = marker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + head[p + i];
    p += len;
    return v;
  };
  const size = vint(false);
  if (size === null) return null;
  const end = Math.min(head.length, p + size);
  while (p < end) {
    const id = vint(true);
    const n = vint(false);
    if (id === null || n === null || p + n > end) return null;
    if (id === 0x4282) return String.fromCharCode(...head.subarray(p, p + n)).replace(/\0+$/, '');
    p += n;
  }
  return null;
}

function failed(analysis: ContainerAnalysis, message: string, code: FileErrorCode): ContainerAnalysis {
  analysis.error = message;
  analysis.errorCode = code;
  return analysis;
}

async function analyzeSource(reader: BlobReader, limited: LimitedSource, o: Resolved): Promise<ContainerAnalysis> {
  const analysis: ContainerAnalysis = { ...emptyAnalysis('unknown'), scan: 'header', errorCode: null, layout: null };
  const size = reader.size;
  if (size === 0) return failed(analysis, 'not a recognised container: empty file', 'empty-file');
  const head = await reader.bytes(0, Math.min(SNIFF_BYTES, size), Math.min(size, o.head, limited.bytesLeft));
  const sniffed = sniff(head);
  if (sniffed.kind === 'unknown') return failed(analysis, `not a recognised container: ${sniffed.reason}`, 'unrecognised');
  if (sniffed.kind === 'matroska') {
    analysis.container = docTypeOf(head) === 'webm' ? 'webm' : 'matroska';
    return failed(analysis, `container not read by the header entry: ${analysis.container}`, 'unsupported-container');
  }
  const { maxTracks, maxTopLevelBoxes } = o.limits;
  return analyzeIsoBmffHeader(reader, limited, { head: o.head, tail: o.tail, maxTracks, maxTopLevelBoxes, index: o.index, codecConfig: o.codecConfig || o.color || o.aspect });
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e));

async function withMetadata(analysis: ContainerAnalysis, o: Resolved): Promise<ContainerAnalysis> {
  try {
    const { withAspect, withColor } = await import('./metadata.ts');
    throwIfAborted(o.signal);
    const last = { keepCodecConfig: o.codecConfig };
    const colored = o.color ? withColor(analysis, o.aspect ? { keepCodecConfig: true } : last) : analysis;
    return o.aspect ? withAspect(colored, last) : colored;
  } catch (e) {
    throwIfAborted(o.signal);
    return failed({ ...analysis }, messageOf(e), 'load-failed');
  }
}

export async function analyzeHeader(source: Blob | BlobLike, options: HeaderOptions = {}): Promise<HeaderResult> {
  const t0 = performance.now();
  const o = resolveHeaderOptions(source, options);
  throwIfAborted(o.signal);
  const limited = new LimitedSource(source, o.size, o.limits, o.signal);
  const reader = new BlobReader(limited, { headWindow: o.head, signal: o.signal });
  let analysis: ContainerAnalysis;
  try {
    analysis = await analyzeSource(reader, limited, o);
  } catch (e) {
    throwIfAborted(o.signal);
    const limit = limited.take();
    analysis = { ...emptyAnalysis('unknown'), scan: 'header', errorCode: null, layout: null };
    failed(analysis, limit ? limit.message : messageOf(e), whichErrorCode(limit ?? e));
  } finally {
    limited.dispose();
  }
  if ((o.color || o.aspect) && analysis.videoTracks.some((t) => t.codecConfig)) analysis = await withMetadata(analysis, o);
  return {
    name: o.name,
    size: o.size,
    ...analysis,
    io: { reads: reader.reads, bytesRead: reader.bytesFetched, ms: performance.now() - t0, bytesRequested: limited.bytesRequested },
    engine: 'own',
  };
}
