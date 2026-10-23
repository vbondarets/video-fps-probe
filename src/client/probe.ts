import { isAbortError, ProbeError } from '../api/errors.ts';
import { emptyAnalysis, primaryTrack } from '../core/result.ts';
import type { EngineId } from '../core/types.ts';
import type { EngineDescriptor, EngineModule, WorkerEngineId } from '../plugins/types.ts';
import type { WireOptions } from '../worker/protocol.ts';
import type { InlineReply } from './inline.ts';
import { WorkerPool } from './pool.ts';
import type { Attempt, BaseOptions, CallOptions, ClientOptions, CustomWorker, IdOf, Probe, ProbeResult } from './types.ts';

export interface CoreOptions extends BaseOptions<EngineId> {
  worker?: CustomWorker<WorkerEngineId> | 'inline';
  engines?: readonly EngineDescriptor[];
}

type Route = { kind: string; pool: () => WorkerPool } | { load: () => Promise<EngineModule> } | { error: ProbeError };

export type Run = (id: EngineId, file: Blob, name: string, wire: WireOptions, call: CallOptions<EngineId>) => Promise<InlineReply>;

export interface CompareContext {
  engines: readonly EngineId[];
  kindOf(id: EngineId): string;
  has(id: EngineId): boolean;
  run: Run;
  defaults?: WireOptions;
}

type Failure = Attempt & { result?: ProbeResult };

const notRegistered = (id: EngineId, message = `engine ${id} is not registered`) => new ProbeError('engine-not-registered', message, { engine: id });

export const nameOf = (file: Blob): string => (typeof File !== 'undefined' && file instanceof File ? file.name : '');

export const failureOf = (r: ProbeResult): string | null => {
  const t = primaryTrack(r);
  return r.error ?? (!t ? 'no video track' : t.avgFps ? null : 'no frame rate');
};

const withAttempts = (result: ProbeResult, failures: readonly Failure[]): ProbeResult =>
  failures.length > 0 ? { ...result, attempts: failures.map(({ engine, error }) => ({ engine, error })) } : result;

export function createProbeCore(options: CoreOptions): Probe<EngineId> {
  const { worker, engines: descriptors = [], engine: defaultEngine = 'own', fallback: defaultFallback = [], workers, idleTimeoutMs, timeoutMs: defaultTimeout, defaults } = options;
  const custom = typeof worker === 'object' ? worker : null;
  const inline = worker === 'inline' || typeof Worker === 'undefined';
  const pools = new Map<string, WorkerPool>();
  const byId = new Map<EngineId, EngineDescriptor>();
  for (const d of descriptors) if (!byId.has(d.id)) byId.set(d.id, d);
  let life = new AbortController();

  const poolOf = (kind: string, create: () => Worker): Route => ({
    kind,
    pool: () => {
      let pool = pools.get(kind);
      if (!pool) pools.set(kind, (pool = new WorkerPool({ create, size: workers, idleTimeoutMs })));
      return pool;
    },
  });
  const servedBy = (d: EngineDescriptor | undefined, key: 'load' | 'loadOwn'): Route | null => {
    const load = d?.[key];
    if (!d || !load) return null;
    return !inline && d.thread === 'worker' && d.createWorker ? poolOf(d.id, d.createWorker) : { load };
  };
  const routeOf = (id: EngineId): Route | null => {
    const listed: Route | null = !custom?.engines.includes(id as WorkerEngineId)
      ? null
      : inline
        ? { error: new ProbeError('unsupported-environment', `engine ${id} runs in a worker and Worker is not available`, { engine: id }) }
        : poolOf('custom', custom.create);
    if (listed && 'pool' in listed) return listed;
    const route =
      id === 'own'
        ? (servedBy(byId.get(defaultEngine), 'loadOwn') ?? servedBy(byId.get('own'), 'load') ?? servedBy(descriptors.find((d) => d.loadOwn), 'loadOwn'))
        : servedBy(byId.get(id), 'load');
    return route ?? listed;
  };

  const routes = new Map<EngineId, Route>();
  for (const id of ['own', ...(custom?.engines ?? []), ...byId.keys()] as EngineId[]) {
    const route = routes.has(id) ? null : routeOf(id);
    if (route) routes.set(id, route);
  }
  if (!routes.has('own')) throw notRegistered('own', 'own has no route: list it on the custom worker or register a prebuilt engine');
  for (const id of [defaultEngine, ...defaultFallback]) if (!routes.has(id)) throw notRegistered(id);

  const run: Run = (id, file, name, wire, call) => {
    const route = routes.get(id);
    if (!route) return Promise.reject(notRegistered(id));
    if ('error' in route) return Promise.reject(route.error);
    const timeoutMs = call.timeoutMs ?? defaultTimeout;
    if ('pool' in route) {
      return route.pool().run({ type: 'analyze', file, name, engine: id as WorkerEngineId, options: wire }, { signal: call.signal, timeoutMs, onProgress: call.onProgress, engine: id }) as Promise<InlineReply>;
    }
    const signals = [call.signal, life.signal];
    return import('./inline.ts').then(
      (m) => m.runInline(route.load, file, name, wire, { engine: id, signals, timeoutMs, onProgress: call.onProgress, host: call.host }),
      (e: unknown) => Promise.reject(new ProbeError('worker-failed', String(e), { engine: id, cause: e })),
    );
  };

  const analyze = async (file: Blob, call: CallOptions<EngineId> = {}): Promise<ProbeResult> => {
    const { engine = defaultEngine, fallback = defaultFallback, name = nameOf(file), host, signal, timeoutMs, onProgress, ...rest } = call;
    const chain = [...new Set([engine, ...fallback])];
    const missing = chain.find((id) => !routes.has(id));
    if (missing) throw notRegistered(missing);
    const wire = { ...defaults, ...rest };
    const failures: Failure[] = [];
    let last: ProbeError | null = null;
    for (const id of chain) {
      let result: ProbeResult;
      try {
        const reply = await run(id, file, name, wire, { host, signal, timeoutMs, onProgress });
        result =
          reply.type === 'result'
            ? reply.result
            : { name, size: file.size, ...emptyAnalysis('unknown', `${id} does not read this container`), io: { reads: 0, bytesRead: 0, ms: 0 }, engine: id };
      } catch (e) {
        if (isAbortError(e)) throw e;
        last = e instanceof ProbeError ? e : new ProbeError('worker-failed', String(e), { engine: id, cause: e });
        failures.push({ engine: id, error: last.message });
        continue;
      }
      const error = failureOf(result);
      if (error === null) return withAttempts(result, failures);
      failures.push({ engine: id, error, result });
    }
    for (let i = failures.length - 1; i >= 0; i--) {
      const { result } = failures[i];
      if (result) return withAttempts(result, failures.slice(0, i).concat(failures.slice(i + 1)));
    }
    throw last;
  };

  const engines = [...routes.keys()];
  const context: CompareContext = {
    engines,
    kindOf: (id) => {
      const route = routes.get(id);
      return route && 'kind' in route ? route.kind : id;
    },
    has: (id) => routes.has(id),
    run,
    defaults,
  };

  return {
    engines,
    analyze,
    tryAnalyze: (file, call) => analyze(file, call).catch(() => null),
    compare: (file, o) => import('./compare.ts').then((m) => m.compare(context, file, o)),
    async prewarm(o = {}) {
      const containers = o.containers ?? ['isobmff'];
      const warm = new Map<WorkerPool, WorkerEngineId[]>();
      const jobs: Promise<unknown>[] = [];
      for (const id of o.engines ?? [defaultEngine]) {
        const route = routes.get(id);
        if (!route || 'error' in route) continue;
        if ('load' in route) jobs.push(route.load().then((m) => m.warm?.(containers)));
        else {
          const pool = route.pool();
          warm.set(pool, [...(warm.get(pool) ?? []), id as WorkerEngineId]);
        }
      }
      for (const [pool, engines] of warm) jobs.push(pool.run({ type: 'warm', engines, containers }));
      await Promise.allSettled(jobs);
    },
    dispose() {
      for (const pool of pools.values()) pool.dispose();
    },
    destroy() {
      life.abort();
      life = new AbortController();
      for (const pool of pools.values()) pool.destroy();
    },
  };
}

export function createProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(
  options: ClientOptions<E, W>,
): Probe<W | IdOf<E[number]> | 'own'> {
  return createProbeCore(options) as Probe<W | IdOf<E[number]> | 'own'>;
}
