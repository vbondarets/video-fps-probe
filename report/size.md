# Bundle size

Production build in `demo/dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 74.44 KB | 0.56 KB | ok | assets/index-BS7dCM7M.js |
| worker entry (core + glue) | 5.00 KB | 4.24 KB | 0.76 KB | ok | assets/probe.worker-JI49fzTl.js |
| ISO BMFF parser chunk | 13.50 KB | 12.22 KB | 1.28 KB | ok | assets/isobmff-Bas0NL5h.js |
| Matroska parser chunk | 12.00 KB | 11.10 KB | 0.90 KB | ok | assets/matroska-BaXK-QWv.js |
| shared statistics chunk | 5.00 KB | 4.29 KB | 0.71 KB | ok | assets/stats-DuutUuR_.js |
| lazy probe client | 3.50 KB | 2.99 KB | 0.51 KB | ok | assets/probe-D4BdlCRZ.js |
| lazy rVFC fallback | 2.50 KB | 2.20 KB | 0.30 KB | ok | assets/rvfc-DcPgK9v4.js |
| lazy rate profile core (segments) | 2.00 KB | 1.84 KB | 0.16 KB | ok | assets/segments-Cpv1juJQ.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-DoSnlzJo.js |
| initial (main + CSS + worker entry) | 85.00 KB | 80.49 KB | 4.51 KB | ok | assets/index-BS7dCM7M.js, assets/index-UkwvJHuS.css, assets/probe.worker-JI49fzTl.js |
| first MP4 analysis (initial + client + ISO BMFF + shared chunks) | 100.00 KB | 100.00 KB | 0.01 KB | ok | assets/index-BS7dCM7M.js, assets/index-UkwvJHuS.css, assets/probe.worker-JI49fzTl.js, assets/isobmff-Bas0NL5h.js, assets/probe-D4BdlCRZ.js, assets/stats-DuutUuR_.js |
| first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks) | 102.00 KB | 101.84 KB | 0.16 KB | ok | assets/index-BS7dCM7M.js, assets/index-UkwvJHuS.css, assets/probe.worker-JI49fzTl.js, assets/isobmff-Bas0NL5h.js, assets/segments-Cpv1juJQ.js, assets/probe-D4BdlCRZ.js, assets/stats-DuutUuR_.js |
| first Matroska analysis (initial + client + Matroska + shared chunks) | 100.00 KB | 98.87 KB | 1.13 KB | ok | assets/index-BS7dCM7M.js, assets/index-UkwvJHuS.css, assets/probe.worker-JI49fzTl.js, assets/matroska-BaXK-QWv.js, assets/probe-D4BdlCRZ.js, assets/stats-DuutUuR_.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

Request chain check: every static dependency of a parser or engine chunk is already loaded when it is requested, or requested together with it in one Promise.all. The worker runtime requests the statistics chunk together with every lazy engine source (one Promise.all of the source call and that chunk), so it counts as requested with each mp4box and mediabunny chunk. The one exception: an engine chunk may wait for the chunk the engines share when it imports that chunk directly, so the mp4box and mediabunny paths have one extra sequential request. No problems.

## Why these limits

- **main (React + UI)** (75.00 KB): User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed, so there is little room: new UI code has to be lazy. The Vite build log prints a larger figure for the same chunk (its own gzip settings), which can exceed 75 KB; the budget is checked against the level 9 numbers of this script only.
- **worker entry (core + glue)** (5.00 KB): Sniffing, reader, options, the worker runtime and the code the lazy parsers and comparison engines share: the demo custom worker, which serves own, mp4box and mediabunny. Both own parsers are lazy chunks, and the timeline statistics are the shared statistics chunk. Budgeted by entry name: only the probe.worker file counts, and any other worker file fails as unbudgeted, so the demo ships exactly one worker. Re-set when the demo worker entry was renamed from analyze.worker to probe.worker (measured 4.19 KB), and re-checked after the worker runtime started requesting the statistics chunk with every lazy engine source: measured 4.22 KB; limit is measured plus 10 percent, rounded up to 0.5 KB (4.64 to 5 KB). That stays well under the 8.5 KB a consumer custom worker gets, so a regression of about 0.8 KB fails here instead of hiding in that headroom.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.00 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **shared statistics chunk** (5.00 KB): Timeline statistics shared by both own parsers and the comparison engines. The worker requests the chunk in parallel with the first parser, so it is part of every first analysis row. Measured 4.29 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Counts every chunk the parsers share. Not required: when the statistics are part of the worker entry, the worker budget catches them.
- **lazy probe client** (3.50 KB): The probe client fetched by the main chunk on the first file, before the worker starts: the demo probe (probe-*) with createProbeClient, its engine routing, the worker pool and the rVFC descriptor. The fallback chain, compare and the in-thread runner are separate lazy chunks that the first analysis does not load. Counted in every first analysis row. Re-set when the demo moved from the module worker pool (1.04 KB) to the library probe client: measured 2.73 KB; limit is measured plus 10 percent, rounded up to 0.5 KB, which is also the consumer client chunk budget. Not required: without a client chunk the client is part of the main chunk.
- **lazy rVFC fallback** (2.50 KB): Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy rate profile core (segments)** (2.00 KB): Segmentation, anomalies, uneven flag and sparkline buckets. Fetched by the worker only for a timeline with unequal frame rates (VFR), after the parser chunk. Measured 1.79 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into another one, that chunk budget catches the growth.
- **lazy rate profile panel (UI)** (1.50 KB): Sparkline and segment table, fetched by the main chunk (React.lazy) when a result card has a rate profile. Measured 0.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into the main chunk, the main budget catches the growth.
- **initial (main + CSS + worker entry)** (85.00 KB): User-facing goal, unchanged: the page, its styles and the worker entry, before any file is analysed. Nothing else loads without a user action: the device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so it is in neither the initial row nor the first analysis rows. Measured 82.05 KB when set.
- **first MP4 analysis (initial + client + ISO BMFF + shared chunks)** (100.00 KB): User-facing promise: page plus first MP4 or MOV result stays under 100 KB gzip. Measured 93.99 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 3.5 + 5 + 13.5 = 107 KB) add up to more than the promise and this can trip while every component is within its own limit.
- **first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks)** (102.00 KB): User-facing promise: page plus the first MP4 or MOV result with unequal frame rates, which also fetches the rate profile chunk, stays under 100 KB gzip. Accepted by the owner on 2026-10-23 for the demo only: with the library probe client this row does not fit the promise without dropping designed features, so the limit is the measurement rounded up to 0.5 KB. The size promise of the package itself is the consumer size matrix, not this demo row. Measured 101.23 KB: main 74.11, CSS 1.81, worker entry 4.22, probe client 2.74, statistics 4.29, ISO BMFF 12.22 and segments 1.84. Before the package work it measured 97.84 KB: the probe client (engine routing, the worker pool, the rVFC descriptor and the fallback, compare and in-thread hooks) adds 2.74 KB while the main chunk lost 0.65 KB with the old module worker pool, and the statistics split out of the worker entry plus the versioned worker runtime add 1.15 KB. Dropping the module preload polyfill and moving the rVFC checks into its lazy chunk took 0.32 KB back. The first MP4 and first Matroska rows keep the 100 KB promise. With the lazy probe client and the shared statistics chunk, the component limits (85 + 3.5 + 5 + 13.5 + 2 = 109 KB) add up to more than this limit, so it can trip while every component is within its own limit. Raised from 101.5 KB to 102.0 KB on 2026-10-24 by the same rule, for the 0.2.0 fix of a tab left open across a redeploy: the load reason on the probe errors, the pool that waits for a live worker, the reload banner with its deploy check and the retry of a panel chunk that failed to load add 0.76 KB to the 101.23 KB of 0.1.0, and moving the sample file loader out of the main chunk took 0.15 KB back. Measured 101.84 KB. Not required: without a segments chunk the code lives elsewhere and the first MP4 analysis covers it.
- **first Matroska analysis (initial + client + Matroska + shared chunks)** (100.00 KB): User-facing promise: page plus first MKV or WebM result stays under 100 KB gzip. Measured 92.78 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 3.5 + 5 + 12 = 105.5 KB) add up to more than the promise and this can trip while every component is within its own limit.

## Chunks

| File | Kind | Raw | gzip -9 | brotli q11 |
|---|---|---:|---:|---:|
| assets/Compare-jKpwPEiz.js | lazy | 2.88 KB | 1.20 KB | 1.09 KB |
| assets/RateProfile-DoSnlzJo.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/abort-BxutaVbu.js | client-shared | 0.10 KB | 0.11 KB | 0.09 KB |
| assets/compare-CSB8K9jG.js | client-compare | 2.60 KB | 1.32 KB | 1.21 KB |
| assets/counting-C9zpWQvy.js | engine-shared | 3.01 KB | 1.50 KB | 1.35 KB |
| assets/deviceInfo-B3eOjrMK.js | deviceInfo | 5.02 KB | 2.29 KB | 2.02 KB |
| assets/fallback-Dht3Cju3.js | client-fallback | 1.01 KB | 0.64 KB | 0.56 KB |
| assets/index-BS7dCM7M.js | main | 238.72 KB | 74.44 KB | 64.43 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/inline-CkbRpK3v.js | client-inline | 1.09 KB | 0.64 KB | 0.56 KB |
| assets/isobmff-Bas0NL5h.js | isobmff | 30.75 KB | 12.22 KB | 11.01 KB |
| assets/isobmff-DzbGUQd-.js | inline-own | 30.83 KB | 12.23 KB | 11.06 KB |
| assets/matroska-BaXK-QWv.js | matroska | 29.05 KB | 11.10 KB | 10.09 KB |
| assets/matroska-CcKz_9Rd.js | inline-own | 29.17 KB | 11.19 KB | 10.16 KB |
| assets/mediabunny-DsJPin6V.js | mediabunny | 200.80 KB | 52.77 KB | 44.47 KB |
| assets/mp4box-BG14bFog.js | mp4box | 187.64 KB | 43.65 KB | 37.32 KB |
| assets/probe-D4BdlCRZ.js | client | 6.92 KB | 2.99 KB | 2.75 KB |
| assets/probe.worker-JI49fzTl.js | worker | 10.18 KB | 4.24 KB | 3.87 KB |
| assets/result-DwUAyOGs.js | client-shared | 0.71 KB | 0.38 KB | 0.33 KB |
| assets/runtime-uhMG987P.js | inline-own | 5.90 KB | 2.48 KB | 2.28 KB |
| assets/rvfc-DcPgK9v4.js | rvfc | 4.24 KB | 2.20 KB | 1.98 KB |
| assets/samples-C9gKRdrE.js | samples | 0.36 KB | 0.28 KB | 0.24 KB |
| assets/segments-Bow7ompv.js | inline-own | 3.35 KB | 1.84 KB | 1.71 KB |
| assets/segments-Cpv1juJQ.js | segments | 3.35 KB | 1.84 KB | 1.71 KB |
| assets/sniff-DecauIFI.js | client-shared | 2.12 KB | 0.99 KB | 0.89 KB |
| assets/stats-B8mUyXPB.js | inline-own | 10.31 KB | 4.33 KB | 3.96 KB |
| assets/stats-DuutUuR_.js | parser-shared | 10.21 KB | 4.29 KB | 3.92 KB |
| **initial** | main + CSS + worker entry | 253.88 KB | 80.49 KB | 69.83 KB |
| **first MP4 analysis** | initial + client chunk + ISO BMFF chunk + shared chunks | 301.76 KB | 100.00 KB | 87.50 KB |
| **first VFR MP4 analysis** | initial + client chunk + ISO BMFF chunk + segments chunk + shared chunks | 305.11 KB | 101.84 KB | 89.21 KB |
| **first Matroska analysis** | initial + client chunk + Matroska chunk + shared chunks | 300.06 KB | 98.87 KB | 86.59 KB |

