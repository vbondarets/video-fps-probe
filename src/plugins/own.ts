import type { EngineDescriptor } from './types.ts';

export const ownDescriptor: EngineDescriptor<'own'> = {
  id: 'own',
  thread: 'worker',
  createWorker: () => new Worker(new URL('../worker/own.worker.ts', import.meta.url), { type: 'module' }),
  load: async () => (await import('../worker/runtime.ts')).ownEngine,
};
