import type { EngineDescriptor, WorkerEngineId } from '../plugins/types.ts';
import { createProbeCore } from './probe.ts';
import { splitRoute } from './route.ts';
import type { ClientOptions, IdOf, Probe } from './types.ts';

export function createProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(
  options: ClientOptions<E, W>,
): Probe<W | IdOf<E[number]> | 'own'> {
  return createProbeCore({ ...options, split: splitRoute }) as Probe<W | IdOf<E[number]> | 'own'>;
}
