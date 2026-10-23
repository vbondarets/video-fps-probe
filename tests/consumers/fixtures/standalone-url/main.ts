import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import ownWorkerUrl from 'video-fps-probe/standalone/own.worker.js?url';

window.__probe = lazyProbeClient({
  worker: {
    create: () => new Worker(ownWorkerUrl),
    engines: ['own'],
  },
});
