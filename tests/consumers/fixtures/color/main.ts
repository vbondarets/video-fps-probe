import { colorOf, withColor } from 'video-fps-probe/color';
import { analyzeHeader } from 'video-fps-probe/header';

declare global {
  interface Window {
    __header?: { analyzeHeader: typeof analyzeHeader };
    __color?: { analyzeHeader: typeof analyzeHeader; colorOf: typeof colorOf; withColor: typeof withColor };
  }
}

window.__header = { analyzeHeader };
window.__color = { analyzeHeader, colorOf, withColor };
