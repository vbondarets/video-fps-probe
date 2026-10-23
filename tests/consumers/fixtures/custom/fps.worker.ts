import { ownEngine, serveProbeWorker } from 'video-fps-probe/worker-runtime';

serveProbeWorker({ own: ownEngine });
