import type { EngineDescriptor } from './types.ts';

export function mediabunny(): EngineDescriptor<'mediabunny'> {
  return {
    id: 'mediabunny',
    thread: 'worker',
    createWorker: () => new Worker(new URL('../worker/mediabunny.worker.ts', import.meta.url), { type: 'module' }),
    load: async () => (await Promise.all([import('../engines/mediabunny.ts'), import('../core/stats.ts')]))[0],
    loadOwn: async () => (await import('../worker/runtime.ts')).ownEngine,
  };
}
