import { lazyProbe } from 'video-fps-probe/lazy';
import { mediabunny } from 'video-fps-probe/mediabunny';
import { mp4box } from 'video-fps-probe/mp4box';
import { rvfc } from 'video-fps-probe/rvfc';

window.__probe = lazyProbe({ engines: [mp4box(), mediabunny(), rvfc()] });
