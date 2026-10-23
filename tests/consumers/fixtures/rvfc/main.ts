import { lazyProbe } from 'video-fps-probe/lazy';
import { rvfc } from 'video-fps-probe/rvfc';

window.__probe = lazyProbe({ engines: [rvfc()] });
