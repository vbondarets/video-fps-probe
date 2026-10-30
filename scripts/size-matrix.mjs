import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FIXTURES, OWN_WORKERS, SPLIT_ROUTING, WORKER_MUST_NOT, consumersDir, fixtureDist, installedPackage, pinDrift } from './consumers.mjs';
import { discover, measure, scanReferences } from './size-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1000;
const PACKAGE_SOURCE = 'node_modules/video-fps-probe/';
const ENTRY_SOURCES = { react: ['./react', `${PACKAGE_SOURCE}dist/react/`], check: ['./check', `${PACKAGE_SOURCE}dist/check/`], presets: ['./presets', `${PACKAGE_SOURCE}dist/presets/`], header: ['./header', `${PACKAGE_SOURCE}dist/header/`] };

const RESET = 'The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.';
const RESET_020 =
  'Re-set in 0.2.0 to the measurement plus 3 percent, rounded up to 0.5 KB, like every budget of this matrix except the two promises of the default configuration: several limits had kept about 30 bytes of headroom (the default emitted lazy total measured 80,966 bytes of 81,000, the standalone-url one 78,968 of 79,000), so a build whose hashed chunk names merely compress differently could fail them, while limits far above their measurement let a regression of that size pass.';
const RESET_030 = 'Set in 0.3.0, when the own engine of the default flavor moved to one worker per container family, to the measurement plus 3 percent, rounded up to 0.5 KB.';
const SPLIT = 'With the own engine on one worker per container family, a first file loads only the worker of its family, with its parser and the statistics inside the worker file.';
const EAGER_030 = 'Set in 0.3.0, when this configuration was added to check that createProbeClient without byContainer ships none of the routing by container family, to the measurement plus 3 percent, rounded up to 0.5 KB.';
const PROMISE = 'User-facing promise of the package, accepted by the owner on 2026-10-23 when the demo budget moved to 101.5 KB: the default configuration adds at most 1 KB to the critical path and the first MP4 loads at most 24 KB lazily.';

export const BUDGETS = {
  default: [
    { key: 'trigger', limit: 1 * KB, why: `${PROMISE} This row is the first half: the package code in the host entry chunk (the lazyProbe stub, ProbeError and the engine list), cut out of the entry chunk by its sourcemap. Vite's preload helper is not counted here, because every Vite app with a dynamic import already has it; the entry chunk row counts it. Design estimate 1.0 KB; measured 0.67 KB, and measured plus 10 percent rounded up to 0.5 KB is also 1.0 KB. Not re-set in 0.2.0, measured 0.67 KB: the promise stays the limit, which the 3 percent rule leaves to every other row.` },
    { key: 'entry', limit: 1.5 * KB, why: `The whole host entry chunk: the package code of the critical path row, Vite's preload helper, which Vite adds to the entry chunk of any app with a dynamic import, and the one line of host code. The critical path row stays the package promise; this row also catches what the package makes Vite add next to its code, such as a longer preload dependency list per dynamic import. Measured 1.40 KB. ${RESET} Measured 1.39 KB when re-set. ${RESET_020}` },
    { key: 'client', limit: 3.5 * KB, why: `The probe client fetched on the first file: createProbe, engine routing, the worker pool and the own descriptor with its two worker literals. Design estimate 3.5 KB; measured 2.67 KB. ${RESET} Measured 2.90 KB when re-set. ${RESET_020} Raised from 3 KB to 3.5 KB in 0.3.0, measured 3.21 KB, for the second worker literal, the four-byte read that picks the worker of a container family, the routes split by family and the prewarm per family. ${RESET_030}` },
    { key: 'worker:own-isobmff.worker', limit: 20.5 * KB, why: `The prebuilt ISO BMFF worker of own: reader, sniffing, options, the worker runtime, the ISO BMFF parser and the statistics in one file, with the rate profile core as its only lazy chunk. It replaces the own worker entry of 0.2.0 (4.18 KB, with the parser and the statistics as lazy chunks). Design estimate 20.0 to 20.4 KB; measured 19.44 KB. ${RESET_030} Measured 19.42 KB once the parser stopped failing a file on an all-ones 64-bit duration, took a header after the moov that runs past the end of the file as trailing data and named read failures (0.06 KB more in the parser), and the shared reader lost the members no code path called and read box types as printable text (0.09 KB less in the rest); the limit stays. Measured 19.45 KB once an all-ones elst duration began to run from the media time of its edit to the end of the media (0.04 KB more in the parser).` },
    { key: 'worker:own-matroska.worker', limit: 19.5 * KB, why: `The prebuilt Matroska worker of own: reader, sniffing, options, the worker runtime, the Matroska parser and the statistics in one file, with the rate profile core and the ffprobe frame rate estimate as lazy chunks. Design estimate 19.5 to 19.9 KB; measured 18.73 KB. ${RESET_030}` },
    { key: 'isobmff', limit: 13 * KB, why: `The own MP4 and MOV parser chunk of the own worker. Design estimate 13.5 KB; measured 12.21 KB. ${RESET} Measured 12.21 KB when re-set. ${RESET_020} Measured 12.07 KB in 0.3.0, 0.06 KB more than the 12.00 KB before, once it stopped failing a file on an all-ones 64-bit duration, took a header after the moov that runs past the end of the file as trailing data and kept read failures apart from corrupt files; the limit stays. Measured 12.10 KB once an all-ones elst duration began to run from the media time of its edit to the end of the media.` },
    { key: 'matroska', limit: 12.5 * KB, why: `The own Matroska and WebM parser chunk of the own worker. Design estimate 12.0 KB; measured 11.14 KB. ${RESET} Measured 11.72 KB when re-set. ${RESET_020}` },
    { key: 'segments', limit: 2 * KB, why: `The rate profile core of the own worker, fetched only for a timeline with unequal frame rates. Design estimate 2.0 KB; measured 1.84 KB. ${RESET} Measured 1.84 KB when re-set. ${RESET_020}` },
    { key: 'rfps', limit: 4 * KB, why: `The ffprobe frame rate estimate of the own worker, fetched by the Matroska parser only for a Matroska or WebM file without DefaultDuration, read in probe and exact mode. Measured 2.76 KB. ${RESET} Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.54 KB, when the estimate began to read the H.264 slice headers that decide the decoder delay and to ride the block walk of the exact scan instead of a walk of its own. Measured 3.60 KB when re-set. ${RESET_020}` },
    { key: 'firstMp4', limit: 24 * KB, why: `${PROMISE} This row is the second half: everything the first MP4 or MOV file loads lazily, which is the probe client and the ISO BMFF worker of own, which holds the parser and the statistics. ${SPLIT} Measured 23.26 KB. Measured plus 10 percent would be 26.0 KB, so the promise stays the limit instead: it is the tighter one and it is what the README states. Not re-set in 0.2.0, measured 23.60 KB: the promise stays the limit, which the 3 percent rule leaves to every other row. Measured 22.73 KB in 0.3.0 with one own worker per container family, and 22.71 KB once the parser stopped failing a file on an all-ones 64-bit duration or on a trailer after the moov (0.06 KB more) and the shared reader lost the members no code path called (0.09 KB less): the first MP4 did not grow. Measured 22.73 KB once an all-ones elst duration began to run from the media time of its edit to the end of the media.` },
    { key: 'firstMkv', limit: 26.5 * KB, why: `Everything the first MKV or WebM file loads lazily, in the worst case of a track without DefaultDuration, such as a MediaRecorder recording: the probe client, the Matroska worker of own, which holds the parser and the statistics, and the ffprobe frame rate estimate it fetches for such a track. ${SPLIT} Design estimate 26.6 KB; 0.2.0 loaded 26.71 KB for the same file through the shared own worker; measured 25.56 KB. ${RESET_030}` },
    { key: 'allOwn', limit: 50.5 * KB, why: `Every own path: the probe client, both own workers with their parsers and statistics, the rate profile core of each and the ffprobe frame rate estimate. Design estimate 37.0 KB; measured 36.24 KB before the estimate was added. ${RESET} Raised from 40 KB to 40.5 KB in 0.2.0, measured 40.34 KB, when the ffprobe frame rate estimate began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip). Raised again to 41 KB, measured 40.58 KB, when the estimate began to ride the block walk of the exact scan (0.23 KB in the estimate and the Matroska parser). Measured 40.76 KB when re-set. ${RESET_020} Raised from 42 KB to 50.5 KB in 0.3.0, measured 48.63 KB, because the two workers are separate builds and each holds its own copy of the reader, the worker runtime, the statistics and the rate profile core; a session that analyzes one container family loads only its worker. ${RESET_030}` },
    { key: 'lazyTotal', limit: 92 * KB, why: `Every JavaScript file the build emits outside the entry chunk, fetched or not: the probe client with its compare and fallback chunks, the own worker with its chunks, and the main-thread copies of the parsers, the statistics, the sniffer and the worker runtime. The default flavor keeps them as an in-thread own for environments without a Worker global (SSR, Node) and for worker: 'inline'; a root analyze(), not imported here, always runs in the calling thread on the same copies. A browser with a Worker global never fetches them otherwise, so the lazy totals above leave them out. This row bounds what the package adds to the deploy and the CDN. Measured 72.20 KB. ${RESET} Raised from 79.5 KB to 81 KB in 0.2.0, measured 80.43 KB, when the ffprobe frame rate estimate began to read the H.264 slice headers: the build emits that code twice, in the own worker and in the main-thread copy. Measured 81.27 KB when re-set. ${RESET_020} Raised from 84 KB to 92 KB in 0.3.0, measured 89.16 KB, for the copies of the reader, the worker runtime, the statistics and the rate profile core in the second own worker. ${RESET_030}` },
  ],
  'zero-config': [
    { key: 'trigger', limit: 1 * KB, why: `As in the default configuration: the worker option does not change the entry chunk. Measured 0.67 KB. ${RESET} Measured 0.66 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 1.5 * KB, why: `As in the default configuration: the worker option does not change the entry chunk. Measured 1.40 KB. ${RESET} Measured 1.39 KB when re-set. ${RESET_020}` },
    { key: 'worker:own-isobmff.worker', limit: 22 * KB, why: `A Vite 8 app with no worker option builds workers with Vite's default format, 'iife', which cannot split, so the ISO BMFF worker of own is one file: the ISO BMFF parser, the statistics and the rate profile core are inlined. Design estimate 21.2 to 21.6 KB; measured 21.19 KB. ${RESET_030}` },
    { key: 'worker:own-matroska.worker', limit: 25 * KB, why: `As for the ISO BMFF worker, the Matroska worker of own is one file: the Matroska parser, the statistics, the rate profile core and the ffprobe frame rate estimate are inlined. Design estimate 24.2 to 24.6 KB; measured 23.89 KB. ${RESET_030}` },
    { key: 'firstMp4', limit: 25 * KB, why: `What the first MP4 loads in a Vite 8 app that keeps the default worker format: the probe client and the one-file ISO BMFF worker of own. User-facing promise of 0.3.0, accepted by the owner in the 0.3.0 design: the zero-config first MP4 loads at most 25 KB. It was 38.92 KB in 0.2.0, with one worker file holding both parsers. Design estimate 24.4 to 25.1 KB; measured 24.41 KB. Measured plus 3 percent would be 25.5 KB, so the promise stays the limit. Measured 24.43 KB once the parser stopped failing a file on an all-ones 64-bit duration or on a trailer after the moov and the shared reader lost the members no code path called, and 24.47 KB, 0.53 KB under the promise, once an all-ones elst duration began to run from the media time of its edit to the end of the media.` },
    { key: 'firstMkv', limit: 28 * KB, why: `What the first MKV or WebM file loads in a Vite 8 app that keeps the default worker format: the probe client and the one-file Matroska worker of own, which inlines the ffprobe frame rate estimate and the rate profile core. Design estimate 27.6 KB; 0.2.0 loaded 38.92 KB; measured 27.10 KB. ${RESET_030}` },
    { key: 'allOwn', limit: 50 * KB, why: `Both one-file own workers and the probe client, what a session that analyzes both container families loads. Measured 48.29 KB. ${RESET_030}` },
    { key: 'lazyTotal', limit: 92 * KB, why: `As in the default configuration, with the two one-file own workers instead of the worker entries and their chunks. Measured 70.75 KB. ${RESET} Raised from 78 KB to 79 KB in 0.2.0, measured 78.66 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the worker and in the main-thread copy. Raised again to 79.5 KB, measured 79.06 KB, when the estimate began to ride the block walk of the exact scan. Measured 79.44 KB when re-set. ${RESET_020} Raised from 82 KB to 92 KB in 0.3.0, measured 88.82 KB, for the second one-file own worker. ${RESET_030}` },
  ],
  custom: [
    { key: 'trigger', limit: 1 * KB, why: `The lazyProbeClient stub in the host entry chunk. The host's worker literal is host code and is not counted. Design estimate 1.0 KB; measured 0.68 KB. ${RESET} Measured 0.67 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 2 * KB, why: `The lazyProbeClient stub, Vite's preload helper and the host's worker literal. Measured 1.47 KB. ${RESET} Measured 1.46 KB when re-set. ${RESET_020}` },
    { key: 'client', limit: 3 * KB, why: `The probe client fetched on the first file, without the own descriptor and its worker literal, which the host replaces with its own worker. Measured 2.56 KB. ${RESET} Measured 2.80 KB when re-set. ${RESET_020} Raised from 3 KB to 3.5 KB in 0.3.0, measured 3.08 KB, for the routes split by container family, which a custom worker without byContainer does not use. Back to 3 KB in 0.3.0, measured 2.88 KB, when the split routing moved to client/route.ts, which this client imports only for a custom worker with byContainer: what stays is the hook of the split routes and that import, 0.08 KB over the 2.80 KB of 0.2.0. Measured 2.93 KB once prewarm merged the warm requests of each worker again, one request with the union of the containers of its engines, so that own on create for a family without a byContainer worker and another engine start one worker: 0.05 KB more. ${RESET_030}` },
    { key: 'worker:fps.worker', limit: 4.5 * KB, why: `The host worker built from video-fps-probe/worker-runtime, serving own only. Design estimate 8.5 KB; measured 4.08 KB. ${RESET} Measured 4.18 KB when re-set. ${RESET_020}` },
    { key: 'firstMp4', limit: 24.5 * KB, why: `A host worker that serves own holds the same code as the prebuilt own worker, so its first MP4 loads what the first MP4 of the default configuration loads, whose row keeps the 24 KB promise as its limit. Measured 23.15 KB. Measured 23.49 KB when re-set. ${RESET_020} Measured 23.82 KB in 0.3.0 while the probe client held the split routing, and 23.58 KB once it moved to client/route.ts.` },
    { key: 'lazyTotal', limit: 84 * KB, why: `As in the default configuration, with the host worker instead of the prebuilt own worker. In the client flavor the main-thread copies are there for worker: 'inline' and for environments without a Worker global, where own runs in the calling thread; a browser with a Worker global never fetches them otherwise. Measured 72.11 KB. ${RESET} Raised from 79.5 KB to 80.5 KB in 0.2.0, measured 80.33 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the host worker and in the main-thread copy. Raised again to 81 KB, measured 80.79 KB, when the estimate began to ride the block walk of the exact scan. Measured 81.18 KB when re-set. ${RESET_020} The build also emits the split routing chunk (client/route.ts and client/split.ts, 0.43 KB), which this client fetches only for a custom worker with byContainer.` },
  ],
  'custom-eager': [
    { key: 'trigger', limit: 3.5 * KB, why: `createProbeClient imported statically, so the whole probe client is in the host entry chunk: the client of the custom configuration (2.93 KB) with the hook that imports the split routing chunk on the first own analysis with byContainer instead of the lazyProbeClient stub. The sourcemap check of this configuration fails when the entry chunk holds client/route.ts, so a custom worker without byContainer ships none of the routing by container family. Measured 2.97 KB. ${EAGER_030}` },
    { key: 'entry', limit: 4 * KB, why: `The probe client of the critical path row, Vite's preload helper and the host's worker literal. Measured 3.81 KB. ${EAGER_030}` },
    { key: 'worker:fps.worker', limit: 4.5 * KB, why: `The host worker of the custom configuration. Measured 4.19 KB. ${EAGER_030}` },
    { key: 'firstMp4', limit: 21.5 * KB, why: `What the first MP4 loads after the entry chunk: the host worker with the statistics and the ISO BMFF parser chunks, the first MP4 of the custom configuration without its probe client, which is in the entry chunk here. Measured 20.70 KB. ${EAGER_030}` },
    { key: 'lazyTotal', limit: 81.5 * KB, why: `As in the custom configuration, without the probe client. It counts the split routing chunk (client/route.ts, 0.38 KB), which this client fetches only on the first own analysis with byContainer. Measured 78.78 KB. ${EAGER_030}` },
  ],
  mp4box: [
    { key: 'trigger', limit: 1 * KB, why: `The default trigger plus the mp4box descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. ${RESET} Measured 0.89 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 2 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.75 KB. ${RESET} Measured 1.74 KB when re-set. ${RESET_020}` },
    { key: 'worker:mp4box.worker', limit: 4.5 * KB, why: `The prebuilt mp4box worker entry, which serves own and mp4box. Design estimate 8.5 KB; measured 4.22 KB. ${RESET} Measured 4.32 KB when re-set. ${RESET_020}` },
    { key: 'mp4box', limit: 46.5 * KB, why: `The mp4box.js engine chunk of the mp4box worker: the mp4box library, the adapter and the counting code the engines share. Design estimate 48.0 KB; measured 44.77 KB. ${RESET} Measured 44.86 KB when re-set. ${RESET_020}` },
    { key: 'engineShared', limit: 2 * KB, required: false, why: `Code the comparison engines share, when it is a chunk of its own. Not built: each prebuilt engine worker serves one comparison engine, so this code is part of the engine chunk. The design estimate of 2.0 KB stays the limit, so a split that grows it is caught. Not built, so not re-set in 0.2.0.` },
    { key: 'lazyTotal', limit: 224 * KB, why: `As in the default configuration plus the mp4box worker, which carries its own copies of the own parsers because it also serves own, and the main-thread copy of the mp4box engine, which runs in the calling thread only with worker: 'inline' or without a Worker global. Measured 195.93 KB. ${RESET} Measured 209.47 KB when re-set. ${RESET_020} Raised from 216 KB to 224 KB in 0.3.0, measured 217.33 KB, for the second own worker. ${RESET_030}` },
  ],
  mediabunny: [
    { key: 'trigger', limit: 1 * KB, why: `The default trigger plus the mediabunny descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. ${RESET} Measured 0.89 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 2 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.75 KB. ${RESET} Measured 1.74 KB when re-set. ${RESET_020}` },
    { key: 'worker:mediabunny.worker', limit: 4.5 * KB, why: `The prebuilt mediabunny worker entry, which serves own and mediabunny. Measured 4.12 KB. ${RESET} Measured 4.21 KB when re-set. ${RESET_020}` },
    { key: 'mediabunny', limit: 56 * KB, why: `The mediabunny engine chunk of the mediabunny worker, with the counting code the engines share. Design estimate 58.0 KB; measured 53.87 KB. ${RESET} Measured 53.97 KB when re-set. ${RESET_020} Measured 54.15 KB in 0.3.0, once a read of the file that rejects or comes back short became file read failed, as in the own engine, also in the packet walk.` },
    { key: 'engineShared', limit: 2 * KB, required: false, why: `Code the comparison engines share, when it is a chunk of its own. Not built, for the same reason as in the mp4box configuration. The design estimate of 2.0 KB stays the limit. Not built, so not re-set in 0.2.0.` },
    { key: 'lazyTotal', limit: 241.5 * KB, why: `As in the mp4box configuration, with the mediabunny worker and engine. Measured 212.89 KB. ${RESET} Measured 226.44 KB when re-set. ${RESET_020} Raised from 233.5 KB to 241.5 KB in 0.3.0, measured 234.33 KB, for the second own worker. ${RESET_030}` },
  ],
  rvfc: [
    { key: 'trigger', limit: 1 * KB, why: `The default trigger plus the rvfc descriptor, which has no worker literal. Measured 0.77 KB. ${RESET} Measured 0.77 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 2 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.59 KB. ${RESET} Measured 1.58 KB when re-set. ${RESET_020}` },
    { key: 'rvfc', limit: 2.5 * KB, why: `The requestVideoFrameCallback engine, a main-thread chunk loaded on its first run. Design estimate 2.5 KB; measured 2.19 KB. ${RESET} Measured 2.19 KB when re-set. ${RESET_020}` },
    { key: 'lazyTotal', limit: 94.5 * KB, why: `As in the default configuration plus the main-thread rVFC engine. Measured 74.52 KB. ${RESET} Raised from 82 KB to 83 KB in 0.2.0, measured 82.76 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the worker and in the main-thread copy. Raised again to 83.5 KB, measured 83.21 KB, when the estimate began to ride the block walk of the exact scan. Measured 83.60 KB when re-set. ${RESET_020} Raised from 86.5 KB to 94.5 KB in 0.3.0, measured 91.48 KB, for the second own worker. ${RESET_030}` },
  ],
  all: [
    { key: 'trigger', limit: 1.5 * KB, why: `The default trigger plus the mp4box, mediabunny and rvfc descriptors. Measured 1.02 KB. ${RESET} Measured 1.01 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 2 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 1.92 KB. ${RESET} Measured 1.91 KB when re-set. ${RESET_020}` },
    { key: 'client', limit: 3.5 * KB, why: `As in the default configuration. Measured 2.71 KB. ${RESET} Measured 2.95 KB when re-set. ${RESET_020}` },
    { key: 'worker:own-isobmff.worker', limit: 20.5 * KB, why: `As in the default configuration. Measured 19.44 KB. ${RESET_030}` },
    { key: 'worker:own-matroska.worker', limit: 19.5 * KB, why: `As in the default configuration. Measured 18.73 KB. ${RESET_030}` },
    { key: 'worker:mp4box.worker', limit: 4.5 * KB, why: `As in the mp4box configuration. Measured 4.22 KB. ${RESET} Measured 4.32 KB when re-set. ${RESET_020}` },
    { key: 'worker:mediabunny.worker', limit: 4.5 * KB, why: `As in the mediabunny configuration. Measured 4.12 KB. ${RESET} Measured 4.21 KB when re-set. ${RESET_020}` },
    { key: 'mp4box', limit: 46.5 * KB, why: `As in the mp4box configuration. Measured 44.77 KB. ${RESET} Measured 44.86 KB when re-set. ${RESET_020}` },
    { key: 'mediabunny', limit: 56 * KB, why: `As in the mediabunny configuration. Measured 53.87 KB. ${RESET} Measured 53.97 KB when re-set. ${RESET_020} Measured 54.15 KB in 0.3.0, as in the mediabunny configuration.` },
    { key: 'rvfc', limit: 2.5 * KB, why: `As in the rvfc configuration. Measured 2.19 KB. ${RESET} Measured 2.19 KB when re-set. ${RESET_020}` },
    { key: 'isobmff', limit: 13 * KB, why: `As in the default configuration. Measured 12.21 KB. ${RESET} Measured 12.21 KB when re-set. ${RESET_020}` },
    { key: 'matroska', limit: 12.5 * KB, why: `As in the default configuration. Measured 11.14 KB. ${RESET} Measured 11.72 KB when re-set. ${RESET_020}` },
    { key: 'segments', limit: 2 * KB, why: `As in the default configuration. Measured 1.84 KB. ${RESET} Measured 1.84 KB when re-set. ${RESET_020}` },
    { key: 'rfps', limit: 4 * KB, why: `As in the default configuration. Measured 2.76 KB. ${RESET} Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.54 KB, as in the default configuration. Measured 3.60 KB when re-set. ${RESET_020}` },
    { key: 'firstMp4', limit: 24.5 * KB, why: `Registering engines must not change what the first own analysis loads; the default configuration row keeps the 24 KB promise as its limit. Measured 23.31 KB. Measured 23.65 KB when re-set. ${RESET_020}` },
    { key: 'allOwn', limit: 50.5 * KB, why: `As in the default configuration. Measured 36.29 KB. ${RESET} Raised from 40 KB to 40.5 KB in 0.2.0, measured 40.38 KB, as in the default configuration. Raised again to 41 KB, measured 40.62 KB, as in the default configuration. Measured 40.81 KB when re-set. ${RESET_020} Raised from 42.5 KB to 50.5 KB in 0.3.0, measured 48.67 KB, as in the default configuration. ${RESET_030}` },
    { key: 'engineShared', limit: 2 * KB, required: false, why: `As in the mp4box and mediabunny configurations: each prebuilt engine worker serves one comparison engine, so no worker builds this chunk. The design estimate of 2.0 KB stays the limit. Not built, so not re-set in 0.2.0.` },
    { key: 'pageEngineShared', limit: 2 * KB, why: `The counting code mp4box and mediabunny share, which becomes a main-thread chunk of its own when both are registered. It loads only when an engine runs in this thread (worker: 'inline', SSR, no Worker global). Measured 1.51 KB. ${RESET} Measured 1.51 KB when re-set. ${RESET_020}` },
    { key: 'lazyTotal', limit: 367 * KB, why: `Every worker with its own copies of the own parsers, the main-thread copies of every engine and the shared engine chunk, which run in the calling thread only with worker: 'inline' or without a Worker global (rVFC always runs there). Measured 338.19 KB. ${RESET} Measured 356.18 KB when re-set. ${RESET_020}` },
  ],
  'standalone-url': [
    { key: 'trigger', limit: 1 * KB, why: `The lazyProbeClient stub in the host entry chunk, as in the custom configuration. The asset URL of the standalone file is host code and is not counted. Measured 0.71 KB. ${RESET} Measured 0.71 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 1.5 * KB, why: `The lazyProbeClient stub, Vite's preload helper and the host's asset URL of the standalone file. Measured 1.46 KB. ${RESET} Measured 1.45 KB when re-set. ${RESET_020}` },
    { key: 'client', limit: 3 * KB, why: `As in the custom configuration. Measured 2.56 KB. ${RESET} Measured 2.79 KB when re-set. ${RESET_020} Raised from 3 KB to 3.5 KB in 0.3.0, measured 3.09 KB, and back to 3 KB, measured 2.88 KB, then 2.93 KB with the merged prewarm, as in the custom configuration. ${RESET_030}` },
    { key: 'worker:own.worker', limit: 37.5 * KB, why: `dist/standalone/own.worker.js, which Vite copies unchanged as an asset for the ?url import and the host starts as a classic worker. Measured 32.04 KB, the standalone row below. ${RESET} Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.58 KB, as the standalone row below. Measured 35.95 KB when re-set. ${RESET_020}` },
    { key: 'firstMp4', limit: 40 * KB, why: `What the first MP4 loads with the standalone worker: the probe client and the one-file worker. It suits a host whose workers must stay classic scripts. Measured 34.60 KB. ${RESET} Raised from 38.5 KB to 39 KB in 0.2.0, measured 38.56 KB, because the standalone file inlines the ffprobe frame rate estimate, which began to read the H.264 slice headers and to ride the block walk of the exact scan (0.81 KB gzip together). Measured 38.74 KB when re-set. ${RESET_020} Measured 39.07 KB in 0.3.0 while the probe client held the split routing, and 38.83 KB once it moved to client/route.ts.` },
    { key: 'lazyTotal', limit: 82 * KB, why: `As in the custom configuration, with the standalone file as the worker. Measured 70.56 KB. ${RESET} Raised from 78 KB to 79 KB in 0.2.0, measured 78.48 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the standalone file and in the main-thread copy. Measured 79.26 KB when re-set. ${RESET_020} The build also emits the split routing chunk, as in the custom configuration.` },
  ],
  'standalone-split-url': [
    { key: 'trigger', limit: 1 * KB, why: `The lazyProbeClient stub in the host entry chunk, as in the standalone-url configuration; the asset URLs of the two standalone files are host code and are not counted. Measured 0.73 KB. ${RESET_030}` },
    { key: 'entry', limit: 2 * KB, why: `The lazyProbeClient stub, Vite's preload helper and the host's asset URLs of the two standalone files. Measured 1.49 KB. ${RESET_030}` },
    { key: 'client', limit: 3.5 * KB, why: `The custom client and the split routing chunk (client/route.ts), which the client imports for byContainer before it builds its routes, one request after the client. Measured 3.11 KB while the client held the split routing. ${RESET_030} Measured 3.32 KB with the split routing as a chunk of its own, 0.21 KB more: a host with byContainer pays it so that a custom worker without byContainer loads none of it. Measured 3.36 KB with the merged prewarm, as in the custom configuration.` },
    { key: 'worker:own-isobmff.worker', limit: 22 * KB, why: `dist/standalone/own-isobmff.worker.js, which Vite copies unchanged as an asset for the ?url import and the host starts as a classic worker, as the standalone row below. Measured 21.15 KB. ${RESET_030}` },
    { key: 'worker:own-matroska.worker', limit: 25 * KB, why: `dist/standalone/own-matroska.worker.js, copied the same way and registered with byContainer, as the standalone row below. Measured 23.80 KB. ${RESET_030}` },
    { key: 'firstMp4', limit: 25 * KB, why: `What the first MP4 loads with the split standalone files: the probe client with the split routing chunk and the ISO BMFF file, against 38.74 KB with the combined standalone file of standalone-url in 0.2.0. Design estimate 25.0 KB; measured 24.26 KB. ${RESET_030} Measured 24.46 KB once the split routing became a chunk of its own, as in the client row; the limit stays.` },
    { key: 'firstMkv', limit: 28 * KB, why: `What the first MKV or WebM file loads with the split standalone files: the probe client with the split routing chunk and the Matroska file, which inlines the ffprobe frame rate estimate. Design estimate 28.5 KB; measured 26.92 KB. ${RESET_030} Measured 27.12 KB once the split routing became a chunk of its own; the limit stays.` },
    { key: 'allOwn', limit: 50 * KB, why: `The probe client with the split routing chunk and both split standalone files. Measured 48.06 KB. ${RESET_030} Measured 48.27 KB once the split routing became a chunk of its own; the limit stays.` },
    { key: 'lazyTotal', limit: 91.5 * KB, why: `As in the standalone-url configuration, with the two split standalone files instead of the combined one. Design estimate 92.0 KB; measured 88.60 KB. ${RESET_030} Measured 88.81 KB once the split routing became a chunk of its own; the limit stays.` },
  ],
  'iife-nosplit': [
    { key: 'trigger', limit: 1 * KB, why: `As in the default configuration. Measured 0.67 KB. ${RESET} Measured 0.66 KB when re-set. ${RESET_020}` },
    { key: 'entry', limit: 1.5 * KB, why: `As in the default configuration. Measured 1.40 KB. ${RESET} Measured 1.39 KB when re-set. ${RESET_020}` },
    { key: 'worker:own-isobmff.worker', limit: 22 * KB, why: `With worker.format iife and codeSplitting false the ISO BMFF worker of own is one file: the ISO BMFF parser, the statistics and the rate profile core are inlined. Design estimate 21.2 to 21.6 KB; measured 21.19 KB. ${RESET_030}` },
    { key: 'worker:own-matroska.worker', limit: 25 * KB, why: `As for the ISO BMFF worker, the Matroska worker of own is one file: the Matroska parser, the statistics, the rate profile core and the ffprobe frame rate estimate are inlined. Design estimate 24.2 to 24.6 KB; measured 23.89 KB. ${RESET_030}` },
    { key: 'firstMp4', limit: 25 * KB, why: `As in the zero-config configuration, whose row holds the 25 KB promise of 0.3.0. Measured 24.41 KB.` },
    { key: 'firstMkv', limit: 28 * KB, why: `As in the zero-config configuration. Measured 27.10 KB. ${RESET_030}` },
    { key: 'allOwn', limit: 50 * KB, why: `As in the zero-config configuration. Measured 48.29 KB. ${RESET_030}` },
    { key: 'lazyTotal', limit: 92 * KB, why: `As in the zero-config configuration. Measured 70.75 KB. ${RESET} Raised from 78 KB to 79 KB in 0.2.0, measured 78.66 KB, as in the zero-config configuration. Raised again to 79.5 KB, measured 79.06 KB, as in the zero-config configuration. Measured 79.44 KB when re-set. ${RESET_020} Raised from 82 KB to 92 KB in 0.3.0, measured 88.82 KB, as in the zero-config configuration. ${RESET_030}` },
  ],
  react: [
    { key: 'trigger', limit: 2 * KB, why: `The package code in the entry chunk of a React host that imports video-fps-probe/react next to video-fps-probe/lazy: the lazyProbe stub, ProbeError and the React entry. React and ReactDOM are host code and are not counted. Measured 1.63 KB. ${RESET} Measured 1.64 KB when re-set. ${RESET_020}` },
    { key: 'react', limit: 1.5 * KB, why: `The part of the critical path the React entry adds: VideoFpsProvider, useVideoFps and the framework-free store that caches by Blob, then by engine and options, and aborts on unmount. Design estimate 1.5 KB; measured 1.17 KB. ${RESET} Measured 1.18 KB when re-set. ${RESET_020}` },
    { key: 'client', limit: 3.5 * KB, why: `As in the default configuration: the React entry adds nothing to the probe client. Measured 2.90 KB. Measured 2.90 KB when re-set. ${RESET_020} Raised from 3 KB to 3.5 KB in 0.3.0, measured 3.21 KB, as in the default configuration. ${RESET_030}` },
    { key: 'worker:own-isobmff.worker', limit: 20.5 * KB, why: `As in the default configuration. Measured 19.44 KB. ${RESET_030}` },
    { key: 'worker:own-matroska.worker', limit: 19.5 * KB, why: `As in the default configuration. Measured 18.73 KB. ${RESET_030}` },
    { key: 'summary', limit: 0.5 * KB, why: `The summarize module, which the store imports with import() in parallel with the first analysis, so it stays off the critical path. Measured 0.43 KB. ${RESET} Measured 0.43 KB when re-set. ${RESET_020}` },
    { key: 'firstMp4', limit: 24.5 * KB, why: `The first MP4 as in the default configuration: the probe client and the ISO BMFF worker of own. Measured 23.60 KB. Measured 23.60 KB when re-set. ${RESET_020} Measured 22.66 KB in 0.3.0.` },
    { key: 'firstMp4Summary', limit: 25 * KB, why: `What the first MP4 of a React host loads lazily: the first MP4 of the default configuration plus the summary module of the store. It was set to the 24 KB promise of the default configuration plus the 0.5 KB summary budget. Measured 24.03 KB. Measured 24.03 KB when re-set. ${RESET_020}` },
    { key: 'allOwn', limit: 50.5 * KB, why: `As in the default configuration. Measured 40.57 KB. Measured 40.77 KB when re-set. ${RESET_020} Raised from 42 KB to 50.5 KB in 0.3.0, measured 48.63 KB, as in the default configuration. ${RESET_030}` },
    { key: 'lazyTotal', limit: 92.5 * KB, why: `As in the default configuration plus the summary module. Measured 81.32 KB. Measured 81.72 KB when re-set. ${RESET_020} Raised from 84.5 KB to 92.5 KB in 0.3.0, measured 89.59 KB, as in the default configuration. ${RESET_030}` },
  ],
  react18: [
    { key: 'trigger', limit: 2 * KB, why: `As in the react configuration, built with React 18.3.1 and ReactDOM 18.3.1. Measured 1.63 KB. Measured 1.64 KB when re-set. ${RESET_020}` },
    { key: 'react', limit: 1.5 * KB, why: `As in the react configuration: the React entry is the same code for React 18 and 19. Measured 1.17 KB. Measured 1.18 KB when re-set. ${RESET_020}` },
    { key: 'firstMp4Summary', limit: 25 * KB, why: `As in the react configuration. Measured 24.03 KB. Measured 24.03 KB when re-set. ${RESET_020}` },
    { key: 'lazyTotal', limit: 92.5 * KB, why: `As in the react configuration. Measured 81.32 KB. Measured 81.73 KB when re-set. ${RESET_020} Raised from 84.5 KB to 92.5 KB in 0.3.0, measured 89.58 KB, as in the react configuration. ${RESET_030}` },
  ],
  check: [
    { key: 'trigger', limit: 5 * KB, why: `The package code in the entry chunk of a host that imports video-fps-probe/check statically next to video-fps-probe/lazy: the lazyProbe stub of the default configuration and check. Measured 3.00 KB. ${RESET} Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.29 KB, with the rule that judges a constant track on 1 ms ticks by its nominal rate and duration, and the validation of every rule value. Raised to 5 KB, measured 3.81 KB, with the NTSC decimals, the 1 ms tick resolution of the frame rate bounds, the message digits, the checks of unknown keys and lists, and the audio rule that fails open. Measured 3.98 KB when re-set. ${RESET_020} Raised from 4.5 KB to 5 KB by the same rule, measured 4.45 KB, when check began to refuse decimal strings beyond the finite range and to describe an analysis error that is not a message. Measured 4.55 KB in 0.3.0 with the larger check of the check entry row.` },
    { key: 'check', limit: 4.5 * KB, why: `The part of the critical path the check entry adds: check(result, rules) with its exact rational comparison, the violation messages and suggestedFps. It imports no other module, so nothing of it loads lazily. Design estimate 0.8 to 1.5 KB; measured 2.43 KB. ${RESET} Measured 2.72 KB in 0.2.0, 2.80 KB before a trim that kept every message, with the rule that judges a constant track on 1 ms ticks by its nominal rate and duration, and the validation of every rule value. Raised from 3 KB to 4 KB, measured 3.25 KB, with the NTSC decimals, the 1 ms tick resolution of the frame rate bounds, the message digits, the checks of unknown keys and lists, and the audio rule that fails open. Measured 3.42 KB when re-set. ${RESET_020} Raised from 4 KB to 4.5 KB by the same rule, measured 3.89 KB, when check began to refuse decimal strings beyond the finite range and to describe an analysis error that is not a message. Measured 3.99 KB in 0.3.0, 0.10 KB more, once check judged the format duration ffprobe prints for a WebM or Matroska track when it is within one typical frame interval of the measured span at microsecond resolution.` },
    { key: 'entry', limit: 5.5 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 3.72 KB. ${RESET} Measured 4.01 KB in 0.2.0 with the larger check. Raised from 4.5 KB to 5.5 KB, measured 4.53 KB, with the larger check again. Measured 4.70 KB when re-set. ${RESET_020} Raised from 5 KB to 5.5 KB, measured 5.03 KB, when check began to judge malformed results as unknown, refuse ratios in the number groups and prefer standard rates in suggestedFps. Measured 5.27 KB in 0.3.0.` },
    { key: 'firstMp4', limit: 24.5 * KB, why: `Importing check must not change what the first own analysis loads; the default configuration row keeps the 24 KB promise as its limit. Measured 23.60 KB. Measured 23.60 KB when re-set. ${RESET_020}` },
    { key: 'lazyTotal', limit: 92 * KB, why: `As in the default configuration: check adds no lazy file. Measured 80.96 KB. Measured 81.28 KB when re-set. ${RESET_020} Raised from 84 KB to 92 KB in 0.3.0, measured 89.17 KB, as in the default configuration. ${RESET_030}` },
  ],
  preset: [
    { key: 'trigger', limit: 5 * KB, why: `The check configuration plus one preset, klingO1ReferenceVideo, imported from video-fps-probe/presets. Measured 3.24 KB. ${RESET} Measured 3.60 KB in 0.2.0 with the larger check and the size note of the preset. Raised from 4 KB to 5 KB, measured 4.12 KB, with the larger check of the check configuration. Measured 4.34 KB when re-set. ${RESET_020} Raised from 4.5 KB to 5 KB, measured 4.51 KB, when check began to judge malformed results and missing policy flags as unknown. Measured 4.90 KB in 0.3.0, with the larger check of the check configuration and the preset with its deprecated sourceUrl.` },
    { key: 'check', limit: 4.5 * KB, why: `As in the check configuration. Measured 3.25 KB. Measured 3.42 KB when re-set. ${RESET_020} Raised from 4 KB to 4.5 KB with the check configuration, measured 3.89 KB. Measured 3.99 KB in 0.3.0, as in the check configuration.` },
    { key: 'presets', limit: 0.5 * KB, why: `The one imported preset: its name, source, source kind, date, note and rules. The six presets together are about 1.5 KB gzip, so this limit also fails a build that stops tree-shaking the presets a host does not import. Design estimate 0.1 to 0.2 KB per preset; measured 0.31 KB. ${RESET} Measured 0.38 KB in 0.2.0, when each note began to name how its MB is read; the limit stays. Measured 0.46 KB when re-set. ${RESET_020} Measured 0.41 KB in 0.3.0 while the source page was in presets/sources.json only, and 0.46 KB again once the presets kept sourceUrl, deprecated, so that a 0.2.0 consumer keeps working; the limit stays.` },
    { key: 'entry', limit: 6 * KB, why: `The trigger of this configuration plus Vite's preload helper. Measured 3.96 KB. ${RESET} Raised from 4.5 KB to 5 KB in 0.2.0, measured 4.33 KB, with the larger check and the size note of the preset. Raised to 6 KB, measured 4.85 KB, with the larger check of the check configuration. Measured 5.06 KB when re-set. ${RESET_020} Raised from 5.5 KB to 6 KB by the same rule, measured 5.43 KB, after check began to judge malformed results, missing policy flags and ratio strings in the number groups, and to prefer standard rates in suggestedFps. Measured 5.62 KB in 0.3.0.` },
    { key: 'firstMp4', limit: 24.5 * KB, why: `As in the check configuration. Measured 23.60 KB. Measured 23.60 KB when re-set. ${RESET_020}` },
    { key: 'lazyTotal', limit: 92 * KB, why: `As in the check configuration. Measured 80.96 KB. Measured 81.29 KB when re-set. ${RESET_020} Raised from 84 KB to 92 KB in 0.3.0, measured 89.16 KB, as in the check configuration. ${RESET_030}` },
  ],
  header: [
    { key: 'trigger', limit: 20 * KB, why: `The package code in the entry chunk of a host that imports video-fps-probe/header statically: analyzeHeader with its option checks, the limited source, the reader, the sniffer, the ISO BMFF box parsers, the header walk, the fragmented duration and the track builder it shares with the full parser. It starts no worker and loads nothing lazily, and it reaches neither the full ISO BMFF parser nor the statistics. Design estimate 11 to 13 KB, measured 17.92 KB, of which 2.37 KB is the per-sample part of the shared track builder, which header mode never runs: moving it out of the shared builder would cost the first MP4 more than the 0.01 KB share of stage 3. ${RESET} Measured 18.49 KB once the walk followed full mode on hybrid files, single moofs, sidx ends, start offsets and limits after the moov.` },
    { key: 'header', limit: 3 * KB, why: `The part of the critical path under dist/header/: analyzeHeader, its option checks, the Matroska DocType check and the limited source with its deadline. Measured 2.34 KB. ${RESET} Measured 2.50 KB once the limited source coded an abort of the source itself and a read without bytes as read failures and kept its deadline past the timer range.` },
    { key: 'entry', limit: 20 * KB, why: `The trigger of this configuration plus the Vite runtime of the entry chunk. Measured 17.94 KB. ${RESET} Measured 18.51 KB with the trigger above.` },
  ],
};

export const STANDALONE_BUDGETS = {
  'own.worker.js': { limit: 37.5 * KB, why: `dist/standalone/own.worker.js: the own worker as one minified IIFE file with no imports, built by rolldown. Design estimate 35.0 KB; measured 32.04 KB. ${RESET} Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.58 KB, when the ffprobe frame rate estimate, which the file inlines, began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip). Measured 35.95 KB when re-set. ${RESET_020}` },
  'own-isobmff.worker.js': { limit: 22 * KB, why: `dist/standalone/own-isobmff.worker.js: the ISO BMFF worker of own as one minified IIFE file with no imports, built by rolldown, for a host that starts classic workers and registers it with byContainer. Design estimate 21.2 to 21.6 KB; measured 21.15 KB. ${RESET_030}` },
  'own-matroska.worker.js': { limit: 25 * KB, why: `dist/standalone/own-matroska.worker.js: the Matroska worker of own as one minified IIFE file with no imports, with the ffprobe frame rate estimate and the rate profile core inlined. Design estimate 24.2 to 24.6 KB; measured 23.80 KB. ${RESET_030}` },
};

const LABELS = {
  trigger: 'critical path (package code in the entry chunk)',
  react: 'React entry (the provider and hooks in the entry chunk, React not counted)',
  check: 'check entry (in the entry chunk)',
  presets: 'presets entry (the imported presets, in the entry chunk)',
  header: 'header entry (analyzeHeader, its option checks and the limited source, in the entry chunk)',
  entry: 'entry chunk with the preload helper',
  client: 'probe client (lazy)',
  isobmff: 'ISO BMFF parser (in the own worker)',
  matroska: 'Matroska parser (in the own worker)',
  segments: 'rate profile core (in the own worker)',
  rfps: 'ffprobe frame rate estimate (in the own worker)',
  firstMp4: 'first MP4 analysis, lazy total',
  firstMkv: 'first MKV or WebM analysis without DefaultDuration, lazy total',
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

export const THIRD_PARTY_ENGINES = ['mp4box', 'mediabunny'];

export const measuresThirdParty = (fixture, key) => THIRD_PARTY_ENGINES.includes(key) || (key === 'lazyTotal' && fixture.engines.some((e) => THIRD_PARTY_ENGINES.includes(e)));

const USAGE = `Usage: node scripts/size-matrix.mjs [--dir <consumers dir>] [--check] [--out <dir>] [--third-party-informational]

Measures the consumer fixtures built by node scripts/consumers.mjs from the packed tarball.

  --dir <dir>   consumers directory (default $CONSUMERS_DIR, else <os tmpdir>/video-fps-probe-consumers)
  --check       exit 1 when a budget is exceeded, a worker count is wrong, a must-not-exist source
                appears in a sourcemap, or a parser or engine chunk waits for a chunk it does not request;
                without --out it also exits 1 when report/size-matrix.md or .json differs from this
                measurement, and writes nothing
  --out <dir>   where size-matrix.md and size-matrix.json are written (default report)
  --third-party-informational
                for the canary, with --out: a budget that measures mp4box or mediabunny code (their
                engine chunks and the emitted lazy total of a configuration with either engine) does
                not fail when it is over, and size-matrix.json lists every such budget under informational,
                for the job summary. Every other budget and check still fails as with --check alone.

Without --check the report is written to --out, or to report/ (npm run size:matrix:write).

size-matrix.json also records a hash-normalized size next to each raw one, under the key normalized: for
every row of a configuration (normalized.metrics), for every emitted file (normalized.gzip, with the
normalized file name, whether the file is in the entry chunk and the modules its sourcemap names, under
sources) and for every standalone worker file (normalized.gzip). A module of the package is named by its
path in the package dist, such as core/stats.js, a module of another package as node_modules/<package>,
any other module by its path from the consumers directory, and a file without a sourcemap that is a copy
of a standalone worker file as standalone/<file>. Before gzip, every name of an emitted file that ends in
-<8 character content hash>.<extension> is replaced, in the contents of every file and with the same
length, by the name with the hash 00000000, so a change in one chunk does not move the size of the
chunks that only name it. scripts/size-gate.mjs compares these sizes. The markdown report shows only the
raw sizes.
`;

const kb = (n) => `${(n / KB).toFixed(2)} KB`;
const posix = (p) => p.split('\\').join('/');
const gzipOf = (buf) => measure(buf).gzip;

export const HASH_PLACEHOLDER = '00000000';
const HASHED_NAME = /^(.+)-([A-Za-z0-9_-]{8})(\.[A-Za-z0-9]+(?:\.map)?)$/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalizedName(name) {
  const at = name.lastIndexOf('/') + 1;
  const m = HASHED_NAME.exec(name.slice(at));
  return m ? `${name.slice(0, at)}${m[1]}-${HASH_PLACEHOLDER}${m[3]}` : name;
}

export function hashNormalizer(names) {
  const swaps = new Map();
  for (const name of names) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    const swapped = normalizedName(base);
    if (swapped !== base) swaps.set(base, swapped);
  }
  if (swaps.size === 0) return (text) => text;
  const pattern = new RegExp(
    [...swaps.keys()]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
      .map(escapeRegExp)
      .join('|'),
    'g',
  );
  return (text) => text.replace(pattern, (s) => swaps.get(s));
}

function emittedNames(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

const PACKAGE_DIST = '/video-fps-probe/dist/';
const NODE_MODULES = '/node_modules/';
const STANDALONE_FILES = ['own.worker.js', 'own-isobmff.worker.js', 'own-matroska.worker.js'];

export function moduleId(source, root) {
  const at = source.lastIndexOf(PACKAGE_DIST);
  if (at >= 0) return source.slice(at + PACKAGE_DIST.length);
  const nm = source.lastIndexOf(NODE_MODULES);
  if (nm >= 0) {
    const parts = source.slice(nm + NODE_MODULES.length).split('/');
    return `node_modules/${parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/')}`;
  }
  return posix(relative(root, source));
}

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

export function measureFixture(dir, fixture, { thirdPartyInformational = false } = {}) {
  const distDir = fixtureDist(dir, fixture.name);
  if (!existsSync(distDir)) throw new Error(`${posix(relative(dir, distDir))} not found: run node scripts/consumers.mjs build first`);
  const found = discover(distDir);
  const files = found.files.filter((f) => /\.m?js$/.test(f));
  const fileSet = new Set(found.files);
  const bytes = new Map(files.map((f) => [f, readFileSync(join(distDir, f))]));
  const texts = new Map(files.map((f) => [f, bytes.get(f).toString('utf8')]));
  const maps = new Map(files.map((f) => [f, readMap(distDir, f)]));
  const normalize = hashNormalizer(emittedNames(distDir));
  const raw = { gz: new Map(files.map((f) => [f, gzipOf(bytes.get(f))])), texts };
  const normalized = {
    gz: new Map(files.map((f) => [f, gzipOf(Buffer.from(normalize(bytes.get(f).toString('latin1')), 'latin1'))])),
    texts: new Map(files.map((f) => [f, normalize(texts.get(f))])),
  };
  const gz = raw.gz;
  const classOf = (f) => classify(maps.get(f)?.sources ?? []);
  const sum = (list) => [...list].reduce((n, f) => n + (gz.get(f) ?? 0), 0);
  const problems = [];

  const entry = found.main ? closureOf(found.main, fileSet, texts, { dynamic: false }) : new Set();
  for (const f of entry) if (!maps.get(f)) problems.push(`${f}: no sourcemap`);
  const without = (set) => new Set([...set].filter((f) => !entry.has(f)));
  const clientFiles = new Set();
  for (const f of files) if (found.kinds.get(f) === 'client') for (const g of closureOf(f, fileSet, texts, { dynamic: false })) clientFiles.add(g);
  const sourcesOf = (f) => maps.get(f)?.sources ?? [];
  if (fixture.byContainer) {
    for (const f of files) if (!clientFiles.has(f) && sourcesOf(f).some((s) => s.includes(SPLIT_ROUTING))) for (const g of closureOf(f, fileSet, texts, { dynamic: false })) clientFiles.add(g);
  }
  for (const f of new Set([...entry, ...clientFiles])) for (const s of sourcesOf(f)) for (const pattern of fixture.clientMustNot ?? []) if (s.includes(pattern)) problems.push(`the probe client must not hold: ${f}: ${pattern}`);

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

  const split = Object.values(OWN_WORKERS).some((n) => fixture.workers.includes(n));
  const ownOf = (family) => workers[split ? OWN_WORKERS[family] : fixture.workers[0]];
  const isoWorker = ownOf('isobmff');
  const mkvWorker = ownOf('matroska');
  const pathOf = (w, classes) => {
    const list = new Set([...clientFiles, ...w.statics]);
    for (const c of classes) for (const f of w.withStatics(w.byClass[c])) list.add(f);
    return list;
  };
  const lazyTotal = (paths) => (paths.every(([w]) => w) ? { files: [...without(new Set(paths.flatMap(([w, classes]) => [...pathOf(w, classes)])))] } : null);
  const share = (w, cls) => {
    if (!w) return null;
    if (w.byClass[cls]) return { files: [...w.byClass[cls]] };
    const re = CLASSES.find(([name]) => name === cls)[1];
    const keep = (s) => re.test(s);
    const cut = [...w.statics].filter((f) => maps.get(f) && codeFromSources(texts.get(f), maps.get(f), keep) !== '');
    return cut.length > 0 ? { cut, keep, skipEmpty: true } : null;
  };
  const OWN_CLASSES = ['isobmff', 'matroska', 'stats', 'segments', 'rfps'];
  const engineChunk = (engine) => {
    const w = Object.values(workers).find((x) => x.byClass[engine]);
    return w ? { files: [...w.byClass[engine]] } : null;
  };
  const engineShared = Object.values(workers).flatMap((w) => [...(w.byClass.engineShared ?? [])]);
  const mainThread = new Set(files.filter((f) => !Object.values(workers).some((w) => w.side.has(f))));
  const rvfcFiles = [...mainThread].filter((f) => classOf(f) === 'rvfc');
  const pageEngineShared = [...mainThread].filter((f) => classOf(f) === 'engineShared');
  const entryCode = (key) => (fixture.imports.includes(ENTRY_SOURCES[key][0]) ? { cut: [...entry], keep: (s) => s.includes(ENTRY_SOURCES[key][1]), skipEmpty: false } : null);
  const summaryFiles = [...mainThread].filter((f) => classOf(f) === 'summary');
  const summary = summaryFiles.length > 0 ? { files: [...without(new Set(summaryFiles.flatMap((f) => [...closureOf(f, fileSet, texts, { dynamic: false })])))] } : null;
  const firstMp4 = lazyTotal([[isoWorker, ['isobmff', 'stats']]]);

  const rows = {
    entry: { files: [...entry] },
    trigger: { cut: [...entry], keep: (s) => s.includes(PACKAGE_SOURCE), skipEmpty: false },
    react: entryCode('react'),
    check: entryCode('check'),
    presets: entryCode('presets'),
    header: entryCode('header'),
    client: clientFiles.size > 0 ? { files: [...without(clientFiles)] } : null,
    isobmff: share(isoWorker, 'isobmff'),
    matroska: share(mkvWorker, 'matroska'),
    segments: share(isoWorker, 'segments') ?? share(mkvWorker, 'segments'),
    rfps: share(mkvWorker, 'rfps'),
    firstMp4,
    firstMkv: lazyTotal([[mkvWorker, ['matroska', 'stats', 'rfps']]]),
    allOwn: lazyTotal([
      [isoWorker, OWN_CLASSES],
      [mkvWorker, OWN_CLASSES],
    ]),
    mp4box: engineChunk('mp4box'),
    mediabunny: engineChunk('mediabunny'),
    engineShared: engineShared.length > 0 ? { files: engineShared } : null,
    rvfc: rvfcFiles.length > 0 ? { files: rvfcFiles } : null,
    pageEngineShared: pageEngineShared.length > 0 ? { files: pageEngineShared } : null,
    summary,
    firstMp4Summary: summary !== null && firstMp4 !== null ? { files: [...firstMp4.files, ...summary.files] } : null,
    lazyTotal: { files: [...without(new Set(files))] },
  };
  const valueOf = (row, sizes) => {
    if (row === null) return null;
    if (row.files) return row.files.reduce((n, f) => n + (sizes.gz.get(f) ?? 0), 0);
    let gzip = 0;
    for (const f of row.cut) {
      const map = maps.get(f);
      if (!map) continue;
      const code = codeFromSources(sizes.texts.get(f), map, row.keep);
      if (code !== '' || !row.skipEmpty) gzip += gzipOf(Buffer.from(code));
    }
    return gzip;
  };
  const metricsOf = (sizes) => Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, valueOf(row, sizes)]));
  const metrics = metricsOf(raw);

  const standaloneDir = join(installedPackage(dir), 'dist', 'standalone');
  const standaloneCopies = STANDALONE_FILES.flatMap((file) => (existsSync(join(standaloneDir, file)) ? [{ bytes: readFileSync(join(standaloneDir, file)), file }] : []));
  const sourcesOfFile = (f) => {
    const map = maps.get(f);
    if (!map) return standaloneCopies.filter((c) => c.bytes.equals(bytes.get(f))).map((c) => `standalone/${c.file}`);
    return [...new Set(map.sources.map((s) => moduleId(s, dir)))].sort();
  };

  const leaks = [];
  for (const f of files) {
    for (const s of maps.get(f)?.sources ?? []) for (const pattern of fixture.mustNot) if (s.includes(pattern)) leaks.push(`${f}: ${pattern} (${s.slice(s.indexOf('node_modules/'))})`);
  }
  for (const l of leaks) problems.push(`must not exist: ${l}`);
  const workerLeaks = [];
  for (const [name, patterns] of Object.entries(WORKER_MUST_NOT)) {
    for (const f of workers[name]?.side ?? []) {
      for (const s of maps.get(f)?.sources ?? []) for (const pattern of patterns) if (s.includes(pattern)) workerLeaks.push(`${name} ${f}: ${pattern}`);
    }
  }
  for (const l of workerLeaks) problems.push(`worker must not reach: ${l}`);
  problems.push(...found.chains);

  const value = (key) => (key.startsWith('worker:') ? (workers[key.slice(7)]?.entry ?? null) : metrics[key]);
  const budgets = (BUDGETS[fixture.name] ?? []).map(({ key, limit, why, required = true }) => {
    const gzip = value(key);
    const label = key.startsWith('worker:') ? `${key.slice(7)} entry` : LABELS[key];
    let status = 'ok';
    if (gzip === null) status = required ? 'missing' : 'not built';
    else if (gzip > limit) status = 'over';
    const informational = thirdPartyInformational && status === 'over' && measuresThirdParty(fixture, key);
    if ((status === 'over' && !informational) || status === 'missing') problems.push(`${fixture.name} ${label}: ${status}${gzip === null ? '' : ` (${kb(gzip)} > ${kb(limit)})`}`);
    return { key, label, limit, gzip, headroom: gzip === null ? null : limit - gzip, status, why };
  });

  return {
    name: fixture.name,
    imports: fixture.imports,
    note: fixture.note ?? null,
    worker: fixture.worker,
    engines: fixture.engines,
    metrics,
    normalized: { metrics: metricsOf(normalized) },
    workers: names.map((n) => ({ name: n, entry: workers[n].entry, chunks: workers[n].chunks, sha256: workers[n].sha256 })),
    files: files.map((f) => ({
      file: f,
      gzip: gz.get(f),
      worker: Object.keys(workers).find((n) => workers[n].side.has(f)) ?? null,
      class: classOf(f),
      normalized: { file: normalizedName(f), gzip: normalized.gz.get(f), entry: entry.has(f), sources: sourcesOfFile(f) },
    })),
    mustNot: fixture.mustNot,
    leaks,
    workerLeaks,
    chains: found.chains,
    budgets,
    problems,
  };
}

function versionOf(dir, name) {
  const path = join(dir, 'node_modules', name, 'package.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : null;
}

export function buildMatrix(dir, { thirdPartyInformational = false } = {}) {
  const fixtures = FIXTURES.map((f) => measureFixture(dir, f, { thirdPartyInformational }));
  const standaloneDir = join(installedPackage(dir), 'dist', 'standalone');
  const normalize = existsSync(standaloneDir) ? hashNormalizer(emittedNames(standaloneDir)) : (text) => text;
  const standalone = Object.entries(STANDALONE_BUDGETS).map(([file, { limit, why }]) => {
    const path = join(standaloneDir, file);
    const bytes = existsSync(path) ? readFileSync(path) : null;
    const gzip = bytes === null ? null : gzipOf(bytes);
    const normalized = { gzip: bytes === null ? null : gzipOf(Buffer.from(normalize(bytes.toString('latin1')), 'latin1')) };
    return { file, gzip, limit, status: gzip === null ? 'missing' : gzip > limit ? 'over' : 'ok', why, normalized };
  });
  const failures = fixtures.flatMap((f) => f.problems.map((p) => (p.startsWith(`${f.name} `) ? p : `${f.name}: ${p}`)));
  for (const s of standalone) if (s.status !== 'ok') failures.push(`standalone ${s.file}: ${s.status}${s.gzip === null ? '' : ` (${kb(s.gzip)} > ${kb(s.limit)})`}`);
  failures.push(...pinDrift(dir));
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz')) ?? null;
  return {
    generator: 'scripts/size-matrix.mjs',
    unit: 'KB = 1000 bytes; gzip level 9',
    tarball,
    versions: { 'video-fps-probe': versionOf(dir, 'video-fps-probe'), vite: versionOf(dir, 'vite'), rolldown: versionOf(dir, 'rolldown'), mp4box: versionOf(dir, 'mp4box'), mediabunny: versionOf(dir, 'mediabunny') },
    fixtures,
    standalone,
    failures,
    ...(thirdPartyInformational && {
      informational: fixtures.flatMap((f) => f.budgets.filter((b) => measuresThirdParty(f, b.key)).map(({ key, label, limit, gzip, status }) => ({ fixture: f.name, key, label, limit, gzip, status }))),
    }),
  };
}

const matrixMetric = (matrix, name, key) => matrix.fixtures.find((f) => f.name === name)?.metrics[key] ?? null;

function sameOwnWorker(matrix, a, b) {
  const digest = (name) => {
    const own = matrix.fixtures.find((f) => f.name === name)?.workers.filter((w) => Object.values(OWN_WORKERS).includes(w.name)) ?? [];
    return own.length === Object.keys(OWN_WORKERS).length ? own.map((w) => w.sha256).join() : null;
  };
  return digest(a) !== null && digest(a) === digest(b);
}

const importsOf = (f) => `${f.imports.map((i) => `video-fps-probe${i.slice(1)}`).join(' + ')}${f.note ? ` (${f.note})` : ''}`;
const cell = (n) => (n === null || n === undefined ? '-' : kb(n));

export function renderMarkdown(matrix) {
  const out = [];
  out.push('# Package size matrix');
  out.push('');
  out.push(
    `What the package adds to a Vite ${matrix.versions.vite} app in each configuration, measured by \`scripts/size-matrix.mjs\` on production builds of the consumer fixtures in \`tests/consumers/fixtures/\`. Each fixture installs the packed tarball (${matrix.tarball ?? 'video-fps-probe'}) with mp4box ${matrix.versions.mp4box} and mediabunny ${matrix.versions.mediabunny} into a directory outside the repository, so nothing resolves to the source tree. Every package Vite and the peers pull in is pinned to its package-lock.json version, rolldown ${matrix.versions.rolldown} among them, so Windows and Linux emit byte-identical files. KB means 1000 bytes; every size is gzip level 9 per file, and totals are sums of files.`,
  );
  out.push('');
  out.push(
    'The critical path is the package code inside the host entry chunk, cut out of the entry chunk by its hidden sourcemap: what a host pays before any file is picked. Vite adds its preload helper to the entry chunk of any app with a dynamic import; it is listed and budgeted separately because a host that already code-splits has it anyway. Everything else loads lazily, on the first file or the first engine run.',
  );
  out.push('');
  out.push('## Configurations');
  out.push('');
  out.push('| Configuration | Imports | Vite worker option | Critical path | Entry chunk with the preload helper | First MP4, lazy | First MKV, lazy | All own paths, lazy | Engine chunk | Worker files | Budgets |');
  out.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const f of matrix.fixtures) {
    const engine = [f.metrics.mp4box !== null ? `mp4box ${kb(f.metrics.mp4box)}` : null, f.metrics.mediabunny !== null ? `mediabunny ${kb(f.metrics.mediabunny)}` : null, f.metrics.rvfc !== null ? `rVFC ${kb(f.metrics.rvfc)}` : null].filter(Boolean).join(', ') || '-';
    const status = f.problems.length === 0 ? 'ok' : `${f.problems.length} problem${f.problems.length === 1 ? '' : 's'}`;
    out.push(`| ${f.name} | ${importsOf(f)} | ${f.worker} | **${kb(f.metrics.trigger)}** | ${kb(f.metrics.entry)} | ${cell(f.metrics.firstMp4)} | ${cell(f.metrics.firstMkv)} | ${cell(f.metrics.allOwn)} | ${engine} | ${f.workers.length > 0 ? `${f.workers.length} (${f.workers.map((w) => w.name).join(', ')})` : '0'} | ${status} |`);
  }
  for (const s of matrix.standalone) {
    const [mp4, mkv] = s.file === 'own-isobmff.worker.js' ? [s.gzip, null] : s.file === 'own-matroska.worker.js' ? [null, s.gzip] : [s.gzip, s.gzip];
    out.push(`| standalone worker file | video-fps-probe/standalone/${s.file} | - | - | - | ${cell(mp4)} | ${cell(mkv)} | ${cell(s.gzip)} | - | 1 file, no imports | ${s.status} |`);
  }
  out.push('');
  out.push(
    'First MP4: the probe client and the worker that serves own for an ISO BMFF file. The default flavor runs own on one worker per container family, picked by the first four bytes of the file, and the ISO BMFF worker holds its parser and the statistics. A custom worker that serves own (custom) loads the statistics chunk and the ISO BMFF parser chunk after its entry, the statistics in parallel with the parser. First MKV is the same for a Matroska or WebM file without DefaultDuration, the worst case, which also loads the ffprobe frame rate estimate. All own paths is every own path of both families with the rate profile core; in the default flavor it counts both workers, each with its own copy of the runtime and the statistics. A worker built as iife cannot split, so in zero-config and iife-nosplit each own worker is one file, and in standalone-url the standalone file holds both parsers. The routing by container family is in the probe client of the default flavor; a custom worker client imports it as a chunk of its own only with byContainer (standalone-split-url), whose client columns count it, and never fetches it without (custom, standalone-url). createProbeClient (custom-eager) puts the probe client in the entry chunk, so its critical path counts the client and its lazy columns do not; it imports the routing chunk on the first own analysis with byContainer, and its entry chunk holds none of it.',
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
  for (const f of matrix.fixtures.filter((x) => typeof x.metrics.check === 'number')) {
    const preset = typeof f.metrics.presets === 'number' ? ` and ${cell(f.metrics.presets)} the one preset it imports (${f.note})` : '';
    out.push(`In ${f.name}, ${cell(f.metrics.check)} of the ${cell(f.metrics.trigger)} critical path is \`check\`${preset}, imported statically next to the lazy stub. ${preset ? 'Neither entry imports another module or loads anything' : 'It imports no other module and loads nothing'} lazily, so the lazy columns equal the default configuration's.`);
    out.push('');
  }
  out.push('## Budgets (gzip)');
  out.push('');
  out.push('| Configuration | Budget | Limit | Actual | Headroom | Status |');
  out.push('|---|---|---:|---:|---:|---|');
  for (const f of matrix.fixtures) for (const b of f.budgets) out.push(`| ${f.name} | ${b.label} | ${kb(b.limit)} | ${cell(b.gzip)} | ${cell(b.headroom)} | ${b.status} |`);
  for (const s of matrix.standalone) out.push(`| standalone | ${s.file} | ${kb(s.limit)} | ${cell(s.gzip)} | ${s.gzip === null ? '-' : kb(s.limit - s.gzip)} | ${s.status} |`);
  out.push('');
  out.push('## Checks');
  out.push('');
  for (const f of matrix.fixtures) {
    const leaks = f.leaks.length === 0 ? `none of ${f.mustNot.length > 0 ? f.mustNot.map((m) => `\`${m}\``).join(', ') : '(no patterns)'} appears in any sourcemap` : `${f.leaks.length} must-not-exist source(s): ${f.leaks.join('; ')}`;
    const chains = f.chains.length === 0 ? 'request chains ok' : f.chains.join('; ');
    const own = f.workers.filter((w) => Object.hasOwn(WORKER_MUST_NOT, w.name));
    const isolation = own.length === 0 ? '' : f.workerLeaks.length === 0 ? `; ${own.map((w) => w.name).join(' and ')} reach${own.length === 1 ? 'es' : ''} only the parser of ${own.length === 1 ? 'its' : 'their'} container family` : `; ${f.workerLeaks.length} worker isolation problem(s): ${f.workerLeaks.join('; ')}`;
    out.push(`- **${f.name}**: worker files ${f.workers.length === 0 ? 'none' : f.workers.map((w) => `${w.name} (${w.chunks} lazy chunk${w.chunks === 1 ? '' : 's'})`).join(', ')}; ${leaks}${isolation}; ${chains}.`);
  }
  out.push('');
  out.push(
    'Must-not-exist reads the `sources` of every hidden sourcemap, because minified identifiers are renamed. The ISO BMFF worker of own and every file it loads must not list the Matroska parser, the ffprobe frame rate estimate or the parser loaders of `core/analyze.js`; the Matroska worker must not list the ISO BMFF parser or `core/analyze.js`. A standalone file copied as an asset has no sourcemap, so `tests/package/standalone.test.ts` checks it instead. The request chain check is the one in `scripts/size-report.mjs`: every static dependency of a parser or engine chunk is already loaded, or requested in the same Promise.all.',
  );
  out.push('');
  out.push('## Why these limits');
  out.push('');
  for (const f of matrix.fixtures) for (const b of f.budgets) out.push(`- **${f.name}, ${b.label}** (${kb(b.limit)}): ${b.why}`);
  for (const s of matrix.standalone) out.push(`- **standalone, ${s.file}** (${kb(s.limit)}): ${s.why}`);
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
    options: { dir: { type: 'string' }, check: { type: 'boolean', default: false }, out: { type: 'string' }, 'third-party-informational': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const thirdPartyInformational = values['third-party-informational'];
  if (thirdPartyInformational && !values.out) {
    console.error(`--third-party-informational needs --out: the committed report is measured with every budget enforced\n\n${USAGE}`);
    return 2;
  }
  const dir = consumersDir(values.dir);
  const matrix = buildMatrix(dir, { thirdPartyInformational });
  const outputs = { 'size-matrix.md': renderMarkdown(matrix), 'size-matrix.json': `${JSON.stringify(matrix, null, 2)}\n` };
  for (const f of matrix.fixtures) {
    console.log(`${f.name.padEnd(13)} critical ${kb(f.metrics.trigger).padStart(9)}  first MP4 ${cell(f.metrics.firstMp4).padStart(9)}  workers ${f.workers.length}  ${f.problems.length === 0 ? 'ok' : 'FAIL'}`);
  }
  for (const s of matrix.standalone) console.log(`${'standalone'.padEnd(13)} ${s.file} ${cell(s.gzip)}  ${s.status}`);
  for (const b of matrix.informational ?? []) if (b.status === 'over') console.log(`INFO: ${b.fixture} ${b.label}: over (${kb(b.gzip)} > ${kb(b.limit)}), a third-party engine budget, informational`);
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
