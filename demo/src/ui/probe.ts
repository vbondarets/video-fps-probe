import { createProbeClient } from 'video-fps-probe/client';
import { rvfc } from 'video-fps-probe/rvfc';

export const probe = createProbeClient({
  worker: {
    create: () => new Worker(new URL('./probe.worker.ts', import.meta.url), { type: 'module' }),
    engines: ['own', 'mp4box', 'mediabunny'],
  },
  engines: [rvfc()],
  workers: 2,
  idleTimeoutMs: 0,
});
