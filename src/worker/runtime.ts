import { analyze, DEFAULT_LOADERS } from '../core/analyze.ts';
import type { EngineModule } from '../plugins/types.ts';

export { serveProbeWorker, type EngineSource } from './serve.ts';

export const ownEngine: EngineModule = {
  run: (blob, name, opts) => analyze(blob, name, opts),
  containers: 'any',
  warm: async (containers) => {
    await Promise.all(containers.map((c) => DEFAULT_LOADERS[c]()));
  },
};
