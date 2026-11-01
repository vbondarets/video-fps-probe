import { bootstrapApplication } from '@angular/platform-browser';
import { lazyProbe } from 'video-fps-probe/lazy';
import { App } from './app';

declare global {
  interface Window {
    __probe?: unknown;
  }
}

bootstrapApplication(App).then(() => {
  window.__probe = lazyProbe();
});
