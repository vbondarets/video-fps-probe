import { ProbeError } from '../api/errors.ts';
import type { EngineId } from '../core/types.ts';
import type { EngineDescriptor } from '../plugins/types.ts';
import type { LazyProbe, Probe } from './types.ts';

export const knownEngines = <Id extends EngineId>(worker: { readonly engines: readonly EngineId[] } | string | undefined, descriptors: readonly EngineDescriptor[] = []): Id[] =>
  [...new Set(['own', ...(typeof worker === 'object' ? worker.engines : []), ...descriptors.map((d) => d.id)])] as Id[];

export function lazyStub<Id extends EngineId>(factory: () => Promise<Probe<Id>>, known: readonly Id[]): LazyProbe<Id> {
  let probe: Probe<Id> | null = null;
  let loading: Promise<Probe<Id>> | null = null;
  const life = new AbortController();
  const aborted = () => new ProbeError('aborted', 'probe destroyed');
  const load = () =>
    (loading ??= new Promise<Probe<Id>>((resolve) => resolve(factory())).then(
      (p) => {
        if (life.signal.aborted) p.destroy();
        return (probe = p);
      },
      (e: unknown) => {
        loading = null;
        throw e instanceof ProbeError ? e : Object.assign(new ProbeError('worker-failed', String(e), { cause: e }), { reason: 'load' as const });
      },
    ));
  const loadUnlessDestroyed = () =>
    new Promise<Probe<Id>>((resolve, reject) => {
      const stop = () => reject(aborted());
      life.signal.addEventListener('abort', stop);
      load().then(resolve, reject).finally(() => life.signal.removeEventListener('abort', stop));
    });
  const forward = <T>(call: (p: Probe<Id>) => Promise<T>): Promise<T> => {
    if (life.signal.aborted) return Promise.reject(aborted());
    const loaded = probe;
    return loaded ? new Promise<T>((resolve) => resolve(call(loaded))) : loadUnlessDestroyed().then((p) => (life.signal.aborted ? Promise.reject(aborted()) : call(p)));
  };
  return {
    get loaded() {
      return probe !== null;
    },
    get engines() {
      return probe?.engines ?? known;
    },
    load,
    analyze: (file, o) => forward((p) => p.analyze(file, o)),
    tryAnalyze: (file, o) => forward((p) => p.tryAnalyze(file, o)).catch(() => null),
    compare: (file, o) => forward((p) => p.compare(file, o)),
    prewarm: (o) => forward((p) => p.prewarm(o)).catch(() => {}),
    dispose: () => probe?.dispose(),
    destroy: () => {
      life.abort();
      probe?.destroy();
    },
  };
}
