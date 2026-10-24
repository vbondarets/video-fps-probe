import { analyze, DEFAULT_LOADERS, errorMessage, isAbortError } from '../core/analyze.ts';
import { containerFamily } from '../core/sniff.ts';
import type { ContainerFamily, EngineModule, WorkerEngineId } from '../plugins/types.ts';
import { PROTOCOL_VERSION, type AnalyzeRequest, type WarmRequest, type WorkerErrorCode, type WorkerRequest, type WorkerResponse } from './protocol.ts';

export type EngineSource = EngineModule | (() => Promise<EngineModule>);

type Reply = WorkerResponse extends infer R ? (R extends WorkerResponse ? Omit<R, 'v'> : never) : never;

const PROGRESS_INTERVAL_MS = 50;

export const ownEngine: EngineModule = {
  run: (blob, name, opts) => analyze(blob, name, opts),
  containers: 'any',
  warm: async (containers) => {
    await Promise.all(containers.map((c) => DEFAULT_LOADERS[c]()));
  },
};

const failure = (message: string, code: WorkerErrorCode) => Object.assign(new Error(message), { code });

const isFamily = (c: unknown): c is ContainerFamily => c === 'isobmff' || c === 'matroska';

export function serveProbeWorker(engines: Partial<Record<WorkerEngineId, EngineSource>>): void {
  const ctx = self as unknown as {
    postMessage(message: WorkerResponse): void;
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  };
  const loaded = new Map<WorkerEngineId, Promise<EngineModule>>();
  const running = new Map<number, AbortController>();
  const post = (reply: Reply) => ctx.postMessage({ v: PROTOCOL_VERSION, ...reply } as WorkerResponse);

  const load = (id: WorkerEngineId): Promise<EngineModule> => {
    let module = loaded.get(id);
    if (!module) {
      const source = Object.hasOwn(engines, id) ? engines[id] : undefined;
      if (!source) return Promise.reject(failure(`unknown engine ${id}`, 'unknown-engine'));
      module = (typeof source === 'function' ? Promise.all([source(), import('../core/stats.ts')]).then(([m]) => m) : Promise.resolve(source)).catch((e: unknown) => {
        loaded.delete(id);
        throw e;
      });
      loaded.set(id, module);
    }
    return module;
  };

  const fail = (id: number, e: unknown, aborted = false, loading = false) => {
    const code = (e as { code?: unknown } | null)?.code;
    const known = code === 'unknown-engine' || code === 'protocol';
    post({
      type: 'error',
      id,
      message: errorMessage(e),
      aborted: aborted || isAbortError(e),
      ...(known ? { code } : loading && { reason: 'load' as const }),
    });
  };

  const analyzeJob = async (job: AnalyzeRequest & { id: number }) => {
    const controller = new AbortController();
    running.set(job.id, controller);
    let lastProgress = 0;
    let loading = true;
    try {
      if (!(job.file instanceof Blob)) throw failure('malformed analyze request', 'protocol');
      const engine = await load(job.engine);
      loading = false;
      if (engine.containers !== 'any') {
        const family = await containerFamily(job.file);
        if (!family || !engine.containers.includes(family)) return post({ type: 'skipped', id: job.id, reason: 'unsupported-container', family });
      }
      const result = await engine.run(job.file, job.name, {
        ...job.options,
        signal: controller.signal,
        onProgress: (progress) => {
          const now = performance.now();
          if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
          lastProgress = now;
          post({ type: 'progress', id: job.id, progress });
        },
      });
      post({ type: 'result', id: job.id, result });
    } catch (e) {
      fail(job.id, e, controller.signal.aborted, loading);
    } finally {
      running.delete(job.id);
    }
  };

  const warmJob = async (job: WarmRequest & { id: number }) => {
    try {
      if (![job.engines, job.containers].every(Array.isArray) || !job.containers.every(isFamily)) throw failure('malformed warm request', 'protocol');
      await Promise.all(job.engines.map(async (id) => (await load(id)).warm?.(job.containers)));
      post({ type: 'warmed', id: job.id });
    } catch (e) {
      fail(job.id, e);
    }
  };

  ctx.onmessage = ({ data }) => {
    if (data?.v !== PROTOCOL_VERSION) return fail(data?.id ?? 0, failure(`unsupported protocol version ${data?.v}`, 'protocol'));
    if (data.type === 'cancel') running.get(data.id)?.abort();
    else if (data.type === 'analyze') void analyzeJob(data);
    else if (data.type === 'warm') void warmJob(data);
    else {
      const unknown = data as { id: number; type: unknown };
      fail(unknown.id, failure(`unknown request type ${unknown.type}`, 'protocol'));
    }
  };
}
