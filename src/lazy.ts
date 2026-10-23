import { lazyProbeFrom } from './client/lazy.ts';
import { knownEngines, lazyStub } from './client/stub.ts';
import type { IdOf, LazyProbe, ProbeOptions } from './client/types.ts';
import type { EngineDescriptor } from './plugins/types.ts';

export { lazyProbeFrom };
export type { LazyProbe, ProbeOptions };

export function lazyProbe<const E extends readonly EngineDescriptor[] = []>(options?: ProbeOptions<E>): LazyProbe<'own' | IdOf<E[number]>> {
  return lazyStub(() => import('./probe.ts').then((m) => m.createProbe(options)), knownEngines(undefined, options?.engines));
}
