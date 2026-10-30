import { analyzeHeader } from 'video-fps-probe/header';

declare global {
  interface Window {
    __header?: { analyzeHeader: typeof analyzeHeader };
  }
}

window.__header = { analyzeHeader };
