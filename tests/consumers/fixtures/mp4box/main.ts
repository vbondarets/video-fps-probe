import { lazyProbe } from 'video-fps-probe/lazy';
import { mp4box } from 'video-fps-probe/mp4box';

window.__probe = lazyProbe({ engines: [mp4box()] });
