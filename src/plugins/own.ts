import type { ContainerFamily, EngineDescriptor } from './types.ts';

export const ownDescriptor: EngineDescriptor<'own'> & { readonly createWorkers: Readonly<Record<ContainerFamily, () => Worker>> } = {
  id: 'own',
  thread: 'worker',
  createWorkers: {
    isobmff: () => new Worker(new URL('../worker/own-isobmff.worker.ts', import.meta.url), { type: 'module' }),
    matroska: () => new Worker(new URL('../worker/own-matroska.worker.ts', import.meta.url), { type: 'module' }),
  },
  load: () => import('../worker/runtime.ts').then((m) => m.ownEngine),
};
