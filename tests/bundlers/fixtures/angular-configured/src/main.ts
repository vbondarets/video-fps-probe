import { bootstrapApplication } from '@angular/platform-browser';
import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import { App } from './app';

declare global {
  interface Window {
    __probe?: unknown;
  }
}

bootstrapApplication(App).then(() => {
  window.__probe = lazyProbeClient({
    worker: {
      create: () => new Worker('/own-isobmff.worker.js'),
      engines: ['own'],
      byContainer: { matroska: () => new Worker('/own-matroska.worker.js') },
    },
  });
});
