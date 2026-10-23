import { ownEngine, serveProbeWorker } from '../worker/runtime.ts';

serveProbeWorker({
  own: ownEngine,
  mp4box: async () => (await Promise.all([import('../engines/mp4box.ts'), import('../core/stats.ts')]))[0],
  mediabunny: async () => (await Promise.all([import('../engines/mediabunny.ts'), import('../core/stats.ts')]))[0],
});
