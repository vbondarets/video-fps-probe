# Bundle size

Production build in `dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 74.70 KB | 0.30 KB | ok | assets/index-ClllHCXL.js |
| worker entry (core + glue) | 8.50 KB | 8.01 KB | 0.49 KB | ok | assets/analyze.worker-CNiu-Dfn.js |
| ISO BMFF parser chunk | 13.50 KB | 12.18 KB | 1.32 KB | ok | assets/isobmff-9JN1uSVB.js |
| Matroska parser chunk | 12.00 KB | 11.09 KB | 0.91 KB | ok | assets/matroska-BGMPO5qx.js |
| lazy probe client | 3.50 KB | - | - | not built | - |
| lazy rVFC fallback | 2.50 KB | 1.97 KB | 0.53 KB | ok | assets/rvfc-DkVtM95m.js |
| lazy rate profile core (segments) | 2.00 KB | 1.80 KB | 0.20 KB | ok | assets/segments-rorRi5jh.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-DAd1YSjq.js |
| initial (main + CSS + worker entry) | 85.00 KB | 84.52 KB | 0.48 KB | ok | assets/analyze.worker-CNiu-Dfn.js, assets/index-ClllHCXL.js, assets/index-UkwvJHuS.css |
| first MP4 analysis (initial + ISO BMFF chunk) | 100.00 KB | 96.70 KB | 3.29 KB | ok | assets/analyze.worker-CNiu-Dfn.js, assets/index-ClllHCXL.js, assets/index-UkwvJHuS.css, assets/isobmff-9JN1uSVB.js |
| first VFR MP4 analysis (initial + ISO BMFF + segments) | 100.00 KB | 98.51 KB | 1.49 KB | ok | assets/analyze.worker-CNiu-Dfn.js, assets/index-ClllHCXL.js, assets/index-UkwvJHuS.css, assets/isobmff-9JN1uSVB.js, assets/segments-rorRi5jh.js |
| first Matroska analysis (initial + Matroska chunk) | 100.00 KB | 95.62 KB | 4.38 KB | ok | assets/analyze.worker-CNiu-Dfn.js, assets/index-ClllHCXL.js, assets/index-UkwvJHuS.css, assets/matroska-BGMPO5qx.js |

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
| assets/Compare-BJ28sHgG.js | lazy | 2.88 KB | 1.21 KB | 1.09 KB |
| assets/RateProfile-DAd1YSjq.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/analyze.worker-CNiu-Dfn.js | worker | 20.03 KB | 8.01 KB | 7.28 KB |
| assets/counting-DrUxYuFk.js | engine-shared | 2.98 KB | 1.48 KB | 1.33 KB |
| assets/deviceInfo-BoHFvMfb.js | deviceInfo | 4.83 KB | 2.24 KB | 1.96 KB |
| assets/index-ClllHCXL.js | main | 239.10 KB | 74.70 KB | 64.65 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/isobmff-9JN1uSVB.js | isobmff | 30.91 KB | 12.18 KB | 11.04 KB |
| assets/matroska-BGMPO5qx.js | matroska | 29.30 KB | 11.09 KB | 10.07 KB |
| assets/mediabunny-DG3Ghp98.js | mediabunny | 201.38 KB | 52.74 KB | 44.33 KB |
| assets/mp4box-D_U6rtQD.js | mp4box | 187.74 KB | 43.65 KB | 37.27 KB |
| assets/rvfc-DkVtM95m.js | rvfc | 3.72 KB | 1.97 KB | 1.79 KB |
| assets/segments-rorRi5jh.js | segments | 3.32 KB | 1.80 KB | 1.68 KB |
| **initial** | main + CSS + worker entry | 264.12 KB | 84.52 KB | 73.46 KB |
| **first MP4 analysis** | initial + ISO BMFF chunk | 295.02 KB | 96.70 KB | 84.50 KB |
| **first VFR MP4 analysis** | initial + ISO BMFF chunk + segments chunk | 298.34 KB | 98.51 KB | 86.18 KB |
| **first Matroska analysis** | initial + Matroska chunk | 293.42 KB | 95.62 KB | 83.53 KB |

