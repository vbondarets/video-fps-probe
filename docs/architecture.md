# Architecture

The package computes FPS statistics for video files from their container headers, without decoding. Parsing runs in module Web Workers by default; `src/core` has no DOM dependency, so the same code runs in a worker, in the calling thread (`worker: 'inline'`, SSR) and in Node (tests, the comparison script, the root `analyze()`). The public API is in [api.md](api.md) and the bundler side in [bundlers.md](bundlers.md). The binding formulas and tolerances are in [research.md](research.md); where the code differs from them, and why, is in [implementation-notes.md](implementation-notes.md).

```
src/
  index.ts, analyze.ts, probe.ts   root entry: createProbe (default flavor) and the in-thread analyze()
  lazy.ts                          lazyProbe stub of the default flavor
  api/                             ProbeError, summarize, compareResults (no worker, no parser)
  check/                           check(result, rules): upload limits, a module with no imports
  presets/                         provider limits as check() rules, a module with no imports
  client/                          probe client: routing, WorkerPool, fallback, compare, inline runner, lazy stubs
  plugins/                         engine descriptors; the only modules with a worker literal
  worker/                          worker runtime, the v1 protocol and the prebuilt worker entries
  engines/                         mp4box.js, mediabunny and requestVideoFrameCallback adapters
  core/                            reader, sniffing, statistics, rate profile, the ISO BMFF and Matroska parsers
demo/                              the demo app, a consumer of the package (demo/README.md)
scripts/                           build-lib, check-dist, size tools, the ffprobe comparison, benches, fixtures
tests/                             vitest suites, e2e, consumer fixtures and dist parity
```

## Module map

### Core (`src/core`, no DOM)

| Path | Role |
|---|---|
| `types.ts` | Result model (`FileResult`, `VideoTrackResult`, `Rational`, `Provenance`, `ScanDepth`), options (`AnalyzeOptions`, `CostModel` with `perReadMs`, `bytesPerMs`, `perBlockMs`) and the `ContainerAnalyzer` contract |
| `reader.ts` | `BlobReader`: the only IO path. One primitive `read(offset, length)` over `Blob.slice().arrayBuffer()`, `readMany` with bounded concurrency, `view()` / `viewExact()` / `bytes()` over up to 4 cached windows, IO counters, abort checks and big-endian DataView helpers (`u8` .. `u64`, `i64`, `fourcc`). 64-bit values above 2^53-1 are rejected |
| `rational.ts` | Exact BigInt port of FFmpeg `av_reduce`, `avgFrameRate(ts, N, D)`, ffprobe-style `num/den` strings |
| `stats.ts` | `analyzeTimeline`: container-independent timeline statistics (research 4.3). Input is run-length segments (MP4) or a PTS array (Matroska); output is average, presented frames, duplicates, tail exclusion, VFR rule, min/max, nominal and dominant rate, plus a deferred rate profile job when the frame intervals differ by more than 7.5%. `rateProfileOf(job)` loads `segments.ts` and runs the job |
| `segments.ts` | `rateProfile`: CUSUM segmentation of the frame intervals, anomalies (rate change, freeze, gap, burst), the uneven flag, the summary line and the sparkline buckets. Lazy chunk, imported only by `rateProfileOf` |
| `rfps.ts` | `ffprobeRates`: the `avg_frame_rate` and `r_frame_rate` that ffprobe estimates for a Matroska track without DefaultDuration, from the first packets of every track in file order (`avformat_find_stream_info` and `ff_rfps_calculate` of FFmpeg 8.1.1, re-implemented). Lazy chunk, imported only by the Matroska parser, which passes in its block walker ([implementation notes](implementation-notes.md#ffprobe-frame-rates-without-defaultduration-020)) |
| `sniff.ts` | Container detection from the first bytes, never from the file name; names known non-video signatures in the error |
| `options.ts` | Defaults and `resolveOptions`: read-ahead sizes (head 64 KiB, fragment 1 MiB, Matroska scan 1 MiB, tail 256 KiB), cost model (0.8 ms per read, 500 kB/ms, 0.0002 ms per block or laced frame), exact-scan budget (150 ms), expansion limit (5M samples, also the Matroska PTS array cap), `predictReadMs` |
| `result.ts` | `emptyAnalysis()`, `emptyTrack()`, `primaryTrack()` shared by the parsers, engines, API and demo |
| `abort.ts` | `throwIfAborted(signal)`: the abort check of every read, written out because `AbortSignal.throwIfAborted` needs Chrome 100, above the floor |
| `dispatch.ts` | `analyzeWith(blob, name, opts, analyzerOf)`: timing, head read, sniffing, dispatch to the analyzer `analyzerOf` returns for the sniffed container, error capture. It references no parser, so a worker entry that imports one parser statically does not pull in the other |
| `analyze.ts` | `analyze(blob, name, opts)`: `analyzeWith` with `DEFAULT_LOADERS`, which load the container parser with a dynamic `import()` on first use, together with `stats.ts` |
| `index.ts` | Barrel of the core modules for tests and scripts; not a package entry |

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

### Comparison engines (`src/engines`)

| Path | Role |
|---|---|
| `types.ts` | Engine-native detail types (`Mp4boxNative`, `MediabunnyNative`, `RvfcDetails`) and result types |
| `counting.ts` | `CountingBlob`: wraps a blob to count reads and unique bytes for library engines; timing helpers |
| `common.ts` | Helpers shared by the engines (`applyStats`, `approxRational`, `ffprobeRotation`, `codecNameFromFourcc`, `newResult`) |
| `mp4box.ts` | `analyzeWithMp4box`: mp4box 2.4.1 fed box by box; durations from the parsed stts, never from the last sample |
| `mediabunny.ts` | `analyzeWithMediabunny`: mediabunny 1.62.1 over a `CustomSource`; native `averagePacketRate` kept as the average |
| `rvfc.ts` | `estimateWithRvfc`: `requestVideoFrameCallback` playback estimate, main thread only; `hosted(host)` is the engine module the `rvfc()` descriptor loads |

Each engine module exports `run` and `containers` (the `EngineModule` contract). Engines import `src/core` pieces (types, reader, rational, result, sniff, stats, options) but never `analyze.ts` or `index.ts`, so they do not pull in the own parsers. `mp4box.ts` and `mediabunny.ts` are the only modules that import a peer, and only `import()` reaches them.

### Worker runtime (`src/worker`)

| Path | Role |
|---|---|
| `protocol.ts` | `PROTOCOL_VERSION = 1` and the typed request and response messages |
| `serve.ts` | `serveProbeWorker(engines)`: installs `self.onmessage`, loads engine sources on first use (in parallel with `core/stats.ts`), gates engines by container family, one `AbortController` per job, progress throttled to 50 ms, warm requests. Imports no parser |
| `runtime.ts` | the `./worker-runtime` entry: `serveProbeWorker` from `serve.ts`, and `ownEngine`, the core `analyze` as an `EngineModule` whose `warm` loads the parser chunks |
| `single.ts` | `singleContainerEngine(kind, analyzer)`: own for one container family with its parser imported statically; a file of the other family is an error result that keeps the sniffed container, so a fallback chain moves on |
| `own-isobmff.worker.ts`, `own-matroska.worker.ts` | `serveProbeWorker({ own: singleContainerEngine(...) })` with the ISO BMFF or the Matroska parser: the two own workers of the default flavor, and the inputs of the two split standalone files |
| `own.worker.ts` | `serveProbeWorker({ own: ownEngine })`: the input of the combined `dist/standalone/own.worker.js` only |
| `mp4box.worker.ts` | `serveProbeWorker({ own: ownEngine, mp4box: () => import('../engines/mp4box.ts') })` |
| `mediabunny.worker.ts` | the same with mediabunny |

### Descriptors (`src/plugins`)

| Path | Role |
|---|---|
| `types.ts` | `EngineModule` (`run`, `containers`, optional `warm`), `EngineDescriptor` (`id`, `thread`, `createWorker`, `load`, `loadOwn`), `ContainerFamily`, `WorkerEngineId` |
| `own.ts` | `ownDescriptor`, internal: `createWorkers`, the two worker literals of the own workers keyed by container family, and `load` of the runtime for the calling thread. Reachable only from `.` and `./lazy` |
| `mp4box.ts`, `mediabunny.ts` | `mp4box()`, `mediabunny()`: their worker literal, `load` of the engine (with the statistics chunk) and `loadOwn` |
| `rvfc.ts` | `rvfc({ host })`: `thread: 'main'`, no worker, `load` of `engines/rvfc.ts` |

### Client (`src/client`) and API helpers (`src/api`)

| Path | Role |
|---|---|
| `client/probe.ts` | `createProbeCore`: builds the route of every engine, owns the pools, runs `analyze`, `tryAnalyze`, `prewarm`, `dispose` and `destroy`; it takes the split routes as `split` and imports none of them |
| `client/create.ts` | `createProbeClient`: `createProbeCore` with split routes whose runner imports `route.ts` on the first own analysis, so it imports none of `route.ts` statically |
| `client/probe-client.ts` | `loadProbeClient`, the factory of `lazyProbeClient`: `createProbeCore`, after an `import()` of `route.ts` only for a custom worker with `byContainer` |
| `client/route.ts` | `runByHead`, the runner of a split route: it picks the pool of a family with `familyOf(file, signal)` (the first 4 bytes of the file; never rejects); `splitRoute`, the route of the own workers and of `byContainer` with that runner. `createProbe` imports it statically, `loadProbeClient` only for `byContainer` and `createProbeClient` on the first own analysis with `byContainer`, so a custom worker without `byContainer` loads none of it |
| `client/split.ts` | `splitBy(runner)`: a split route, whose pool of a container family is the worker of the family or else the worker of the route, and whose `warmPools` gives `prewarm` the pool of each family it is given without reading a file |
| `client/pool.ts` | `WorkerPool`: one pool per worker kind, queue, timeouts, cancel, idle termination |
| `client/fallback.ts` | `runChain`: the fallback chain, `attempts`, skipped results; a lazy chunk loaded only for chains or skips |
| `client/compare.ts` | `compare`: per-engine outcomes and the agreement; a lazy chunk |
| `client/inline.ts` | `runInline`: an engine in the calling thread with abort, timeout and the containers gate; a lazy chunk |
| `client/stub.ts`, `client/lazy.ts` | `lazyStub`, `lazyProbeClient`, `lazyProbeFrom` |
| `client/types.ts`, `client/index.ts` | the public types and the `./client` entry |
| `api/errors.ts`, `api/guards.ts` | `ProbeError`; `isAbortError` and `isTimeoutError`, which check the name and the code so that the entry chunk of a lazy host holds only the class |
| `api/summary.ts` | `summarize` |
| `api/agreement.ts` | `compareResults` and the agreement rules |
| `index.ts`, `probe.ts`, `analyze.ts`, `lazy.ts` | the root entry (`createProbe` registers `ownDescriptor` first), the in-thread `analyze()` and `lazyProbe` |

## Two flavors

Bundlers emit a worker file for every `new Worker(new URL('...', import.meta.url))` literal they find in the module graph, also behind `import()` and also when the code never runs (Vite 8 matches the literal in every module it loads). The package therefore comes in two flavors:

- **Default** (`.`, `./lazy`): `createProbe` registers `ownDescriptor`, so the two own workers are built in.
- **Client** (`./client`, `./client/lazy`): no descriptor is built in; the host passes `worker: { create, engines }`, `'inline'` or prebuilt descriptors. A host with a custom worker pays for exactly one worker file.

**Literal hygiene.** Worker literals live only in `plugins/own.ts`, `plugins/mp4box.ts` and `plugins/mediabunny.ts`. The static and dynamic import closure of `./client`, `./client/lazy`, `./rvfc`, `./worker-runtime` and `./engines/*` reaches none of them, and no other `new URL(..., import.meta.url)` of a worker or standalone file. `check-dist` enforces it on the built `dist/`, and the size matrix asserts the worker files of each consumer build.

## Worker kinds and routing

A worker kind is a worker script: `own-isobmff`, `own-matroska`, `mp4box`, `mediabunny` (the prebuilt ones), `custom` (the host's) or `custom-<family>` (a `byContainer` worker). Each kind has its own `WorkerPool`. At creation the probe computes one route per engine id:

- an engine listed on the custom worker runs there;
- `own` otherwise runs on the worker of the default engine when that descriptor has `loadOwn` (mp4box, mediabunny), else on the own workers, else on any descriptor with `loadOwn`, else in the calling thread when inline;
- the own workers and a custom worker with `byContainer` give a split route (`splitRoute`): its runner first reads the first 4 bytes of the file with `familyOf`, then takes the pool of that family (`own-isobmff` or `own-matroska`, `custom-<family>` or `custom`). `1A 45 DF A3` goes to the Matroska worker and everything else to the ISO BMFF worker; that is the first branch of `sniff()` exactly, so the route never disagrees with the worker's own sniff. The read is bounded by the call's `signal` and by `destroy()`, and is not counted in `io`. `compare` still groups engines by the route's kind, `own` or `custom`;
- `prewarm` sends one warm request per pool, with the engines on it and the union of their containers; a split route adds only the pools of the families it is given, through `warmPools`, so a pool that it shares with another engine (`create` for a family without a `byContainer` worker) gets one request and starts one worker;
- any other engine runs on its descriptor's worker, or through its `load()` in the calling thread when the descriptor is `thread: 'main'` (rvfc) or the probe is inline;
- an engine listed only on the custom worker gets an `unsupported-environment` route when the probe is inline.

Creation throws `ProbeError('engine-not-registered')` when `own`, the default `engine` or a `fallback` id has no route. Inline is `worker: 'inline'` or no `Worker` global.

## WorkerPool

```
run(request, { signal, timeoutMs, onProgress, engine })
  queue (FIFO) --> free slot? reuse : (slots < size ? spawn : wait)
  postMessage { v: 1, id, ...request }      timer starts here when timeoutMs > 0
  <-- progress   forwarded unless the job already settled
  <-- result | skipped | warmed   resolve, slot released, idle timer armed
  <-- error      reject: 'aborted' when aborted, else the code ('unknown-engine', 'protocol') or 'worker-failed'
                 ('worker-failed' has reason 'load' when the reply carries it, else 'crash')
```

- `size` is the `workers` option (default 1). Workers spawn on demand and terminate after `idleTimeoutMs` idle (default 30 s; 0 keeps them).
- Timeout: reject `timeout` and terminate the worker at once; the next job spawns a new one.
- Abort: a queued job is removed and rejected at once; a running job is rejected at once and its worker gets `cancel`, and the worker is terminated if it has not replied within `KILL_AFTER_MS` (1.5 s).
- A worker `error` event rejects its job with `worker-failed` and drops the worker. Before the worker's first reply it is a load failure (`reason: 'load'`, the script did not load, did not parse or threw at the top level; the event's message, if any, follows the load message): while another worker of the pool is alive, the job goes back to the front of the queue and the pool spawns no more workers until the next `run`; with no worker left, the job and every queued job are rejected with it. Otherwise it is a crash (`reason: 'crash'`). A throwing `create()` rejects the job it was spawned for, with `reason: 'load'`.
- `dispose()` terminates idle workers; `destroy()` rejects every queued and running job with `aborted` and terminates every worker.

## Protocol v1

```ts
type WorkerRequest = { v: 1; id: number } & (
  | { type: 'analyze'; file: Blob; name: string; engine: WorkerEngineId; options: WireOptions }
  | { type: 'warm'; engines: readonly WorkerEngineId[]; containers: readonly ContainerFamily[] }
  | { type: 'cancel' }
);

type WorkerResponse = { v: 1; id: number } & (
  | { type: 'progress'; progress: AnalyzeProgress }
  | { type: 'result'; result: FileResult }
  | { type: 'skipped'; reason: 'unsupported-container'; family: ContainerFamily | null }
  | { type: 'warmed' }
  | { type: 'error'; message: string; aborted: boolean; code?: 'unknown-engine' | 'protocol'; reason?: 'load' }
);
```

- The `File` is cloned by reference, so no bytes are copied. `signal` and `onProgress` cannot cross the boundary; the worker builds them per job id.
- A message with another `v`, a malformed analyze or warm request, or an unknown type gets `error` with code `protocol`. An engine the worker was not given gets `unknown-engine`. A lazy engine source, or the statistics chunk loaded next to it, that fails to load gets `error` with `reason: 'load'`.
- For an engine with a `containers` list, the runtime sniffs the container family first and replies `skipped` for any other.
- `progress` is sent at most once per 50 ms. Phases: `fragments` (ISO BMFF, every 64 moofs), `matroska-exact` (bytes after the first Cluster), `read` and `analyze` (mp4box), `packets` (mediabunny).
- `warm` loads the listed engines and calls their `warm(containers)`; for own that loads the parser chunks of those containers. A failed `warm` replies `error` with `reason: 'load'` unless it has a `code`.

## Lazy stubs

`lazyStub(factory, known)` is all a host keeps in its critical bundle: `lazyProbe` passes `() => import('./probe.ts').then((m) => m.createProbe(options))`, `lazyProbeClient` the same for `loadProbeClient`, which imports `route.ts` before it builds the routes when the custom worker has `byContainer`, `lazyProbeFrom` any factory. The first `analyze`, `tryAnalyze`, `compare`, `prewarm` or `load()` runs the factory once (retried after a failure) and every call is forwarded. `destroy()` aborts a load in flight and destroys the probe when it arrives. The stub is what the size matrix measures as the critical path.

## Data flow

```
main thread                         worker (module)                       core
-----------                         ---------------                       ----
probe.analyze(file)                                                       
  [stub: import() of the client]
  route of the engine
  split route: familyOf(file), 4 bytes -> own-isobmff | own-matroska
  -> WorkerPool(kind).run
     postMessage {analyze} -------> serveProbeWorker: load engine ------> BlobReader(file)
                                    (own: the parser of the worker's      read head window (64 KiB) or a small file whole, 1 read
                                    family, or ownEngine = core analyze   sniff(head) -> isobmff | matroska | unknown
                                    in a custom worker)                   custom worker: import() of that parser and stats.ts (first use)
                                                                          analyzeIsoBmff / analyzeMatroska(reader, opts)
                                                                             timeline -> analyzeTimeline() (+ profile job)
                                                                          profile job? import() of segments.ts
                                                                          FileResult + io { reads, bytesRead, ms }
     {progress} / {result} <------- postMessage
  single engine: the result; a chain or a skip: import() of fallback.ts
```

- The head window read by `analyze` stays in the reader cache, so a faststart MP4 or a Matroska header usually needs no second read. A file below the single-read size (the head window plus `perReadMs x bytesPerMs` of the cost model, 465,536 bytes by default, at most 1 MiB) is read whole in that first read, and `readMany` serves ranges that a cached window already holds.
- `io.bytesRead` counts unique bytes fetched; overlapping reads are not counted twice. `io.ms` covers the analysis where it runs, without the chunk loads.
- The rate profile runs after the statistics of a track, inside the same `analyze` call. A track whose intervals are all within 7.5% of each other has no job and never loads `segments.ts`.
- Cancellation: every read checks the signal before and after the fetch, and `analyze` rethrows the abort instead of returning a result. Every other failure becomes `FileResult.error`; `analyze` never throws for a bad file.

**ISO BMFF.** Top-level walk: `ftyp`, then `moov` read exactly (a moov at the end costs one extra read of the remainder), `moof` windows with read-ahead and sidx or mfra prefetch, `mfra` stops the walk. Then the ffprobe header extent is emulated, each video track is built (rates, edit window, timeline segments into `analyzeTimeline`), the primary track is picked and the format duration is computed.

**Matroska.** Stage A header (budget 5 reads and 1 MiB, with resync) gives tracks, DefaultDuration, Duration and tags. Mode `header` stops there. Otherwise the first Cluster is found, the block density is sampled and a scan plan is costed. When the video track has no DefaultDuration, `rfps.ts` is loaded first and walks the first Clusters until ffprobe would stop, for the rates ffprobe estimates. `auto` runs the exact scan when the prediction is within the budget (150 ms by default) and the sampled probe otherwise. Exact walks every block header and feeds the PTS array to `analyzeTimeline`; probe samples clusters from Cues plus a tail scan and never reports an average.

**Library engines.** mp4box and mediabunny run on their prebuilt worker (or a custom worker that serves them) through the same protocol; the runtime imports the engine on its first job and returns a `FileResult` tagged with its engine. rvfc runs on the main thread through `runInline` and plays the file in a visible host element; it has no IO counters.

## Chunks

| Chunk | Contents | Loaded by | When |
|---|---|---|---|
| stub | `lazyStub` and the lazy entry | the host's entry chunk | page load (the critical path) |
| probe client | `client/probe.ts`, `pool.ts` and, in the default flavor, `route.ts`, `split.ts` and the own descriptor; for `lazyProbeClient`, `client/probe-client.ts`; for `createProbeClient`, `client/create.ts` and `split.ts` | `import()` in the stub | first call or `prewarm()` |
| split routing | `client/route.ts`, with `split.ts` for `lazyProbeClient`, for a custom worker of the client flavor | `import()` in the client, only with `byContainer` | right after the client, before the routes are built (`lazyProbeClient`); on the first own analysis (`createProbeClient`) |
| own worker of a family | `worker/own-isobmff.worker.ts` or `own-matroska.worker.ts`: runtime, reader, sniff, options, result builders, the statistics and that family's parser | the worker literal of the family, default flavor | first file of that family |
| fallback, compare, inline | `client/fallback.ts`, `client/compare.ts` with `api/agreement.ts`, `client/inline.ts` | `import()` in the client | first chain or skip, first `compare`, first in-thread run |
| worker entry | runtime, reader, sniff, options, result builders | the worker literal of the kind (mp4box, mediabunny, a custom worker) | first job of that kind |
| statistics | `core/stats.ts` and what it shares | `import()` with each parser or engine, in parallel | first parser or engine, once per worker |
| ISO BMFF, Matroska | `src/core/isobmff`, `src/core/matroska` | `import()` in `core/analyze.ts`, in every worker but the two own workers, which hold their parser | first file of that container, once per worker |
| segments | `core/segments.ts` (rate profile) | `import()` in `stats.ts` | first track with unequal intervals, once per worker |
| rfps | `core/rfps.ts` (ffprobe frame rate estimate) | `import()` in the Matroska parser | first Matroska track without DefaultDuration in probe or exact mode, once per worker |
| mp4box, mediabunny | the library and its adapter | `import()` in the runtime | first job of that engine |
| rVFC | `engines/rvfc.ts` | `import()` from the `rvfc()` descriptor, main thread | first rvfc run |
| main-thread copies | runtime and parsers for the calling thread | `import()` in the inline route or the root `analyze()` | only inline, without `Worker`, or a root `analyze()` |

Where a bundler places modules shared by several lazy chunks can change between builds; the size tools classify them as shared chunks.

## Build and package checks

**`scripts/build-lib.mjs`** (`npm run build:lib`, also run by `prepack`):

1. Deletes `dist/`.
2. Runs `tsc -p tsconfig.lib.json`: per-module ES2022 output with declarations.
3. Rewrites worker URLs from `.worker.ts` to `.worker.js` in the emitted JavaScript.
4. Rewrites relative `.ts` specifiers to `.js` in the emitted `.d.ts` files (TypeScript 6 rewrites them only in JavaScript).
5. Deletes every `.d.ts` that the types of no export or `typesVersions` target reach through `import`, `export ... from` or `import()` types: the declarations of the parsers, the statistics and the worker files, which the `exports` map gives no way to import.
6. Builds the standalone files `dist/standalone/own.worker.js`, `own-isobmff.worker.js` and `own-matroska.worker.js` with rolldown: each is one minified IIFE file, no code splitting.

**`scripts/check-dist.mjs`** (`npm run check:package` after publint, and `prepack`) fails on any of:

- a file outside the whitelist (`dist/{index,lazy,analyze,probe}` and `dist/{core,engines,worker,client,api,plugins,react,check,presets,standalone}/**` as `.js` and `.d.ts`), or a pack listing with anything but those plus `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md`;
- an unpacked package size above the cap (`UNPACKED_CAP`, 580 KB, README and CHANGELOG included; in 0.2.0 it went from 450 to 460 KB when the H.264 slice header check of the ffprobe frame rate estimate took the package to 450.1 KB, to 470 KB when `video-fps-probe/react` took it past 460 KB, and to 480 KB when the CHANGELOG and README grew with the last 0.2.0 entries; in 0.3.0 to 580 KB, when the two per-container standalone files took it to about 563 KB). The cap bounds the install footprint in `node_modules`, not the size of a host bundle: a bundler takes only the modules a host imports, and the size matrix below budgets that. It leaves room for the README and the CHANGELOG, which grow with every release;
- an export or `typesVersions` target that does not exist, an import that does not resolve inside `dist/`, a `.ts` specifier, a `.d.ts` import without a `.d.ts` behind it, a `.d.ts` that no exported entry's types reach;
- a worker reference that is not a literal `.js` URL to an existing file, or a literal outside the three plugin modules; the literal hygiene above;
- worker isolation: the static and dynamic closure of `worker/own-isobmff.worker.js` reaching `core/matroska/`, `core/rfps.js` or `core/analyze.js`, or of `worker/own-matroska.worker.js` reaching `core/isobmff/` or `core/analyze.js`, so each per-container worker holds only its own parser; both are also roots of the literal hygiene;
- peer isolation: the static closure of the entries and plugins reaching a parser, an engine adapter or a bare `mp4box` or `mediabunny` import; a peer imported anywhere but the two engine adapters, or by a `.d.ts`;
- an import of any module, static or `import()`, in `dist/check/index.js` or `dist/presets/index.js`;
- `import.meta.env`, the demo's test hook, a DOM global in a worker file;
- an entry that throws when imported in plain Node (the SSR check).

`node scripts/check-dist.mjs --self-test` checks the checker on synthetic trees. In CI the package job also runs attw (`npm run check:types`) and the package suite (`npm run test:package`: `dist/` analyzes every committed fixture exactly like `src/`, and every name `docs/api.md` gives an entry resolves from that entry of the packed tarball).

**Size matrix.** `npm run consumers:setup` packs the package and installs the tarball, Vite, the peers and React into a directory outside the repository, and the tarball with React 18 into its `react18/` subdirectory, both with `--strict-peer-deps`, so a peer range of the package that React 19 or 18 does not satisfy fails the setup; the `react18` fixture's Vite config aliases `react` and `react-dom` to that subdirectory. Neither install has a lockfile, so npm `overrides` pin every package Vite and the peers pull in to its `package-lock.json` version (`lockedOverrides` in `scripts/consumers.mjs`) and the three packages React 18 pulls in to fixed versions: without them a fresh npm cache takes the newest patch inside Vite's `rolldown: ~1.2.14`, and rolldown 1.2.15 renamed every main-thread chunk of four fixtures on CI while a warm cache kept 1.2.14 (the same rolldown on Windows and Linux emits byte-identical files); the size matrix fails when any installed copy of a pinned package, nested copies included, differs from its pin, and when the `react18/` install has another version of React, ReactDOM or the three packages they pull in, or lacks one (`pinDrift` in `scripts/consumers.mjs`). `npm run consumers:build` builds every fixture of `tests/consumers/fixtures/` with hidden sourcemaps; `scripts/size-matrix.mjs` measures them (the critical path cut out of the entry chunk by its sourcemap, lazy totals, worker files), checks must-not-exist modules against the sourcemap `sources` and the request chains, enforces the budgets and compares with the committed `report/size-matrix.*`. The same builds run in the consumer smoke test.

## Demo

`demo/` is a React app and a consumer of the package. It imports `video-fps-probe/client/lazy`, `video-fps-probe/client`, `video-fps-probe/rvfc`, `video-fps-probe/worker-runtime` and `video-fps-probe/engines/*` by package name, and only types from `video-fps-probe`; `scripts/src-aliases.mjs` maps those names to `src/` for the demo build, the TypeScript paths and vitest, derived from the `exports` map and checked by `npm run check:aliases`. Its store holds `lazyProbeFrom(() => import('./probe.ts').then((m) => m.probe))`, and `probe.ts` creates a client with a custom worker (`probe.worker.ts`, serving own, mp4box and mediabunny), `engines: [rvfc()]`, `workers: 2` and `idleTimeoutMs: 0`, so the demo build has exactly one worker file. An analysis that fails with `reason: 'load'`, or a result whose error is a chunk import failure, runs one deploy check (`ui/deploy.ts`: the page fetched with `cache: 'no-store'` against the entry script that is running) and shows a reload banner when another build is deployed ([deploy skew](bundlers.md#deploy-skew)). Its sizes are budgeted by `node scripts/size-report.mjs demo/dist --check`. See [demo/README.md](../demo/README.md).

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

Each `VideoTrackResult` field can carry a provenance tag in `provenance`. The demo shows it as a one-letter mark with a tooltip, and the legend under its summary line lists all five.

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
- `RateProfile` is plain data (segments, anomalies, buckets, flags and a summary string), so it crosses the worker boundary and lands in the JSON export unchanged. The demo card shows the `uneven` badge from `rateProfile.uneven` and renders the panel from a lazy chunk; a chunk that fails to load shows a Retry button that imports it again.
- The algorithm, its thresholds and its known gaps are in [implementation-notes.md section 11](implementation-notes.md#11-rate-profile).

## Demo JSON export

The demo's Download JSON and Copy JSON produce one document:

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
- `build` is the file name of the page's hashed entry chunk (for example `index-uMRvdkcZ.js`), so exports from different devices show whether they ran the same deployed build. `buildTime` and `commit` come from the `VITE_BUILD_TIME` and `VITE_COMMIT` environment variables at build time and are null when the build does not set them. The demo's Vite config writes them into `index.html` as `build-time` and `build-commit` meta tags instead of the bundle: a value inlined into a chunk renamed that chunk, every chunk that imports it, and so every lazy chunk on each deploy, docs-only deploys included, which broke the first file in every tab opened before the deploy ([deploy skew](bundlers.md#deploy-skew)).
- The copy path starts the clipboard write synchronously inside the click handler (Safari rejects a write after an `await`), which is why the chunk is preloaded on idle after the first result, before the export buttons matter.

## Scripts and data

| Path | Role |
|---|---|
| `scripts/build-lib.mjs`, `scripts/check-dist.mjs` | the library build and the package checks above |
| `scripts/src-aliases.mjs` | package exports mapped to `src/` for the demo, the TypeScript paths and vitest; `--check` |
| `scripts/consumers.mjs`, `scripts/size-matrix.mjs` | consumer fixtures from the packed tarball and the package size matrix; `setup --latest` installs the latest Vite, rolldown, mp4box and mediabunny for the canary |
| `scripts/canary-summary.mjs` | the job summary of the canary: each arm of a comparison run against the committed `report/accuracy.json`, fixture by fixture, and the mp4box and mediabunny runs of the smoke test that differ from Node (`--smoke`); exit 1 when an own check changed, never for a library arm |
| `scripts/size-report.mjs` | chunk sizes and budgets of the demo build (`demo/dist`), the request chain check |
| `scripts/compare-ffprobe.ts`, `scripts/compare/` | compares engines with the ffprobe references and writes `report/accuracy.*`; exit 1 on an unexpected own mismatch |
| `scripts/bench/` | Chrome DevTools Protocol drivers: `run-bench.mjs` (timings, Node identity check, screenshots) and `integration.mjs` (cost of embedding in a host SPA); they drive the demo through its test hook |
| `scripts/readme-tables.ts` | rewrites the generated blocks of the README, `docs/benchmarks.md`, `docs/bundlers.md` and `report/README.md` from the JSON reports |
| `scripts/release-prep.mjs` | the `preversion` and `version` steps of `npm version`: gates, the CHANGELOG section and every report the version moves, staged into the release commit ([releasing](releasing.md)); the release notes file of the GitHub Release (`--notes <version> --out <file>`) and the tag check of the Release workflow (`--publish-check <tag>`) |
| `scripts/fixtures/` | fixture generator, reference extraction and patch tools |
| `fixtures/` | `files/` (126 committed fixtures), `manifest.tsv`, `ref/*.ref.json` (ffprobe 8.1.1), `known-deviations/*.json`, `large/` (git-ignored) |
| `report/` | generated accuracy, size, size matrix, browser benchmark and integration cost reports, and the hand-written average-user model |

## Test layers

| Layer | Runs | Checks |
|---|---|---|
| vitest (`npm test`) | Node: `src/` on the fixture files through `fs.openAsBlob`, the API with a fake worker | units, every manifest row, rate profiles, engine contracts, the worker runtime, the pool, routing, fallback, compare, timeouts, deadlines, lazy stubs, demo device info and export |
| dist parity and API types (`npm run test:package`) | Node, after `build:lib` | `dist/` gives the same results as `src/` on every committed fixture; every name `docs/api.md` gives an entry resolves from that entry of the packed tarball (tsc) |
| comparison (`npm run compare`) | Node, all engines against `fixtures/ref` | every field against ffprobe 8.1.1 under the research tolerances; gates on the own engine |
| demo end-to-end (`npm run test:e2e`) | Playwright Chromium, Firefox and WebKit against a `vite preview` of the demo, or `E2E_BASE_URL` | browser results equal Node field by field, the UI flows, the export, the 360 px layout, keyboard access |
| consumers (`npm run test:consumers`) | Playwright Chromium, Firefox and WebKit against the consumer fixtures under `vite build` and `vite dev` | results equal Node `analyze` from the same tarball; no dev reload when an engine first runs; with `CONSUMERS_LIBRARY_REPORT=<dir>` the mp4box and mediabunny results are informational: each run is written to `<dir>` instead of asserted, and the own results are still asserted |
| benchmark (`npm run bench`, `scripts/bench/integration.mjs`) | installed Chrome (and Edge) over the DevTools Protocol, real file input | timings, bytes, memory, main-thread blocking, Node identity of every result |
| CI ([ci.yml](../.github/workflows/ci.yml)) | Ubuntu | job Verify: typecheck, lint, aliases, vitest, comparison, demo build, size budgets, generated tables; job Node 22.12: vitest, `build:lib`, dist parity and API types on the lowest supported Node; job Package: check-dist self-test, `build:lib`, publint and check-dist, attw, dist parity and API types; job End-to-end: the demo suite in three browsers; job Consumers: the size matrix, the generated tables and the smoke test from the packed tarball |
| Canary ([canary.yml](../.github/workflows/canary.yml)) | Ubuntu, weekly and by hand | the latest mp4box and mediabunny in the comparison, the latest Vite, rolldown and peers in the consumer fixtures: the comparison of every arm, the size matrix and the smoke test; red only when an own result changes or a size check fails, never when only a library arm changes: the comparison gates on the own engine, and the smoke test asserts the own results only (`CONSUMERS_LIBRARY_REPORT`); the changes of the library arms, in the comparison and in the smoke test, go to the job summary |
