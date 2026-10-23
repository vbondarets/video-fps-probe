import { ownEngine, serveProbeWorker } from './runtime.ts';

serveProbeWorker({ own: ownEngine });
