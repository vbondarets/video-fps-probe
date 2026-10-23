# Bundle size

Production build in `dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 74.50 KB | 0.49 KB | ok | assets/index-DHex063Y.js |
| worker entry (core + glue) | 8.50 KB | 4.14 KB | 4.36 KB | ok | assets/analyze.worker-BUALHF8a.js |
| ISO BMFF parser chunk | 13.50 KB | 12.25 KB | 1.25 KB | ok | assets/isobmff-CO4YC0Lw.js |
| Matroska parser chunk | 12.00 KB | 11.13 KB | 0.87 KB | ok | assets/matroska-CSjW9Xgj.js |
| lazy probe client | 1.50 KB | 1.04 KB | 0.46 KB | ok | assets/pool-DqgPZmkm.js |
| lazy rVFC fallback | 2.50 KB | 1.99 KB | 0.51 KB | ok | assets/rvfc-DxKJ20E7.js |
| lazy rate profile core (segments) | 2.00 KB | 1.84 KB | 0.15 KB | ok | assets/segments-CuOmC4EC.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-BEbThngj.js |
| initial (main + CSS + worker entry) | 85.00 KB | 80.45 KB | 4.55 KB | ok | assets/analyze.worker-BUALHF8a.js, assets/index-DHex063Y.js, assets/index-UkwvJHuS.css |
| first MP4 analysis (initial + ISO BMFF chunk) | 100.00 KB | 98.06 KB | 1.94 KB | ok | assets/analyze.worker-BUALHF8a.js, assets/index-DHex063Y.js, assets/index-UkwvJHuS.css, assets/isobmff-CO4YC0Lw.js, assets/pool-DqgPZmkm.js, assets/stats-C7U3IWdW.js |
| first VFR MP4 analysis (initial + ISO BMFF + segments) | 100.00 KB | 99.91 KB | 0.09 KB | ok | assets/analyze.worker-BUALHF8a.js, assets/index-DHex063Y.js, assets/index-UkwvJHuS.css, assets/isobmff-CO4YC0Lw.js, assets/segments-CuOmC4EC.js, assets/pool-DqgPZmkm.js, assets/stats-C7U3IWdW.js |
| first Matroska analysis (initial + Matroska chunk) | 100.00 KB | 96.94 KB | 3.06 KB | ok | assets/analyze.worker-BUALHF8a.js, assets/index-DHex063Y.js, assets/index-UkwvJHuS.css, assets/matroska-CSjW9Xgj.js, assets/pool-DqgPZmkm.js, assets/stats-C7U3IWdW.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

Request chain check: every static dependency of a parser or engine chunk is in its worker entry or requested by it in parallel (the chunk the engines share may follow the engine). No problems.

## Why these limits

- **main (React + UI)** (75.00 KB): User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed, so there is little room: new UI code has to be lazy. The Vite build log prints a larger figure for the same chunk (its own gzip settings), which can exceed 75 KB; the budget is checked against the level 9 numbers of this script only.
- **worker entry (core + glue)** (8.50 KB): Sniffing, reader, options, timeline statistics, message glue and the code the lazy parsers and comparison engines share. Both own parsers are lazy chunks. Budgeted by entry name: only the analyze.worker file counts, and any other worker file fails as unbudgeted. Re-set once before the package work: measured 7.37 KB with 0.13 KB of headroom left, while loading the statistics module next to each parser and the worker runtime (versioned protocol, warm requests, per-engine container gate) both grow this entry. Limit is that measurement plus 10 percent, rounded up to 0.5 KB, which is also the 8.5 KB a consumer custom worker gets.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.00 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy probe client** (1.50 KB): The probe client fetched by the main chunk on the first file, before the worker starts: the worker pool (pool-*) now, and the probe with its engine descriptors (probe-*) once the demo uses it. Counted in every first analysis row. Measured 1.04 KB when set, when the chunk held only the worker pool; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: without a client chunk the pool is part of the main chunk.
- **lazy rVFC fallback** (2.50 KB): Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy rate profile core (segments)** (2.00 KB): Segmentation, anomalies, uneven flag and sparkline buckets. Fetched by the worker only for a timeline with unequal frame rates (VFR), after the parser chunk. Measured 1.79 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into another one, that chunk budget catches the growth.
- **lazy rate profile panel (UI)** (1.50 KB): Sparkline and segment table, fetched by the main chunk (React.lazy) when a result card has a rate profile. Measured 0.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into the main chunk, the main budget catches the growth.
- **initial (main + CSS + worker entry)** (85.00 KB): User-facing goal, unchanged: the page, its styles and the worker entry, before any file is analysed. Nothing else loads without a user action: the device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so it is in neither the initial row nor the first analysis rows. Measured 82.05 KB when set.
- **first MP4 analysis (initial + ISO BMFF chunk)** (100.00 KB): User-facing promise: page plus first MP4 or MOV result stays under 100 KB gzip. Measured 93.99 KB when set. The component limits add up to 98.5 KB, so this only trips when something outside the budgeted chunks, such as a new shared chunk, joins the path.
- **first VFR MP4 analysis (initial + ISO BMFF + segments)** (100.00 KB): User-facing promise: page plus the first MP4 or MOV result with unequal frame rates, which also fetches the rate profile chunk, stays under 100 KB gzip. Measured 96.41 KB when set. Unlike the first MP4 analysis, the component limits (85 + 13.5 + 2 = 100.5 KB) add up to more than the promise, so this can trip while every component is within its own limit. Not required: without a segments chunk the code lives elsewhere and the first MP4 analysis covers it.
- **first Matroska analysis (initial + Matroska chunk)** (100.00 KB): User-facing promise: page plus first MKV or WebM result stays under 100 KB gzip. Measured 92.78 KB when set. The component limits add up to 97 KB, so this only trips when something outside the budgeted chunks joins the path.

## Chunks

| File | Kind | Raw | gzip -9 | brotli q11 |
|---|---|---:|---:|---:|
| assets/Compare-7PCHX0u1.js | lazy | 2.88 KB | 1.20 KB | 1.08 KB |
| assets/RateProfile-BEbThngj.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/analyze.worker-BUALHF8a.js | worker | 9.95 KB | 4.14 KB | 3.79 KB |
| assets/counting-gRJUtl9n.js | engine-shared | 3.02 KB | 1.50 KB | 1.35 KB |
| assets/deviceInfo-BoHFvMfb.js | deviceInfo | 4.83 KB | 2.24 KB | 1.96 KB |
| assets/index-DHex063Y.js | main | 238.68 KB | 74.50 KB | 64.49 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/isobmff-CO4YC0Lw.js | isobmff | 30.96 KB | 12.25 KB | 11.04 KB |
| assets/matroska-CSjW9Xgj.js | matroska | 29.38 KB | 11.13 KB | 10.12 KB |
| assets/mediabunny-CTr6LIye.js | mediabunny | 201.64 KB | 52.88 KB | 44.54 KB |
| assets/mp4box-CSoqwsAX.js | mp4box | 187.86 KB | 43.72 KB | 37.39 KB |
| assets/pool-DqgPZmkm.js | client | 2.21 KB | 1.04 KB | 0.93 KB |
| assets/rvfc-DxKJ20E7.js | rvfc | 3.75 KB | 1.99 KB | 1.80 KB |
| assets/segments-CuOmC4EC.js | segments | 3.35 KB | 1.84 KB | 1.72 KB |
| assets/stats-C7U3IWdW.js | parser-shared | 10.24 KB | 4.31 KB | 3.93 KB |
| **initial** | main + CSS + worker entry | 253.61 KB | 80.45 KB | 69.80 KB |
| **first MP4 analysis** | initial + ISO BMFF chunk | 297.02 KB | 98.06 KB | 85.71 KB |
| **first VFR MP4 analysis** | initial + ISO BMFF chunk + segments chunk | 300.37 KB | 99.91 KB | 87.42 KB |
| **first Matroska analysis** | initial + Matroska chunk | 295.43 KB | 96.94 KB | 84.79 KB |

