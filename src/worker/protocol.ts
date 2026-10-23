import type { AnalyzeOptions, AnalyzeProgress, FileResult } from '../core/types.ts';
import type { ContainerFamily, WorkerEngineId } from '../plugins/types.ts';

export const PROTOCOL_VERSION = 1;

export type WireOptions = Omit<AnalyzeOptions, 'signal' | 'onProgress'>;

export type SkipReason = 'unsupported-container';

export type WorkerErrorCode = 'unknown-engine' | 'protocol';

export type AnalyzeRequest = { type: 'analyze'; file: Blob; name: string; engine: WorkerEngineId; options: WireOptions };

export type WarmRequest = { type: 'warm'; engines: readonly WorkerEngineId[]; containers: readonly ContainerFamily[] };

export type JobRequest = AnalyzeRequest | WarmRequest;

export type WorkerRequest = { v: typeof PROTOCOL_VERSION; id: number } & (JobRequest | { type: 'cancel' });

export type WorkerResponse = { v: typeof PROTOCOL_VERSION; id: number } & (
  | { type: 'progress'; progress: AnalyzeProgress }
  | { type: 'result'; result: FileResult }
  | { type: 'skipped'; reason: SkipReason }
  | { type: 'warmed' }
  | { type: 'error'; message: string; aborted: boolean; code?: WorkerErrorCode }
);
