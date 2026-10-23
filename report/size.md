# Bundle size

Production build in `demo/dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 74.02 KB | 0.98 KB | ok | assets/index-6J-WkQwu.js |
| worker entry (core + glue) | 5.00 KB | 4.20 KB | 0.80 KB | ok | assets/probe.worker-C1o-MVK3.js |
| ISO BMFF parser chunk | 13.50 KB | 12.22 KB | 1.28 KB | ok | assets/isobmff-dafJFW1e.js |
| Matroska parser chunk | 12.00 KB | 11.10 KB | 0.91 KB | ok | assets/matroska-DHB5JXpt.js |
| shared statistics chunk | 5.00 KB | 4.29 KB | 0.71 KB | ok | assets/stats-B2P8SpMe.js |
| lazy probe client | 3.50 KB | 2.66 KB | 0.84 KB | ok | assets/probe-DW2AHwN1.js |
| lazy rVFC fallback | 2.50 KB | 2.12 KB | 0.38 KB | ok | assets/rvfc-DGuO1CtL.js |
| lazy rate profile core (segments) | 2.00 KB | 1.84 KB | 0.15 KB | ok | assets/segments-CltrQ3Y4.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-BiDcN0yQ.js |
| initial (main + CSS + worker entry) | 85.00 KB | 80.03 KB | 4.97 KB | ok | assets/index-6J-WkQwu.js, assets/index-UkwvJHuS.css, assets/probe.worker-C1o-MVK3.js |
| first MP4 analysis (initial + client + ISO BMFF + shared chunks) | 100.00 KB | 99.21 KB | 0.79 KB | ok | assets/index-6J-WkQwu.js, assets/index-UkwvJHuS.css, assets/probe.worker-C1o-MVK3.js, assets/isobmff-dafJFW1e.js, assets/probe-DW2AHwN1.js, assets/stats-B2P8SpMe.js |
| first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks) | 102.00 KB | 101.05 KB | 0.95 KB | ok | assets/index-6J-WkQwu.js, assets/index-UkwvJHuS.css, assets/probe.worker-C1o-MVK3.js, assets/isobmff-dafJFW1e.js, assets/segments-CltrQ3Y4.js, assets/probe-DW2AHwN1.js, assets/stats-B2P8SpMe.js |
| first Matroska analysis (initial + client + Matroska + shared chunks) | 100.00 KB | 98.08 KB | 1.92 KB | ok | assets/index-6J-WkQwu.js, assets/index-UkwvJHuS.css, assets/probe.worker-C1o-MVK3.js, assets/matroska-DHB5JXpt.js, assets/probe-DW2AHwN1.js, assets/stats-B2P8SpMe.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

Request chain check: every static dependency of a parser or engine chunk is already loaded when it is requested, or requested together with it in one Promise.all. The one exception: an engine chunk may wait for the chunk the engines share when it imports that chunk directly, so the mp4box and mediabunny paths have one extra sequential request. No problems.

## Why these limits

- **main (React + UI)** (75.00 KB): User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed, so there is little room: new UI code has to be lazy. The Vite build log prints a larger figure for the same chunk (its own gzip settings), which can exceed 75 KB; the budget is checked against the level 9 numbers of this script only.
- **worker entry (core + glue)** (5.00 KB): Sniffing, reader, options, the worker runtime and the code the lazy parsers and comparison engines share: the demo custom worker, which serves own, mp4box and mediabunny. Both own parsers are lazy chunks, and the timeline statistics are the shared statistics chunk. Budgeted by entry name: only the probe.worker file counts, and any other worker file fails as unbudgeted, so the demo ships exactly one worker. Re-set when the demo worker entry was renamed from analyze.worker to probe.worker: measured 4.19 KB; limit is measured plus 10 percent, rounded up to 0.5 KB, under the 8.5 KB a consumer custom worker gets.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.00 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **shared statistics chunk** (5.00 KB): Timeline statistics shared by both own parsers and the comparison engines. The worker requests the chunk in parallel with the first parser, so it is part of every first analysis row. Measured 4.29 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Counts every chunk the parsers share. Not required: when the statistics are part of the worker entry, the worker budget catches them.
- **lazy probe client** (3.50 KB): The probe client fetched by the main chunk on the first file, before the worker starts: the demo probe (probe-*) with createProbeClient, its engine routing, the worker pool and the rVFC descriptor. The fallback chain, compare and the in-thread runner are separate lazy chunks that the first analysis does not load. Counted in every first analysis row. Re-set when the demo moved from the module worker pool (1.04 KB) to the library probe client: measured 2.73 KB; limit is measured plus 10 percent, rounded up to 0.5 KB, which is also the consumer client chunk budget. Not required: without a client chunk the client is part of the main chunk.
- **lazy rVFC fallback** (2.50 KB): Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy rate profile core (segments)** (2.00 KB): Segmentation, anomalies, uneven flag and sparkline buckets. Fetched by the worker only for a timeline with unequal frame rates (VFR), after the parser chunk. Measured 1.79 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into another one, that chunk budget catches the growth.
- **lazy rate profile panel (UI)** (1.50 KB): Sparkline and segment table, fetched by the main chunk (React.lazy) when a result card has a rate profile. Measured 0.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into the main chunk, the main budget catches the growth.
- **initial (main + CSS + worker entry)** (85.00 KB): User-facing goal, unchanged: the page, its styles and the worker entry, before any file is analysed. Nothing else loads without a user action: the device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so it is in neither the initial row nor the first analysis rows. Measured 82.05 KB when set.
- **first MP4 analysis (initial + client + ISO BMFF + shared chunks)** (100.00 KB): User-facing promise: page plus first MP4 or MOV result stays under 100 KB gzip. Measured 93.99 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 3.5 + 5 + 13.5 = 107 KB) add up to more than the promise and this can trip while every component is within its own limit.
- **first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks)** (102.00 KB): Page plus the first MP4 or MOV result with unequal frame rates, which also fetches the rate profile chunk. Measured 96.41 KB when set at 100 KB, and 99.96 KB before the demo moved to the library probe client. The client grew the first analysis rows by 1.5 to 1.7 KB (engine routing, fallback, prewarm and the compare and in-thread hooks on top of the worker pool), so this row measured 101.48 KB and the limit was raised to 102 KB, the measurement rounded up to the next whole KB. The first MP4 and first Matroska rows keep the 100 KB promise. With the lazy probe client and the shared statistics chunk, the component limits (85 + 3.5 + 5 + 13.5 + 2 = 109 KB) add up to more than this limit, so it can trip while every component is within its own limit. Not required: without a segments chunk the code lives elsewhere and the first MP4 analysis covers it.
- **first Matroska analysis (initial + client + Matroska + shared chunks)** (100.00 KB): User-facing promise: page plus first MKV or WebM result stays under 100 KB gzip. Measured 92.78 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 3.5 + 5 + 12 = 105.5 KB) add up to more than the promise and this can trip while every component is within its own limit.

## Chunks

| File | Kind | Raw | gzip -9 | brotli q11 |
|---|---|---:|---:|---:|
| assets/Compare-HsmRm0Xx.js | lazy | 2.88 KB | 1.21 KB | 1.09 KB |
| assets/RateProfile-BiDcN0yQ.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/compare-BZysSL04.js | client-compare | 2.57 KB | 1.31 KB | 1.19 KB |
| assets/counting-r6OebIZA.js | engine-shared | 3.01 KB | 1.50 KB | 1.35 KB |
| assets/deviceInfo-BoHFvMfb.js | deviceInfo | 4.83 KB | 2.24 KB | 1.96 KB |
| assets/fallback-DheaNlVS.js | client-fallback | 0.98 KB | 0.62 KB | 0.54 KB |
| assets/index-6J-WkQwu.js | main | 237.32 KB | 74.02 KB | 64.08 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/inline-B5FvZC5N.js | client-inline | 3.07 KB | 1.48 KB | 1.33 KB |
| assets/isobmff-dafJFW1e.js | isobmff | 30.75 KB | 12.22 KB | 11.04 KB |
| assets/matroska-DHB5JXpt.js | matroska | 29.05 KB | 11.10 KB | 10.09 KB |
| assets/mediabunny-DxV2spuW.js | mediabunny | 200.82 KB | 52.78 KB | 44.45 KB |
| assets/mp4box-U2EMRXIA.js | mp4box | 187.64 KB | 43.65 KB | 37.29 KB |
| assets/probe-DW2AHwN1.js | client | 6.14 KB | 2.66 KB | 2.45 KB |
| assets/probe.worker-C1o-MVK3.js | worker | 10.20 KB | 4.20 KB | 3.83 KB |
| assets/result-DwUAyOGs.js | client-shared | 0.71 KB | 0.38 KB | 0.33 KB |
| assets/rvfc-DGuO1CtL.js | rvfc | 4.06 KB | 2.12 KB | 1.92 KB |
| assets/segments-CltrQ3Y4.js | segments | 3.35 KB | 1.84 KB | 1.71 KB |
| assets/stats-B2P8SpMe.js | parser-shared | 10.21 KB | 4.29 KB | 3.92 KB |
| **initial** | main + CSS + worker entry | 252.50 KB | 80.03 KB | 69.43 KB |
| **first MP4 analysis** | initial + client chunk + ISO BMFF chunk + shared chunks | 299.60 KB | 99.21 KB | 86.85 KB |
| **first VFR MP4 analysis** | initial + client chunk + ISO BMFF chunk + segments chunk + shared chunks | 302.95 KB | 101.05 KB | 88.56 KB |
| **first Matroska analysis** | initial + client chunk + Matroska chunk + shared chunks | 297.90 KB | 98.08 KB | 85.89 KB |

