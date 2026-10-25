import { analyzeWith } from './dispatch.ts';
import type { BlobLike } from './reader.ts';
import type { SniffKind } from './sniff.ts';
import type { AnalyzeOptions, ContainerAnalyzer, FileResult } from './types.ts';

export { errorMessage, firstReadAhead, isAbortError, SINGLE_READ_MAX_BYTES } from './dispatch.ts';

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

export function analyze(
  blob: BlobLike,
  name: string,
  opts: AnalyzeOptions = {},
  analyzers: Readonly<AnalyzerRegistry> = DEFAULT_ANALYZERS,
  loaders: Readonly<AnalyzerLoaders> | null = analyzers === DEFAULT_ANALYZERS ? DEFAULT_LOADERS : null,
): Promise<FileResult> {
  return analyzeWith(blob, name, opts, loaders ? (kind) => loaders[kind]() : (kind) => analyzers[kind]);
}
