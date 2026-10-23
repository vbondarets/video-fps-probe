# Architecture

The app computes FPS statistics for local video files without decoding them. All parsing runs in module Web Workers; `src/core` has no DOM dependency, so the same code runs in a worker and in Node 24 (tests, the comparison script and benchmarks). The binding formulas and tolerances are in [research.md](research.md); where the code differs from them, and why, is in [implementation-notes.md](implementation-notes.md).

## Module map

### Core (`src/core`, no DOM)

| Path | Role |
|---|---|
| `types.ts` | Result model (`FileResult`, `VideoTrackResult`, `Rational`, `Provenance`, `ScanDepth`), options (`AnalyzeOptions`, `CostModel` with `perReadMs`, `bytesPerMs`, `perBlockMs`) and the `ContainerAnalyzer` contract |
| `reader.ts` | `BlobReader`: the only IO path. One primitive `read(offset, length)` over `Blob.slice().arrayBuffer()`, `readMany` with bounded concurrency, `view()` / `viewExact()` / `bytes()` over up to 4 cached windows, IO counters, abort checks and big-endian DataView helpers (`u8` .. `u64`, `i64`, `fourcc`). 64-bit values above 2^53-1 are rejected |
| `rational.ts` | Exact BigInt port of FFmpeg `av_reduce`, `avgFrameRate(ts, N, D)`, ffprobe-style `num/den` strings |
| `stats.ts` | `analyzeTimeline`: container-independent timeline statistics (research 4.3). Input is run-length segments (MP4) or a PTS array (Matroska); output is average, presented frames, duplicates, tail exclusion, VFR rule, min/max, nominal and dominant rate, plus a deferred rate profile job when the frame intervals differ by more than 7.5%. `rateProfileOf(job)` loads `segments.ts` and runs the job |
| `segments.ts` | `rateProfile`: CUSUM segmentation of the frame intervals, anomalies (rate change, freeze, gap, burst), the uneven flag, the summary line and the sparkline buckets. Lazy chunk, imported only by `rateProfileOf` |
| `sniff.ts` | Container detection from the first bytes, never from the file name; names known non-video signatures in the error |
| `options.ts` | Defaults and `resolveOptions`: read-ahead sizes (head 64 KiB, fragment 1 MiB, Matroska scan 1 MiB, tail 256 KiB), cost model (0.8 ms per read, 500 kB/ms, 0.0002 ms per block or laced frame), exact-scan budget (150 ms), expansion limit (5M samples, also the Matroska PTS array cap), `predictReadMs` |
| `result.ts` | `emptyAnalysis()`, `emptyTrack()`, `primaryTrack()` shared by the parsers, engines and UI |
| `analyze.ts` | `analyze(blob, name, opts)`: timing, head read, sniffing, dispatch to the container parser (loaded with a dynamic `import()` on first use), error capture |
| `index.ts` | Public exports of the above |

### ISO BMFF (`src/core/isobmff`)

| Path | Role |
|---|---|
| `index.ts` | `analyzeIsoBmff` (and `analyzeIsoBmffDetailed`, which also returns the internal movie model for tests): top-level walk, ffprobe header-extent emulation, per-track result, primary track pick, format duration, then the rate profile of each track |
| `boxes.ts` | Box header reader (size 0, largesize, uuid, size smaller than header), child walk, entry bounding, `boxU64` / `boxI64`, `IsoBmffError` |
| `model.ts` | `IsoMovie`, `IsoTrack`, `Fragment`, `Sidx`, `TopBox` |
| `moov.ts` | mvhd, tkhd, edts/elst, mdhd, mdia/hdlr, stsd, stts, ctts, stsz/stz2, stss, stsc, stco/co64 references, tref, mvex/trex, cmov detection |
| `moof.ts` | tfhd (all flags, trex fallback), tfdt, trun (all flags, record size, bounding), sidx, `found_tfhd` emulation |
| `prefetch.ts` | Moof offset hints from a global sidx or mfra/tfra and parallel `readMany` batches |
| `track.ts` | `av_rescale`, average and emulated ffprobe average, edit info, duration and start rules, stage-1 `r_frame_rate`, timeline segments, truncated-sample counting, rotation |
| `codecs.ts` | fourcc to ffprobe `codec_name`, esds object type remap |

### Matroska (`src/core/matroska`)

| Path | Role |
|---|---|
| `index.ts` | `analyzeMatroska`: header, probe, exact and auto modes, scan cost plan, result building |
| `ebml.ts` | Element IDs, VINT readers, element headers, unknown sizes |
| `source.ts` | `ByteSource`: windowed cursor over `BlobReader`; Cluster and level-1 validation and forward search for resync |
| `header.ts` | Stage A: EBML header, Segment, SeekHead, Info, Tracks, Tags, Cues, with resync, a read budget and a nesting limit |
| `scan.ts` | Block parsing and validation, Cluster walk, top-level Segment scan with ffmpeg-style recovery, tail scan |

### Worker (`src/worker`)

| Path | Role |
|---|---|
| `protocol.ts` | Typed request and response messages |
| `analyze.worker.ts` | Worker entry: runs `analyze()` for engine `own`, dynamically imports the mp4box or mediabunny engine, one `AbortController` per job, progress throttled to 50 ms |

### Comparison engines (`src/engines`)

| Path | Role |
|---|---|
| `types.ts` | Engine-native detail types (`Mp4boxNative`, `MediabunnyNative`, `RvfcDetails`) and result types |
| `counting.ts` | `CountingBlob`: wraps a blob to count reads and unique bytes for library engines; timing helpers |
| `common.ts` | Helpers shared by the engines (`applyStats`, `approxRational`, `ffprobeRotation`, `codecNameFromFourcc`, `newResult`) |
| `mp4box.ts` | `analyzeWithMp4box`: mp4box 2.4.1 fed box by box; durations from the parsed stts, never from the last sample |
| `mediabunny.ts` | `analyzeWithMediabunny`: mediabunny 1.62.0 over a `CustomSource`; native `averagePacketRate` kept as the average |
| `rvfc.ts` | `estimateWithRvfc`: `requestVideoFrameCallback` playback estimate, main thread only |

Engines import `src/core` pieces (types, reader, rational, result, sniff, stats, options) but never `analyze.ts` or `index.ts`, so they do not pull in the own parsers.

### UI (`src/App.tsx`, `src/main.tsx`, `src/index.css`, `src/ui`)

| Path | Role |
|---|---|
| `ui/workerPool.ts` | Pool of up to 2 module workers, FIFO queue, `submit(file, engine, options, onProgress)` returning `{ promise, cancel }`; `prewarm()` spawns a worker and runs a 16-byte `ftyp` blob through it (loads the ISO BMFF chunk), `dispose()` terminates idle workers |
| `ui/store.ts` | External store (`useSyncExternalStore`): rows, Matroska mode, add / rescan / cancel / clear, comparison runs, `exportJson` and `loadDevice` (both through the lazy `deviceInfo.ts`), `window.__fpsProbe` test hook |
| `ui/deviceInfo.ts` | Lazy chunk: `collectEnvironment` (user agent, client hints where Chromium offers them, threads, memory, screen, viewport, time zone), the footer device line, `buildExport` (the `video-fps-probe/export@1` envelope) and `exportResults` (download, or copy through the async clipboard, then `execCommand`, then a read-only text box to select by hand) |
| `ui/RateProfile.tsx` | Lazy chunk (`React.lazy` in `ResultCard.tsx`): sparkline, summary, segment table and anomaly list of one track |
| `ui/format.ts` | Number, duration and byte formatting; provenance label table |
| `ui/ResultCard.tsx` | One card per file: values with provenance marks, the uneven badge, the rate profile panel, notes, rescan and cancel |
| `ui/Compare.tsx` | Lazy comparison table (own vs mp4box, mediabunny, rVFC) |
| `ui/samples.ts` | Fetches the bundled sample files into in-memory `File` objects |
| `App.tsx` | Drop zone and picker, toolbar (Matroska mode, Download JSON, Copy JSON, Clear list), summary line, provenance legend, result list, footer device line |

### Scripts, tests, data

| Path | Role |
|---|---|
| `scripts/compare-ffprobe.ts` | CLI that compares engines with the ffprobe references and writes `report/accuracy.md` and `.json`; exit 1 on an unexpected own mismatch |
| `scripts/compare/` | `ref.ts` (reference parser), `rules.ts` (research 6.4 tolerances per field), `deviations.ts` (known-deviation loader), `layout.ts` (independent box scan), `engines.ts` (engine loader), `report.ts`, `types.ts`, `self-test.ts` |
| `scripts/size-report.mjs` | Reads a Vite build, reports raw, gzip -9 and brotli q11 per chunk and checks the budgets |
| `scripts/fixtures/` | Fixture generator, reference extraction and the patch tools (`tools/*.mjs`) |
| `scripts/bench/` | Chrome DevTools Protocol drivers: `run-bench.mjs` (`npm run bench`, timings, Node identity check, screenshots) and `integration.mjs` (cost of embedding in a host SPA); they drive the page through `window.__fpsProbe` |
| `scripts/readme-tables.ts` | Rewrites the README tables between markers from the JSON reports |
| `tests/` | vitest, Node environment: `unit/` (core, device info), `isobmff/`, `matroska/`, `segments/` (rate profile on fixtures), `engines/`, `helpers/` |
| `tests/e2e/`, `playwright.config.ts` | Playwright end-to-end suite on the built app in Chromium, Firefox and WebKit (`npm run test:e2e`) |
| `fixtures/` | `files/` (111 committed fixtures), `manifest.tsv`, `ref/*.ref.json` (ffprobe 8.1.1), `known-deviations/*.json`, `large/` (git-ignored) |
| `public/samples/` | The six sample files shown by "Try sample files" |
| `report/` | Generated accuracy, size, browser benchmark and integration cost reports, and the hand-written average-user model |

## Data flow

```
main thread                    worker (module)                  core
-----------                    ---------------                  ----
File (drop / picker / sample)
  store.addFiles -> workerPool.submit(file, 'own', opts)
     postMessage {analyze} --> analyze(file, name, opts) -----> BlobReader(file)
                                                                read head window (64 KiB, 1 read)
                                                                sniff(head) -> isobmff | matroska | unknown
                                                                import() of that parser (first use only)
                                                                analyzeIsoBmff / analyzeMatroska(reader, opts)
                                                                   box or EBML walk through reader.view()
                                                                   timeline -> analyzeTimeline() -> stats (+ profile job)
                                                                profile job? import() of segments.ts -> rateProfile
                                                                FileResult + io { reads, bytesRead, ms }
     {progress} / {result} <-- postMessage
  store row updated -> React render
```

- The head window read by `analyze` stays in the reader cache, so a faststart MP4 or a Matroska header usually needs no second read.
- `io.bytesRead` counts unique bytes fetched; overlapping reads are not counted twice. `io.ms` covers the whole `analyze` call, measured where it runs.
- The rate profile runs after the statistics of a track, inside the same `analyze` call, so `io.ms` includes it. A track whose intervals are all within 7.5% of each other has no job and never loads `segments.ts`.
- Cancellation: pass an `AbortSignal`. Every read checks it before and after the fetch, and `analyze` rethrows `AbortError` instead of returning a result. Every other failure becomes `FileResult.error`; `analyze` never throws for a bad file.

**ISO BMFF.** Top-level walk: `ftyp`, then `moov` read exactly (a moov at the end costs one extra read of the remainder), `moof` windows with read-ahead and sidx or mfra prefetch, `mfra` stops the walk. Then the ffprobe header extent is emulated, each video track is built (rates, edit window, timeline segments into `analyzeTimeline`), the primary track is picked and the format duration is computed.

**Matroska.** Stage A header (budget 5 reads and 1 MiB, with resync) gives tracks, DefaultDuration, Duration and tags. Mode `header` stops there. Otherwise the first Cluster is found, the block density is sampled and a scan plan is costed. `auto` runs the exact scan when the prediction is within the budget (150 ms by default) and the sampled probe otherwise. Exact walks every block header and feeds the PTS array to `analyzeTimeline`; probe samples clusters from Cues plus a tail scan and never reports an average.

**Comparison engines.** The compare panel sends `mp4box` and `mediabunny` jobs through the same pool and worker protocol; the worker imports the engine on first use and returns a `FileResult` tagged with its engine. `rvfc` runs on the main thread: the store imports `rvfc.ts` and plays the file in a visible host element. It has no IO counters.

## Worker protocol

```ts
type WorkerEngine = 'own' | 'mp4box' | 'mediabunny';

type WorkerRequest =
  | { type: 'analyze'; id: number; file: File; engine: WorkerEngine; options: Omit<AnalyzeOptions, 'signal' | 'onProgress'> }
  | { type: 'cancel'; id: number };

type WorkerResponse =
  | { type: 'progress'; id: number; progress: AnalyzeProgress }
  | { type: 'result'; id: number; result: FileResult }
  | { type: 'error'; id: number; message: string; aborted: boolean };
```

- The `File` is cloned by reference, so no bytes are copied. `signal` and `onProgress` cannot cross the boundary; the worker builds them per job id.
- `progress` is sent at most once per 50 ms. Phases: `fragments` (ISO BMFF, every 64 moofs), `matroska-exact` (bytes after the first Cluster), `read` and `analyze` (mp4box), `packets` (mediabunny).
- `cancel` aborts the job's controller. The pool rejects the job with `AbortError` immediately and terminates and replaces a worker that is still busy 1.5 s later. A worker crash rejects its job and the next job spawns a new worker.

## Lazy chunks

| Chunk | Contents | Loaded by | When |
|---|---|---|---|
| main | React, UI, store, pool | `index.html` | page load |
| worker entry | message glue, `analyze`, reader, sniff, options, result builders | `new Worker(new URL('../worker/analyze.worker.ts', import.meta.url), { type: 'module' })` in `workerPool.ts` | first file |
| ISO BMFF parser | `src/core/isobmff` | dynamic `import()` in `analyze.ts` | first file that sniffs as ISO BMFF, once per worker |
| Matroska parser | `src/core/matroska` | dynamic `import()` in `analyze.ts` | first file that sniffs as EBML, once per worker |
| mp4box | mp4box 2.4.1 and `engines/mp4box.ts` | dynamic `import()` in the worker | compare panel on an MP4 or MOV card |
| mediabunny | mediabunny 1.62.0 and `engines/mediabunny.ts` | dynamic `import()` in the worker | compare panel |
| shared chunks | modules several lazy chunks use, such as `stats.ts` and `rational.ts` (parsers and engines) and `engines/counting.ts` (library engines) | static imports of the lazy chunks that need them | with the first chunk that needs them |
| Compare | comparison table (`React.lazy`) | `ResultCard.tsx` | first time a card's compare panel opens |
| rVFC | `engines/rvfc.ts` | dynamic `import()` in `store.ts`, main thread | explicit click on "Run (approximate)" |
| segments | `core/segments.ts` (rate profile) | dynamic `import()` in `stats.ts` (`rateProfileOf`), in the worker | first track with unequal frame intervals, once per worker |
| RateProfile | `ui/RateProfile.tsx` | `React.lazy` in `ResultCard.tsx` | first card that has a rate profile |
| deviceInfo | `ui/deviceInfo.ts` | dynamic `import()` in `store.ts` | on idle after the first result (footer device line), or by the first export |

Each worker of the pool fetches the chunks it needs once. Where the bundler places modules shared by several lazy chunks can change between builds; the size report classifies them as shared chunks. `scripts/size-report.mjs` discovers the chunks from the build output and enforces the budgets in its `BUDGETS` table; run `npm run build && npm run size` for current numbers.

## ContainerAnalyzer contract

```ts
type ContainerAnalyzer = (reader: BlobReader, opts: ResolvedAnalyzeOptions) => Promise<ContainerAnalysis>;
type ContainerAnalysis = Omit<FileResult, 'name' | 'size' | 'io' | 'engine'>;
```

- Export the analyzer by name from the parser's `index.ts` (`analyzeIsoBmff`, `analyzeMatroska`): `analyze.ts` loads it with a dynamic import.
- Do all IO through `reader` (`view`, `viewExact`, `bytes`, `read`, `readMany`). Never touch the Blob directly, or the IO counters and abort checks are bypassed.
- Offsets are Numbers. Never apply 32-bit bit operations to offsets or sizes; decode 64-bit fields with `u64` / `i64`, which reject values above 2^53-1.
- Throw (or return `error`) for files that cannot be analysed; `analyze` keeps the sniffed container kind on a throw. Return partial results with `warnings` when the header is usable.
- Set `container` precisely (`mp4` vs `mov` from the ftyp brand, `webm` vs `matroska` from DocType) and `brand` to the major brand or DocType.
- Build per-track statistics with `analyzeTimeline()` from `stats.ts`, passing run-length stts/ctts or trun arrays as `segments` (MP4) or block timestamps as `pts` with `tickQuantized` (Matroska). The ffprobe-equivalent strings (`avgFpsFfprobe`, `rFpsFfprobe`) are the parser's job, because they are container specific (research 2.1 and 2.2).
- Respect `opts.maxExpandedSamples`, `opts.matroskaMode`, `opts.exactBudgetMs`, `opts.costModel`, `opts.readAhead` and report long scans through `opts.onProgress`.

## Provenance

Each `VideoTrackResult` field can carry a provenance tag in `provenance`. The UI shows it as a one-letter mark with a tooltip, and the legend under the summary line lists all five.

| Value | Mark | Meaning | Produced by |
|---|---|---|---|
| `header` | H | Read or derived directly from container headers (codec, dimensions, rotation, stts frame count, durations, DefaultDuration, DURATION tag) | both parsers |
| `exact` | E | Computed from every sample or block timestamp of the track | ISO BMFF timeline fields; Matroska after an exact scan |
| `sampled` | S | Computed from a sample of blocks (Matroska probe); never used for an average | Matroska probe |
| `estimated` | ~ | Derived under an assumption, for example a frame count from duration x declared rate (assumes CFR), or a playback measurement | rVFC engine (all values), Matroska frame estimates (warning only) |
| `computed` | C | A value ffprobe prints as N/A, computed by the app (for example a Matroska frame count) | Matroska after an exact scan |

`avgFpsFfprobe` and `rFpsFfprobe` are not provenance-tagged: they are ffprobe-equivalent strings, null when ffprobe's own value cannot be reproduced.

## Rate profile

```
analyzeTimeline (stats.ts)            parser (isobmff / matroska index.ts)       segments.ts (lazy)
--------------------------            ------------------------------------       ------------------
min and max delta over the timeline
max > min x 1.075 ? ProfileJob : null  --> after the track result is built:
                                           rateProfileOf(job) --- import() ---> rateProfile(source, timescale, frames, span)
                                           track.rateProfile = result            one pass over the deltas, in order
```

- The job is a closure over the timeline's delta source: run-length stts runs for MP4 (no per-frame array on the fast path), the sorted PTS for Matroska. Nothing is computed for CFR tracks, and a failed import leaves `rateProfile` null instead of failing the file.
- `RateProfile` is plain data (segments, anomalies, buckets, flags and a summary string), so it crosses the worker boundary and lands in the JSON export unchanged. The card shows the `uneven` badge from `rateProfile.uneven` and renders the panel through `React.lazy`.
- The algorithm, its thresholds and its known gaps are in [implementation-notes.md section 11](implementation-notes.md#11-rate-profile).

## JSON export

Download JSON and Copy JSON produce one document:

```ts
interface ExportDocument {
  schema: 'video-fps-probe/export@1';
  app: { name: string; version: string; build: string | null; buildTime: string | null; commit: string | null };
  environment: Environment;          // userAgent, userAgentData (brands, mobile, platform, high-entropy hints), platform,
                                     // language, hardwareConcurrency, deviceMemory, maxTouchPoints, screen, viewport,
                                     // timezone, crossOriginIsolated, timestamp; unavailable values are null
  settings: { matroskaMode: MatroskaMode };
  results: (FileResult & { compare?: Record<string, FileResult> })[];
}
```

- `results` are the own `FileResult` objects in display order, each with a `compare` object when engine runs finished.
- `build` is the file name of the page's hashed entry chunk (for example `index-uMRvdkcZ.js`), so exports from different devices show whether they ran the same deployed build. `buildTime` and `commit` come from the `VITE_BUILD_TIME` and `VITE_COMMIT` environment variables at build time (Vite exposes `VITE_*` variables) and are null when the build does not set them.
- The copy path starts the clipboard write synchronously inside the click handler (Safari rejects a write after an `await`), which is why the chunk is preloaded on idle after the first result, before the export buttons matter.

## Test layers

| Layer | Runs | Checks |
|---|---|---|
| vitest (`npm test`) | Node, `src/core` on the fixture files through `fs.openAsBlob` | units, every manifest row, rate profiles, engine contracts, device info and export with fake navigators |
| comparison (`npm run compare`) | Node, all engines against `fixtures/ref` | every field against ffprobe 8.1.1 under the research tolerances; gates on the own engine |
| benchmark (`npm run bench`, `scripts/bench/integration.mjs`) | installed Chrome (and Edge) over the DevTools Protocol, real file input | timings, bytes, memory, main-thread blocking, Node identity of every result |
| end-to-end (`npm run test:e2e`) | Playwright Chromium, Firefox and WebKit against a `vite preview` of the build, or `E2E_BASE_URL` | browser results equal Node field by field, the UI flows, the export, the 360 px layout, keyboard access |
| CI ([ci.yml](../.github/workflows/ci.yml)) | Ubuntu | job `verify`: typecheck, lint, vitest, comparison, build, size budgets; job `e2e`: the Playwright suite in all three browsers |
