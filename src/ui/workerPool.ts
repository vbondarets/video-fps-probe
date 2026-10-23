import type { WorkerPool } from '../client/pool.ts';
import type { AnalyzeProgress, FileResult } from '../core/types.ts';
import type { WorkerEngineId } from '../plugins/types.ts';
import type { WireOptions } from '../worker/protocol.ts';

let pool: Promise<WorkerPool> | undefined;
let loaded: WorkerPool | undefined;

const load = (): Promise<WorkerPool> =>
  (pool ??= import('../client/pool.ts').then(
    ({ WorkerPool }) =>
      (loaded = new WorkerPool({
        create: () => new Worker(new URL('../worker/analyze.worker.ts', import.meta.url), { type: 'module' }),
        size: 2,
        idleTimeoutMs: 0,
      })),
    (e: unknown) => {
      pool = undefined;
      throw e;
    },
  ));

export interface Submitted {
  promise: Promise<FileResult>;
  cancel(): void;
}

export function submit(file: File, engine: WorkerEngineId, options: WireOptions, onProgress?: (progress: AnalyzeProgress) => void): Submitted {
  const controller = new AbortController();
  const promise = load()
    .then((p) => p.run({ type: 'analyze', file, name: file.name, engine, options }, { signal: controller.signal, onProgress, engine }))
    .then((reply) => (reply.type === 'result' ? reply.result : Promise.reject(new Error(`skipped: ${reply.type === 'skipped' ? reply.reason : reply.type}`))));
  return { promise, cancel: () => controller.abort() };
}

export function prewarm(): Promise<void> {
  return load()
    .then((p) => p.run({ type: 'warm', engines: ['own'], containers: ['isobmff'] }))
    .then(
      () => undefined,
      () => undefined,
    );
}

export function dispose(): void {
  loaded?.dispose();
}
