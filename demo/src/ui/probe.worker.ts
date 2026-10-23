import { ownEngine, serveProbeWorker } from 'video-fps-probe/worker-runtime';

serveProbeWorker({
  own: ownEngine,
  mp4box: () => import('video-fps-probe/engines/mp4box'),
  mediabunny: () => import('video-fps-probe/engines/mediabunny'),
});
