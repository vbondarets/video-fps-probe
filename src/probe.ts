import { createProbeCore } from './client/probe.ts';
import type { IdOf, Probe, ProbeOptions } from './client/types.ts';
import { ownDescriptor } from './plugins/own.ts';
import type { EngineDescriptor } from './plugins/types.ts';

export function createProbe<const E extends readonly EngineDescriptor[] = []>(options: ProbeOptions<E> = {}): Probe<'own' | IdOf<E[number]>> {
  const { engines = [], worker, ...rest } = options;
  return createProbeCore({ ...rest, engines: [ownDescriptor, ...engines], worker: worker === 'inline' ? 'inline' : undefined }) as Probe<'own' | IdOf<E[number]>>;
}
