import { ownEngine, serveProbeWorker } from 'video-fps-probe/worker-runtime';

serveProbeWorker({
  own: ownEngine,
  mp4box: async () => (await Promise.all([import('video-fps-probe/engines/mp4box'), import('../../../src/core/stats.ts')]))[0],
  mediabunny: async () => (await Promise.all([import('video-fps-probe/engines/mediabunny'), import('../../../src/core/stats.ts')]))[0],
});
