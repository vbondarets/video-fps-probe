import type { AnalyzeProgress, EngineId, FileResult } from '../core/types.ts';
import type { MediabunnyNative, Mp4boxNative, RvfcDetails } from '../engines/types.ts';
import type { ContainerFamily, EngineDescriptor, WorkerEngineId } from '../plugins/types.ts';
import type { WireOptions } from '../worker/protocol.ts';

export type IdOf<E> = E extends EngineDescriptor<infer I> ? I : never;

export interface BaseOptions<Id extends EngineId> {
  engine?: Id;
  fallback?: readonly Id[];
  workers?: number;
  idleTimeoutMs?: number;
  timeoutMs?: number;
  defaults?: WireOptions;
}

export interface CustomWorker<W extends WorkerEngineId> {
  create: () => Worker;
  engines: readonly W[];
}

export interface ClientOptions<E extends readonly EngineDescriptor[] = [], W extends WorkerEngineId = never> extends BaseOptions<NoInfer<W | IdOf<E[number]> | 'own'>> {
  worker: CustomWorker<W> | 'inline';
  engines?: E;
}

export interface CallOptions<Id extends EngineId> extends WireOptions {
  engine?: Id;
  fallback?: readonly Id[];
  name?: string;
  host?: HTMLElement;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: AnalyzeProgress) => void;
}

export interface Attempt {
  engine: EngineId;
  error: string;
}

export type ProbeResult = FileResult & {
  mp4box?: Mp4boxNative;
  mediabunny?: MediabunnyNative;
  rvfc?: RvfcDetails;
  attempts?: readonly Attempt[];
};

export interface PrewarmOptions<Id extends EngineId> {
  engines?: readonly Id[];
  containers?: readonly ContainerFamily[];
}

export interface Probe<Id extends EngineId = 'own'> {
  readonly engines: readonly Id[];
  analyze(file: Blob, options?: CallOptions<Id>): Promise<ProbeResult>;
  tryAnalyze(file: Blob, options?: CallOptions<Id>): Promise<ProbeResult | null>;
  prewarm(options?: PrewarmOptions<Id>): Promise<void>;
  dispose(): void;
  destroy(): void;
}
