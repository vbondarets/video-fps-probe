# Bundle size

Production build in `demo/dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 77.00 KB | 74.44 KB | 2.56 KB | ok | assets/index-tAzzGRMo.js |
| worker entry (core + glue) | 5.00 KB | 4.32 KB | 0.68 KB | ok | assets/probe.worker-EqWq3AfM.js |
| ISO BMFF parser chunk | 13.50 KB | 12.22 KB | 1.28 KB | ok | assets/isobmff-BeEZb04O.js |
| Matroska parser chunk | 12.00 KB | 11.45 KB | 0.55 KB | ok | assets/matroska-Bh1J14dF.js |
| shared statistics chunk | 5.00 KB | 4.29 KB | 0.70 KB | ok | assets/stats-DPQL7gq_.js |
| lazy probe client | 3.50 KB | 2.99 KB | 0.51 KB | ok | assets/probe-C4KnLWjQ.js |
| lazy rVFC fallback | 2.50 KB | 2.19 KB | 0.30 KB | ok | assets/rvfc-DgeHtmXb.js |
| lazy rate profile core (segments) | 2.00 KB | 1.85 KB | 0.15 KB | ok | assets/segments-Bt4UI3Tt.js |
| lazy ffprobe frame rate estimate (rfps) | 3.50 KB | 3.38 KB | 0.12 KB | ok | assets/rfps-Cru73fPZ.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-RHLltyNn.js |
| initial (main + CSS + worker entry) | 83.00 KB | 80.57 KB | 2.43 KB | ok | assets/index-UkwvJHuS.css, assets/index-tAzzGRMo.js, assets/probe.worker-EqWq3AfM.js |
| first MP4 analysis (initial + client + ISO BMFF + shared chunks) | 103.00 KB | 100.07 KB | 2.93 KB | ok | assets/index-UkwvJHuS.css, assets/index-tAzzGRMo.js, assets/probe.worker-EqWq3AfM.js, assets/isobmff-BeEZb04O.js, assets/probe-C4KnLWjQ.js, assets/stats-DPQL7gq_.js |
| first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks) | 105.00 KB | 101.92 KB | 3.08 KB | ok | assets/index-UkwvJHuS.css, assets/index-tAzzGRMo.js, assets/probe.worker-EqWq3AfM.js, assets/isobmff-BeEZb04O.js, assets/segments-Bt4UI3Tt.js, assets/probe-C4KnLWjQ.js, assets/stats-DPQL7gq_.js |
| first Matroska analysis (initial + client + Matroska + shared chunks) | 102.00 KB | 99.31 KB | 2.69 KB | ok | assets/index-UkwvJHuS.css, assets/index-tAzzGRMo.js, assets/probe.worker-EqWq3AfM.js, assets/matroska-Bh1J14dF.js, assets/probe-C4KnLWjQ.js, assets/stats-DPQL7gq_.js |
| first Matroska analysis without DefaultDuration (initial + client + Matroska + rfps + shared chunks) | 105.50 KB | 102.69 KB | 2.81 KB | ok | assets/index-UkwvJHuS.css, assets/index-tAzzGRMo.js, assets/probe.worker-EqWq3AfM.js, assets/matroska-Bh1J14dF.js, assets/rfps-Cru73fPZ.js, assets/probe-C4KnLWjQ.js, assets/stats-DPQL7gq_.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

Request chain check: every static dependency of a parser or engine chunk is already loaded when it is requested, or requested together with it in one Promise.all. The worker runtime requests the statistics chunk together with every lazy engine source (one Promise.all of the source call and that chunk), so it counts as requested with each mp4box and mediabunny chunk. The one exception: an engine chunk may wait for the chunk the engines share when it imports that chunk directly, so the mp4box and mediabunny paths have one extra sequential request. No problems.

## Why these limits

- **main (React + UI)** (77.00 KB): Demo page only. React and ReactDOM are about 67.5 KB gzip of it. Measured 74.44 KB when set, 0.56 KB under the previous 75 KB limit. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. The Vite build log prints a larger figure for the same chunk (its own gzip settings); the budget is checked against the level 9 numbers of this script only.
- **worker entry (core + glue)** (5.00 KB): Sniffing, reader, options, the worker runtime and the code the lazy parsers and comparison engines share: the demo custom worker, which serves own, mp4box and mediabunny. Both own parsers are lazy chunks, and the timeline statistics are the shared statistics chunk. Budgeted by entry name: only the probe.worker file counts, and any other worker file fails as unbudgeted, so the demo ships exactly one worker. Re-set when the demo worker entry was renamed from analyze.worker to probe.worker (measured 4.19 KB), and re-checked after the worker runtime started requesting the statistics chunk with every lazy engine source: measured 4.22 KB; limit is measured plus 10 percent, rounded up to 0.5 KB (4.64 to 5 KB). That stays well under the 8.5 KB a consumer custom worker gets, so a regression of about 0.8 KB fails here instead of hiding in that headroom.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.00 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **shared statistics chunk** (5.00 KB): Timeline statistics shared by both own parsers and the comparison engines. The worker requests the chunk in parallel with the first parser, so it is part of every first analysis row. Measured 4.29 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Counts every chunk the parsers share. Not required: when the statistics are part of the worker entry, the worker budget catches them.
- **lazy probe client** (3.50 KB): The probe client fetched by the main chunk on the first file, before the worker starts: the demo probe (probe-*) with createProbeClient, its engine routing, the worker pool and the rVFC descriptor. The fallback chain, compare and the in-thread runner are separate lazy chunks that the first analysis does not load. Counted in every first analysis row. Re-set when the demo moved from the module worker pool (1.04 KB) to the library probe client: measured 2.73 KB; limit is measured plus 10 percent, rounded up to 0.5 KB, which is also the consumer client chunk budget. Not required: without a client chunk the client is part of the main chunk.
- **lazy rVFC fallback** (2.50 KB): Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **lazy rate profile core (segments)** (2.00 KB): Segmentation, anomalies, uneven flag and sparkline buckets. Fetched by the worker only for a timeline with unequal frame rates (VFR), after the parser chunk. Measured 1.79 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into another one, that chunk budget catches the growth.
- **lazy ffprobe frame rate estimate (rfps)** (3.50 KB): The ffprobe avg_frame_rate and r_frame_rate estimate for a Matroska or WebM file without DefaultDuration, fetched by the Matroska parser chunk only for such a file, in probe and exact mode. Measured 2.75 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: a build whose Matroska files never need it still emits it, and when the chunk is merged into the parser, the Matroska budget catches the growth.
- **lazy rate profile panel (UI)** (1.50 KB): Sparkline and segment table, fetched by the main chunk (React.lazy) when a result card has a rate profile. Measured 0.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into the main chunk, the main budget catches the growth.
- **initial (main + CSS + worker entry)** (83.00 KB): The demo page, its styles and the worker entry, before any file is analysed. Nothing else loads without a user action: the device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so it is in neither the initial row nor the first analysis rows. Measured 80.49 KB when set; the previous limit was 85 KB. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed.
- **first MP4 analysis (initial + client + ISO BMFF + shared chunks)** (103.00 KB): The demo page plus the first MP4 or MOV result. Measured 99,995 bytes when set, 5 bytes under the previous 100 KB limit. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. Counts the lazy probe client and the shared statistics chunk too, so the component limits (83 + 3.5 + 5 + 13.5 = 105 KB) add up to more than this limit and it can trip while every component is within its own limit.
- **first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks)** (105.00 KB): The demo page plus the first MP4 or MOV result with unequal frame rates, which also fetches the rate profile chunk. Measured 101.84 KB when set; the previous limit was 102.0 KB, set by the owner's rule of 2026-10-23 for the demo only (the measurement rounded up to 0.5 KB). Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. With the lazy probe client and the shared statistics chunk, the component limits (83 + 3.5 + 5 + 13.5 + 2 = 107 KB) add up to more than this limit, so it can trip while every component is within its own limit. Not required: without a segments chunk the code lives elsewhere and the first MP4 analysis covers it.
- **first Matroska analysis (initial + client + Matroska + shared chunks)** (102.00 KB): The demo page plus the first MKV or WebM result. Measured 98.87 KB when set; the previous limit was 100 KB. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. Counts the lazy probe client and the shared statistics chunk too, so the component limits (83 + 3.5 + 5 + 12 = 103.5 KB) add up to more than this limit and it can trip while every component is within its own limit.
- **first Matroska analysis without DefaultDuration (initial + client + Matroska + rfps + shared chunks)** (105.50 KB): The demo page plus the first MKV or WebM result of a file without DefaultDuration, such as a browser MediaRecorder recording, which also fetches the ffprobe frame rate estimate. Measured 102.06 KB when set; limit is the measurement plus 3 percent, rounded up to 0.5 KB, as for the other demo rows. Not required: without an rfps chunk the code lives in the Matroska chunk and the first Matroska analysis covers it.

## Chunks

| File | Kind | Raw | gzip -9 | brotli q11 |
|---|---|---:|---:|---:|
| assets/Compare-JWuh7XAo.js | lazy | 2.92 KB | 1.22 KB | 1.11 KB |
| assets/RateProfile-RHLltyNn.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/abort-BxutaVbu.js | client-shared | 0.10 KB | 0.11 KB | 0.09 KB |
| assets/compare-CKRj_Dmd.js | client-compare | 2.60 KB | 1.33 KB | 1.20 KB |
| assets/counting-BrCt5_57.js | engine-shared | 3.01 KB | 1.50 KB | 1.35 KB |
| assets/deviceInfo-B3eOjrMK.js | deviceInfo | 5.02 KB | 2.29 KB | 2.02 KB |
| assets/fallback-BWVXh2Fj.js | client-fallback | 1.01 KB | 0.64 KB | 0.56 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/index-tAzzGRMo.js | main | 238.72 KB | 74.44 KB | 64.48 KB |
| assets/inline-DT3MoSDl.js | client-inline | 1.09 KB | 0.64 KB | 0.55 KB |
| assets/isobmff-BeEZb04O.js | isobmff | 30.75 KB | 12.22 KB | 11.01 KB |
| assets/isobmff-BsTAd3oB.js | inline-own | 30.82 KB | 12.23 KB | 11.08 KB |
| assets/matroska-2dendv1-.js | inline-own | 30.40 KB | 11.73 KB | 10.63 KB |
| assets/matroska-Bh1J14dF.js | matroska | 29.85 KB | 11.45 KB | 10.41 KB |
| assets/mediabunny-CbOY4R3M.js | mediabunny | 201.10 KB | 52.88 KB | 44.47 KB |
| assets/mp4box-Df4WHNG_.js | mp4box | 187.93 KB | 43.73 KB | 37.39 KB |
| assets/probe-C4KnLWjQ.js | client | 6.92 KB | 2.99 KB | 2.75 KB |
| assets/probe.worker-EqWq3AfM.js | worker | 10.39 KB | 4.32 KB | 3.93 KB |
| assets/result-DwUAyOGs.js | client-shared | 0.71 KB | 0.38 KB | 0.33 KB |
| assets/rfps-Cru73fPZ.js | rfps | 6.89 KB | 3.38 KB | 3.18 KB |
| assets/rfps-n1egNYyc.js | inline-own | 6.88 KB | 3.40 KB | 3.18 KB |
| assets/runtime-BbJdL_AX.js | inline-own | 6.11 KB | 2.55 KB | 2.35 KB |
| assets/rvfc-DgeHtmXb.js | rvfc | 4.24 KB | 2.19 KB | 1.99 KB |
| assets/samples-C9gKRdrE.js | samples | 0.36 KB | 0.28 KB | 0.24 KB |
| assets/segments-Bt4UI3Tt.js | segments | 3.35 KB | 1.85 KB | 1.71 KB |
| assets/segments-Dl0-YoC4.js | inline-own | 3.35 KB | 1.84 KB | 1.71 KB |
| assets/sniff-DecauIFI.js | client-shared | 2.12 KB | 0.99 KB | 0.89 KB |
| assets/stats-BgixSYGJ.js | inline-own | 10.32 KB | 4.34 KB | 3.95 KB |
| assets/stats-DPQL7gq_.js | parser-shared | 10.21 KB | 4.29 KB | 3.93 KB |
| **initial** | main + CSS + worker entry | 254.09 KB | 80.57 KB | 69.94 KB |
| **first MP4 analysis** | initial + client chunk + ISO BMFF chunk + shared chunks | 301.97 KB | 100.07 KB | 87.63 KB |
| **first VFR MP4 analysis** | initial + client chunk + ISO BMFF chunk + segments chunk + shared chunks | 305.32 KB | 101.92 KB | 89.34 KB |
| **first Matroska analysis** | initial + client chunk + Matroska chunk + shared chunks | 301.08 KB | 99.31 KB | 87.03 KB |
| **first Matroska analysis without DefaultDuration** | initial + client chunk + Matroska chunk + rfps chunk + shared chunks | 307.97 KB | 102.69 KB | 90.21 KB |

