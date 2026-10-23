import { lazyProbe } from 'video-fps-probe/lazy';
import { mediabunny } from 'video-fps-probe/mediabunny';

window.__probe = lazyProbe({ engines: [mediabunny()] });
