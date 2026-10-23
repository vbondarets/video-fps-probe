import type { EngineDescriptor } from './types.ts';

export function mp4box(): EngineDescriptor<'mp4box'> {
  return {
    id: 'mp4box',
    thread: 'worker',
    createWorker: () => new Worker(new URL('../worker/mp4box.worker.ts', import.meta.url), { type: 'module' }),
    load: async () => (await Promise.all([import('../engines/mp4box.ts'), import('../core/stats.ts')]))[0],
    loadOwn: async () => (await import('../worker/runtime.ts')).ownEngine,
  };
}
