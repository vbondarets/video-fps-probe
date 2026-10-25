import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FIXTURES, consumersDir, fixtureDist, installedPackage } from './consumers.mjs';
import { discover, measure, scanReferences } from './size-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1000;
const PACKAGE_SOURCE = 'node_modules/video-fps-probe/';
const REACT_SOURCE = `${PACKAGE_SOURCE}dist/react/`;

const RESET = 'The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.';
const PROMISE = 'User-facing promise of the package, accepted by the owner on 2026-10-23 when the demo budget moved to 101.5 KB: the default configuration adds at most 1 KB to the critical path and the first MP4 loads at most 24 KB lazily.';

export const BUDGETS = {
  default: [
    { key: 'trigger', limit: 1 * KB, why: `${PROMISE} This row is the first half: the package code in the host entry chunk (the lazyProbe stub, ProbeError and the engine list), cut out of the entry chunk by its sourcemap. Vite's preload helper is not counted here, because every Vite app with a dynamic import already has it; the entry chunk row counts it. Design estimate 1.0 KB; measured 0.67 KB, and measured plus 10 percent rounded up to 0.5 KB is also 1.0 KB.` },
    { key: 'entry', limit: 2 * KB, why: `The whole host entry chunk: the package code of the critical path row, Vite's preload helper, which Vite adds to the entry chunk of any app with a dynamic import, and the one line of host code. The critical path row stays the package promise; this row also catches what the package makes Vite add next to its code, such as a longer preload dependency list per dynamic import. Measured 1.40 KB. ${RESET}` },
    { key: 'client', limit: 3 * KB, why: `The probe client fetched on the first file: createProbe, engine routing, the worker pool and the own descriptor with the worker literal. Design estimate 3.5 KB; measured 2.67 KB. ${RESET}` },
    { key: 'worker:own.worker', limit: 4.5 * KB, why: `The prebuilt own worker entry: reader, sniffing, options and the worker runtime. Both parsers and the statistics are lazy chunks of this worker. Design estimate 8.0 KB; measured 4.08 KB. ${RESET}` },
    { key: 'isobmff', limit: 13.5 * KB, why: `The own MP4 and MOV parser chunk of the own worker. Design estimate 13.5 KB; measured 12.21 KB. ${RESET}` },
    { key: 'matroska', limit: 12.5 * KB, why: `The own Matroska and WebM parser chunk of the own worker. Design estimate 12.0 KB; measured 11.14 KB. ${RESET}` },
    { key: 'segments', limit: 2.5 * KB, why: `The rate profile core of the own worker, fetched only for a timeline with unequal frame rates. Design estimate 2.0 KB; measured 1.84 KB. ${RESET}` },
    { key: 'rfps', limit: 4 * KB, why: `The ffprobe frame rate estimate of the own worker, fetched by the Matroska parser only for a Matroska or WebM file without DefaultDuration, read in probe and exact mode. Measured 2.76 KB. ${RESET} Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.54 KB, when the estimate began to read the H.264 slice headers that decide the decoder delay and to ride the block walk of the exact scan instead of a walk of its own.` },
    { key: 'firstMp4', limit: 24 * KB, why: `${PROMISE} This row is the second half: everything the first MP4 or MOV file loads lazily, which is the probe client, the own worker entry, the statistics chunk (requested in parallel with the parser) and the ISO BMFF parser. Measured 23.26 KB. Measured plus 10 percent would be 26.0 KB, so the promise stays the limit instead: it is the tighter one and it is what the README states.` },
    { key: 'allOwn', limit: 41 * KB, why: `Every own path: the probe client, the own worker entry, the statistics, both parsers, the rate profile core and the ffprobe frame rate estimate. Design estimate 37.0 KB; measured 36.24 KB before the estimate was added. ${RESET} Raised from 40 KB to 40.5 KB in 0.2.0, measured 40.34 KB, when the ffprobe frame rate estimate began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip). Raised again to 41 KB, measured 40.58 KB, when the estimate began to ride the block walk of the exact scan (0.23 KB in the estimate and the Matroska parser).` },
    { key: 'lazyTotal', limit: 81 * KB, why: `Every JavaScript file the build emits outside the entry chunk, fetched or not: the probe client with its compare and fallback chunks, the own worker with its chunks, and the main-thread copies of the parsers, the statistics, the sniffer and the worker runtime. The default flavor keeps them as an in-thread own for environments without a Worker global (SSR, Node) and for worker: 'inline'; a root analyze(), not imported here, always runs in the calling thread on the same copies. A browser with a Worker global never fetches them otherwise, so the lazy totals above leave them out. This row bounds what the package adds to the deploy and the CDN. Measured 72.20 KB. ${RESET} Raised from 79.5 KB to 81 KB in 0.2.0, measured 80.43 KB, when the ffprobe frame rate estimate began to read the H.264 slice headers: the build emits that code twice, in the own worker and in the main-thread copy.` },
  ],
  'zero-config': [
    { key: 'trigger', limit: 1 * KB, why: `As in the default configuration: the worker option does not change the entry chunk. Measured 0.67 KB. ${RESET}` },
    { key: 'entry', limit: 2 * KB, why: `As in the default configuration: the worker option does not change the entry chunk. Measured 1.40 KB. ${RESET}` },
    { key: 'worker:own.worker', limit: 36 * KB, why: `A Vite 8 app with no worker option builds workers with Vite's default format, 'iife', which cannot split, so the own worker is one file: both parsers, the statistics and the rate profile core are inlined. Measured 32.11 KB. ${RESET} Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.65 KB, when the ffprobe frame rate estimate, which the one-file worker inlines, began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip).` },
    { key: 'firstMp4', limit: 39 * KB, why: `What the first MP4 loads in a Vite 8 app that keeps the default worker format: the probe client and the one-file own worker. The 24 KB of the default configuration needs worker.format 'es' in the host's Vite config. Measured 34.77 KB. ${RESET} Raised from 38.5 KB to 39 KB in 0.2.0, measured 38.55 KB, because the one-file worker inlines the ffprobe frame rate estimate, which then began to read the H.264 slice headers (0.63 KB gzip).` },
    { key: 'lazyTotal', limit: 79.5 * KB, why: `As in the default configuration, with the one-file own worker instead of the worker entry and its chunks. Measured 70.75 KB. ${RESET} Raised from 78 KB to 79 KB in 0.2.0, measured 78.66 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the worker and in the main-thread copy. Raised again to 79.5 KB, measured 79.06 KB, when the estimate began to ride the block walk of the exact scan.` },
  ],
  custom: [
    { key: 'trigger', limit: 1 * KB, why: `The lazyProbeClient stub in the host entry chunk. The host's worker literal is host code and is not counted. Design estimate 1.0 KB; measured 0.68 KB. ${RESET}` },
    { key: 'entry', limit: 2 * KB, why: `The lazyProbeClient stub, Vite's preload helper and the host's worker literal. Measured 1.47 KB. ${RESET}` },
    { key: 'client', limit: 3 * KB, why: `The probe client fetched on the first file, without the own descriptor and its worker literal, which the host replaces with its own worker. Measured 2.56 KB. ${RESET}` },
    { key: 'worker:fps.worker', limit: 4.5 * KB, why: `The host worker built from video-fps-probe/worker-runtime, serving own only. Design estimate 8.5 KB; measured 4.08 KB. ${RESET}` },
    { key: 'firstMp4', limit: 24 * KB, why: 'A host worker that serves own holds the same code as the prebuilt own worker, so the 24 KB promise of the default configuration applies to the first MP4 here too. Measured 23.15 KB.' },
    { key: 'lazyTotal', limit: 81 * KB, why: `As in the default configuration, with the host worker instead of the prebuilt own worker. In the client flavor the main-thread copies are there for worker: 'inline' and for environments without a Worker global, where own runs in the calling thread; a browser with a Worker global never fetches them otherwise. Measured 72.11 KB. ${RESET} Raised from 79.5 KB to 80.5 KB in 0.2.0, measured 80.33 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the host worker and in the main-thread copy. Raised again to 81 KB, measured 80.79 KB, when the estimate began to ride the block walk of the exact scan.` },
  ],
  mp4box: [
    { key: 'trigger', limit: 1 * KB, why: `The default trigger plus the mp4box descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. ${RESET}` },
    { key: 'entry', limit: 2 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.75 KB. ${RESET}` },
    { key: 'worker:mp4box.worker', limit: 5 * KB, why: `The prebuilt mp4box worker entry, which serves own and mp4box. Design estimate 8.5 KB; measured 4.22 KB. ${RESET}` },
    { key: 'mp4box', limit: 49.5 * KB, why: `The mp4box.js engine chunk of the mp4box worker: the mp4box library, the adapter and the counting code the engines share. Design estimate 48.0 KB; measured 44.77 KB. ${RESET}` },
    { key: 'engineShared', limit: 2 * KB, required: false, why: 'Code the comparison engines share, when it is a chunk of its own. Not built: each prebuilt engine worker serves one comparison engine, so this code is part of the engine chunk. The design estimate of 2.0 KB stays the limit, so a split that grows it is caught.' },
    { key: 'lazyTotal', limit: 216 * KB, why: `As in the default configuration plus the mp4box worker, which carries its own copies of the own parsers because it also serves own, and the main-thread copy of the mp4box engine, which runs in the calling thread only with worker: 'inline' or without a Worker global. Measured 195.93 KB. ${RESET}` },
  ],
  mediabunny: [
    { key: 'trigger', limit: 1 * KB, why: `The default trigger plus the mediabunny descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. ${RESET}` },
    { key: 'entry', limit: 2 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.75 KB. ${RESET}` },
    { key: 'worker:mediabunny.worker', limit: 5 * KB, why: `The prebuilt mediabunny worker entry, which serves own and mediabunny. Measured 4.12 KB. ${RESET}` },
    { key: 'mediabunny', limit: 59.5 * KB, why: `The mediabunny engine chunk of the mediabunny worker, with the counting code the engines share. Design estimate 58.0 KB; measured 53.87 KB. ${RESET}` },
    { key: 'engineShared', limit: 2 * KB, required: false, why: 'Code the comparison engines share, when it is a chunk of its own. Not built, for the same reason as in the mp4box configuration. The design estimate of 2.0 KB stays the limit.' },
    { key: 'lazyTotal', limit: 234.5 * KB, why: `As in the mp4box configuration, with the mediabunny worker and engine. Measured 212.89 KB. ${RESET}` },
  ],
  rvfc: [
    { key: 'trigger', limit: 1 * KB, why: `The default trigger plus the rvfc descriptor, which has no worker literal. Measured 0.77 KB. ${RESET}` },
    { key: 'entry', limit: 2 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.59 KB. ${RESET}` },
    { key: 'rvfc', limit: 2.5 * KB, why: `The requestVideoFrameCallback engine, a main-thread chunk loaded on its first run. Design estimate 2.5 KB; measured 2.19 KB. ${RESET}` },
    { key: 'lazyTotal', limit: 83.5 * KB, why: `As in the default configuration plus the main-thread rVFC engine. Measured 74.52 KB. ${RESET} Raised from 82 KB to 83 KB in 0.2.0, measured 82.76 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the worker and in the main-thread copy. Raised again to 83.5 KB, measured 83.21 KB, when the estimate began to ride the block walk of the exact scan.` },
  ],
  all: [
    { key: 'trigger', limit: 1.5 * KB, why: `The default trigger plus the mp4box, mediabunny and rvfc descriptors. Measured 1.02 KB. ${RESET}` },
    { key: 'entry', limit: 2.5 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.92 KB. ${RESET}` },
    { key: 'client', limit: 3 * KB, why: `As in the default configuration. Measured 2.71 KB. ${RESET}` },
    { key: 'worker:own.worker', limit: 4.5 * KB, why: `As in the default configuration. Measured 4.08 KB. ${RESET}` },
    { key: 'worker:mp4box.worker', limit: 5 * KB, why: `As in the mp4box configuration. Measured 4.22 KB. ${RESET}` },
    { key: 'worker:mediabunny.worker', limit: 5 * KB, why: `As in the mediabunny configuration. Measured 4.12 KB. ${RESET}` },
    { key: 'mp4box', limit: 49.5 * KB, why: `As in the mp4box configuration. Measured 44.77 KB. ${RESET}` },
    { key: 'mediabunny', limit: 59.5 * KB, why: `As in the mediabunny configuration. Measured 53.87 KB. ${RESET}` },
    { key: 'rvfc', limit: 2.5 * KB, why: `As in the rvfc configuration. Measured 2.19 KB. ${RESET}` },
    { key: 'isobmff', limit: 13.5 * KB, why: `As in the default configuration. Measured 12.21 KB. ${RESET}` },
    { key: 'matroska', limit: 12.5 * KB, why: `As in the default configuration. Measured 11.14 KB. ${RESET}` },
    { key: 'segments', limit: 2.5 * KB, why: `As in the default configuration. Measured 1.84 KB. ${RESET}` },
    { key: 'rfps', limit: 4 * KB, why: `As in the default configuration. Measured 2.76 KB. ${RESET} Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.54 KB, as in the default configuration.` },
    { key: 'firstMp4', limit: 24 * KB, why: 'Registering engines must not change what the first own analysis loads, so the 24 KB promise of the default configuration applies here too. Measured 23.31 KB.' },
    { key: 'allOwn', limit: 41 * KB, why: `As in the default configuration. Measured 36.29 KB. ${RESET} Raised from 40 KB to 40.5 KB in 0.2.0, measured 40.38 KB, as in the default configuration. Raised again to 41 KB, measured 40.62 KB, as in the default configuration.` },
    { key: 'engineShared', limit: 2 * KB, required: false, why: 'As in the mp4box and mediabunny configurations: each prebuilt engine worker serves one comparison engine, so no worker builds this chunk. The design estimate of 2.0 KB stays the limit.' },
    { key: 'pageEngineShared', limit: 2 * KB, why: `The counting code mp4box and mediabunny share, which becomes a main-thread chunk of its own when both are registered. It loads only when an engine runs in this thread (worker: 'inline', SSR, no Worker global). Measured 1.51 KB. ${RESET}` },
    { key: 'lazyTotal', limit: 372.5 * KB, why: `Every worker with its own copies of the own parsers, the main-thread copies of every engine and the shared engine chunk, which run in the calling thread only with worker: 'inline' or without a Worker global (rVFC always runs there). Measured 338.19 KB. ${RESET}` },
  ],
  'standalone-url': [
    { key: 'trigger', limit: 1 * KB, why: `The lazyProbeClient stub in the host entry chunk, as in the custom configuration. The asset URL of the standalone file is host code and is not counted. Measured 0.71 KB. ${RESET}` },
    { key: 'entry', limit: 2 * KB, why: `The lazyProbeClient stub, Vite's preload helper and the host's asset URL of the standalone file. Measured 1.46 KB. ${RESET}` },
    { key: 'client', limit: 3 * KB, why: `As in the custom configuration. Measured 2.56 KB. ${RESET}` },
    { key: 'worker:own.worker', limit: 36 * KB, why: `dist/standalone/own.worker.js, which Vite copies unchanged as an asset for the ?url import and the host starts as a classic worker. Measured 32.04 KB, the standalone row below. ${RESET} Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.58 KB, as the standalone row below.` },
    { key: 'firstMp4', limit: 39 * KB, why: `What the first MP4 loads with the standalone worker: the probe client and the one-file worker. It suits a host whose workers must stay classic scripts. Measured 34.60 KB. ${RESET} Raised from 38.5 KB to 39 KB in 0.2.0, measured 38.56 KB, because the standalone file inlines the ffprobe frame rate estimate, which began to read the H.264 slice headers and to ride the block walk of the exact scan (0.81 KB gzip together).` },
    { key: 'lazyTotal', limit: 79 * KB, why: `As in the custom configuration, with the standalone file as the worker. Measured 70.56 KB. ${RESET} Raised from 78 KB to 79 KB in 0.2.0, measured 78.48 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the standalone file and in the main-thread copy.` },
  ],
  'iife-nosplit': [
    { key: 'trigger', limit: 1 * KB, why: `As in the default configuration. Measured 0.67 KB. ${RESET}` },
    { key: 'entry', limit: 2 * KB, why: `As in the default configuration. Measured 1.40 KB. ${RESET}` },
    { key: 'worker:own.worker', limit: 36 * KB, why: `With worker.format iife and codeSplitting false the own worker is one file: both parsers, the statistics and the rate profile core are inlined. Design estimate 35.0 KB; measured 32.11 KB. ${RESET} Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.65 KB, as in the zero-config configuration.` },
    { key: 'lazyTotal', limit: 79.5 * KB, why: `As in the zero-config configuration. Measured 70.75 KB. ${RESET} Raised from 78 KB to 79 KB in 0.2.0, measured 78.66 KB, as in the zero-config configuration. Raised again to 79.5 KB, measured 79.06 KB, as in the zero-config configuration.` },
  ],
  react: [
    { key: 'trigger', limit: 2 * KB, why: `The package code in the entry chunk of a React host that imports video-fps-probe/react next to video-fps-probe/lazy: the lazyProbe stub, ProbeError and the React entry. React and ReactDOM are host code and are not counted. Measured 1.63 KB. ${RESET}` },
    { key: 'react', limit: 1.5 * KB, why: `The part of the critical path the React entry adds: VideoFpsProvider, useVideoFps and the framework-free store that caches by Blob, then by engine and options, and aborts on unmount. Design estimate 1.5 KB; measured 1.17 KB. ${RESET}` },
    { key: 'client', limit: 3 * KB, why: 'As in the default configuration: the React entry adds nothing to the probe client. Measured 2.90 KB.' },
    { key: 'worker:own.worker', limit: 4.5 * KB, why: 'As in the default configuration. Measured 4.18 KB.' },
    { key: 'summary', limit: 0.5 * KB, why: `The summarize module, which the store imports with import() in parallel with the first analysis, so it stays off the critical path. Measured 0.43 KB. ${RESET}` },
    { key: 'firstMp4', limit: 24 * KB, why: 'The first MP4 as in the default configuration: the probe client, the own worker entry, the statistics chunk and the ISO BMFF parser. Measured 23.60 KB.' },
    { key: 'firstMp4Summary', limit: 24.5 * KB, why: 'What the first MP4 of a React host loads lazily: the first MP4 of the default configuration plus the summary module of the store. The 24 KB promise of the default configuration plus the 0.5 KB summary budget. Measured 24.03 KB.' },
    { key: 'allOwn', limit: 41 * KB, why: 'As in the default configuration. Measured 40.57 KB.' },
    { key: 'lazyTotal', limit: 82 * KB, why: 'As in the default configuration plus the summary module. Measured 81.32 KB.' },
  ],
  react18: [
    { key: 'trigger', limit: 2 * KB, why: 'As in the react configuration, built with React 18.3.1 and ReactDOM 18.3.1. Measured 1.63 KB.' },
    { key: 'react', limit: 1.5 * KB, why: 'As in the react configuration: the React entry is the same code for React 18 and 19. Measured 1.17 KB.' },
    { key: 'firstMp4Summary', limit: 24.5 * KB, why: 'As in the react configuration. Measured 24.03 KB.' },
    { key: 'lazyTotal', limit: 82 * KB, why: 'As in the react configuration. Measured 81.32 KB.' },
  ],
};

export const STANDALONE_BUDGET = { limit: 36 * KB, why: `dist/standalone/own.worker.js: the own worker as one minified IIFE file with no imports, built by rolldown. Design estimate 35.0 KB; measured 32.04 KB. ${RESET} Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.58 KB, when the ffprobe frame rate estimate, which the file inlines, began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip).` };

const LABELS = {
  trigger: 'critical path (package code in the entry chunk)',
  react: 'React entry (the provider and hooks in the entry chunk, React not counted)',
  entry: 'entry chunk with the preload helper',
  client: 'probe client (lazy)',
  isobmff: 'ISO BMFF parser (in the own worker)',
  matroska: 'Matroska parser (in the own worker)',
  segments: 'rate profile core (in the own worker)',
  rfps: 'ffprobe frame rate estimate (in the own worker)',
  firstMp4: 'first MP4 analysis, lazy total',
  allOwn: 'all own paths, lazy total',
  lazyTotal: 'emitted lazy total (every file outside the entry chunk)',
  mp4box: 'mp4box engine chunk',
  mediabunny: 'mediabunny engine chunk',
  engineShared: 'shared engine chunk',
  pageEngineShared: 'shared engine chunk (main thread, inline mode)',
  rvfc: 'rVFC engine (main thread)',
  summary: 'summary module of the React store (lazy, main thread)',
  firstMp4Summary: 'first MP4 analysis with the React summary, lazy total',
};

const CLASSES = [
  ['mp4box', /node_modules\/mp4box\/|video-fps-probe\/dist\/engines\/mp4box\.js$/],
  ['mediabunny', /node_modules\/mediabunny\/|video-fps-probe\/dist\/engines\/mediabunny\.js$/],
  ['rvfc', /video-fps-probe\/dist\/engines\/rvfc\.js$/],
  ['isobmff', /video-fps-probe\/dist\/core\/isobmff\//],
  ['matroska', /video-fps-probe\/dist\/core\/matroska\//],
  ['stats', /video-fps-probe\/dist\/core\/stats\.js$/],
  ['segments', /video-fps-probe\/dist\/core\/segments\.js$/],
  ['rfps', /video-fps-probe\/dist\/core\/rfps\.js$/],
  ['engineShared', /video-fps-probe\/dist\/engines\/(?:common|counting)\.js$/],
  ['summary', /video-fps-probe\/dist\/api\/summary\.js$/],
];

const USAGE = `Usage: node scripts/size-matrix.mjs [--dir <consumers dir>] [--check] [--out <dir>]

Measures the consumer fixtures built by node scripts/consumers.mjs from the packed tarball.

  --dir <dir>   consumers directory (default $CONSUMERS_DIR, else <os tmpdir>/video-fps-probe-consumers)
  --check       exit 1 when a budget is exceeded, a worker count is wrong, a must-not-exist source
                appears in a sourcemap, or a parser or engine chunk waits for a chunk it does not request;
                without --out it also exits 1 when report/size-matrix.md or .json differs from this
                measurement, and writes nothing
  --out <dir>   where size-matrix.md and size-matrix.json are written (default report)

Without --check the report is written to --out, or to report/ (npm run size:matrix:write).
`;

const kb = (n) => `${(n / KB).toFixed(2)} KB`;
const posix = (p) => p.split('\\').join('/');
const gzipOf = (buf) => measure(buf).gzip;

const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

export function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  for (const line of mappings.split(';')) {
    const segments = [];
    let column = 0;
    for (const segment of line ? line.split(',') : []) {
      const values = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = B64.get(ch);
        if (digit === undefined) throw new Error(`invalid base64 VLQ digit ${ch}`);
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value % 2 === 1 ? -Math.floor(value / 2) : value / 2);
          value = 0;
          shift = 0;
        }
      }
      column += values[0];
      if (values.length >= 4) source += values[1];
      segments.push({ column, source: values.length >= 4 ? source : -1 });
    }
    lines.push(segments);
  }
  return lines;
}

export function codeFromSources(text, map, keep) {
  const wanted = map.sources.map((s) => keep(s));
  const out = [];
  const lines = text.split('\n');
  decodeMappings(map.mappings).forEach((segments, i) => {
    const line = lines[i] ?? '';
    segments.forEach((s, j) => {
      if (s.source < 0 || !wanted[s.source]) return;
      out.push(line.slice(s.column, j + 1 < segments.length ? segments[j + 1].column : line.length));
    });
  });
  return out.join('');
}

function readMap(distDir, file) {
  const path = join(distDir, `${file}.map`);
  if (!existsSync(path)) return null;
  const map = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(join(distDir, file));
  return { ...map, sources: map.sources.map((s) => posix(resolve(base, map.sourceRoot ?? '', s))) };
}

function classify(sources) {
  for (const [name, re] of CLASSES) if (sources.some((s) => re.test(s))) return name;
  return 'shared';
}

function closureOf(start, fileSet, texts, { dynamic }) {
  const seen = new Set([start]);
  for (const stack = [start]; stack.length > 0; ) {
    const f = stack.pop();
    const refs = scanReferences(texts.get(f) ?? '', f, fileSet);
    for (const dep of [...refs.staticImports, ...(dynamic ? refs.dynamicImports : [])]) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      stack.push(dep);
    }
  }
  return seen;
}

export function measureFixture(dir, fixture) {
  const distDir = fixtureDist(dir, fixture.name);
  if (!existsSync(distDir)) throw new Error(`${posix(relative(dir, distDir))} not found: run node scripts/consumers.mjs build first`);
  const found = discover(distDir);
  const files = found.files.filter((f) => /\.m?js$/.test(f));
  const fileSet = new Set(found.files);
  const texts = new Map(files.map((f) => [f, readFileSync(join(distDir, f), 'utf8')]));
  const maps = new Map(files.map((f) => [f, readMap(distDir, f)]));
  const gz = new Map(files.map((f) => [f, gzipOf(readFileSync(join(distDir, f)))]));
  const classOf = (f) => classify(maps.get(f)?.sources ?? []);
  const sum = (list) => [...list].reduce((n, f) => n + (gz.get(f) ?? 0), 0);
  const problems = [];

  const entry = found.main ? closureOf(found.main, fileSet, texts, { dynamic: false }) : new Set();
  let trigger = 0;
  let react = 0;
  for (const f of entry) {
    const map = maps.get(f);
    if (map) {
      trigger += gzipOf(Buffer.from(codeFromSources(texts.get(f), map, (s) => s.includes(PACKAGE_SOURCE))));
      if (fixture.imports.includes('./react')) react += gzipOf(Buffer.from(codeFromSources(texts.get(f), map, (s) => s.includes(REACT_SOURCE))));
    } else problems.push(`${f}: no sourcemap`);
  }
  const without = (set) => new Set([...set].filter((f) => !entry.has(f)));
  const clientFiles = new Set();
  for (const f of files) if (found.kinds.get(f) === 'client') for (const g of closureOf(f, fileSet, texts, { dynamic: false })) clientFiles.add(g);

  const workers = {};
  for (const w of found.workers) {
    const name = basename(w).replace(/-[\w-]{8}\.m?js$/, '').replace(/\.m?js$/, '');
    const side = closureOf(w, fileSet, texts, { dynamic: true });
    const statics = closureOf(w, fileSet, texts, { dynamic: false });
    const byClass = {};
    for (const f of side) {
      if (statics.has(f)) continue;
      const c = classOf(f);
      (byClass[c] ??= new Set()).add(f);
    }
    const withStatics = (list) => {
      const out = new Set();
      for (const f of list ?? []) for (const g of closureOf(f, fileSet, texts, { dynamic: false })) out.add(g);
      return out;
    };
    const sha256 = createHash('sha256').update(readFileSync(join(distDir, w))).digest('hex').slice(0, 16);
    workers[name] = { file: w, entry: sum(statics), chunks: side.size - statics.size, sha256, side, statics, byClass, withStatics };
  }
  const names = Object.keys(workers).sort();
  const expected = [...fixture.workers].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) problems.push(`worker files: expected ${expected.join(', ')}, built ${names.join(', ') || 'none'}`);
  if (fixture.singleFileWorkers) for (const n of names) if (workers[n].side.size !== 1) problems.push(`worker ${n}: expected one file, it loads ${workers[n].side.size - 1} more`);

  const ownWorker = workers[fixture.workers[0]];
  const lazyTotal = (classes) => {
    if (!ownWorker) return null;
    const list = new Set([...clientFiles, ...ownWorker.statics]);
    for (const c of classes) for (const f of ownWorker.withStatics(ownWorker.byClass[c])) list.add(f);
    return sum(without(list));
  };
  const engineChunk = (engine) => {
    const w = Object.values(workers).find((x) => x.byClass[engine]);
    return w ? sum(w.byClass[engine]) : null;
  };
  const engineShared = Object.values(workers).reduce((n, w) => n + sum(w.byClass.engineShared ?? []), 0);
  const mainThread = new Set(files.filter((f) => !Object.values(workers).some((w) => w.side.has(f))));
  const rvfcFiles = [...mainThread].filter((f) => classOf(f) === 'rvfc');
  const pageEngineShared = [...mainThread].filter((f) => classOf(f) === 'engineShared');

  const metrics = {
    entry: sum(entry),
    trigger,
    react: fixture.imports.includes('./react') ? react : null,
    client: clientFiles.size > 0 ? sum(without(clientFiles)) : null,
    isobmff: ownWorker?.byClass.isobmff ? sum(ownWorker.byClass.isobmff) : null,
    matroska: ownWorker?.byClass.matroska ? sum(ownWorker.byClass.matroska) : null,
    segments: ownWorker?.byClass.segments ? sum(ownWorker.byClass.segments) : null,
    rfps: ownWorker?.byClass.rfps ? sum(ownWorker.byClass.rfps) : null,
    firstMp4: ownWorker && !fixture.singleFileWorkers ? lazyTotal(['isobmff', 'stats']) : null,
    allOwn: ownWorker && !fixture.singleFileWorkers ? lazyTotal(['isobmff', 'matroska', 'stats', 'segments', 'rfps']) : null,
    mp4box: engineChunk('mp4box'),
    mediabunny: engineChunk('mediabunny'),
    engineShared: engineShared > 0 ? engineShared : null,
    rvfc: rvfcFiles.length > 0 ? sum(rvfcFiles) : null,
    pageEngineShared: pageEngineShared.length > 0 ? sum(pageEngineShared) : null,
    summary: null,
    firstMp4Summary: null,
    lazyTotal: sum(without(new Set(files))),
  };
  if (fixture.singleFileWorkers && ownWorker) metrics.firstMp4 = metrics.allOwn = sum(without(new Set([...clientFiles, ownWorker.file])));
  const summaryFiles = [...mainThread].filter((f) => classOf(f) === 'summary');
  if (summaryFiles.length > 0) metrics.summary = sum(without(new Set(summaryFiles.flatMap((f) => [...closureOf(f, fileSet, texts, { dynamic: false })]))));
  if (metrics.summary !== null && metrics.firstMp4 !== null) metrics.firstMp4Summary = metrics.firstMp4 + metrics.summary;

  const leaks = [];
  for (const f of files) {
    for (const s of maps.get(f)?.sources ?? []) for (const pattern of fixture.mustNot) if (s.includes(pattern)) leaks.push(`${f}: ${pattern} (${s.slice(s.indexOf('node_modules/'))})`);
  }
  for (const l of leaks) problems.push(`must not exist: ${l}`);
  problems.push(...found.chains);

  const value = (key) => (key.startsWith('worker:') ? (workers[key.slice(7)]?.entry ?? null) : metrics[key]);
  const budgets = (BUDGETS[fixture.name] ?? []).map(({ key, limit, why, required = true }) => {
    const gzip = value(key);
    const label = key.startsWith('worker:') ? `${key.slice(7)} entry` : LABELS[key];
    let status = 'ok';
    if (gzip === null) status = required ? 'missing' : 'not built';
    else if (gzip > limit) status = 'over';
    if (status === 'over' || status === 'missing') problems.push(`${fixture.name} ${label}: ${status}${gzip === null ? '' : ` (${kb(gzip)} > ${kb(limit)})`}`);
    return { key, label, limit, gzip, headroom: gzip === null ? null : limit - gzip, status, why };
  });

  return {
    name: fixture.name,
    imports: fixture.imports,
    note: fixture.note ?? null,
    worker: fixture.worker,
    engines: fixture.engines,
    metrics,
    workers: names.map((n) => ({ name: n, entry: workers[n].entry, chunks: workers[n].chunks, sha256: workers[n].sha256 })),
    files: files.map((f) => ({ file: f, gzip: gz.get(f), worker: Object.keys(workers).find((n) => workers[n].side.has(f)) ?? null, class: classOf(f) })),
    mustNot: fixture.mustNot,
    leaks,
    chains: found.chains,
    budgets,
    problems,
  };
}

function versionOf(dir, name) {
  const path = join(dir, 'node_modules', name, 'package.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : null;
}

export function buildMatrix(dir) {
  const fixtures = FIXTURES.map((f) => measureFixture(dir, f));
  const standaloneFile = join(installedPackage(dir), 'dist', 'standalone', 'own.worker.js');
  const standaloneGzip = existsSync(standaloneFile) ? gzipOf(readFileSync(standaloneFile)) : null;
  const standalone = {
    gzip: standaloneGzip,
    limit: STANDALONE_BUDGET.limit,
    status: standaloneGzip === null ? 'missing' : standaloneGzip > STANDALONE_BUDGET.limit ? 'over' : 'ok',
    why: STANDALONE_BUDGET.why,
  };
  const failures = fixtures.flatMap((f) => f.problems.map((p) => (p.startsWith(`${f.name} `) ? p : `${f.name}: ${p}`)));
  if (standalone.status !== 'ok') failures.push(`standalone own.worker.js: ${standalone.status}`);
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz')) ?? null;
  return {
    generator: 'scripts/size-matrix.mjs',
    unit: 'KB = 1000 bytes; gzip level 9',
    tarball,
    versions: { 'video-fps-probe': versionOf(dir, 'video-fps-probe'), vite: versionOf(dir, 'vite'), mp4box: versionOf(dir, 'mp4box'), mediabunny: versionOf(dir, 'mediabunny') },
    fixtures,
    standalone,
    failures,
  };
}

const matrixMetric = (matrix, name, key) => matrix.fixtures.find((f) => f.name === name)?.metrics[key] ?? null;

function sameOwnWorker(matrix, a, b) {
  const digest = (name) => matrix.fixtures.find((f) => f.name === name)?.workers.find((w) => w.name === 'own.worker')?.sha256 ?? null;
  return digest(a) !== null && digest(a) === digest(b);
}

const importsOf = (f) => `${f.imports.map((i) => `video-fps-probe${i.slice(1)}`).join(' + ')}${f.note ? ` (${f.note})` : ''}`;
const cell = (n) => (n === null || n === undefined ? '-' : kb(n));

export function renderMarkdown(matrix) {
  const out = [];
  out.push('# Package size matrix');
  out.push('');
  out.push(
    `What the package adds to a Vite ${matrix.versions.vite} app in each configuration, measured by \`scripts/size-matrix.mjs\` on production builds of the consumer fixtures in \`tests/consumers/fixtures/\`. Each fixture installs the packed tarball (${matrix.tarball ?? 'video-fps-probe'}) with mp4box ${matrix.versions.mp4box} and mediabunny ${matrix.versions.mediabunny} into a directory outside the repository, so nothing resolves to the source tree. KB means 1000 bytes; every size is gzip level 9 per file, and totals are sums of files.`,
  );
  out.push('');
  out.push(
    'The critical path is the package code inside the host entry chunk, cut out of the entry chunk by its hidden sourcemap: what a host pays before any file is picked. Vite adds its preload helper to the entry chunk of any app with a dynamic import; it is listed and budgeted separately because a host that already code-splits has it anyway. Everything else loads lazily, on the first file or the first engine run.',
  );
  out.push('');
  out.push('## Configurations');
  out.push('');
  out.push('| Configuration | Imports | Vite worker option | Critical path | Entry chunk with the preload helper | First MP4, lazy | All own paths, lazy | Engine chunk | Worker files | Budgets |');
  out.push('|---|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const f of matrix.fixtures) {
    const engine = [f.metrics.mp4box !== null ? `mp4box ${kb(f.metrics.mp4box)}` : null, f.metrics.mediabunny !== null ? `mediabunny ${kb(f.metrics.mediabunny)}` : null, f.metrics.rvfc !== null ? `rVFC ${kb(f.metrics.rvfc)}` : null].filter(Boolean).join(', ') || '-';
    const status = f.problems.length === 0 ? 'ok' : `${f.problems.length} problem${f.problems.length === 1 ? '' : 's'}`;
    out.push(`| ${f.name} | ${importsOf(f)} | ${f.worker} | **${kb(f.metrics.trigger)}** | ${kb(f.metrics.entry)} | ${cell(f.metrics.firstMp4)} | ${cell(f.metrics.allOwn)} | ${engine} | ${f.workers.length} (${f.workers.map((w) => w.name).join(', ')}) | ${status} |`);
  }
  out.push(`| standalone worker file | video-fps-probe/standalone/own.worker.js | - | - | - | ${cell(matrix.standalone.gzip)} | ${cell(matrix.standalone.gzip)} | - | 1 file, no imports | ${matrix.standalone.status} |`);
  out.push('');
  out.push(
    'First MP4: the probe client, the worker entry that serves own, the statistics chunk (requested in parallel with the parser) and the ISO BMFF parser. All own paths adds the Matroska parser, the ffprobe frame rate estimate of a Matroska file without DefaultDuration and the rate profile core. A worker built as iife cannot split, so in zero-config and iife-nosplit the own worker is one file, as the standalone file is in standalone-url, and both columns are the client plus that file.',
  );
  out.push('');
  const same = sameOwnWorker(matrix, 'zero-config', 'iife-nosplit')
    ? ` In Vite ${matrix.versions.vite} zero-config and iife-nosplit build byte-identical own worker files: with format 'iife' Vite already inlines the worker's dynamic imports, so \`codeSplitting: false\` changes nothing.`
    : '';
  out.push(
    `The host's worker option decides the first MP4: ${cell(matrixMetric(matrix, 'default', 'firstMp4'))} with \`worker: { format: 'es' }\` (default), ${cell(matrixMetric(matrix, 'zero-config', 'firstMp4'))} with no worker option (zero-config), because Vite's default worker format is 'iife'.${same}`,
  );
  out.push('');
  const react = matrix.fixtures.filter((f) => f.metrics.react !== null && f.metrics.react !== undefined);
  if (react.length > 0) {
    out.push(
      `In ${react.map((f) => `${f.name} (${f.note})`).join(' and ')} the entry chunk also holds React and ReactDOM, which a React host ships anyway, so its column is not a package cost. The critical path counts the package code only, and the React entry is ${new Set(react.map((f) => cell(f.metrics.react))).size === 1 ? `${cell(react[0].metrics.react)} of it in each` : react.map((f) => `${cell(f.metrics.react)} of it in ${f.name}`).join(' and ')}. The first analysis also fetches the ${cell(react[0].metrics.summary)} summary module of the store, in parallel with the probe client.`,
    );
    out.push('');
  }
  out.push('## Budgets (gzip)');
  out.push('');
  out.push('| Configuration | Budget | Limit | Actual | Headroom | Status |');
  out.push('|---|---|---:|---:|---:|---|');
  for (const f of matrix.fixtures) for (const b of f.budgets) out.push(`| ${f.name} | ${b.label} | ${kb(b.limit)} | ${cell(b.gzip)} | ${cell(b.headroom)} | ${b.status} |`);
  out.push(`| standalone | own.worker.js | ${kb(matrix.standalone.limit)} | ${cell(matrix.standalone.gzip)} | ${matrix.standalone.gzip === null ? '-' : kb(matrix.standalone.limit - matrix.standalone.gzip)} | ${matrix.standalone.status} |`);
  out.push('');
  out.push('## Checks');
  out.push('');
  for (const f of matrix.fixtures) {
    const leaks = f.leaks.length === 0 ? `none of ${f.mustNot.length > 0 ? f.mustNot.map((m) => `\`${m}\``).join(', ') : '(no patterns)'} appears in any sourcemap` : `${f.leaks.length} must-not-exist source(s): ${f.leaks.join('; ')}`;
    const chains = f.chains.length === 0 ? 'request chains ok' : f.chains.join('; ');
    out.push(`- **${f.name}**: worker files ${f.workers.map((w) => `${w.name} (${w.chunks} lazy chunk${w.chunks === 1 ? '' : 's'})`).join(', ')}; ${leaks}; ${chains}.`);
  }
  out.push('');
  out.push(
    'Must-not-exist reads the `sources` of every hidden sourcemap, because minified identifiers are renamed. The request chain check is the one in `scripts/size-report.mjs`: every static dependency of a parser or engine chunk is already loaded, or requested in the same Promise.all.',
  );
  out.push('');
  out.push('## Why these limits');
  out.push('');
  for (const f of matrix.fixtures) for (const b of f.budgets) out.push(`- **${f.name}, ${b.label}** (${kb(b.limit)}): ${b.why}`);
  out.push(`- **standalone, own.worker.js** (${kb(matrix.standalone.limit)}): ${matrix.standalone.why}`);
  out.push('');
  out.push('## Files');
  out.push('');
  out.push('| Configuration | File | Runs in | Holds | gzip -9 |');
  out.push('|---|---|---|---|---:|');
  for (const f of matrix.fixtures) for (const x of f.files) out.push(`| ${f.name} | ${x.file.replace(/-[\w-]{8}(\.m?js)$/, '$1')} | ${x.worker ?? 'page'} | ${x.class} | ${kb(x.gzip)} |`);
  out.push('');
  return `${out.join('\n')}\n`;
}

function main() {
  const { values } = parseArgs({
    options: { dir: { type: 'string' }, check: { type: 'boolean', default: false }, out: { type: 'string' }, help: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const dir = consumersDir(values.dir);
  const matrix = buildMatrix(dir);
  const outputs = { 'size-matrix.md': renderMarkdown(matrix), 'size-matrix.json': `${JSON.stringify(matrix, null, 2)}\n` };
  for (const f of matrix.fixtures) {
    console.log(`${f.name.padEnd(13)} critical ${kb(f.metrics.trigger).padStart(9)}  first MP4 ${cell(f.metrics.firstMp4).padStart(9)}  workers ${f.workers.length}  ${f.problems.length === 0 ? 'ok' : 'FAIL'}`);
  }
  console.log(`${'standalone'.padEnd(13)} own.worker.js ${cell(matrix.standalone.gzip)}  ${matrix.standalone.status}`);
  const failures = [...matrix.failures];
  if (values.check && !values.out) {
    const reportDir = join(REPO_ROOT, 'report');
    for (const [name, text] of Object.entries(outputs)) {
      const difference = firstDifference(readIfExists(join(reportDir, name)), text);
      if (difference) failures.push(`report/${name} differs from this measurement (${difference}); run npm run size:matrix:write and commit the report`);
    }
    if (failures.length === 0) console.log('report/size-matrix.md and size-matrix.json match this measurement');
  } else {
    const outDir = values.out ? resolve(values.out) : join(REPO_ROOT, 'report');
    mkdirSync(outDir, { recursive: true });
    for (const [name, text] of Object.entries(outputs)) writeFileSync(join(outDir, name), text);
    console.log(`wrote ${join(outDir, 'size-matrix.md')} and size-matrix.json`);
  }
  if (values.check && failures.length > 0) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    return 1;
  }
  return 0;
}

const readIfExists = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

export function firstDifference(committed, measured) {
  if (committed === null) return 'not committed';
  if (committed === measured) return null;
  const a = committed.split('\n');
  const b = measured.split('\n');
  const i = a.findIndex((line, n) => line !== b[n]);
  const line = i === -1 ? a.length : i;
  return `line ${line + 1}: committed ${JSON.stringify(a[line] ?? '<end of file>')}, measured ${JSON.stringify(b[line] ?? '<end of file>')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
