import { lazyProbeFrom } from './client/lazy.ts';
import type { IdOf, LazyProbe, ProbeOptions } from './client/types.ts';
import type { EngineDescriptor } from './plugins/types.ts';

export { lazyProbeFrom };
export type { LazyProbe, ProbeOptions };

export function lazyProbe<const E extends readonly EngineDescriptor[] = []>(options?: ProbeOptions<E>): LazyProbe<'own' | IdOf<E[number]>> {
  return lazyProbeFrom(() => import('./probe.ts').then((m) => m.createProbe(options)));
}
