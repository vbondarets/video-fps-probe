# Package size matrix

What the package adds to a Vite 8.3.5 app in each configuration, measured by `scripts/size-matrix.mjs` on production builds of the consumer fixtures in `tests/consumers/fixtures/`. Each fixture installs the packed tarball (video-fps-probe-0.1.0.tgz) with mp4box 2.4.1 and mediabunny 1.62.1 into a directory outside the repository, so nothing resolves to the source tree. Every package Vite and the peers pull in is pinned to its package-lock.json version, rolldown 1.2.14 among them, so Windows and Linux emit byte-identical files. KB means 1000 bytes; every size is gzip level 9 per file, and totals are sums of files.

The critical path is the package code inside the host entry chunk, cut out of the entry chunk by its hidden sourcemap: what a host pays before any file is picked. Vite adds its preload helper to the entry chunk of any app with a dynamic import; it is listed and budgeted separately because a host that already code-splits has it anyway. Everything else loads lazily, on the first file or the first engine run.

## Configurations

| Configuration | Imports | Vite worker option | Critical path | Entry chunk with the preload helper | First MP4, lazy | All own paths, lazy | Engine chunk | Worker files | Budgets |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| default | video-fps-probe/lazy | format: 'es' | **0.67 KB** | 1.39 KB | 23.60 KB | 40.60 KB | - | 1 (own.worker) | ok |
| zero-config | video-fps-probe/lazy | none, so Vite's default format: 'iife' | **0.67 KB** | 1.39 KB | 38.79 KB | 38.79 KB | - | 1 (own.worker) | ok |
| custom | video-fps-probe/client/lazy + video-fps-probe/worker-runtime (host worker serving own) | format: 'es' | **0.67 KB** | 1.46 KB | 23.49 KB | 40.50 KB | - | 1 (fps.worker) | ok |
| mp4box | video-fps-probe/lazy + video-fps-probe/mp4box | format: 'es' | **0.89 KB** | 1.74 KB | 23.63 KB | 40.64 KB | mp4box 44.86 KB | 2 (mp4box.worker, own.worker) | ok |
| mediabunny | video-fps-probe/lazy + video-fps-probe/mediabunny | format: 'es' | **0.89 KB** | 1.74 KB | 23.63 KB | 40.64 KB | mediabunny 53.97 KB | 2 (mediabunny.worker, own.worker) | ok |
| rvfc | video-fps-probe/lazy + video-fps-probe/rvfc | format: 'es' | **0.77 KB** | 1.58 KB | 23.61 KB | 40.62 KB | rVFC 2.19 KB | 1 (own.worker) | ok |
| all | video-fps-probe/lazy + video-fps-probe/mp4box + video-fps-probe/mediabunny + video-fps-probe/rvfc | format: 'es' | **1.01 KB** | 1.91 KB | 23.64 KB | 40.65 KB | mp4box 44.86 KB, mediabunny 53.97 KB, rVFC 2.19 KB | 3 (mediabunny.worker, mp4box.worker, own.worker) | ok |
| standalone-url | video-fps-probe/client/lazy + video-fps-probe/standalone/own.worker.js?url (classic worker from the standalone file) | none needed: the file is copied as an asset | **0.70 KB** | 1.45 KB | 38.60 KB | 38.60 KB | - | 1 (own.worker) | ok |
| iife-nosplit | video-fps-probe/lazy | format: 'iife', rolldownOptions.output.codeSplitting: false | **0.67 KB** | 1.39 KB | 38.79 KB | 38.79 KB | - | 1 (own.worker) | ok |
| react | video-fps-probe/lazy + video-fps-probe/react (React 19.3.1) | format: 'es' | **1.64 KB** | 69.85 KB | 23.60 KB | 40.61 KB | - | 1 (own.worker) | ok |
| react18 | video-fps-probe/lazy + video-fps-probe/react (React 18.3.1) | format: 'es' | **1.64 KB** | 47.25 KB | 23.59 KB | 40.60 KB | - | 1 (own.worker) | ok |
| check | video-fps-probe/lazy + video-fps-probe/check | format: 'es' | **3.98 KB** | 4.70 KB | 23.60 KB | 40.60 KB | - | 1 (own.worker) | ok |
| preset | video-fps-probe/lazy + video-fps-probe/check + video-fps-probe/presets (klingO1ReferenceVideo) | format: 'es' | **4.34 KB** | 5.06 KB | 23.60 KB | 40.61 KB | - | 1 (own.worker) | ok |
| standalone worker file | video-fps-probe/standalone/own.worker.js | - | - | - | 35.80 KB | 35.80 KB | - | 1 file, no imports | ok |

First MP4: the probe client, the worker entry that serves own, the statistics chunk (requested in parallel with the parser) and the ISO BMFF parser. All own paths adds the Matroska parser, the ffprobe frame rate estimate of a Matroska file without DefaultDuration and the rate profile core. A worker built as iife cannot split, so in zero-config and iife-nosplit the own worker is one file, as the standalone file is in standalone-url, and both columns are the client plus that file.

The host's worker option decides the first MP4: 23.60 KB with `worker: { format: 'es' }` (default), 38.79 KB with no worker option (zero-config), because Vite's default worker format is 'iife'. In Vite 8.3.5 zero-config and iife-nosplit build byte-identical own worker files: with format 'iife' Vite already inlines the worker's dynamic imports, so `codeSplitting: false` changes nothing.

In react (React 19.3.1) and react18 (React 18.3.1) the entry chunk also holds React and ReactDOM, which a React host ships anyway, so its column is not a package cost. The critical path counts the package code only, and the React entry is 1.18 KB of it in each. The first analysis also fetches the 0.43 KB summary module of the store, in parallel with the probe client.

In check, 3.42 KB of the 3.98 KB critical path is `check`, imported statically next to the lazy stub. It imports no other module and loads nothing lazily, so the lazy columns equal the default configuration's.

In preset, 3.42 KB of the 4.34 KB critical path is `check` and 0.46 KB the one preset it imports (klingO1ReferenceVideo), imported statically next to the lazy stub. Neither entry imports another module or loads anything lazily, so the lazy columns equal the default configuration's.

## Budgets (gzip)

| Configuration | Budget | Limit | Actual | Headroom | Status |
|---|---|---:|---:|---:|---|
| default | critical path (package code in the entry chunk) | 1.00 KB | 0.67 KB | 0.34 KB | ok |
| default | entry chunk with the preload helper | 2.00 KB | 1.39 KB | 0.61 KB | ok |
| default | probe client (lazy) | 3.00 KB | 2.90 KB | 0.10 KB | ok |
| default | own.worker entry | 4.50 KB | 4.18 KB | 0.32 KB | ok |
| default | ISO BMFF parser (in the own worker) | 13.50 KB | 12.21 KB | 1.29 KB | ok |
| default | Matroska parser (in the own worker) | 12.50 KB | 11.59 KB | 0.91 KB | ok |
| default | rate profile core (in the own worker) | 2.50 KB | 1.84 KB | 0.66 KB | ok |
| default | ffprobe frame rate estimate (in the own worker) | 4.00 KB | 3.58 KB | 0.42 KB | ok |
| default | first MP4 analysis, lazy total | 24.00 KB | 23.60 KB | 0.40 KB | ok |
| default | all own paths, lazy total | 41.00 KB | 40.60 KB | 0.40 KB | ok |
| default | emitted lazy total (every file outside the entry chunk) | 81.00 KB | 80.97 KB | 0.03 KB | ok |
| zero-config | critical path (package code in the entry chunk) | 1.00 KB | 0.67 KB | 0.34 KB | ok |
| zero-config | entry chunk with the preload helper | 2.00 KB | 1.39 KB | 0.61 KB | ok |
| zero-config | own.worker entry | 36.00 KB | 35.88 KB | 0.12 KB | ok |
| zero-config | first MP4 analysis, lazy total | 39.00 KB | 38.79 KB | 0.21 KB | ok |
| zero-config | emitted lazy total (every file outside the entry chunk) | 79.50 KB | 79.14 KB | 0.35 KB | ok |
| custom | critical path (package code in the entry chunk) | 1.00 KB | 0.67 KB | 0.33 KB | ok |
| custom | entry chunk with the preload helper | 2.00 KB | 1.46 KB | 0.54 KB | ok |
| custom | probe client (lazy) | 3.00 KB | 2.79 KB | 0.21 KB | ok |
| custom | fps.worker entry | 4.50 KB | 4.18 KB | 0.32 KB | ok |
| custom | first MP4 analysis, lazy total | 24.00 KB | 23.49 KB | 0.51 KB | ok |
| custom | emitted lazy total (every file outside the entry chunk) | 81.00 KB | 80.86 KB | 0.14 KB | ok |
| mp4box | critical path (package code in the entry chunk) | 1.00 KB | 0.89 KB | 0.11 KB | ok |
| mp4box | entry chunk with the preload helper | 2.00 KB | 1.74 KB | 0.26 KB | ok |
| mp4box | mp4box.worker entry | 5.00 KB | 4.32 KB | 0.68 KB | ok |
| mp4box | mp4box engine chunk | 49.50 KB | 44.86 KB | 4.64 KB | ok |
| mp4box | shared engine chunk | 2.00 KB | - | - | not built |
| mp4box | emitted lazy total (every file outside the entry chunk) | 216.00 KB | 208.97 KB | 7.03 KB | ok |
| mediabunny | critical path (package code in the entry chunk) | 1.00 KB | 0.89 KB | 0.11 KB | ok |
| mediabunny | entry chunk with the preload helper | 2.00 KB | 1.74 KB | 0.26 KB | ok |
| mediabunny | mediabunny.worker entry | 5.00 KB | 4.22 KB | 0.78 KB | ok |
| mediabunny | mediabunny engine chunk | 59.50 KB | 53.97 KB | 5.53 KB | ok |
| mediabunny | shared engine chunk | 2.00 KB | - | - | not built |
| mediabunny | emitted lazy total (every file outside the entry chunk) | 234.50 KB | 225.98 KB | 8.52 KB | ok |
| rvfc | critical path (package code in the entry chunk) | 1.00 KB | 0.77 KB | 0.23 KB | ok |
| rvfc | entry chunk with the preload helper | 2.00 KB | 1.58 KB | 0.42 KB | ok |
| rvfc | rVFC engine (main thread) | 2.50 KB | 2.19 KB | 0.31 KB | ok |
| rvfc | emitted lazy total (every file outside the entry chunk) | 83.50 KB | 83.29 KB | 0.21 KB | ok |
| all | critical path (package code in the entry chunk) | 1.50 KB | 1.01 KB | 0.49 KB | ok |
| all | entry chunk with the preload helper | 2.50 KB | 1.91 KB | 0.59 KB | ok |
| all | probe client (lazy) | 3.00 KB | 2.95 KB | 0.05 KB | ok |
| all | own.worker entry | 4.50 KB | 4.18 KB | 0.32 KB | ok |
| all | mp4box.worker entry | 5.00 KB | 4.32 KB | 0.68 KB | ok |
| all | mediabunny.worker entry | 5.00 KB | 4.22 KB | 0.78 KB | ok |
| all | mp4box engine chunk | 49.50 KB | 44.86 KB | 4.64 KB | ok |
| all | mediabunny engine chunk | 59.50 KB | 53.97 KB | 5.53 KB | ok |
| all | rVFC engine (main thread) | 2.50 KB | 2.19 KB | 0.31 KB | ok |
| all | ISO BMFF parser (in the own worker) | 13.50 KB | 12.21 KB | 1.29 KB | ok |
| all | Matroska parser (in the own worker) | 12.50 KB | 11.59 KB | 0.91 KB | ok |
| all | rate profile core (in the own worker) | 2.50 KB | 1.84 KB | 0.66 KB | ok |
| all | ffprobe frame rate estimate (in the own worker) | 4.00 KB | 3.58 KB | 0.42 KB | ok |
| all | first MP4 analysis, lazy total | 24.00 KB | 23.64 KB | 0.36 KB | ok |
| all | all own paths, lazy total | 41.00 KB | 40.65 KB | 0.35 KB | ok |
| all | shared engine chunk | 2.00 KB | - | - | not built |
| all | shared engine chunk (main thread, inline mode) | 2.00 KB | 1.51 KB | 0.49 KB | ok |
| all | emitted lazy total (every file outside the entry chunk) | 372.50 KB | 355.55 KB | 16.95 KB | ok |
| standalone-url | critical path (package code in the entry chunk) | 1.00 KB | 0.70 KB | 0.30 KB | ok |
| standalone-url | entry chunk with the preload helper | 2.00 KB | 1.45 KB | 0.55 KB | ok |
| standalone-url | probe client (lazy) | 3.00 KB | 2.80 KB | 0.20 KB | ok |
| standalone-url | own.worker entry | 36.00 KB | 35.80 KB | 0.20 KB | ok |
| standalone-url | first MP4 analysis, lazy total | 39.00 KB | 38.60 KB | 0.40 KB | ok |
| standalone-url | emitted lazy total (every file outside the entry chunk) | 79.00 KB | 78.97 KB | 0.03 KB | ok |
| iife-nosplit | critical path (package code in the entry chunk) | 1.00 KB | 0.67 KB | 0.34 KB | ok |
| iife-nosplit | entry chunk with the preload helper | 2.00 KB | 1.39 KB | 0.61 KB | ok |
| iife-nosplit | own.worker entry | 36.00 KB | 35.88 KB | 0.12 KB | ok |
| iife-nosplit | emitted lazy total (every file outside the entry chunk) | 79.50 KB | 79.14 KB | 0.35 KB | ok |
| react | critical path (package code in the entry chunk) | 2.00 KB | 1.64 KB | 0.36 KB | ok |
| react | React entry (the provider and hooks in the entry chunk, React not counted) | 1.50 KB | 1.18 KB | 0.32 KB | ok |
| react | probe client (lazy) | 3.00 KB | 2.90 KB | 0.10 KB | ok |
| react | own.worker entry | 4.50 KB | 4.18 KB | 0.32 KB | ok |
| react | summary module of the React store (lazy, main thread) | 0.50 KB | 0.43 KB | 0.07 KB | ok |
| react | first MP4 analysis, lazy total | 24.00 KB | 23.60 KB | 0.40 KB | ok |
| react | first MP4 analysis with the React summary, lazy total | 24.50 KB | 24.03 KB | 0.47 KB | ok |
| react | all own paths, lazy total | 41.00 KB | 40.61 KB | 0.39 KB | ok |
| react | emitted lazy total (every file outside the entry chunk) | 82.00 KB | 81.41 KB | 0.59 KB | ok |
| react18 | critical path (package code in the entry chunk) | 2.00 KB | 1.64 KB | 0.36 KB | ok |
| react18 | React entry (the provider and hooks in the entry chunk, React not counted) | 1.50 KB | 1.18 KB | 0.32 KB | ok |
| react18 | first MP4 analysis with the React summary, lazy total | 24.50 KB | 24.02 KB | 0.47 KB | ok |
| react18 | emitted lazy total (every file outside the entry chunk) | 82.00 KB | 81.40 KB | 0.60 KB | ok |
| check | critical path (package code in the entry chunk) | 5.00 KB | 3.98 KB | 1.02 KB | ok |
| check | check entry (in the entry chunk) | 4.00 KB | 3.42 KB | 0.58 KB | ok |
| check | entry chunk with the preload helper | 5.50 KB | 4.70 KB | 0.80 KB | ok |
| check | first MP4 analysis, lazy total | 24.00 KB | 23.60 KB | 0.40 KB | ok |
| check | emitted lazy total (every file outside the entry chunk) | 81.00 KB | 80.96 KB | 0.04 KB | ok |
| preset | critical path (package code in the entry chunk) | 5.00 KB | 4.34 KB | 0.66 KB | ok |
| preset | check entry (in the entry chunk) | 4.00 KB | 3.42 KB | 0.58 KB | ok |
| preset | presets entry (the imported presets, in the entry chunk) | 0.50 KB | 0.46 KB | 0.04 KB | ok |
| preset | entry chunk with the preload helper | 6.00 KB | 5.06 KB | 0.94 KB | ok |
| preset | first MP4 analysis, lazy total | 24.00 KB | 23.60 KB | 0.40 KB | ok |
| preset | emitted lazy total (every file outside the entry chunk) | 81.00 KB | 80.96 KB | 0.04 KB | ok |
| standalone | own.worker.js | 36.00 KB | 35.80 KB | 0.20 KB | ok |

## Checks

- **default**: worker files own.worker (5 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/`, `video-fps-probe/dist/engines/` appears in any sourcemap; request chains ok.
- **zero-config**: worker files own.worker (0 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/`, `video-fps-probe/dist/engines/` appears in any sourcemap; request chains ok.
- **custom**: worker files fps.worker (5 lazy chunks); none of `video-fps-probe/dist/plugins/own.js`, `video-fps-probe/dist/worker/own.worker.js`, `node_modules/mp4box/`, `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **mp4box**: worker files mp4box.worker (6 lazy chunks), own.worker (5 lazy chunks); none of `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **mediabunny**: worker files mediabunny.worker (6 lazy chunks), own.worker (5 lazy chunks); none of `node_modules/mp4box/` appears in any sourcemap; request chains ok.
- **rvfc**: worker files own.worker (5 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **all**: worker files mediabunny.worker (6 lazy chunks), mp4box.worker (6 lazy chunks), own.worker (5 lazy chunks); none of (no patterns) appears in any sourcemap; request chains ok.
- **standalone-url**: worker files own.worker (0 lazy chunks); none of `video-fps-probe/dist/plugins/own.js`, `video-fps-probe/dist/worker/own.worker.js`, `node_modules/mp4box/`, `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **iife-nosplit**: worker files own.worker (0 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **react**: worker files own.worker (5 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/`, `video-fps-probe/dist/engines/` appears in any sourcemap; request chains ok.
- **react18**: worker files own.worker (5 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/`, `video-fps-probe/dist/engines/` appears in any sourcemap; request chains ok.
- **check**: worker files own.worker (5 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/`, `video-fps-probe/dist/engines/` appears in any sourcemap; request chains ok.
- **preset**: worker files own.worker (5 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/`, `video-fps-probe/dist/engines/` appears in any sourcemap; request chains ok.

Must-not-exist reads the `sources` of every hidden sourcemap, because minified identifiers are renamed. The request chain check is the one in `scripts/size-report.mjs`: every static dependency of a parser or engine chunk is already loaded, or requested in the same Promise.all.

## Why these limits

- **default, critical path (package code in the entry chunk)** (1.00 KB): User-facing promise of the package, accepted by the owner on 2026-10-23 when the demo budget moved to 101.5 KB: the default configuration adds at most 1 KB to the critical path and the first MP4 loads at most 24 KB lazily. This row is the first half: the package code in the host entry chunk (the lazyProbe stub, ProbeError and the engine list), cut out of the entry chunk by its sourcemap. Vite's preload helper is not counted here, because every Vite app with a dynamic import already has it; the entry chunk row counts it. Design estimate 1.0 KB; measured 0.67 KB, and measured plus 10 percent rounded up to 0.5 KB is also 1.0 KB.
- **default, entry chunk with the preload helper** (2.00 KB): The whole host entry chunk: the package code of the critical path row, Vite's preload helper, which Vite adds to the entry chunk of any app with a dynamic import, and the one line of host code. The critical path row stays the package promise; this row also catches what the package makes Vite add next to its code, such as a longer preload dependency list per dynamic import. Measured 1.40 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, probe client (lazy)** (3.00 KB): The probe client fetched on the first file: createProbe, engine routing, the worker pool and the own descriptor with the worker literal. Design estimate 3.5 KB; measured 2.67 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, own.worker entry** (4.50 KB): The prebuilt own worker entry: reader, sniffing, options and the worker runtime. Both parsers and the statistics are lazy chunks of this worker. Design estimate 8.0 KB; measured 4.08 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, ISO BMFF parser (in the own worker)** (13.50 KB): The own MP4 and MOV parser chunk of the own worker. Design estimate 13.5 KB; measured 12.21 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, Matroska parser (in the own worker)** (12.50 KB): The own Matroska and WebM parser chunk of the own worker. Design estimate 12.0 KB; measured 11.14 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, rate profile core (in the own worker)** (2.50 KB): The rate profile core of the own worker, fetched only for a timeline with unequal frame rates. Design estimate 2.0 KB; measured 1.84 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, ffprobe frame rate estimate (in the own worker)** (4.00 KB): The ffprobe frame rate estimate of the own worker, fetched by the Matroska parser only for a Matroska or WebM file without DefaultDuration, read in probe and exact mode. Measured 2.76 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.54 KB, when the estimate began to read the H.264 slice headers that decide the decoder delay and to ride the block walk of the exact scan instead of a walk of its own.
- **default, first MP4 analysis, lazy total** (24.00 KB): User-facing promise of the package, accepted by the owner on 2026-10-23 when the demo budget moved to 101.5 KB: the default configuration adds at most 1 KB to the critical path and the first MP4 loads at most 24 KB lazily. This row is the second half: everything the first MP4 or MOV file loads lazily, which is the probe client, the own worker entry, the statistics chunk (requested in parallel with the parser) and the ISO BMFF parser. Measured 23.26 KB. Measured plus 10 percent would be 26.0 KB, so the promise stays the limit instead: it is the tighter one and it is what the README states.
- **default, all own paths, lazy total** (41.00 KB): Every own path: the probe client, the own worker entry, the statistics, both parsers, the rate profile core and the ffprobe frame rate estimate. Design estimate 37.0 KB; measured 36.24 KB before the estimate was added. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 40 KB to 40.5 KB in 0.2.0, measured 40.34 KB, when the ffprobe frame rate estimate began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip). Raised again to 41 KB, measured 40.58 KB, when the estimate began to ride the block walk of the exact scan (0.23 KB in the estimate and the Matroska parser).
- **default, emitted lazy total (every file outside the entry chunk)** (81.00 KB): Every JavaScript file the build emits outside the entry chunk, fetched or not: the probe client with its compare and fallback chunks, the own worker with its chunks, and the main-thread copies of the parsers, the statistics, the sniffer and the worker runtime. The default flavor keeps them as an in-thread own for environments without a Worker global (SSR, Node) and for worker: 'inline'; a root analyze(), not imported here, always runs in the calling thread on the same copies. A browser with a Worker global never fetches them otherwise, so the lazy totals above leave them out. This row bounds what the package adds to the deploy and the CDN. Measured 72.20 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 79.5 KB to 81 KB in 0.2.0, measured 80.43 KB, when the ffprobe frame rate estimate began to read the H.264 slice headers: the build emits that code twice, in the own worker and in the main-thread copy.
- **zero-config, critical path (package code in the entry chunk)** (1.00 KB): As in the default configuration: the worker option does not change the entry chunk. Measured 0.67 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **zero-config, entry chunk with the preload helper** (2.00 KB): As in the default configuration: the worker option does not change the entry chunk. Measured 1.40 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **zero-config, own.worker entry** (36.00 KB): A Vite 8 app with no worker option builds workers with Vite's default format, 'iife', which cannot split, so the own worker is one file: both parsers, the statistics and the rate profile core are inlined. Measured 32.11 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.65 KB, when the ffprobe frame rate estimate, which the one-file worker inlines, began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip).
- **zero-config, first MP4 analysis, lazy total** (39.00 KB): What the first MP4 loads in a Vite 8 app that keeps the default worker format: the probe client and the one-file own worker. The 24 KB of the default configuration needs worker.format 'es' in the host's Vite config. Measured 34.77 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 38.5 KB to 39 KB in 0.2.0, measured 38.55 KB, because the one-file worker inlines the ffprobe frame rate estimate, which then began to read the H.264 slice headers (0.63 KB gzip).
- **zero-config, emitted lazy total (every file outside the entry chunk)** (79.50 KB): As in the default configuration, with the one-file own worker instead of the worker entry and its chunks. Measured 70.75 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 78 KB to 79 KB in 0.2.0, measured 78.66 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the worker and in the main-thread copy. Raised again to 79.5 KB, measured 79.06 KB, when the estimate began to ride the block walk of the exact scan.
- **custom, critical path (package code in the entry chunk)** (1.00 KB): The lazyProbeClient stub in the host entry chunk. The host's worker literal is host code and is not counted. Design estimate 1.0 KB; measured 0.68 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **custom, entry chunk with the preload helper** (2.00 KB): The lazyProbeClient stub, Vite's preload helper and the host's worker literal. Measured 1.47 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **custom, probe client (lazy)** (3.00 KB): The probe client fetched on the first file, without the own descriptor and its worker literal, which the host replaces with its own worker. Measured 2.56 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **custom, fps.worker entry** (4.50 KB): The host worker built from video-fps-probe/worker-runtime, serving own only. Design estimate 8.5 KB; measured 4.08 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **custom, first MP4 analysis, lazy total** (24.00 KB): A host worker that serves own holds the same code as the prebuilt own worker, so the 24 KB promise of the default configuration applies to the first MP4 here too. Measured 23.15 KB.
- **custom, emitted lazy total (every file outside the entry chunk)** (81.00 KB): As in the default configuration, with the host worker instead of the prebuilt own worker. In the client flavor the main-thread copies are there for worker: 'inline' and for environments without a Worker global, where own runs in the calling thread; a browser with a Worker global never fetches them otherwise. Measured 72.11 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 79.5 KB to 80.5 KB in 0.2.0, measured 80.33 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the host worker and in the main-thread copy. Raised again to 81 KB, measured 80.79 KB, when the estimate began to ride the block walk of the exact scan.
- **mp4box, critical path (package code in the entry chunk)** (1.00 KB): The default trigger plus the mp4box descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, entry chunk with the preload helper** (2.00 KB): The trigger of this configuration plus Vite's preload helper. Measured 1.75 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, mp4box.worker entry** (5.00 KB): The prebuilt mp4box worker entry, which serves own and mp4box. Design estimate 8.5 KB; measured 4.22 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, mp4box engine chunk** (49.50 KB): The mp4box.js engine chunk of the mp4box worker: the mp4box library, the adapter and the counting code the engines share. Design estimate 48.0 KB; measured 44.77 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, shared engine chunk** (2.00 KB): Code the comparison engines share, when it is a chunk of its own. Not built: each prebuilt engine worker serves one comparison engine, so this code is part of the engine chunk. The design estimate of 2.0 KB stays the limit, so a split that grows it is caught.
- **mp4box, emitted lazy total (every file outside the entry chunk)** (216.00 KB): As in the default configuration plus the mp4box worker, which carries its own copies of the own parsers because it also serves own, and the main-thread copy of the mp4box engine, which runs in the calling thread only with worker: 'inline' or without a Worker global. Measured 195.93 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, critical path (package code in the entry chunk)** (1.00 KB): The default trigger plus the mediabunny descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, entry chunk with the preload helper** (2.00 KB): The trigger of this configuration plus Vite's preload helper. Measured 1.75 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, mediabunny.worker entry** (5.00 KB): The prebuilt mediabunny worker entry, which serves own and mediabunny. Measured 4.12 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, mediabunny engine chunk** (59.50 KB): The mediabunny engine chunk of the mediabunny worker, with the counting code the engines share. Design estimate 58.0 KB; measured 53.87 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, shared engine chunk** (2.00 KB): Code the comparison engines share, when it is a chunk of its own. Not built, for the same reason as in the mp4box configuration. The design estimate of 2.0 KB stays the limit.
- **mediabunny, emitted lazy total (every file outside the entry chunk)** (234.50 KB): As in the mp4box configuration, with the mediabunny worker and engine. Measured 212.89 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **rvfc, critical path (package code in the entry chunk)** (1.00 KB): The default trigger plus the rvfc descriptor, which has no worker literal. Measured 0.77 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **rvfc, entry chunk with the preload helper** (2.00 KB): The trigger of this configuration plus Vite's preload helper. Measured 1.59 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **rvfc, rVFC engine (main thread)** (2.50 KB): The requestVideoFrameCallback engine, a main-thread chunk loaded on its first run. Design estimate 2.5 KB; measured 2.19 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **rvfc, emitted lazy total (every file outside the entry chunk)** (83.50 KB): As in the default configuration plus the main-thread rVFC engine. Measured 74.52 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 82 KB to 83 KB in 0.2.0, measured 82.76 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the worker and in the main-thread copy. Raised again to 83.5 KB, measured 83.21 KB, when the estimate began to ride the block walk of the exact scan.
- **all, critical path (package code in the entry chunk)** (1.50 KB): The default trigger plus the mp4box, mediabunny and rvfc descriptors. Measured 1.02 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, entry chunk with the preload helper** (2.50 KB): The trigger of this configuration plus Vite's preload helper. Measured 1.92 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, probe client (lazy)** (3.00 KB): As in the default configuration. Measured 2.71 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, own.worker entry** (4.50 KB): As in the default configuration. Measured 4.08 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mp4box.worker entry** (5.00 KB): As in the mp4box configuration. Measured 4.22 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mediabunny.worker entry** (5.00 KB): As in the mediabunny configuration. Measured 4.12 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mp4box engine chunk** (49.50 KB): As in the mp4box configuration. Measured 44.77 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mediabunny engine chunk** (59.50 KB): As in the mediabunny configuration. Measured 53.87 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, rVFC engine (main thread)** (2.50 KB): As in the rvfc configuration. Measured 2.19 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, ISO BMFF parser (in the own worker)** (13.50 KB): As in the default configuration. Measured 12.21 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, Matroska parser (in the own worker)** (12.50 KB): As in the default configuration. Measured 11.14 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, rate profile core (in the own worker)** (2.50 KB): As in the default configuration. Measured 1.84 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, ffprobe frame rate estimate (in the own worker)** (4.00 KB): As in the default configuration. Measured 2.76 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.54 KB, as in the default configuration.
- **all, first MP4 analysis, lazy total** (24.00 KB): Registering engines must not change what the first own analysis loads, so the 24 KB promise of the default configuration applies here too. Measured 23.31 KB.
- **all, all own paths, lazy total** (41.00 KB): As in the default configuration. Measured 36.29 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 40 KB to 40.5 KB in 0.2.0, measured 40.38 KB, as in the default configuration. Raised again to 41 KB, measured 40.62 KB, as in the default configuration.
- **all, shared engine chunk** (2.00 KB): As in the mp4box and mediabunny configurations: each prebuilt engine worker serves one comparison engine, so no worker builds this chunk. The design estimate of 2.0 KB stays the limit.
- **all, shared engine chunk (main thread, inline mode)** (2.00 KB): The counting code mp4box and mediabunny share, which becomes a main-thread chunk of its own when both are registered. It loads only when an engine runs in this thread (worker: 'inline', SSR, no Worker global). Measured 1.51 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, emitted lazy total (every file outside the entry chunk)** (372.50 KB): Every worker with its own copies of the own parsers, the main-thread copies of every engine and the shared engine chunk, which run in the calling thread only with worker: 'inline' or without a Worker global (rVFC always runs there). Measured 338.19 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **standalone-url, critical path (package code in the entry chunk)** (1.00 KB): The lazyProbeClient stub in the host entry chunk, as in the custom configuration. The asset URL of the standalone file is host code and is not counted. Measured 0.71 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **standalone-url, entry chunk with the preload helper** (2.00 KB): The lazyProbeClient stub, Vite's preload helper and the host's asset URL of the standalone file. Measured 1.46 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **standalone-url, probe client (lazy)** (3.00 KB): As in the custom configuration. Measured 2.56 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **standalone-url, own.worker entry** (36.00 KB): dist/standalone/own.worker.js, which Vite copies unchanged as an asset for the ?url import and the host starts as a classic worker. Measured 32.04 KB, the standalone row below. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.58 KB, as the standalone row below.
- **standalone-url, first MP4 analysis, lazy total** (39.00 KB): What the first MP4 loads with the standalone worker: the probe client and the one-file worker. It suits a host whose workers must stay classic scripts. Measured 34.60 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 38.5 KB to 39 KB in 0.2.0, measured 38.56 KB, because the standalone file inlines the ffprobe frame rate estimate, which began to read the H.264 slice headers and to ride the block walk of the exact scan (0.81 KB gzip together).
- **standalone-url, emitted lazy total (every file outside the entry chunk)** (79.00 KB): As in the custom configuration, with the standalone file as the worker. Measured 70.56 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 78 KB to 79 KB in 0.2.0, measured 78.48 KB, for the H.264 slice header check of the ffprobe frame rate estimate, in the standalone file and in the main-thread copy.
- **iife-nosplit, critical path (package code in the entry chunk)** (1.00 KB): As in the default configuration. Measured 0.67 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **iife-nosplit, entry chunk with the preload helper** (2.00 KB): As in the default configuration. Measured 1.40 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **iife-nosplit, own.worker entry** (36.00 KB): With worker.format iife and codeSplitting false the own worker is one file: both parsers, the statistics and the rate profile core are inlined. Design estimate 35.0 KB; measured 32.11 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.65 KB, as in the zero-config configuration.
- **iife-nosplit, emitted lazy total (every file outside the entry chunk)** (79.50 KB): As in the zero-config configuration. Measured 70.75 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 78 KB to 79 KB in 0.2.0, measured 78.66 KB, as in the zero-config configuration. Raised again to 79.5 KB, measured 79.06 KB, as in the zero-config configuration.
- **react, critical path (package code in the entry chunk)** (2.00 KB): The package code in the entry chunk of a React host that imports video-fps-probe/react next to video-fps-probe/lazy: the lazyProbe stub, ProbeError and the React entry. React and ReactDOM are host code and are not counted. Measured 1.63 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **react, React entry (the provider and hooks in the entry chunk, React not counted)** (1.50 KB): The part of the critical path the React entry adds: VideoFpsProvider, useVideoFps and the framework-free store that caches by Blob, then by engine and options, and aborts on unmount. Design estimate 1.5 KB; measured 1.17 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **react, probe client (lazy)** (3.00 KB): As in the default configuration: the React entry adds nothing to the probe client. Measured 2.90 KB.
- **react, own.worker entry** (4.50 KB): As in the default configuration. Measured 4.18 KB.
- **react, summary module of the React store (lazy, main thread)** (0.50 KB): The summarize module, which the store imports with import() in parallel with the first analysis, so it stays off the critical path. Measured 0.43 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **react, first MP4 analysis, lazy total** (24.00 KB): The first MP4 as in the default configuration: the probe client, the own worker entry, the statistics chunk and the ISO BMFF parser. Measured 23.60 KB.
- **react, first MP4 analysis with the React summary, lazy total** (24.50 KB): What the first MP4 of a React host loads lazily: the first MP4 of the default configuration plus the summary module of the store. The 24 KB promise of the default configuration plus the 0.5 KB summary budget. Measured 24.03 KB.
- **react, all own paths, lazy total** (41.00 KB): As in the default configuration. Measured 40.57 KB.
- **react, emitted lazy total (every file outside the entry chunk)** (82.00 KB): As in the default configuration plus the summary module. Measured 81.32 KB.
- **react18, critical path (package code in the entry chunk)** (2.00 KB): As in the react configuration, built with React 18.3.1 and ReactDOM 18.3.1. Measured 1.63 KB.
- **react18, React entry (the provider and hooks in the entry chunk, React not counted)** (1.50 KB): As in the react configuration: the React entry is the same code for React 18 and 19. Measured 1.17 KB.
- **react18, first MP4 analysis with the React summary, lazy total** (24.50 KB): As in the react configuration. Measured 24.03 KB.
- **react18, emitted lazy total (every file outside the entry chunk)** (82.00 KB): As in the react configuration. Measured 81.32 KB.
- **check, critical path (package code in the entry chunk)** (5.00 KB): The package code in the entry chunk of a host that imports video-fps-probe/check statically next to video-fps-probe/lazy: the lazyProbe stub of the default configuration and check. Measured 3.00 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 3.5 KB to 4 KB in 0.2.0, measured 3.29 KB, with the rule that judges a constant track on 1 ms ticks by its nominal rate and duration, and the validation of every rule value. Raised to 5 KB, measured 3.81 KB, with the NTSC decimals, the 1 ms tick resolution of the frame rate bounds, the message digits, the checks of unknown keys and lists, and the audio rule that fails open.
- **check, check entry (in the entry chunk)** (4.00 KB): The part of the critical path the check entry adds: check(result, rules) with its exact rational comparison, the violation messages and suggestedFps. It imports no other module, so nothing of it loads lazily. Design estimate 0.8 to 1.5 KB; measured 2.43 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Measured 2.72 KB in 0.2.0, 2.80 KB before a trim that kept every message, with the rule that judges a constant track on 1 ms ticks by its nominal rate and duration, and the validation of every rule value. Raised from 3 KB to 4 KB, measured 3.25 KB, with the NTSC decimals, the 1 ms tick resolution of the frame rate bounds, the message digits, the checks of unknown keys and lists, and the audio rule that fails open.
- **check, entry chunk with the preload helper** (5.50 KB): The trigger of this configuration plus Vite's preload helper. Measured 3.72 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Measured 4.01 KB in 0.2.0 with the larger check. Raised from 4.5 KB to 5.5 KB, measured 4.53 KB, with the larger check again.
- **check, first MP4 analysis, lazy total** (24.00 KB): Importing check must not change what the first own analysis loads, so the 24 KB promise of the default configuration applies here too. Measured 23.60 KB.
- **check, emitted lazy total (every file outside the entry chunk)** (81.00 KB): As in the default configuration: check adds no lazy file. Measured 80.96 KB.
- **preset, critical path (package code in the entry chunk)** (5.00 KB): The check configuration plus one preset, klingO1ReferenceVideo, imported from video-fps-probe/presets. Measured 3.24 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Measured 3.60 KB in 0.2.0 with the larger check and the size note of the preset. Raised from 4 KB to 5 KB, measured 4.12 KB, with the larger check of the check configuration.
- **preset, check entry (in the entry chunk)** (4.00 KB): As in the check configuration. Measured 3.25 KB.
- **preset, presets entry (the imported presets, in the entry chunk)** (0.50 KB): The one imported preset: its name, source, date, note and rules. The six presets together are about 1.5 KB gzip, so this limit also fails a build that stops tree-shaking the presets a host does not import. Design estimate 0.1 to 0.2 KB per preset; measured 0.31 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Measured 0.38 KB in 0.2.0, when each note began to name how its MB is read; the limit stays.
- **preset, entry chunk with the preload helper** (6.00 KB): The trigger of this configuration plus Vite's preload helper. Measured 3.96 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 4.5 KB to 5 KB in 0.2.0, measured 4.33 KB, with the larger check and the size note of the preset. Raised to 6 KB, measured 4.85 KB, with the larger check of the check configuration.
- **preset, first MP4 analysis, lazy total** (24.00 KB): As in the check configuration. Measured 23.60 KB.
- **preset, emitted lazy total (every file outside the entry chunk)** (81.00 KB): As in the check configuration. Measured 80.96 KB.
- **standalone, own.worker.js** (36.00 KB): dist/standalone/own.worker.js: the own worker as one minified IIFE file with no imports, built by rolldown. Design estimate 35.0 KB; measured 32.04 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB. Raised from 35.5 KB to 36 KB in 0.2.0, measured 35.58 KB, when the ffprobe frame rate estimate, which the file inlines, began to read the H.264 slice headers that decide the decoder delay (0.63 KB gzip).

## Files

| Configuration | File | Runs in | Holds | gzip -9 |
|---|---|---|---|---:|
| default | assets/compare.js | page | shared | 1.32 KB |
| default | assets/fallback.js | page | shared | 0.73 KB |
| default | assets/index.js | page | shared | 1.39 KB |
| default | assets/inline.js | page | shared | 0.63 KB |
| default | assets/isobmff.js | page | isobmff | 12.23 KB |
| default | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| default | assets/matroska.js | page | matroska | 11.77 KB |
| default | assets/matroska.js | own.worker | matroska | 11.59 KB |
| default | assets/own.worker.js | own.worker | shared | 4.18 KB |
| default | assets/probe.js | page | shared | 2.90 KB |
| default | assets/result.js | page | shared | 0.38 KB |
| default | assets/rfps.js | page | rfps | 3.57 KB |
| default | assets/rfps.js | own.worker | rfps | 3.58 KB |
| default | assets/runtime.js | page | shared | 2.54 KB |
| default | assets/segments.js | page | segments | 1.84 KB |
| default | assets/segments.js | own.worker | segments | 1.84 KB |
| default | assets/sniff.js | page | shared | 0.99 KB |
| default | assets/stats.js | own.worker | stats | 4.31 KB |
| default | assets/stats.js | page | stats | 4.34 KB |
| zero-config | assets/compare.js | page | shared | 1.33 KB |
| zero-config | assets/fallback.js | page | shared | 0.73 KB |
| zero-config | assets/index.js | page | shared | 1.39 KB |
| zero-config | assets/inline.js | page | shared | 0.63 KB |
| zero-config | assets/isobmff.js | page | isobmff | 12.23 KB |
| zero-config | assets/matroska.js | page | matroska | 11.77 KB |
| zero-config | assets/own.worker.js | own.worker | isobmff | 35.88 KB |
| zero-config | assets/probe.js | page | shared | 2.90 KB |
| zero-config | assets/result.js | page | shared | 0.38 KB |
| zero-config | assets/rfps.js | page | rfps | 3.57 KB |
| zero-config | assets/runtime.js | page | shared | 2.54 KB |
| zero-config | assets/segments.js | page | segments | 1.84 KB |
| zero-config | assets/sniff.js | page | shared | 0.99 KB |
| zero-config | assets/stats.js | page | stats | 4.34 KB |
| custom | assets/compare.js | page | shared | 1.33 KB |
| custom | assets/fallback.js | page | shared | 0.73 KB |
| custom | assets/fps.worker.js | fps.worker | shared | 4.18 KB |
| custom | assets/index.js | page | shared | 1.46 KB |
| custom | assets/inline.js | page | shared | 0.63 KB |
| custom | assets/isobmff.js | page | isobmff | 12.23 KB |
| custom | assets/isobmff.js | fps.worker | isobmff | 12.21 KB |
| custom | assets/matroska.js | page | matroska | 11.77 KB |
| custom | assets/matroska.js | fps.worker | matroska | 11.59 KB |
| custom | assets/probe.js | page | shared | 2.79 KB |
| custom | assets/result.js | page | shared | 0.38 KB |
| custom | assets/rfps.js | page | rfps | 3.57 KB |
| custom | assets/rfps.js | fps.worker | rfps | 3.58 KB |
| custom | assets/runtime.js | page | shared | 2.54 KB |
| custom | assets/segments.js | fps.worker | segments | 1.84 KB |
| custom | assets/segments.js | page | segments | 1.84 KB |
| custom | assets/sniff.js | page | shared | 0.99 KB |
| custom | assets/stats.js | page | stats | 4.34 KB |
| custom | assets/stats.js | fps.worker | stats | 4.31 KB |
| mp4box | assets/compare.js | page | shared | 1.32 KB |
| mp4box | assets/fallback.js | page | shared | 0.73 KB |
| mp4box | assets/index.js | page | shared | 1.74 KB |
| mp4box | assets/inline.js | page | shared | 0.63 KB |
| mp4box | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| mp4box | assets/isobmff.js | mp4box.worker | isobmff | 12.26 KB |
| mp4box | assets/isobmff.js | page | isobmff | 12.22 KB |
| mp4box | assets/matroska.js | own.worker | matroska | 11.59 KB |
| mp4box | assets/matroska.js | page | matroska | 11.73 KB |
| mp4box | assets/matroska.js | mp4box.worker | matroska | 11.58 KB |
| mp4box | assets/mp4box.js | page | mp4box | 44.86 KB |
| mp4box | assets/mp4box.js | mp4box.worker | mp4box | 44.86 KB |
| mp4box | assets/mp4box.worker.js | mp4box.worker | shared | 4.32 KB |
| mp4box | assets/options.js | page | shared | 0.37 KB |
| mp4box | assets/own.worker.js | own.worker | shared | 4.18 KB |
| mp4box | assets/probe.js | page | shared | 2.94 KB |
| mp4box | assets/reader.js | page | shared | 1.47 KB |
| mp4box | assets/result.js | page | shared | 0.38 KB |
| mp4box | assets/rfps.js | page | rfps | 3.58 KB |
| mp4box | assets/rfps.js | mp4box.worker | rfps | 3.58 KB |
| mp4box | assets/rfps.js | own.worker | rfps | 3.58 KB |
| mp4box | assets/runtime.js | page | shared | 1.12 KB |
| mp4box | assets/segments.js | mp4box.worker | segments | 1.84 KB |
| mp4box | assets/segments.js | own.worker | segments | 1.84 KB |
| mp4box | assets/segments.js | page | segments | 1.84 KB |
| mp4box | assets/sniff.js | page | shared | 0.99 KB |
| mp4box | assets/stats.js | own.worker | stats | 4.31 KB |
| mp4box | assets/stats.js | mp4box.worker | stats | 4.31 KB |
| mp4box | assets/stats.js | page | stats | 4.34 KB |
| mediabunny | assets/abort.js | page | shared | 0.11 KB |
| mediabunny | assets/compare.js | page | shared | 1.33 KB |
| mediabunny | assets/fallback.js | page | shared | 0.73 KB |
| mediabunny | assets/index.js | page | shared | 1.74 KB |
| mediabunny | assets/inline.js | page | shared | 0.63 KB |
| mediabunny | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| mediabunny | assets/isobmff.js | page | isobmff | 12.23 KB |
| mediabunny | assets/isobmff.js | mediabunny.worker | isobmff | 12.21 KB |
| mediabunny | assets/matroska.js | mediabunny.worker | matroska | 11.59 KB |
| mediabunny | assets/matroska.js | own.worker | matroska | 11.59 KB |
| mediabunny | assets/matroska.js | page | matroska | 11.74 KB |
| mediabunny | assets/mediabunny.js | mediabunny.worker | mediabunny | 53.97 KB |
| mediabunny | assets/mediabunny.js | page | mediabunny | 53.04 KB |
| mediabunny | assets/mediabunny.worker.js | mediabunny.worker | shared | 4.22 KB |
| mediabunny | assets/options.js | page | shared | 0.37 KB |
| mediabunny | assets/own.worker.js | own.worker | shared | 4.18 KB |
| mediabunny | assets/probe.js | page | shared | 2.93 KB |
| mediabunny | assets/result.js | page | shared | 0.38 KB |
| mediabunny | assets/rfps.js | page | rfps | 3.57 KB |
| mediabunny | assets/rfps.js | own.worker | rfps | 3.58 KB |
| mediabunny | assets/rfps.js | mediabunny.worker | rfps | 3.58 KB |
| mediabunny | assets/runtime.js | page | shared | 2.31 KB |
| mediabunny | assets/segments.js | page | segments | 1.84 KB |
| mediabunny | assets/segments.js | mediabunny.worker | segments | 1.84 KB |
| mediabunny | assets/segments.js | own.worker | segments | 1.84 KB |
| mediabunny | assets/sniff.js | page | shared | 0.99 KB |
| mediabunny | assets/stats.js | mediabunny.worker | stats | 4.31 KB |
| mediabunny | assets/stats.js | own.worker | stats | 4.31 KB |
| mediabunny | assets/stats.js | page | stats | 4.34 KB |
| rvfc | assets/abort.js | page | shared | 0.11 KB |
| rvfc | assets/compare.js | page | shared | 1.33 KB |
| rvfc | assets/fallback.js | page | shared | 0.73 KB |
| rvfc | assets/index.js | page | shared | 1.58 KB |
| rvfc | assets/inline.js | page | shared | 0.63 KB |
| rvfc | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| rvfc | assets/isobmff.js | page | isobmff | 12.23 KB |
| rvfc | assets/matroska.js | own.worker | matroska | 11.59 KB |
| rvfc | assets/matroska.js | page | matroska | 11.78 KB |
| rvfc | assets/own.worker.js | own.worker | shared | 4.18 KB |
| rvfc | assets/probe.js | page | shared | 2.92 KB |
| rvfc | assets/result.js | page | shared | 0.38 KB |
| rvfc | assets/rfps.js | page | rfps | 3.57 KB |
| rvfc | assets/rfps.js | own.worker | rfps | 3.58 KB |
| rvfc | assets/runtime.js | page | shared | 2.53 KB |
| rvfc | assets/rvfc.js | page | rvfc | 2.19 KB |
| rvfc | assets/segments.js | own.worker | segments | 1.84 KB |
| rvfc | assets/segments.js | page | segments | 1.84 KB |
| rvfc | assets/sniff.js | page | shared | 0.99 KB |
| rvfc | assets/stats.js | own.worker | stats | 4.31 KB |
| rvfc | assets/stats.js | page | stats | 4.34 KB |
| all | assets/abort.js | page | shared | 0.11 KB |
| all | assets/compare.js | page | shared | 1.33 KB |
| all | assets/counting.js | page | engineShared | 1.51 KB |
| all | assets/fallback.js | page | shared | 0.73 KB |
| all | assets/index.js | page | shared | 1.91 KB |
| all | assets/inline.js | page | shared | 0.63 KB |
| all | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| all | assets/isobmff.js | mediabunny.worker | isobmff | 12.21 KB |
| all | assets/isobmff.js | page | isobmff | 12.22 KB |
| all | assets/isobmff.js | mp4box.worker | isobmff | 12.26 KB |
| all | assets/matroska.js | mediabunny.worker | matroska | 11.59 KB |
| all | assets/matroska.js | own.worker | matroska | 11.59 KB |
| all | assets/matroska.js | page | matroska | 11.74 KB |
| all | assets/matroska.js | mp4box.worker | matroska | 11.58 KB |
| all | assets/mediabunny.js | mediabunny.worker | mediabunny | 53.97 KB |
| all | assets/mediabunny.js | page | mediabunny | 52.05 KB |
| all | assets/mediabunny.worker.js | mediabunny.worker | shared | 4.22 KB |
| all | assets/mp4box.js | page | mp4box | 43.83 KB |
| all | assets/mp4box.js | mp4box.worker | mp4box | 44.86 KB |
| all | assets/mp4box.worker.js | mp4box.worker | shared | 4.32 KB |
| all | assets/options.js | page | shared | 0.37 KB |
| all | assets/own.worker.js | own.worker | shared | 4.18 KB |
| all | assets/probe.js | page | shared | 2.95 KB |
| all | assets/reader.js | page | shared | 1.46 KB |
| all | assets/result.js | page | shared | 0.38 KB |
| all | assets/rfps.js | page | rfps | 3.58 KB |
| all | assets/rfps.js | mp4box.worker | rfps | 3.58 KB |
| all | assets/rfps.js | own.worker | rfps | 3.58 KB |
| all | assets/rfps.js | mediabunny.worker | rfps | 3.58 KB |
| all | assets/runtime.js | page | shared | 1.13 KB |
| all | assets/rvfc.js | page | rvfc | 2.19 KB |
| all | assets/segments.js | mediabunny.worker | segments | 1.84 KB |
| all | assets/segments.js | page | segments | 1.84 KB |
| all | assets/segments.js | mp4box.worker | segments | 1.84 KB |
| all | assets/segments.js | own.worker | segments | 1.84 KB |
| all | assets/sniff.js | page | shared | 0.99 KB |
| all | assets/stats.js | mediabunny.worker | stats | 4.31 KB |
| all | assets/stats.js | page | stats | 4.34 KB |
| all | assets/stats.js | own.worker | stats | 4.31 KB |
| all | assets/stats.js | mp4box.worker | stats | 4.31 KB |
| standalone-url | assets/compare.js | page | shared | 1.33 KB |
| standalone-url | assets/fallback.js | page | shared | 0.73 KB |
| standalone-url | assets/index.js | page | shared | 1.45 KB |
| standalone-url | assets/inline.js | page | shared | 0.63 KB |
| standalone-url | assets/isobmff.js | page | isobmff | 12.23 KB |
| standalone-url | assets/matroska.js | page | matroska | 11.77 KB |
| standalone-url | assets/own.worker.js | own.worker | shared | 35.80 KB |
| standalone-url | assets/probe.js | page | shared | 2.80 KB |
| standalone-url | assets/result.js | page | shared | 0.38 KB |
| standalone-url | assets/rfps.js | page | rfps | 3.57 KB |
| standalone-url | assets/runtime.js | page | shared | 2.54 KB |
| standalone-url | assets/segments.js | page | segments | 1.84 KB |
| standalone-url | assets/sniff.js | page | shared | 0.99 KB |
| standalone-url | assets/stats.js | page | stats | 4.34 KB |
| iife-nosplit | assets/compare.js | page | shared | 1.33 KB |
| iife-nosplit | assets/fallback.js | page | shared | 0.73 KB |
| iife-nosplit | assets/index.js | page | shared | 1.39 KB |
| iife-nosplit | assets/inline.js | page | shared | 0.63 KB |
| iife-nosplit | assets/isobmff.js | page | isobmff | 12.23 KB |
| iife-nosplit | assets/matroska.js | page | matroska | 11.77 KB |
| iife-nosplit | assets/own.worker.js | own.worker | isobmff | 35.88 KB |
| iife-nosplit | assets/probe.js | page | shared | 2.90 KB |
| iife-nosplit | assets/result.js | page | shared | 0.38 KB |
| iife-nosplit | assets/rfps.js | page | rfps | 3.57 KB |
| iife-nosplit | assets/runtime.js | page | shared | 2.54 KB |
| iife-nosplit | assets/segments.js | page | segments | 1.84 KB |
| iife-nosplit | assets/sniff.js | page | shared | 0.99 KB |
| iife-nosplit | assets/stats.js | page | stats | 4.34 KB |
| react | assets/compare.js | page | shared | 1.33 KB |
| react | assets/fallback.js | page | shared | 0.73 KB |
| react | assets/index.js | page | shared | 69.85 KB |
| react | assets/inline.js | page | shared | 0.64 KB |
| react | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| react | assets/isobmff.js | page | isobmff | 12.23 KB |
| react | assets/matroska.js | page | matroska | 11.77 KB |
| react | assets/matroska.js | own.worker | matroska | 11.59 KB |
| react | assets/own.worker.js | own.worker | shared | 4.18 KB |
| react | assets/probe.js | page | shared | 2.90 KB |
| react | assets/result.js | page | shared | 0.38 KB |
| react | assets/rfps.js | page | rfps | 3.58 KB |
| react | assets/rfps.js | own.worker | rfps | 3.58 KB |
| react | assets/runtime.js | page | shared | 2.54 KB |
| react | assets/segments.js | own.worker | segments | 1.84 KB |
| react | assets/segments.js | page | segments | 1.84 KB |
| react | assets/sniff.js | page | shared | 0.99 KB |
| react | assets/stats.js | own.worker | stats | 4.31 KB |
| react | assets/stats.js | page | stats | 4.34 KB |
| react | assets/summary.js | page | summary | 0.43 KB |
| react18 | assets/compare.js | page | shared | 1.32 KB |
| react18 | assets/fallback.js | page | shared | 0.73 KB |
| react18 | assets/index.js | page | shared | 47.25 KB |
| react18 | assets/inline.js | page | shared | 0.63 KB |
| react18 | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| react18 | assets/isobmff.js | page | isobmff | 12.23 KB |
| react18 | assets/matroska.js | own.worker | matroska | 11.59 KB |
| react18 | assets/matroska.js | page | matroska | 11.77 KB |
| react18 | assets/own.worker.js | own.worker | shared | 4.18 KB |
| react18 | assets/probe.js | page | shared | 2.90 KB |
| react18 | assets/result.js | page | shared | 0.38 KB |
| react18 | assets/rfps.js | page | rfps | 3.58 KB |
| react18 | assets/rfps.js | own.worker | rfps | 3.58 KB |
| react18 | assets/runtime.js | page | shared | 2.54 KB |
| react18 | assets/segments.js | page | segments | 1.84 KB |
| react18 | assets/segments.js | own.worker | segments | 1.84 KB |
| react18 | assets/sniff.js | page | shared | 0.99 KB |
| react18 | assets/stats.js | own.worker | stats | 4.31 KB |
| react18 | assets/stats.js | page | stats | 4.34 KB |
| react18 | assets/summary.js | page | summary | 0.43 KB |
| check | assets/compare.js | page | shared | 1.32 KB |
| check | assets/fallback.js | page | shared | 0.73 KB |
| check | assets/index.js | page | shared | 4.70 KB |
| check | assets/inline.js | page | shared | 0.63 KB |
| check | assets/isobmff.js | page | isobmff | 12.23 KB |
| check | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| check | assets/matroska.js | own.worker | matroska | 11.59 KB |
| check | assets/matroska.js | page | matroska | 11.77 KB |
| check | assets/own.worker.js | own.worker | shared | 4.18 KB |
| check | assets/probe.js | page | shared | 2.90 KB |
| check | assets/result.js | page | shared | 0.38 KB |
| check | assets/rfps.js | page | rfps | 3.57 KB |
| check | assets/rfps.js | own.worker | rfps | 3.58 KB |
| check | assets/runtime.js | page | shared | 2.54 KB |
| check | assets/segments.js | page | segments | 1.84 KB |
| check | assets/segments.js | own.worker | segments | 1.84 KB |
| check | assets/sniff.js | page | shared | 0.99 KB |
| check | assets/stats.js | own.worker | stats | 4.31 KB |
| check | assets/stats.js | page | stats | 4.34 KB |
| preset | assets/compare.js | page | shared | 1.33 KB |
| preset | assets/fallback.js | page | shared | 0.73 KB |
| preset | assets/index.js | page | shared | 5.06 KB |
| preset | assets/inline.js | page | shared | 0.63 KB |
| preset | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| preset | assets/isobmff.js | page | isobmff | 12.23 KB |
| preset | assets/matroska.js | own.worker | matroska | 11.59 KB |
| preset | assets/matroska.js | page | matroska | 11.77 KB |
| preset | assets/own.worker.js | own.worker | shared | 4.18 KB |
| preset | assets/probe.js | page | shared | 2.90 KB |
| preset | assets/result.js | page | shared | 0.38 KB |
| preset | assets/rfps.js | page | rfps | 3.57 KB |
| preset | assets/rfps.js | own.worker | rfps | 3.58 KB |
| preset | assets/runtime.js | page | shared | 2.54 KB |
| preset | assets/segments.js | page | segments | 1.84 KB |
| preset | assets/segments.js | own.worker | segments | 1.84 KB |
| preset | assets/sniff.js | page | shared | 0.99 KB |
| preset | assets/stats.js | own.worker | stats | 4.31 KB |
| preset | assets/stats.js | page | stats | 4.34 KB |

