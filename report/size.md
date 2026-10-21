# Bundle size

Production build in `dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 75.00 KB | 73.86 KB | 1.15 KB | ok | assets/index-Dv2ZzZRw.js |
| worker entry (core + glue) | 7.50 KB | 6.56 KB | 0.94 KB | ok | assets/analyze.worker-BDRTs8Yh.js |
| ISO BMFF parser chunk | 13.50 KB | 11.94 KB | 1.56 KB | ok | assets/isobmff-Cr632sJh.js |
| Matroska parser chunk | 12.00 KB | 10.73 KB | 1.27 KB | ok | assets/matroska-BGqmYQTb.js |
| lazy rVFC fallback | 2.50 KB | 1.94 KB | 0.56 KB | ok | assets/rvfc-Cf3vbuc9.js |
| initial (main + CSS + worker entry) | 85.00 KB | 82.05 KB | 2.95 KB | ok | assets/analyze.worker-BDRTs8Yh.js, assets/index-Dv2ZzZRw.js, assets/index-EzQSOrc3.css |
| first MP4 analysis (initial + ISO BMFF chunk) | 100.00 KB | 93.99 KB | 6.01 KB | ok | assets/analyze.worker-BDRTs8Yh.js, assets/index-Dv2ZzZRw.js, assets/index-EzQSOrc3.css, assets/isobmff-Cr632sJh.js |
| first Matroska analysis (initial + Matroska chunk) | 100.00 KB | 92.78 KB | 7.22 KB | ok | assets/analyze.worker-BDRTs8Yh.js, assets/index-Dv2ZzZRw.js, assets/index-EzQSOrc3.css, assets/matroska-BGqmYQTb.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

## Why these limits

- **main (React + UI)** (75.00 KB): User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed (the Vite build log prints 74.79 KB for the same chunk; both fit), so there is little room: new UI code has to be lazy.
- **worker entry (core + glue)** (7.50 KB): Sniffing, reader, options, timeline statistics, message glue and the code the lazy parsers and comparison engines share. Both own parsers are lazy chunks. Measured 6.56 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.00 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy rVFC fallback** (2.50 KB): Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **initial (main + CSS + worker entry)** (85.00 KB): User-facing goal, unchanged: the page, its styles and the worker entry, before any file is analysed. Measured 82.05 KB when set.
- **first MP4 analysis (initial + ISO BMFF chunk)** (100.00 KB): User-facing promise: page plus first MP4 or MOV result stays under 100 KB gzip. Measured 93.99 KB when set. The component limits add up to 98.5 KB, so this only trips when something outside the budgeted chunks, such as a new shared chunk, joins the path.
- **first Matroska analysis (initial + Matroska chunk)** (100.00 KB): User-facing promise: page plus first MKV or WebM result stays under 100 KB gzip. Measured 92.78 KB when set. The component limits add up to 97 KB, so this only trips when something outside the budgeted chunks joins the path.

## Chunks

| File | Kind | Raw | gzip -9 | brotli q11 |
|---|---|---:|---:|---:|
| assets/Compare-dNBqNTTr.js | lazy | 2.84 KB | 1.17 KB | 1.06 KB |
| assets/analyze.worker-BDRTs8Yh.js | worker | 16.55 KB | 6.56 KB | 6.01 KB |
| assets/counting-D-o1Qw7U.js | engine-shared | 2.98 KB | 1.48 KB | 1.34 KB |
| assets/index-Dv2ZzZRw.js | main | 236.43 KB | 73.86 KB | 63.81 KB |
| assets/index-EzQSOrc3.css | css | 4.34 KB | 1.63 KB | 1.38 KB |
| assets/isobmff-Cr632sJh.js | isobmff | 30.28 KB | 11.94 KB | 10.82 KB |
| assets/matroska-BGqmYQTb.js | matroska | 28.62 KB | 10.73 KB | 9.76 KB |
| assets/mediabunny-Lvsr5jF6.js | mediabunny | 201.47 KB | 52.76 KB | 44.40 KB |
| assets/mp4box-BdBRyqZI.js | mp4box | 187.74 KB | 43.66 KB | 37.34 KB |
| assets/rvfc-Cf3vbuc9.js | rvfc | 3.65 KB | 1.94 KB | 1.76 KB |
| **initial** | main + CSS + worker entry | 257.31 KB | 82.05 KB | 71.20 KB |
| **first MP4 analysis** | initial + ISO BMFF chunk | 287.59 KB | 93.99 KB | 82.01 KB |
| **first Matroska analysis** | initial + Matroska chunk | 285.93 KB | 92.78 KB | 80.95 KB |

