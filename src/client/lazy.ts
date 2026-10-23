import type { EngineId } from '../core/types.ts';
import type { EngineDescriptor, WorkerEngineId } from '../plugins/types.ts';
import type { ClientOptions, IdOf, LazyProbe, Probe } from './types.ts';

export type { ClientOptions, LazyProbe, Probe };

export function lazyProbeFrom<Id extends EngineId>(factory: () => Promise<Probe<Id>>): LazyProbe<Id> {
  let probe: Probe<Id> | null = null;
  let loading: Promise<Probe<Id>> | null = null;
  const load = () =>
    (loading ??= factory().then(
      (p) => (probe = p),
      (e: unknown) => {
        loading = null;
        throw e;
      },
    ));
  return {
    get loaded() {
      return probe !== null;
    },
    get engines() {
      return probe?.engines ?? [];
    },
    load,
    analyze: (file, o) => load().then((p) => p.analyze(file, o)),
    tryAnalyze: (file, o) => load().then((p) => p.tryAnalyze(file, o), () => null),
    compare: (file, o) => load().then((p) => p.compare(file, o)),
    prewarm: (o) => load().then((p) => p.prewarm(o), () => {}),
    dispose: () => probe?.dispose(),
    destroy: () => probe?.destroy(),
  };
}

export function lazyProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(
  options: ClientOptions<E, W>,
): LazyProbe<W | IdOf<E[number]> | 'own'> {
  return lazyProbeFrom(() => import('./probe.ts').then((m) => m.createProbeClient(options)));
}
