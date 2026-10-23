# Bundle size

Production build in `dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 74.51 KB | 0.49 KB | ok | assets/index-iPztWNxU.js |
| worker entry (core + glue) | 8.50 KB | 4.19 KB | 4.31 KB | ok | assets/analyze.worker-DrqORr30.js |
| ISO BMFF parser chunk | 13.50 KB | 12.22 KB | 1.28 KB | ok | assets/isobmff-Cxb7e5cV.js |
| Matroska parser chunk | 12.00 KB | 11.09 KB | 0.91 KB | ok | assets/matroska-CO4PMVKC.js |
| shared statistics chunk | 5.00 KB | 4.29 KB | 0.71 KB | ok | assets/stats-DHflr_nu.js |
| lazy probe client | 1.50 KB | 1.09 KB | 0.41 KB | ok | assets/pool-wUPLe10P.js |
| lazy rVFC fallback | 2.50 KB | 1.99 KB | 0.51 KB | ok | assets/rvfc-CmLx9V9F.js |
| lazy rate profile core (segments) | 2.00 KB | 1.84 KB | 0.16 KB | ok | assets/segments-OJFPgdZE.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-ZWiafoEd.js |
| initial (main + CSS + worker entry) | 85.00 KB | 80.52 KB | 4.49 KB | ok | assets/analyze.worker-DrqORr30.js, assets/index-UkwvJHuS.css, assets/index-iPztWNxU.js |
| first MP4 analysis (initial + client + ISO BMFF + shared chunks) | 100.00 KB | 98.12 KB | 1.88 KB | ok | assets/analyze.worker-DrqORr30.js, assets/index-UkwvJHuS.css, assets/index-iPztWNxU.js, assets/isobmff-Cxb7e5cV.js, assets/pool-wUPLe10P.js, assets/stats-DHflr_nu.js |
| first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks) | 100.00 KB | 99.96 KB | 0.04 KB | ok | assets/analyze.worker-DrqORr30.js, assets/index-UkwvJHuS.css, assets/index-iPztWNxU.js, assets/isobmff-Cxb7e5cV.js, assets/segments-OJFPgdZE.js, assets/pool-wUPLe10P.js, assets/stats-DHflr_nu.js |
| first Matroska analysis (initial + client + Matroska + shared chunks) | 100.00 KB | 96.99 KB | 3.01 KB | ok | assets/analyze.worker-DrqORr30.js, assets/index-UkwvJHuS.css, assets/index-iPztWNxU.js, assets/matroska-CO4PMVKC.js, assets/pool-wUPLe10P.js, assets/stats-DHflr_nu.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

Request chain check: every static dependency of a parser or engine chunk is already loaded when it is requested, or requested together with it in one Promise.all. The one exception: an engine chunk may wait for the chunk the engines share when it imports that chunk directly, so the mp4box and mediabunny paths have one extra sequential request. No problems.

## Why these limits

- **main (React + UI)** (75.00 KB): User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed, so there is little room: new UI code has to be lazy. The Vite build log prints a larger figure for the same chunk (its own gzip settings), which can exceed 75 KB; the budget is checked against the level 9 numbers of this script only.
- **worker entry (core + glue)** (8.50 KB): Sniffing, reader, options, the worker runtime and the code the lazy parsers and comparison engines share. Both own parsers are lazy chunks, and the timeline statistics are the shared statistics chunk. Budgeted by entry name: only the analyze.worker file counts, and any other worker file fails as unbudgeted. Re-set once before the package work: measured 7.37 KB with 0.13 KB of headroom left, while loading the statistics module next to each parser and the worker runtime (versioned protocol, warm requests, per-engine container gate) both grow this entry. Limit is that measurement plus 10 percent, rounded up to 0.5 KB, which is also the 8.5 KB a consumer custom worker gets. The worker runtime then moved the timeline statistics out of the entry, so the entry measures about 4.2 KB against this limit; the statistics have their own budget, and this limit is re-set when the demo worker entry is renamed to probe.worker.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.00 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **shared statistics chunk** (5.00 KB): Timeline statistics shared by both own parsers and the comparison engines. The worker requests the chunk in parallel with the first parser, so it is part of every first analysis row. Measured 4.29 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Counts every chunk the parsers share. Not required: when the statistics are part of the worker entry, the worker budget catches them.
- **lazy probe client** (1.50 KB): The probe client fetched by the main chunk on the first file, before the worker starts: the worker pool (pool-*) now, and the probe with its engine descriptors (probe-*) once the demo uses it. Counted in every first analysis row. Measured 1.04 KB when set, when the chunk held only the worker pool; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: without a client chunk the pool is part of the main chunk.
- **lazy rVFC fallback** (2.50 KB): Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy rate profile core (segments)** (2.00 KB): Segmentation, anomalies, uneven flag and sparkline buckets. Fetched by the worker only for a timeline with unequal frame rates (VFR), after the parser chunk. Measured 1.79 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into another one, that chunk budget catches the growth.
- **lazy rate profile panel (UI)** (1.50 KB): Sparkline and segment table, fetched by the main chunk (React.lazy) when a result card has a rate profile. Measured 0.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into the main chunk, the main budget catches the growth.
- **initial (main + CSS + worker entry)** (85.00 KB): User-facing goal, unchanged: the page, its styles and the worker entry, before any file is analysed. Nothing else loads without a user action: the device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so it is in neither the initial row nor the first analysis rows. Measured 82.05 KB when set.
- **first MP4 analysis (initial + client + ISO BMFF + shared chunks)** (100.00 KB): User-facing promise: page plus first MP4 or MOV result stays under 100 KB gzip. Measured 93.99 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 1.5 + 5 + 13.5 = 105 KB) add up to more than the promise and this can trip while every component is within its own limit.
- **first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks)** (100.00 KB): User-facing promise: page plus the first MP4 or MOV result with unequal frame rates, which also fetches the rate profile chunk, stays under 100 KB gzip. Measured 96.41 KB when set. With the lazy probe client and the shared statistics chunk, the component limits (85 + 1.5 + 5 + 13.5 + 2 = 107 KB) add up to more than the promise, so this can trip while every component is within its own limit. Not required: without a segments chunk the code lives elsewhere and the first MP4 analysis covers it.
- **first Matroska analysis (initial + client + Matroska + shared chunks)** (100.00 KB): User-facing promise: page plus first MKV or WebM result stays under 100 KB gzip. Measured 92.78 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 1.5 + 5 + 12 = 103.5 KB) add up to more than the promise and this can trip while every component is within its own limit.

## Chunks

| File | Kind | Raw | gzip -9 | brotli q11 |
|---|---|---:|---:|---:|
| assets/Compare-DXZJbqtV.js | lazy | 2.88 KB | 1.20 KB | 1.08 KB |
| assets/RateProfile-ZWiafoEd.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/analyze.worker-DrqORr30.js | worker | 10.20 KB | 4.19 KB | 3.82 KB |
| assets/counting-qd2uqrcD.js | engine-shared | 3.02 KB | 1.50 KB | 1.35 KB |
| assets/deviceInfo-BoHFvMfb.js | deviceInfo | 4.83 KB | 2.24 KB | 1.96 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/index-iPztWNxU.js | main | 238.70 KB | 74.51 KB | 64.55 KB |
| assets/isobmff-Cxb7e5cV.js | isobmff | 30.75 KB | 12.22 KB | 11.05 KB |
| assets/matroska-CO4PMVKC.js | matroska | 29.05 KB | 11.09 KB | 10.09 KB |
| assets/mediabunny-yQdMBm0m.js | mediabunny | 200.82 KB | 52.77 KB | 44.43 KB |
| assets/mp4box-CFoRby8N.js | mp4box | 187.65 KB | 43.64 KB | 37.29 KB |
| assets/pool-wUPLe10P.js | client | 2.28 KB | 1.09 KB | 0.98 KB |
| assets/rvfc-CmLx9V9F.js | rvfc | 3.75 KB | 1.99 KB | 1.80 KB |
| assets/segments-OJFPgdZE.js | segments | 3.35 KB | 1.84 KB | 1.71 KB |
| assets/stats-DHflr_nu.js | parser-shared | 10.21 KB | 4.29 KB | 3.92 KB |
| **initial** | main + CSS + worker entry | 253.88 KB | 80.52 KB | 69.89 KB |
| **first MP4 analysis** | initial + client chunk + ISO BMFF chunk + shared chunks | 297.12 KB | 98.12 KB | 85.84 KB |
| **first VFR MP4 analysis** | initial + client chunk + ISO BMFF chunk + segments chunk + shared chunks | 300.47 KB | 99.96 KB | 87.55 KB |
| **first Matroska analysis** | initial + client chunk + Matroska chunk + shared chunks | 295.42 KB | 96.99 KB | 84.88 KB |

