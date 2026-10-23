# Package size matrix

What the package adds to a Vite 8.3.5 app in each configuration, measured by `scripts/size-matrix.mjs` on production builds of the consumer fixtures in `tests/consumers/fixtures/`. Each fixture installs the packed tarball (video-fps-probe-0.0.0.tgz) with mp4box 2.4.1 and mediabunny 1.62.0 into a directory outside the repository, so nothing resolves to the source tree. KB means 1000 bytes; every size is gzip level 9 per file, and totals are sums of files.

The critical path is the package code inside the host entry chunk, cut out of the entry chunk by its hidden sourcemap: what a host pays before any file is picked. Vite adds its preload helper to the entry chunk of any app with a dynamic import; it is listed separately because a host that already code-splits has it anyway. Everything else loads lazily, on the first file or the first engine run.

## Configurations

| Configuration | Imports | Critical path | Entry chunk with the preload helper | First MP4, lazy | All own paths, lazy | Engine chunk | Worker files | Budgets |
|---|---|---:|---:|---:|---:|---:|---:|---|
| default | ./lazy | **0.67 KB** | 1.40 KB | 23.26 KB | 36.24 KB | - | 1 (own.worker) | ok |
| custom | ./client/lazy + host worker | **0.68 KB** | 1.47 KB | 23.15 KB | 36.13 KB | - | 1 (fps.worker) | ok |
| mp4box | ./lazy + ./mp4box | **0.90 KB** | 1.75 KB | 23.29 KB | 36.27 KB | mp4box 44.77 KB | 2 (mp4box.worker, own.worker) | ok |
| mediabunny | ./lazy + ./mediabunny | **0.90 KB** | 1.75 KB | 23.29 KB | 36.27 KB | mediabunny 53.87 KB | 2 (mediabunny.worker, own.worker) | ok |
| rvfc | ./lazy + ./rvfc | **0.77 KB** | 1.59 KB | 23.27 KB | 36.26 KB | rVFC 2.19 KB | 1 (own.worker) | ok |
| all | ./lazy + ./mp4box + ./mediabunny + ./rvfc | **1.02 KB** | 1.92 KB | 23.31 KB | 36.29 KB | mp4box 44.77 KB, mediabunny 53.87 KB, rVFC 2.19 KB | 3 (mediabunny.worker, mp4box.worker, own.worker) | ok |
| iife-nosplit | ./lazy, worker format iife with codeSplitting false | **0.67 KB** | 1.40 KB | 34.77 KB | - | - | 1 (own.worker) | ok |
| standalone worker file | video-fps-probe/standalone/own.worker.js | - | - | 32.04 KB | 32.04 KB | - | 1 file, no imports | ok |

First MP4: the probe client, the worker entry that serves own, the statistics chunk (requested in parallel with the parser) and the ISO BMFF parser. All own paths adds the Matroska parser and the rate profile core. In iife-nosplit the worker is one file, so both columns are the client plus that file.

## Budgets (gzip)

| Configuration | Budget | Limit | Actual | Headroom | Status |
|---|---|---:|---:|---:|---|
| default | critical path (package code in the entry chunk) | 1.00 KB | 0.67 KB | 0.33 KB | ok |
| default | probe client (lazy) | 3.00 KB | 2.67 KB | 0.34 KB | ok |
| default | own.worker entry | 4.50 KB | 4.08 KB | 0.42 KB | ok |
| default | ISO BMFF parser (in the own worker) | 13.50 KB | 12.21 KB | 1.29 KB | ok |
| default | Matroska parser (in the own worker) | 12.50 KB | 11.14 KB | 1.36 KB | ok |
| default | rate profile core (in the own worker) | 2.50 KB | 1.84 KB | 0.66 KB | ok |
| default | first MP4 analysis, lazy total | 24.00 KB | 23.26 KB | 0.74 KB | ok |
| default | all own paths, lazy total | 40.00 KB | 36.24 KB | 3.76 KB | ok |
| custom | critical path (package code in the entry chunk) | 1.00 KB | 0.68 KB | 0.32 KB | ok |
| custom | fps.worker entry | 4.50 KB | 4.08 KB | 0.42 KB | ok |
| mp4box | critical path (package code in the entry chunk) | 1.00 KB | 0.90 KB | 0.10 KB | ok |
| mp4box | mp4box.worker entry | 5.00 KB | 4.22 KB | 0.78 KB | ok |
| mp4box | mp4box engine chunk | 49.50 KB | 44.77 KB | 4.73 KB | ok |
| mp4box | shared engine chunk | 2.00 KB | - | - | not built |
| mediabunny | critical path (package code in the entry chunk) | 1.00 KB | 0.90 KB | 0.10 KB | ok |
| mediabunny | mediabunny.worker entry | 5.00 KB | 4.12 KB | 0.88 KB | ok |
| mediabunny | mediabunny engine chunk | 59.50 KB | 53.87 KB | 5.63 KB | ok |
| mediabunny | shared engine chunk | 2.00 KB | - | - | not built |
| rvfc | critical path (package code in the entry chunk) | 1.00 KB | 0.77 KB | 0.23 KB | ok |
| rvfc | rVFC engine (main thread) | 2.50 KB | 2.19 KB | 0.31 KB | ok |
| all | critical path (package code in the entry chunk) | 1.50 KB | 1.02 KB | 0.48 KB | ok |
| all | probe client (lazy) | 3.00 KB | 2.71 KB | 0.29 KB | ok |
| all | own.worker entry | 4.50 KB | 4.08 KB | 0.42 KB | ok |
| all | mp4box.worker entry | 5.00 KB | 4.22 KB | 0.78 KB | ok |
| all | mediabunny.worker entry | 5.00 KB | 4.12 KB | 0.88 KB | ok |
| all | mp4box engine chunk | 49.50 KB | 44.77 KB | 4.73 KB | ok |
| all | mediabunny engine chunk | 59.50 KB | 53.87 KB | 5.63 KB | ok |
| all | rVFC engine (main thread) | 2.50 KB | 2.19 KB | 0.31 KB | ok |
| all | first MP4 analysis, lazy total | 24.00 KB | 23.31 KB | 0.69 KB | ok |
| iife-nosplit | critical path (package code in the entry chunk) | 1.00 KB | 0.67 KB | 0.33 KB | ok |
| iife-nosplit | own.worker entry | 35.50 KB | 32.11 KB | 3.39 KB | ok |
| standalone | own.worker.js | 35.50 KB | 32.04 KB | 3.46 KB | ok |

## Checks

- **default**: worker files own.worker (4 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/`, `video-fps-probe/dist/engines/` appears in any sourcemap; request chains ok.
- **custom**: worker files fps.worker (4 lazy chunks); none of `video-fps-probe/dist/plugins/own.js`, `video-fps-probe/dist/worker/own.worker.js`, `node_modules/mp4box/`, `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **mp4box**: worker files mp4box.worker (5 lazy chunks), own.worker (4 lazy chunks); none of `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **mediabunny**: worker files mediabunny.worker (5 lazy chunks), own.worker (4 lazy chunks); none of `node_modules/mp4box/` appears in any sourcemap; request chains ok.
- **rvfc**: worker files own.worker (4 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/` appears in any sourcemap; request chains ok.
- **all**: worker files mediabunny.worker (5 lazy chunks), mp4box.worker (5 lazy chunks), own.worker (4 lazy chunks); none of (no patterns) appears in any sourcemap; request chains ok.
- **iife-nosplit**: worker files own.worker (0 lazy chunks); none of `node_modules/mp4box/`, `node_modules/mediabunny/` appears in any sourcemap; request chains ok.

Must-not-exist reads the `sources` of every hidden sourcemap, because minified identifiers are renamed. The request chain check is the one in `scripts/size-report.mjs`: every static dependency of a parser or engine chunk is already loaded, or requested in the same Promise.all.

## Why these limits

- **default, critical path (package code in the entry chunk)** (1.00 KB): User-facing promise of the package, accepted by the owner on 2026-10-23 when the demo budget moved to 101.5 KB: the default configuration adds at most 1 KB to the critical path and the first MP4 loads at most 24 KB lazily. This row is the first half: the package code in the host entry chunk (the lazyProbe stub, ProbeError and the engine list), cut out of the entry chunk by its sourcemap. Vite's preload helper is not counted, because every Vite app with a dynamic import already has it. Design estimate 1.0 KB; measured 0.67 KB, and measured plus 10 percent rounded up to 0.5 KB is also 1.0 KB.
- **default, probe client (lazy)** (3.00 KB): The probe client fetched on the first file: createProbe, engine routing, the worker pool and the own descriptor with the worker literal. Design estimate 3.5 KB; measured 2.67 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, own.worker entry** (4.50 KB): The prebuilt own worker entry: reader, sniffing, options and the worker runtime. Both parsers and the statistics are lazy chunks of this worker. Design estimate 8.0 KB; measured 4.08 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, ISO BMFF parser (in the own worker)** (13.50 KB): The own MP4 and MOV parser chunk of the own worker. Design estimate 13.5 KB; measured 12.21 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, Matroska parser (in the own worker)** (12.50 KB): The own Matroska and WebM parser chunk of the own worker. Design estimate 12.0 KB; measured 11.14 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, rate profile core (in the own worker)** (2.50 KB): The rate profile core of the own worker, fetched only for a timeline with unequal frame rates. Design estimate 2.0 KB; measured 1.84 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **default, first MP4 analysis, lazy total** (24.00 KB): User-facing promise of the package, accepted by the owner on 2026-10-23 when the demo budget moved to 101.5 KB: the default configuration adds at most 1 KB to the critical path and the first MP4 loads at most 24 KB lazily. This row is the second half: everything the first MP4 or MOV file loads lazily, which is the probe client, the own worker entry, the statistics chunk (requested in parallel with the parser) and the ISO BMFF parser. Measured 23.26 KB. Measured plus 10 percent would be 26.0 KB, so the promise stays the limit instead: it is the tighter one and it is what the README states.
- **default, all own paths, lazy total** (40.00 KB): Every own path: the probe client, the own worker entry, the statistics, both parsers and the rate profile core. Design estimate 37.0 KB; measured 36.24 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **custom, critical path (package code in the entry chunk)** (1.00 KB): The lazyProbeClient stub in the host entry chunk. The host's worker literal is host code and is not counted. Design estimate 1.0 KB; measured 0.68 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **custom, fps.worker entry** (4.50 KB): The host worker built from video-fps-probe/worker-runtime, serving own only. Design estimate 8.5 KB; measured 4.08 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, critical path (package code in the entry chunk)** (1.00 KB): The default trigger plus the mp4box descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, mp4box.worker entry** (5.00 KB): The prebuilt mp4box worker entry, which serves own and mp4box. Design estimate 8.5 KB; measured 4.22 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, mp4box engine chunk** (49.50 KB): The mp4box.js engine chunk of the mp4box worker: the mp4box library, the adapter and the counting code the engines share. Design estimate 48.0 KB; measured 44.77 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mp4box, shared engine chunk** (2.00 KB): Code the comparison engines share, when it is a chunk of its own. Not built: each prebuilt engine worker serves one comparison engine, so this code is part of the engine chunk. The design estimate of 2.0 KB stays the limit, so a split that grows it is caught.
- **mediabunny, critical path (package code in the entry chunk)** (1.00 KB): The default trigger plus the mediabunny descriptor and its worker literal. Design estimate the default plus 0.5 KB; measured 0.90 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, mediabunny.worker entry** (5.00 KB): The prebuilt mediabunny worker entry, which serves own and mediabunny. Measured 4.12 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, mediabunny engine chunk** (59.50 KB): The mediabunny engine chunk of the mediabunny worker, with the counting code the engines share. Design estimate 58.0 KB; measured 53.87 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **mediabunny, shared engine chunk** (2.00 KB): Code the comparison engines share, when it is a chunk of its own. Not built, for the same reason as in the mp4box configuration. The design estimate of 2.0 KB stays the limit.
- **rvfc, critical path (package code in the entry chunk)** (1.00 KB): The default trigger plus the rvfc descriptor, which has no worker literal. Measured 0.77 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **rvfc, rVFC engine (main thread)** (2.50 KB): The requestVideoFrameCallback engine, a main-thread chunk loaded on its first run. Design estimate 2.5 KB; measured 2.19 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, critical path (package code in the entry chunk)** (1.50 KB): The default trigger plus the mp4box, mediabunny and rvfc descriptors. Measured 1.02 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, probe client (lazy)** (3.00 KB): As in the default configuration. Measured 2.71 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, own.worker entry** (4.50 KB): As in the default configuration. Measured 4.08 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mp4box.worker entry** (5.00 KB): As in the mp4box configuration. Measured 4.22 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mediabunny.worker entry** (5.00 KB): As in the mediabunny configuration. Measured 4.12 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mp4box engine chunk** (49.50 KB): As in the mp4box configuration. Measured 44.77 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, mediabunny engine chunk** (59.50 KB): As in the mediabunny configuration. Measured 53.87 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, rVFC engine (main thread)** (2.50 KB): As in the rvfc configuration. Measured 2.19 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **all, first MP4 analysis, lazy total** (24.00 KB): Registering engines must not change what the first own analysis loads, so the 24 KB promise of the default configuration applies here too. Measured 23.31 KB.
- **iife-nosplit, critical path (package code in the entry chunk)** (1.00 KB): As in the default configuration. Measured 0.67 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **iife-nosplit, own.worker entry** (35.50 KB): With worker.format iife and codeSplitting false the own worker is one file: both parsers, the statistics and the rate profile core are inlined. Design estimate 35.0 KB; measured 32.11 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.
- **standalone, own.worker.js** (35.50 KB): dist/standalone/own.worker.js: the own worker as one minified IIFE file with no imports, built by rolldown. Design estimate 35.0 KB; measured 32.04 KB. The limit is the first measurement from the packed tarball plus 10 percent, rounded up to 0.5 KB.

## Files

| Configuration | File | Runs in | Holds | gzip -9 |
|---|---|---|---|---:|
| default | assets/compare.js | page | shared | 1.31 KB |
| default | assets/fallback.js | page | shared | 0.62 KB |
| default | assets/index.js | page | shared | 1.40 KB |
| default | assets/inline.js | page | shared | 0.59 KB |
| default | assets/isobmff.js | page | isobmff | 12.23 KB |
| default | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| default | assets/matroska.js | page | matroska | 11.19 KB |
| default | assets/matroska.js | own.worker | matroska | 11.14 KB |
| default | assets/own.worker.js | own.worker | shared | 4.08 KB |
| default | assets/probe.js | page | shared | 2.67 KB |
| default | assets/result.js | page | shared | 0.38 KB |
| default | assets/runtime.js | page | shared | 2.47 KB |
| default | assets/segments.js | page | segments | 1.84 KB |
| default | assets/segments.js | own.worker | segments | 1.84 KB |
| default | assets/sniff.js | page | shared | 0.99 KB |
| default | assets/stats.js | own.worker | stats | 4.31 KB |
| default | assets/stats.js | page | stats | 4.33 KB |
| custom | assets/compare.js | page | shared | 1.31 KB |
| custom | assets/fallback.js | page | shared | 0.62 KB |
| custom | assets/fps.worker.js | fps.worker | shared | 4.08 KB |
| custom | assets/index.js | page | shared | 1.47 KB |
| custom | assets/inline.js | page | shared | 0.59 KB |
| custom | assets/isobmff.js | fps.worker | isobmff | 12.21 KB |
| custom | assets/isobmff.js | page | isobmff | 12.23 KB |
| custom | assets/matroska.js | fps.worker | matroska | 11.14 KB |
| custom | assets/matroska.js | page | matroska | 11.19 KB |
| custom | assets/probe.js | page | shared | 2.56 KB |
| custom | assets/result.js | page | shared | 0.38 KB |
| custom | assets/runtime.js | page | shared | 2.47 KB |
| custom | assets/segments.js | page | segments | 1.84 KB |
| custom | assets/segments.js | fps.worker | segments | 1.84 KB |
| custom | assets/sniff.js | page | shared | 0.99 KB |
| custom | assets/stats.js | page | stats | 4.33 KB |
| custom | assets/stats.js | fps.worker | stats | 4.30 KB |
| mp4box | assets/compare.js | page | shared | 1.31 KB |
| mp4box | assets/fallback.js | page | shared | 0.62 KB |
| mp4box | assets/index.js | page | shared | 1.75 KB |
| mp4box | assets/inline.js | page | shared | 0.59 KB |
| mp4box | assets/isobmff.js | page | isobmff | 12.22 KB |
| mp4box | assets/isobmff.js | mp4box.worker | isobmff | 12.26 KB |
| mp4box | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| mp4box | assets/matroska.js | page | matroska | 11.19 KB |
| mp4box | assets/matroska.js | mp4box.worker | matroska | 11.13 KB |
| mp4box | assets/matroska.js | own.worker | matroska | 11.14 KB |
| mp4box | assets/mp4box.js | mp4box.worker | mp4box | 44.77 KB |
| mp4box | assets/mp4box.js | page | mp4box | 44.78 KB |
| mp4box | assets/mp4box.worker.js | mp4box.worker | shared | 4.22 KB |
| mp4box | assets/options.js | page | shared | 0.37 KB |
| mp4box | assets/own.worker.js | own.worker | shared | 4.08 KB |
| mp4box | assets/probe.js | page | shared | 2.70 KB |
| mp4box | assets/reader.js | page | shared | 1.45 KB |
| mp4box | assets/result.js | page | shared | 0.38 KB |
| mp4box | assets/runtime.js | page | shared | 1.04 KB |
| mp4box | assets/segments.js | page | segments | 1.84 KB |
| mp4box | assets/segments.js | own.worker | segments | 1.84 KB |
| mp4box | assets/segments.js | mp4box.worker | segments | 1.84 KB |
| mp4box | assets/sniff.js | page | shared | 0.99 KB |
| mp4box | assets/stats.js | mp4box.worker | stats | 4.31 KB |
| mp4box | assets/stats.js | own.worker | stats | 4.31 KB |
| mp4box | assets/stats.js | page | stats | 4.33 KB |
| mediabunny | assets/abort.js | page | shared | 0.11 KB |
| mediabunny | assets/compare.js | page | shared | 1.31 KB |
| mediabunny | assets/fallback.js | page | shared | 0.62 KB |
| mediabunny | assets/index.js | page | shared | 1.75 KB |
| mediabunny | assets/inline.js | page | shared | 0.59 KB |
| mediabunny | assets/isobmff.js | mediabunny.worker | isobmff | 12.21 KB |
| mediabunny | assets/isobmff.js | page | isobmff | 12.23 KB |
| mediabunny | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| mediabunny | assets/matroska.js | page | matroska | 11.19 KB |
| mediabunny | assets/matroska.js | own.worker | matroska | 11.14 KB |
| mediabunny | assets/matroska.js | mediabunny.worker | matroska | 11.14 KB |
| mediabunny | assets/mediabunny.js | page | mediabunny | 52.94 KB |
| mediabunny | assets/mediabunny.js | mediabunny.worker | mediabunny | 53.87 KB |
| mediabunny | assets/mediabunny.worker.js | mediabunny.worker | shared | 4.12 KB |
| mediabunny | assets/options.js | page | shared | 0.37 KB |
| mediabunny | assets/own.worker.js | own.worker | shared | 4.08 KB |
| mediabunny | assets/probe.js | page | shared | 2.70 KB |
| mediabunny | assets/result.js | page | shared | 0.38 KB |
| mediabunny | assets/runtime.js | page | shared | 2.21 KB |
| mediabunny | assets/segments.js | page | segments | 1.84 KB |
| mediabunny | assets/segments.js | own.worker | segments | 1.84 KB |
| mediabunny | assets/segments.js | mediabunny.worker | segments | 1.84 KB |
| mediabunny | assets/sniff.js | page | shared | 0.99 KB |
| mediabunny | assets/stats.js | mediabunny.worker | stats | 4.32 KB |
| mediabunny | assets/stats.js | own.worker | stats | 4.31 KB |
| mediabunny | assets/stats.js | page | stats | 4.34 KB |
| rvfc | assets/abort.js | page | shared | 0.11 KB |
| rvfc | assets/compare.js | page | shared | 1.31 KB |
| rvfc | assets/fallback.js | page | shared | 0.62 KB |
| rvfc | assets/index.js | page | shared | 1.59 KB |
| rvfc | assets/inline.js | page | shared | 0.59 KB |
| rvfc | assets/isobmff.js | page | isobmff | 12.23 KB |
| rvfc | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| rvfc | assets/matroska.js | own.worker | matroska | 11.14 KB |
| rvfc | assets/matroska.js | page | matroska | 11.19 KB |
| rvfc | assets/own.worker.js | own.worker | shared | 4.08 KB |
| rvfc | assets/probe.js | page | shared | 2.68 KB |
| rvfc | assets/result.js | page | shared | 0.38 KB |
| rvfc | assets/runtime.js | page | shared | 2.46 KB |
| rvfc | assets/rvfc.js | page | rvfc | 2.19 KB |
| rvfc | assets/segments.js | own.worker | segments | 1.84 KB |
| rvfc | assets/segments.js | page | segments | 1.84 KB |
| rvfc | assets/sniff.js | page | shared | 0.99 KB |
| rvfc | assets/stats.js | page | stats | 4.33 KB |
| rvfc | assets/stats.js | own.worker | stats | 4.31 KB |
| all | assets/abort.js | page | shared | 0.11 KB |
| all | assets/compare.js | page | shared | 1.31 KB |
| all | assets/counting.js | page | engineShared | 1.51 KB |
| all | assets/fallback.js | page | shared | 0.62 KB |
| all | assets/index.js | page | shared | 1.92 KB |
| all | assets/inline.js | page | shared | 0.59 KB |
| all | assets/isobmff.js | mediabunny.worker | isobmff | 12.21 KB |
| all | assets/isobmff.js | mp4box.worker | isobmff | 12.26 KB |
| all | assets/isobmff.js | page | isobmff | 12.22 KB |
| all | assets/isobmff.js | own.worker | isobmff | 12.21 KB |
| all | assets/matroska.js | mp4box.worker | matroska | 11.13 KB |
| all | assets/matroska.js | own.worker | matroska | 11.14 KB |
| all | assets/matroska.js | page | matroska | 11.19 KB |
| all | assets/matroska.js | mediabunny.worker | matroska | 11.14 KB |
| all | assets/mediabunny.js | mediabunny.worker | mediabunny | 53.87 KB |
| all | assets/mediabunny.js | page | mediabunny | 51.97 KB |
| all | assets/mediabunny.worker.js | mediabunny.worker | shared | 4.12 KB |
| all | assets/mp4box.js | mp4box.worker | mp4box | 44.77 KB |
| all | assets/mp4box.js | page | mp4box | 43.75 KB |
| all | assets/mp4box.worker.js | mp4box.worker | shared | 4.22 KB |
| all | assets/options.js | page | shared | 0.37 KB |
| all | assets/own.worker.js | own.worker | shared | 4.08 KB |
| all | assets/probe.js | page | shared | 2.71 KB |
| all | assets/reader.js | page | shared | 1.43 KB |
| all | assets/result.js | page | shared | 0.38 KB |
| all | assets/runtime.js | page | shared | 1.06 KB |
| all | assets/rvfc.js | page | rvfc | 2.19 KB |
| all | assets/segments.js | page | segments | 1.84 KB |
| all | assets/segments.js | own.worker | segments | 1.84 KB |
| all | assets/segments.js | mediabunny.worker | segments | 1.84 KB |
| all | assets/segments.js | mp4box.worker | segments | 1.84 KB |
| all | assets/sniff.js | page | shared | 0.99 KB |
| all | assets/stats.js | mp4box.worker | stats | 4.31 KB |
| all | assets/stats.js | mediabunny.worker | stats | 4.32 KB |
| all | assets/stats.js | own.worker | stats | 4.31 KB |
| all | assets/stats.js | page | stats | 4.34 KB |
| iife-nosplit | assets/compare.js | page | shared | 1.31 KB |
| iife-nosplit | assets/fallback.js | page | shared | 0.62 KB |
| iife-nosplit | assets/index.js | page | shared | 1.40 KB |
| iife-nosplit | assets/inline.js | page | shared | 0.60 KB |
| iife-nosplit | assets/isobmff.js | page | isobmff | 12.23 KB |
| iife-nosplit | assets/matroska.js | page | matroska | 11.19 KB |
| iife-nosplit | assets/own.worker.js | own.worker | isobmff | 32.11 KB |
| iife-nosplit | assets/probe.js | page | shared | 2.67 KB |
| iife-nosplit | assets/result.js | page | shared | 0.38 KB |
| iife-nosplit | assets/runtime.js | page | shared | 2.47 KB |
| iife-nosplit | assets/segments.js | page | segments | 1.84 KB |
| iife-nosplit | assets/sniff.js | page | shared | 0.99 KB |
| iife-nosplit | assets/stats.js | page | stats | 4.33 KB |

