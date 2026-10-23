import { ownEngine, serveProbeWorker } from './runtime.ts';

serveProbeWorker({
  own: ownEngine,
  mediabunny: async () => (await Promise.all([import('../engines/mediabunny.ts'), import('../core/stats.ts')]))[0],
});
