import { throwIfAborted } from './abort.ts';
import { resolveOptions } from './options.ts';
import { BlobReader, codeOf, fileError, type BlobLike } from './reader.ts';
import { emptyAnalysis } from './result.ts';
import { sniff, type SniffKind } from './sniff.ts';
import type { AnalyzeOptions, ContainerAnalyzer, FileResult, ResolvedAnalyzeOptions } from './types.ts';

export type ContainerKind = Exclude<SniffKind, 'unknown'>;

export type AnalyzerOf = (kind: ContainerKind) => ContainerAnalyzer | Promise<ContainerAnalyzer>;

const SNIFF_BYTES = 1024;

export const SINGLE_READ_MAX_BYTES = 1024 * 1024;

export function firstReadAhead(size: number, opts: ResolvedAnalyzeOptions): number {
  const { perReadMs, bytesPerMs } = opts.costModel;
  const head = opts.readAhead.head;
  return size < Math.max(head, Math.min(head + perReadMs * bytesPerMs, SINGLE_READ_MAX_BYTES)) ? size : head;
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === 'AbortError';
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

export async function analyzeWith(blob: BlobLike, name: string, opts: AnalyzeOptions, analyzerOf: AnalyzerOf): Promise<FileResult> {
  const t0 = performance.now();
  const resolved = resolveOptions(opts);
  throwIfAborted(resolved.signal);
  const result: FileResult = {
    name,
    size: blob.size,
    ...emptyAnalysis('unknown'),
    errorCode: null,
    io: { reads: 0, bytesRead: 0, ms: 0 },
    engine: 'own',
  };
  let reader: BlobReader | null = null;
  let loadMs = 0;
  let loading = false;
  try {
    reader = new BlobReader(blob, { headWindow: resolved.readAhead.head, signal: resolved.signal });
    if (reader.size === 0) throw fileError('empty-file', 'not a recognised container: empty file');
    const head = await reader.bytes(0, Math.min(SNIFF_BYTES, reader.size), firstReadAhead(reader.size, resolved));
    const sniffed = sniff(head);
    if (sniffed.kind === 'unknown') throw fileError('unrecognised', `not a recognised container: ${sniffed.reason}`);
    result.container = sniffed.kind === 'isobmff' ? 'mp4' : 'matroska';
    const l0 = performance.now();
    loading = true;
    const analyzer = await analyzerOf(sniffed.kind);
    loading = false;
    loadMs = performance.now() - l0;
    Object.assign(result, await analyzer(reader, resolved));
  } catch (e) {
    if (resolved.signal?.aborted || isAbortError(e)) throw e;
    result.error = errorMessage(e);
    result.errorCode = codeOf(e, loading ? 'load-failed' : 'internal');
  }
  if (reader) {
    result.io.reads = reader.reads;
    result.io.bytesRead = reader.bytesFetched;
  }
  result.io.ms = performance.now() - t0 - loadMs;
  return result;
}
