# Bundle size

Production build in `dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 74.50 KB | 0.50 KB | ok | assets/index-C54OKNhf.js |
| worker entry (core + glue) | 8.50 KB | 4.17 KB | 4.33 KB | ok | assets/analyze.worker-CoZnowTG.js |
| ISO BMFF parser chunk | 13.50 KB | 12.25 KB | 1.25 KB | ok | assets/isobmff-BFTLc3Yu.js |
| Matroska parser chunk | 12.00 KB | 11.13 KB | 0.87 KB | ok | assets/matroska-BUdTt7hK.js |
| lazy probe client | 1.50 KB | 1.04 KB | 0.46 KB | ok | assets/pool-CMiFySVn.js |
| lazy rVFC fallback | 2.50 KB | 1.99 KB | 0.51 KB | ok | assets/rvfc-CyJ6I_1O.js |
| lazy rate profile core (segments) | 2.00 KB | 1.85 KB | 0.15 KB | ok | assets/segments-C-DXkQ6g.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-CyLnrrHA.js |
| initial (main + CSS + worker entry) | 85.00 KB | 80.48 KB | 4.52 KB | ok | assets/analyze.worker-CoZnowTG.js, assets/index-C54OKNhf.js, assets/index-UkwvJHuS.css |
| first MP4 analysis (initial + ISO BMFF chunk) | 100.00 KB | 98.09 KB | 1.91 KB | ok | assets/analyze.worker-CoZnowTG.js, assets/index-C54OKNhf.js, assets/index-UkwvJHuS.css, assets/isobmff-BFTLc3Yu.js, assets/pool-CMiFySVn.js, assets/stats-BXbOgPI8.js |
| first VFR MP4 analysis (initial + ISO BMFF + segments) | 100.00 KB | 99.94 KB | 0.06 KB | ok | assets/analyze.worker-CoZnowTG.js, assets/index-C54OKNhf.js, assets/index-UkwvJHuS.css, assets/isobmff-BFTLc3Yu.js, assets/segments-C-DXkQ6g.js, assets/pool-CMiFySVn.js, assets/stats-BXbOgPI8.js |
| first Matroska analysis (initial + Matroska chunk) | 100.00 KB | 96.97 KB | 3.03 KB | ok | assets/analyze.worker-CoZnowTG.js, assets/index-C54OKNhf.js, assets/index-UkwvJHuS.css, assets/matroska-BUdTt7hK.js, assets/pool-CMiFySVn.js, assets/stats-BXbOgPI8.js |

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
| assets/Compare-CLjjsHYz.js | lazy | 2.88 KB | 1.20 KB | 1.09 KB |
| assets/RateProfile-CyLnrrHA.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/analyze.worker-CoZnowTG.js | worker | 10.08 KB | 4.17 KB | 3.83 KB |
| assets/counting-D2iCl5ts.js | engine-shared | 3.02 KB | 1.50 KB | 1.35 KB |
| assets/deviceInfo-BoHFvMfb.js | deviceInfo | 4.83 KB | 2.24 KB | 1.96 KB |
| assets/index-C54OKNhf.js | main | 238.68 KB | 74.50 KB | 64.49 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/isobmff-BFTLc3Yu.js | isobmff | 30.96 KB | 12.25 KB | 11.04 KB |
| assets/matroska-BUdTt7hK.js | matroska | 29.38 KB | 11.13 KB | 10.12 KB |
| assets/mediabunny-DO-dIB7x.js | mediabunny | 201.51 KB | 52.78 KB | 44.40 KB |
| assets/mp4box-CSEyiN4u.js | mp4box | 187.78 KB | 43.66 KB | 37.30 KB |
| assets/pool-CMiFySVn.js | client | 2.21 KB | 1.04 KB | 0.94 KB |
| assets/rvfc-CyJ6I_1O.js | rvfc | 3.75 KB | 1.99 KB | 1.80 KB |
| assets/segments-C-DXkQ6g.js | segments | 3.35 KB | 1.85 KB | 1.71 KB |
| assets/stats-BXbOgPI8.js | parser-shared | 10.24 KB | 4.31 KB | 3.94 KB |
| **initial** | main + CSS + worker entry | 253.74 KB | 80.48 KB | 69.85 KB |
| **first MP4 analysis** | initial + ISO BMFF chunk | 297.15 KB | 98.09 KB | 85.77 KB |
| **first VFR MP4 analysis** | initial + ISO BMFF chunk + segments chunk | 300.50 KB | 99.94 KB | 87.48 KB |
| **first Matroska analysis** | initial + Matroska chunk | 295.57 KB | 96.97 KB | 84.84 KB |

