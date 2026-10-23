import { ownEngine, serveProbeWorker } from './runtime.ts';

serveProbeWorker({
  own: ownEngine,
  mp4box: () => import('../engines/mp4box.ts'),
  mediabunny: () => import('../engines/mediabunny.ts'),
});
