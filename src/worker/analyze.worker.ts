import { ownEngine, serveProbeWorker } from './runtime.ts';

serveProbeWorker({
  own: ownEngine,
  mp4box: () => import('../engines/mp4box.ts').then((m) => ({ run: m.analyzeWithMp4box, containers: ['isobmff'] })),
  mediabunny: () => import('../engines/mediabunny.ts').then((m) => ({ run: m.analyzeWithMediabunny, containers: ['isobmff', 'matroska'] })),
});
