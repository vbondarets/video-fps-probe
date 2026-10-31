# Bundle size

Production build in `demo/dist`, measured by `scripts/size-report.mjs`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: index.html; worker: Worker() reference.

## Budgets (gzip)

| Budget | Limit | Actual | Headroom | Status | Files |
|---|---:|---:|---:|---|---|
| main (React + UI) | 77.00 KB | 74.49 KB | 2.51 KB | ok | assets/index-DkXtX0h1.js |
| worker entry (core + glue) | 5.00 KB | 4.28 KB | 0.72 KB | ok | assets/probe.worker-texa1Vsv.js |
| ISO BMFF parser chunk | 13.50 KB | 12.53 KB | 0.97 KB | ok | assets/isobmff-zDZPNGDL.js |
| Matroska parser chunk | 12.50 KB | 11.84 KB | 0.66 KB | ok | assets/matroska-DgB2f4So.js |
| shared statistics chunk | 5.00 KB | 4.33 KB | 0.67 KB | ok | assets/stats-Qj6C2s4i.js |
| lazy probe client | 3.50 KB | 3.24 KB | 0.26 KB | ok | assets/probe-CO1lfBbt.js |
| lazy rVFC fallback | 2.50 KB | 2.19 KB | 0.31 KB | ok | assets/rvfc-zRmlC3zB.js |
| lazy rate profile core (segments) | 2.00 KB | 1.85 KB | 0.15 KB | ok | assets/segments-CTf6p5_2.js |
| lazy ffprobe frame rate estimate (rfps) | 4.00 KB | 3.59 KB | 0.41 KB | ok | assets/rfps-B_WaxrKb.js |
| lazy rate profile panel (UI) | 1.50 KB | 0.94 KB | 0.56 KB | ok | assets/RateProfile-CJrq1fnv.js |
| initial (main + CSS + worker entry) | 83.00 KB | 80.58 KB | 2.42 KB | ok | assets/index-DkXtX0h1.js, assets/index-UkwvJHuS.css, assets/probe.worker-texa1Vsv.js |
| first MP4 analysis (initial + client + ISO BMFF + shared chunks) | 103.00 KB | 100.68 KB | 2.32 KB | ok | assets/index-DkXtX0h1.js, assets/index-UkwvJHuS.css, assets/probe.worker-texa1Vsv.js, assets/isobmff-zDZPNGDL.js, assets/probe-CO1lfBbt.js, assets/stats-Qj6C2s4i.js |
| first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks) | 105.00 KB | 102.52 KB | 2.48 KB | ok | assets/index-DkXtX0h1.js, assets/index-UkwvJHuS.css, assets/probe.worker-texa1Vsv.js, assets/isobmff-zDZPNGDL.js, assets/segments-CTf6p5_2.js, assets/probe-CO1lfBbt.js, assets/stats-Qj6C2s4i.js |
| first Matroska analysis (initial + client + Matroska + shared chunks) | 102.00 KB | 99.99 KB | 2.01 KB | ok | assets/index-DkXtX0h1.js, assets/index-UkwvJHuS.css, assets/probe.worker-texa1Vsv.js, assets/matroska-DgB2f4So.js, assets/probe-CO1lfBbt.js, assets/stats-Qj6C2s4i.js |
| first Matroska analysis without DefaultDuration (initial + client + Matroska + rfps + shared chunks) | 105.50 KB | 103.57 KB | 1.93 KB | ok | assets/index-DkXtX0h1.js, assets/index-UkwvJHuS.css, assets/probe.worker-texa1Vsv.js, assets/matroska-DgB2f4So.js, assets/rfps-B_WaxrKb.js, assets/probe-CO1lfBbt.js, assets/stats-Qj6C2s4i.js |

The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.

Request chain check: every static dependency of a parser or engine chunk is already loaded when it is requested, or requested together with it in one Promise.all. The worker runtime requests the statistics chunk together with every lazy engine source (one Promise.all of the source call and that chunk), so it counts as requested with each mp4box and mediabunny chunk. The one exception: an engine chunk may wait for the chunk the engines share when it imports that chunk directly, so the mp4box and mediabunny paths have one extra sequential request. No problems.

## Why these limits

- **main (React + UI)** (77.00 KB): Demo page only. React and ReactDOM are about 67.5 KB gzip of it. Measured 74.44 KB when set, 0.56 KB under the previous 75 KB limit. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. The Vite build log prints a larger figure for the same chunk (its own gzip settings); the budget is checked against the level 9 numbers of this script only.
- **worker entry (core + glue)** (5.00 KB): Sniffing, reader, options, the worker runtime and the code the lazy parsers and comparison engines share: the demo custom worker, which serves own, mp4box and mediabunny. Both own parsers are lazy chunks, and the timeline statistics are the shared statistics chunk. Budgeted by entry name: only the probe.worker file counts, and any other worker file fails as unbudgeted, so the demo ships exactly one worker. Re-set when the demo worker entry was renamed from analyze.worker to probe.worker (measured 4.19 KB), and re-checked after the worker runtime started requesting the statistics chunk with every lazy engine source: measured 4.22 KB; limit is measured plus 10 percent, rounded up to 0.5 KB (4.64 to 5 KB). That stays well under the 8.5 KB a consumer custom worker gets, so a regression of about 0.8 KB fails here instead of hiding in that headroom.
- **ISO BMFF parser chunk** (13.50 KB): Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.
- **Matroska parser chunk** (12.50 KB): Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Raised from 12 KB to 12.5 KB in 0.2.0, measured 11.68 KB with 0.33 KB of headroom left, to the measurement plus 3 percent, rounded up to 0.5 KB, the rule of every demo row with less than 0.5 KB of headroom in 0.2.0.
- **shared statistics chunk** (5.00 KB): Timeline statistics shared by both own parsers and the comparison engines. The worker requests the chunk in parallel with the first parser, so it is part of every first analysis row. Measured 4.29 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Counts every chunk the parsers share. Not required: when the statistics are part of the worker entry, the worker budget catches them.
- **lazy probe client** (3.50 KB): The probe client fetched by the main chunk on the first file, before the worker starts: the demo probe (probe-*) with createProbeClient, its engine routing, the worker pool and the rVFC descriptor. The fallback chain, compare and the in-thread runner are separate lazy chunks that the first analysis does not load. Counted in every first analysis row. Re-set when the demo moved from the module worker pool (1.04 KB) to the library probe client: measured 2.73 KB; limit is measured plus 10 percent, rounded up to 0.5 KB, which is also the consumer client chunk budget. Not required: without a client chunk the client is part of the main chunk.
- **lazy rVFC fallback** (2.50 KB): Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Re-checked in 0.2.0, measured 2.20 KB with 0.30 KB of headroom left: the measurement plus 3 percent, rounded up to 0.5 KB, the rule of every demo row with less than 0.5 KB of headroom in 0.2.0, is the same 2.5 KB.
- **lazy rate profile core (segments)** (2.00 KB): Segmentation, anomalies, uneven flag and sparkline buckets. Fetched by the worker only for a timeline with unequal frame rates (VFR), after the parser chunk. Measured 1.79 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Re-checked in 0.2.0, measured 1.85 KB with 0.15 KB of headroom left: the measurement plus 3 percent, rounded up to 0.5 KB, the rule of every demo row with less than 0.5 KB of headroom in 0.2.0, is the same 2 KB. Not required: when the chunk is merged into another one, that chunk budget catches the growth.
- **lazy ffprobe frame rate estimate (rfps)** (4.00 KB): The ffprobe avg_frame_rate and r_frame_rate estimate for a Matroska or WebM file without DefaultDuration, fetched by the Matroska parser chunk only for such a file, in probe and exact mode. Measured 2.75 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Raised from 3.5 KB to 4.0 KB in 0.2.0 by the same rule, measured 3.52 KB, when the estimate began to read the H.264 slice headers that decide the decoder delay and to ride the block walk of the exact scan instead of a walk of its own. Re-checked in 0.2.0, measured 3.59 KB with 0.41 KB of headroom left: the measurement plus 3 percent, rounded up to 0.5 KB, the rule of every demo row with less than 0.5 KB of headroom in 0.2.0, is the same 4 KB. Not required: a build whose Matroska files never need it still emits it, and when the chunk is merged into the parser, the Matroska budget catches the growth.
- **lazy rate profile panel (UI)** (1.50 KB): Sparkline and segment table, fetched by the main chunk (React.lazy) when a result card has a rate profile. Measured 0.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into the main chunk, the main budget catches the growth.
- **initial (main + CSS + worker entry)** (83.00 KB): The demo page, its styles and the worker entry, before any file is analysed. Nothing else loads without a user action: the device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so it is in neither the initial row nor the first analysis rows. Measured 80.49 KB when set; the previous limit was 85 KB. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed.
- **first MP4 analysis (initial + client + ISO BMFF + shared chunks)** (103.00 KB): The demo page plus the first MP4 or MOV result. Measured 99,995 bytes when set, 5 bytes under the previous 100 KB limit. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. Counts the lazy probe client and the shared statistics chunk too, so the component limits (83 + 3.5 + 5 + 13.5 = 105 KB) add up to more than this limit and it can trip while every component is within its own limit.
- **first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks)** (105.00 KB): The demo page plus the first MP4 or MOV result with unequal frame rates, which also fetches the rate profile chunk. Measured 101.84 KB when set; the previous limit was 102.0 KB, set by the owner's rule of 2026-10-23 for the demo only (the measurement rounded up to 0.5 KB). Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. With the lazy probe client and the shared statistics chunk, the component limits (83 + 3.5 + 5 + 13.5 + 2 = 107 KB) add up to more than this limit, so it can trip while every component is within its own limit. Not required: without a segments chunk the code lives elsewhere and the first MP4 analysis covers it.
- **first Matroska analysis (initial + client + Matroska + shared chunks)** (102.00 KB): The demo page plus the first MKV or WebM result. Measured 98.87 KB when set; the previous limit was 100 KB. Re-set on 2026-10-24 to the measurement plus 3 percent, rounded up to 0.5 KB, when the owner decided that the demo size does not matter as long as the package stays tiny: the size promise of the package is the consumer size matrix (report/size-matrix.md), whose budgets did not change. That left 2.51 to 3.16 KB of headroom across these rows when set (3.0 to 3.4 percent of the measurements; the Headroom column has the current figure), so a demo regression smaller than the headroom of its row passes this check unnoticed. Counts the lazy probe client and the shared statistics chunk too, so the component limits (83 + 3.5 + 5 + 12.5 = 104 KB) add up to more than this limit and it can trip while every component is within its own limit.
- **first Matroska analysis without DefaultDuration (initial + client + Matroska + rfps + shared chunks)** (105.50 KB): The demo page plus the first MKV or WebM result of a file without DefaultDuration, such as a browser MediaRecorder recording, which also fetches the ffprobe frame rate estimate. Measured 102.06 KB when set; limit is the measurement plus 3 percent, rounded up to 0.5 KB, as for the other demo rows. Not required: without an rfps chunk the code lives in the Matroska chunk and the first Matroska analysis covers it.

## Chunks

| File | Kind | Raw | gzip -9 | brotli q11 |
|---|---|---:|---:|---:|
| assets/Compare-2ztt4rh5.js | lazy | 2.91 KB | 1.21 KB | 1.10 KB |
| assets/RateProfile-CJrq1fnv.js | rateProfile | 2.17 KB | 0.94 KB | 0.85 KB |
| assets/abort-BxutaVbu.js | client-shared | 0.10 KB | 0.11 KB | 0.09 KB |
| assets/compare-AEkV_Qt_.js | client-compare | 2.60 KB | 1.32 KB | 1.20 KB |
| assets/counting-BLnL5x-u.js | engine-shared | 3.24 KB | 1.59 KB | 1.44 KB |
| assets/deviceInfo-DCJA8lkG.js | deviceInfo | 5.03 KB | 2.30 KB | 2.03 KB |
| assets/fallback-BWomzx0f.js | client-fallback | 1.01 KB | 0.64 KB | 0.56 KB |
| assets/index-DkXtX0h1.js | main | 238.86 KB | 74.49 KB | 64.46 KB |
| assets/index-UkwvJHuS.css | css | 4.98 KB | 1.81 KB | 1.53 KB |
| assets/inline-6XZJruPK.js | client-inline | 1.12 KB | 0.66 KB | 0.57 KB |
| assets/isobmff-CZ982OL3.js | inline-own | 31.66 KB | 12.56 KB | 11.38 KB |
| assets/isobmff-zDZPNGDL.js | isobmff | 31.59 KB | 12.53 KB | 11.31 KB |
| assets/matroska-CU542kk_.js | inline-own | 31.34 KB | 12.11 KB | 11.02 KB |
| assets/matroska-DgB2f4So.js | matroska | 30.85 KB | 11.84 KB | 10.78 KB |
| assets/mediabunny-D15pX26q.js | mediabunny | 201.40 KB | 52.99 KB | 44.61 KB |
| assets/mp4box-DfIfyfKt.js | mp4box | 187.95 KB | 43.73 KB | 37.35 KB |
| assets/probe-CO1lfBbt.js | client | 7.47 KB | 3.24 KB | 3.00 KB |
| assets/probe.worker-texa1Vsv.js | worker | 10.21 KB | 4.28 KB | 3.90 KB |
| assets/result-CpvffFj4.js | client-shared | 0.73 KB | 0.39 KB | 0.34 KB |
| assets/rfps-BYLqLUiB.js | inline-own | 7.31 KB | 3.60 KB | 3.35 KB |
| assets/rfps-B_WaxrKb.js | rfps | 7.32 KB | 3.59 KB | 3.35 KB |
| assets/route-Cw_KyA1k.js | other | 0.56 KB | 0.38 KB | 0.33 KB |
| assets/runtime-CCuwdsbI.js | inline-own | 5.90 KB | 2.48 KB | 2.30 KB |
| assets/rvfc-zRmlC3zB.js | rvfc | 4.24 KB | 2.19 KB | 1.98 KB |
| assets/samples-C9gKRdrE.js | samples | 0.36 KB | 0.28 KB | 0.24 KB |
| assets/segments-CTf6p5_2.js | segments | 3.35 KB | 1.85 KB | 1.71 KB |
| assets/segments-DTnbEIUt.js | inline-own | 3.35 KB | 1.84 KB | 1.71 KB |
| assets/sniff-DecauIFI.js | client-shared | 2.12 KB | 0.99 KB | 0.89 KB |
| assets/stats-CxaGmQAI.js | inline-own | 10.39 KB | 4.37 KB | 3.98 KB |
| assets/stats-Qj6C2s4i.js | parser-shared | 10.29 KB | 4.33 KB | 3.95 KB |
| **initial** | main + CSS + worker entry | 254.05 KB | 80.58 KB | 69.89 KB |
| **first MP4 analysis** | initial + client chunk + ISO BMFF chunk + shared chunks | 303.40 KB | 100.68 KB | 88.16 KB |
| **first VFR MP4 analysis** | initial + client chunk + ISO BMFF chunk + segments chunk + shared chunks | 306.75 KB | 102.52 KB | 89.87 KB |
| **first Matroska analysis** | initial + client chunk + Matroska chunk + shared chunks | 302.67 KB | 99.99 KB | 87.62 KB |
| **first Matroska analysis without DefaultDuration** | initial + client chunk + Matroska chunk + rfps chunk + shared chunks | 309.99 KB | 103.57 KB | 90.97 KB |

