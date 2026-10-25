import { check } from 'video-fps-probe/check';
import { lazyProbe } from 'video-fps-probe/lazy';

window.__probe = lazyProbe();
window.__check = { check };
