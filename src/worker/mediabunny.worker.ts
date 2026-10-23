import { ownEngine, serveProbeWorker } from './runtime.ts';

serveProbeWorker({
  own: ownEngine,
  mediabunny: () => import('../engines/mediabunny.ts'),
});
