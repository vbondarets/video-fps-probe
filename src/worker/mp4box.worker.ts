import { ownEngine, serveProbeWorker } from './runtime.ts';

serveProbeWorker({
  own: ownEngine,
  mp4box: async () => (await Promise.all([import('../engines/mp4box.ts'), import('../core/stats.ts')]))[0],
});
