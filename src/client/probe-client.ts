import type { EngineDescriptor, WorkerEngineId } from '../plugins/types.ts';
import { createProbeCore } from './probe.ts';
import type { ClientOptions, CustomWorker, IdOf, Probe } from './types.ts';

export const loadProbeClient = <const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(options: ClientOptions<E, W>): Probe<W | IdOf<E[number]> | 'own'> | Promise<Probe<W | IdOf<E[number]> | 'own'>> =>
  (options.worker as Partial<CustomWorker<W>> | undefined)?.byContainer
    ? import('./route.ts').then((m) => createProbeCore({ ...options, split: m.splitRoute }) as Probe<W | IdOf<E[number]> | 'own'>)
    : (createProbeCore(options) as Probe<W | IdOf<E[number]> | 'own'>);
