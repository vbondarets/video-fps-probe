import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import isobmffWorkerUrl from 'video-fps-probe/standalone/own-isobmff.worker.js' with { type: 'file' };
import matroskaWorkerUrl from 'video-fps-probe/standalone/own-matroska.worker.js' with { type: 'file' };

window.__probe = lazyProbeClient({
  worker: {
    create: () => new Worker(isobmffWorkerUrl),
    engines: ['own'],
    byContainer: { matroska: () => new Worker(matroskaWorkerUrl) },
  },
});
