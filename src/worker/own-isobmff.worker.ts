import { analyzeIsoBmff } from '../core/isobmff/index.ts';
import { serveProbeWorker } from './serve.ts';
import { singleContainerEngine } from './single.ts';

serveProbeWorker({ own: singleContainerEngine('isobmff', analyzeIsoBmff) });
