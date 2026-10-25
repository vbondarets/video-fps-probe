import { check } from 'video-fps-probe/check';
import { lazyProbe } from 'video-fps-probe/lazy';
import { klingO1ReferenceVideo } from 'video-fps-probe/presets';

window.__probe = lazyProbe();
window.__check = { check, preset: klingO1ReferenceVideo };
