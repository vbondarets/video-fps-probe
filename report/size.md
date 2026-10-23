# Bundle size

Production build in `dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 74.70 KB | 0.30 KB | ok | assets/index-DP7ofC8T.js |
| worker entry (core + glue) | 8.50 KB | 7.37 KB | 1.13 KB | ok | assets/analyze.worker-Cxu1jFcj.js |
| ISO BMFF parser chunk | 13.50 KB | 12.16 KB | 1.34 KB | ok | assets/isobmff-B7edjAwI.js |
| Matroska parser chunk | 12.00 KB | 10.90 KB | 1.09 KB | ok | assets/matroska-DTWARJKN.js |
| lazy probe client | 3.50 KB | - | - | not built | - |
| lazy rVFC fallback | 2.50 KB | 1.94 KB | 0.56 KB | ok | assets/rvfc-CXzfTGGl.js |
| lazy rate profile core (segments) | 2.00 KB | 1.80 KB | 0.20 KB | ok | assets/segments-_WfjZiol.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-D1rfW1-Y.js |
| initial (main + CSS + worker entry) | 85.00 KB | 83.88 KB | 1.12 KB | ok | assets/analyze.worker-Cxu1jFcj.js, assets/index-DP7ofC8T.js, assets/index-UkwvJHuS.css |
| first MP4 analysis (initial + ISO BMFF chunk) | 100.00 KB | 96.04 KB | 3.96 KB | ok | assets/analyze.worker-Cxu1jFcj.js, assets/index-DP7ofC8T.js, assets/index-UkwvJHuS.css, assets/isobmff-B7edjAwI.js |
| first VFR MP4 analysis (initial + ISO BMFF + segments) | 100.00 KB | 97.84 KB | 2.16 KB | ok | assets/analyze.worker-Cxu1jFcj.js, assets/index-DP7ofC8T.js, assets/index-UkwvJHuS.css, assets/isobmff-B7edjAwI.js, assets/segments-_WfjZiol.js |
| first Matroska analysis (initial + Matroska chunk) | 100.00 KB | 94.78 KB | 5.22 KB | ok | assets/analyze.worker-Cxu1jFcj.js, assets/index-DP7ofC8T.js, assets/index-UkwvJHuS.css, assets/matroska-DTWARJKN.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

Request chain check: every static dependency of a parser or engine chunk is in its worker entry or requested by it in parallel (the chunk the engines share may follow the engine). No problems.

## Why these limits

- **main (React + UI)** (75.00 KB): User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed, so there is little room: new UI code has to be lazy. The Vite build log prints a larger figure for the same chunk (its own gzip settings), which can exceed 75 KB; the budget is checked against the level 9 numbers of this script only.
- **worker entry (core + glue)** (8.50 KB): Sniffing, reader, options, timeline statistics, message glue and the code the lazy parsers and comparison engines share. Both own parsers are lazy chunks. Budgeted by entry name: only the analyze.worker file counts, and any other worker file fails as unbudgeted. Re-set once before the package work: measured 7.37 KB with 0.13 KB of headroom left, while loading the statistics module next to each parser and the worker runtime (versioned protocol, warm requests, per-engine container gate) both grow this entry. Limit is that measurement plus 10 percent, rounded up to 0.5 KB, which is also the 8.5 KB a consumer custom worker gets.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.00 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy probe client** (3.50 KB): Probe client, engine descriptors and worker pool in one lazy chunk (probe-*), fetched by the main chunk before the first analysis. Estimate until the chunk is first built; then reset to measured plus 10 percent, rounded up to 0.5 KB. Not required: until the client chunk exists the pool is part of the main chunk.
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
| assets/Compare-D4BfYwVb.js | lazy | 2.88 KB | 1.21 KB | 1.09 KB |
| assets/RateProfile-D1rfW1-Y.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/analyze.worker-Cxu1jFcj.js | worker | 18.76 KB | 7.37 KB | 6.71 KB |
| assets/counting-CSDeT7Yw.js | engine-shared | 3.00 KB | 1.48 KB | 1.34 KB |
| assets/deviceInfo-BoHFvMfb.js | deviceInfo | 4.83 KB | 2.24 KB | 1.96 KB |
| assets/index-DP7ofC8T.js | main | 239.10 KB | 74.70 KB | 64.57 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/isobmff-B7edjAwI.js | isobmff | 30.77 KB | 12.16 KB | 10.98 KB |
| assets/matroska-DTWARJKN.js | matroska | 29.02 KB | 10.90 KB | 9.92 KB |
| assets/mediabunny-j8MYQBno.js | mediabunny | 201.47 KB | 52.77 KB | 44.40 KB |
| assets/mp4box-oqxk3uum.js | mp4box | 187.74 KB | 43.65 KB | 37.30 KB |
| assets/rvfc-CXzfTGGl.js | rvfc | 3.65 KB | 1.94 KB | 1.76 KB |
| assets/segments-_WfjZiol.js | segments | 3.32 KB | 1.80 KB | 1.68 KB |
| **initial** | main + CSS + worker entry | 262.85 KB | 83.88 KB | 72.81 KB |
| **first MP4 analysis** | initial + ISO BMFF chunk | 293.62 KB | 96.04 KB | 83.79 KB |
| **first VFR MP4 analysis** | initial + ISO BMFF chunk + segments chunk | 296.93 KB | 97.84 KB | 85.46 KB |
| **first Matroska analysis** | initial + Matroska chunk | 291.87 KB | 94.78 KB | 82.73 KB |

