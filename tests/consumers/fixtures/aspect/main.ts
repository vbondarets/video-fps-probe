import { aspectOf, withAspect } from 'video-fps-probe/aspect';
import { analyzeHeader } from 'video-fps-probe/header';

declare global {
  interface Window {
    __header?: { analyzeHeader: typeof analyzeHeader };
    __aspect?: { analyzeHeader: typeof analyzeHeader; aspectOf: typeof aspectOf; withAspect: typeof withAspect };
  }
}

window.__header = { analyzeHeader };
window.__aspect = { analyzeHeader, aspectOf, withAspect };
