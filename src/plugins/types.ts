import type { BlobLike } from '../core/reader.ts';
import type { AnalyzeOptions, EngineId, FileResult } from '../core/types.ts';

export type { EngineId };

export type ContainerFamily = 'isobmff' | 'matroska';

export type WorkerEngineId = 'own' | 'mp4box' | 'mediabunny';

export interface EngineModule<R extends FileResult = FileResult> {
  readonly run: (blob: BlobLike, name: string, opts: AnalyzeOptions) => Promise<R>;
  readonly containers: readonly ContainerFamily[] | 'any';
  readonly warm?: (containers: readonly ContainerFamily[]) => Promise<void>;
}
