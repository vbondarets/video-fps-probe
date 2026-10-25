import { createProbeClient } from 'video-fps-probe/client';

window.__probe = createProbeClient({
  worker: {
    create: () => new Worker(new URL('./fps.worker.ts', import.meta.url), { type: 'module' }),
    engines: ['own'],
  },
});
