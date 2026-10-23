import { lazyProbeClient } from 'video-fps-probe/client/lazy';

window.__probe = lazyProbeClient({
  worker: {
    create: () => new Worker(new URL('./fps.worker.ts', import.meta.url), { type: 'module' }),
    engines: ['own'],
  },
});
