import { analyzeMatroska } from '../core/matroska/index.ts';
import { serveProbeWorker } from './serve.ts';
import { singleContainerEngine } from './single.ts';

serveProbeWorker({ own: singleContainerEngine('matroska', analyzeMatroska) });
