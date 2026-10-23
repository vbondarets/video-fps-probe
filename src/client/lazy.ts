import type { EngineId } from '../core/types.ts';
import type { EngineDescriptor, WorkerEngineId } from '../plugins/types.ts';
import { knownEngines, lazyStub } from './stub.ts';
import type { ClientOptions, IdOf, LazyProbe, Probe } from './types.ts';

export type { ClientOptions, LazyProbe, Probe };

export function lazyProbeFrom<Id extends EngineId>(factory: () => Promise<Probe<Id>>): LazyProbe<Id> {
  return lazyStub(factory, []);
}

export function lazyProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(
  options: ClientOptions<E, W>,
): LazyProbe<W | IdOf<E[number]> | 'own'> {
  return lazyStub(() => import('./probe.ts').then((m) => m.createProbeClient(options)), knownEngines(options.worker, options.engines));
}
