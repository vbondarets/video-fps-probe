import type { EngineDescriptor, WorkerEngineId } from '../plugins/types.ts';
import { createProbeCore } from './probe.ts';
import { splitBy } from './split.ts';
import type { ClientOptions, IdOf, Probe } from './types.ts';

const splitOnFirstRun = splitBy((pool, lazy, life) => ({
  run: (request, options) => lazy(import('./route.ts'), request.engine).then((m) => m.runByHead(pool, lazy, life).run(request, options)),
}));

export function createProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(
  options: ClientOptions<E, W>,
): Probe<W | IdOf<E[number]> | 'own'> {
  return createProbeCore({ ...options, split: splitOnFirstRun }) as Probe<W | IdOf<E[number]> | 'own'>;
}
