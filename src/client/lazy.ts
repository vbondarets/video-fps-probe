import { ProbeError } from '../api/errors.ts';
import type { EngineId } from '../core/types.ts';
import type { EngineDescriptor, WorkerEngineId } from '../plugins/types.ts';
import type { ClientOptions, IdOf, LazyProbe, Probe } from './types.ts';

export type { ClientOptions, LazyProbe, Probe };

export function lazyProbeFrom<Id extends EngineId>(factory: () => Promise<Probe<Id>>): LazyProbe<Id> {
  let probe: Probe<Id> | null = null;
  let loading: Promise<Probe<Id>> | null = null;
  let destroyed = false;
  const aborted = () => Promise.reject(new ProbeError('aborted', 'probe destroyed'));
  const load = () =>
    (loading ??= new Promise<Probe<Id>>((resolve) => resolve(factory())).then(
      (p) => {
        if (destroyed) p.destroy();
        return (probe = p);
      },
      (e: unknown) => {
        loading = null;
        throw e;
      },
    ));
  const forward = <T>(call: (p: Probe<Id>) => Promise<T>): Promise<T> => {
    if (destroyed) return aborted();
    const loaded = probe;
    return loaded ? new Promise<T>((resolve) => resolve(call(loaded))) : load().then((p) => (destroyed ? aborted() : call(p)));
  };
  return {
    get loaded() {
      return probe !== null;
    },
    get engines() {
      return probe?.engines ?? [];
    },
    load,
    analyze: (file, o) => forward((p) => p.analyze(file, o)),
    tryAnalyze: (file, o) => forward((p) => p.tryAnalyze(file, o)).catch(() => null),
    compare: (file, o) => forward((p) => p.compare(file, o)),
    prewarm: (o) => forward((p) => p.prewarm(o)).catch(() => {}),
    dispose: () => probe?.dispose(),
    destroy: () => {
      destroyed = true;
      probe?.destroy();
    },
  };
}

export function lazyProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(
  options: ClientOptions<E, W>,
): LazyProbe<W | IdOf<E[number]> | 'own'> {
  return lazyProbeFrom(() => import('./probe.ts').then((m) => m.createProbeClient(options)));
}
