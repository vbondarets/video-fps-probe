import { resolveOptions } from './options.ts';
import { BlobReader, type BlobLike } from './reader.ts';
import { emptyAnalysis } from './result.ts';
import { sniff, type SniffKind } from './sniff.ts';
import type { AnalyzeOptions, ContainerAnalysis, ContainerAnalyzer, FileResult } from './types.ts';

export type AnalyzerRegistry = Record<Exclude<SniffKind, 'unknown'>, ContainerAnalyzer>;

export type AnalyzerLoaders = Record<Exclude<SniffKind, 'unknown'>, () => Promise<ContainerAnalyzer>>;

export const DEFAULT_LOADERS: Readonly<AnalyzerLoaders> = {
  isobmff: async () => (await Promise.all([import('./isobmff/index.ts'), import('./stats.ts')]))[0].analyzeIsoBmff,
  matroska: async () => (await Promise.all([import('./matroska/index.ts'), import('./stats.ts')]))[0].analyzeMatroska,
};

export const DEFAULT_ANALYZERS: Readonly<AnalyzerRegistry> = {
  isobmff: async (reader, opts) => (await DEFAULT_LOADERS.isobmff())(reader, opts),
  matroska: async (reader, opts) => (await DEFAULT_LOADERS.matroska())(reader, opts),
};

const SNIFF_BYTES = 1024;

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && (e as { name: unknown }).name === 'AbortError';
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

function applyAnalysis(target: FileResult, a: ContainerAnalysis): void {
  target.container = a.container;
  target.brand = a.brand;
  target.formatDurationSec = a.formatDurationSec;
  target.scan = a.scan;
  target.videoTracks = a.videoTracks;
  target.audioTrackCount = a.audioTrackCount;
  target.primaryTrackId = a.primaryTrackId;
  target.error = a.error;
  target.warnings = a.warnings;
}

export async function analyze(
  blob: BlobLike,
  name: string,
  opts: AnalyzeOptions = {},
  analyzers: Readonly<AnalyzerRegistry> = DEFAULT_ANALYZERS,
  loaders: Readonly<AnalyzerLoaders> | null = analyzers === DEFAULT_ANALYZERS ? DEFAULT_LOADERS : null,
): Promise<FileResult> {
  const t0 = performance.now();
  const resolved = resolveOptions(opts);
  resolved.signal?.throwIfAborted();
  const result: FileResult = {
    name,
    size: blob.size,
    ...emptyAnalysis('unknown'),
    io: { reads: 0, bytesRead: 0, ms: 0 },
    engine: 'own',
  };
  let reader: BlobReader | null = null;
  let loadMs = 0;
  try {
    reader = new BlobReader(blob, { headWindow: resolved.readAhead.head, signal: resolved.signal });
    if (reader.size === 0) {
      result.error = 'not a recognised container: empty file';
    } else {
      const head = await reader.bytes(0, Math.min(SNIFF_BYTES, reader.size));
      const sniffed = sniff(head);
      if (sniffed.kind === 'unknown') {
        result.error = `not a recognised container: ${sniffed.reason}`;
      } else {
        result.container = sniffed.kind === 'isobmff' ? 'mp4' : 'matroska';
        let analyzer = analyzers[sniffed.kind];
        if (loaders) {
          const l0 = performance.now();
          analyzer = await loaders[sniffed.kind]();
          loadMs = performance.now() - l0;
        }
        applyAnalysis(result, await analyzer(reader, resolved));
      }
    }
  } catch (e) {
    if (resolved.signal?.aborted || isAbortError(e)) throw e;
    result.error = errorMessage(e);
  }
  if (reader) {
    result.io.reads = reader.reads;
    result.io.bytesRead = reader.bytesFetched;
  }
  result.io.ms = performance.now() - t0 - loadMs;
  return result;
}
