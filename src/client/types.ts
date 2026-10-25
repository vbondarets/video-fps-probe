import type { Agreement } from '../api/agreement.ts';
import type { ProbeError } from '../api/errors.ts';
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

export interface ProbeOptions<E extends readonly EngineDescriptor[] = []> extends BaseOptions<NoInfer<'own' | IdOf<E[number]>>> {
  engines?: E;
  worker?: 'auto' | 'inline';
}

export interface CustomWorker<W extends WorkerEngineId> {
  create: () => Worker;
  engines: readonly W[];
  byContainer?: Readonly<Partial<Record<ContainerFamily, () => Worker>>>;
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

export interface CompareOptions<K extends EngineId> {
  engines?: readonly K[];
  reference?: K;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: AnalyzeProgress & { engine: K }) => void;
}

export type EngineOutcome =
  | { status: 'ok'; result: ProbeResult; ms: number }
  | { status: 'failed'; result: ProbeResult; error: string; ms: number }
  | { status: 'skipped'; reason: 'unsupported-container' | 'unsupported-environment' }
  | { status: 'timeout' | 'crashed'; error: ProbeError };

export interface CompareResult<K extends EngineId> {
  name: string;
  size: number;
  reference: K | null;
  outcomes: Partial<Record<K, EngineOutcome>>;
  agreement: Agreement<K>;
}

export interface Probe<Id extends EngineId = 'own'> {
  readonly engines: readonly Id[];
  analyze(file: Blob, options?: CallOptions<Id>): Promise<ProbeResult>;
  tryAnalyze(file: Blob, options?: CallOptions<Id>): Promise<ProbeResult | null>;
  compare<K extends Id>(file: Blob, options?: CompareOptions<K>): Promise<CompareResult<K>>;
  prewarm(options?: PrewarmOptions<Id>): Promise<void>;
  dispose(): void;
  destroy(): void;
}

export type LazyProbe<Id extends EngineId> = Probe<Id> & {
  readonly loaded: boolean;
  load(): Promise<Probe<Id>>;
};
