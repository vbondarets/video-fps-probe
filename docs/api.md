# API

Everything the package exports, by entry, with options, defaults, errors and the result schema. The [README](../README.md) has the short version; [bundlers.md](bundlers.md) covers worker setup per bundler, and [architecture.md](architecture.md) how the pieces fit together.

The package is ESM only, targets ES2022 and ships its own types. Every entry except the standalone worker file can be imported in Node and during SSR: nothing touches `Worker`, `window` or `document` at import time.

## Entries

| Entry | Exports | Worker literal in the build |
|---|---|---|
| `video-fps-probe` | `createProbe`, `analyze`, `summarize`, `compareResults`, `ProbeError`, `isAbortError`, `isTimeoutError`, all types | the own worker |
| `video-fps-probe/lazy` | `lazyProbe`, `lazyProbeFrom`, `LazyProbe`, `ProbeOptions` | the own worker |
| `video-fps-probe/client` | `createProbeClient`, `summarize`, `compareResults`, `ProbeError`, `isAbortError`, `isTimeoutError`, all types | none |
| `video-fps-probe/client/lazy` | `lazyProbeClient`, `lazyProbeFrom`, `ClientOptions`, `LazyProbe`, `Probe` | none |
| `video-fps-probe/mp4box` | `mp4box()` descriptor | the mp4box worker |
| `video-fps-probe/mediabunny` | `mediabunny()` descriptor | the mediabunny worker |
| `video-fps-probe/rvfc` | `rvfc(options)` descriptor, `RvfcPluginOptions` | none (main thread) |
| `video-fps-probe/worker-runtime` | `serveProbeWorker`, `ownEngine`, `EngineSource` | none |
| `video-fps-probe/engines/mp4box` | the mp4box.js engine module (`run`, `containers`, `analyzeWithMp4box`, `MP4BOX_VERSION`) | none |
| `video-fps-probe/engines/mediabunny` | the mediabunny engine module (`run`, `containers`, `analyzeWithMediabunny`, `MEDIABUNNY_VERSION`, `NATIVE_STATS_MAX_PACKETS`) | none |
| `video-fps-probe/standalone/own.worker.js` | a classic worker file, no imports, serving own | it is the worker |

There are two flavors because bundlers emit a worker file for every `new Worker(new URL(..., import.meta.url))` they see in the module graph, whether or not it runs:

- **Default flavor** (`video-fps-probe`, `video-fps-probe/lazy`): the own engine and its prebuilt worker are built in. Use it unless you build your own worker.
- **Client flavor** (`video-fps-probe/client`, `video-fps-probe/client/lazy`): no worker is built in. You pass a worker, `'inline'`, or prebuilt descriptors. A host with its own worker uses this flavor so the unused own worker is never emitted.

The `mp4box` and `mediabunny` descriptors each carry their own prebuilt worker, which serves that engine and own. `rvfc`, `worker-runtime` and `engines/*` never reach a worker literal. `check-dist` enforces all of this on every build.

## Probes

### createProbe (default flavor)

```ts
function createProbe<const E extends readonly EngineDescriptor[] = []>(options?: ProbeOptions<E>): Probe<'own' | IdOf<E[number]>>;

interface ProbeOptions<E> extends BaseOptions<'own' | IdOf<E[number]>> {
  engines?: E; // descriptors: mp4box(), mediabunny(), rvfc()
  worker?: 'auto' | 'inline'; // default 'auto'
}
```

Registers own with its prebuilt worker plus the given descriptors. `worker: 'inline'` runs every engine in the calling thread through lazy chunks; it is also chosen automatically when there is no `Worker` global (Node, SSR).

### createProbeClient (client flavor)

```ts
function createProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(
  options: ClientOptions<E, W>,
): Probe<W | IdOf<E[number]> | 'own'>;

interface ClientOptions<E, W> extends BaseOptions<W | IdOf<E[number]> | 'own'> {
  worker: CustomWorker<W> | 'inline'; // required
  engines?: E;
}

interface CustomWorker<W extends WorkerEngineId> {
  create: () => Worker; // keep the new Worker(new URL(...)) literal here, in your code
  engines: readonly W[]; // the engines your worker serves: 'own' | 'mp4box' | 'mediabunny'
}
```

Own must be routable: list it on the custom worker, pass `worker: 'inline'`, or register a prebuilt `mp4box()` or `mediabunny()` descriptor (each also serves own). Otherwise `createProbeClient` throws `ProbeError('engine-not-registered')`.

### BaseOptions (both flavors)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `engine` | engine id | `'own'` | default engine of `analyze` and `tryAnalyze` |
| `fallback` | engine ids | `[]` | default fallback chain, tried in order after `engine` |
| `workers` | number | `1` | workers per worker kind (own, mp4box, mediabunny, custom); values below 1 or not finite give 1 |
| `idleTimeoutMs` | number | `30_000` | an idle worker is terminated after this; `0` keeps workers alive |
| `timeoutMs` | number | none | per attempt, from the moment a worker takes the job; also bounds the warm request of `prewarm()` |
| `defaults` | `WireOptions` | none | parser options merged under every call's own options |

Creating a probe throws `ProbeError('engine-not-registered')` when `engine` or a `fallback` id has no route.

### Lazy stubs

```ts
function lazyProbe<const E extends readonly EngineDescriptor[] = []>(options?: ProbeOptions<E>): LazyProbe<'own' | IdOf<E[number]>>; // video-fps-probe/lazy
function lazyProbeClient<const E extends readonly EngineDescriptor[] = [], const W extends WorkerEngineId = never>(options: ClientOptions<E, W>): LazyProbe<W | IdOf<E[number]> | 'own'>; // video-fps-probe/client/lazy
function lazyProbeFrom<Id extends EngineId>(factory: () => Promise<Probe<Id>>): LazyProbe<Id>; // both lazy entries

type LazyProbe<Id> = Probe<Id> & { readonly loaded: boolean; load(): Promise<Probe<Id>> };
```

A stub is what you keep in the critical bundle. It imports the probe client with a dynamic `import()` on the first `analyze`, `tryAnalyze`, `compare`, `prewarm` or `load()`, then forwards every call.

- `load()` is idempotent; a failed load is retried on the next call. Creating a stub never throws: an option error such as an unregistered `engine` surfaces on the first call.
- A failed load rejects with the factory's error as it is, not with a `ProbeError`. For the built-in stubs that is the browser's dynamic-import error (a `TypeError`), for example when the probe client chunk returns 404 after a redeploy, so check `e instanceof ProbeError` before reading `e.code`. `tryAnalyze` still resolves `null` and `prewarm` still resolves.
- `engines` lists the ids known from the options before the load, and the routed ids after it.
- `dispose()` on a stub that has not loaded does nothing. `destroy()` also stops a load in flight. From then on `analyze` and `compare` reject with `ProbeError('aborted')`, calls that were waiting for the load included, `tryAnalyze` resolves `null`, and `prewarm` resolves without loading anything.
- `lazyProbeFrom` wraps any factory, for example a module of your own that calls `createProbeClient` with your worker literal: `lazyProbeFrom(() => import('./probe.ts').then((m) => m.probe))`. The demo does this.

### Probe

```ts
interface Probe<Id extends EngineId = 'own'> {
  readonly engines: readonly Id[];
  analyze(file: Blob, options?: CallOptions<Id>): Promise<ProbeResult>;
  tryAnalyze(file: Blob, options?: CallOptions<Id>): Promise<ProbeResult | null>;
  compare<K extends Id>(file: Blob, options?: CompareOptions<K>): Promise<CompareResult<K>>; // experimental
  prewarm(options?: { engines?: readonly Id[]; containers?: readonly ContainerFamily[] }): Promise<void>;
  dispose(): void;
  destroy(): void;
}

interface CallOptions<Id> extends WireOptions {
  engine?: Id; // default: the probe's engine
  fallback?: readonly Id[]; // default: the probe's fallback
  name?: string; // default: File.name, or '' for a Blob
  host?: HTMLElement; // rvfc only: the visible element to play the file in
  signal?: AbortSignal;
  timeoutMs?: number; // default: the probe's timeoutMs
  onProgress?: (progress: AnalyzeProgress) => void; // { phase, done, total }, at most every 50 ms from a worker
}
```

- **`analyze`** resolves with the result of the first engine of the chain (`engine`, then `fallback`, duplicates removed). A file that cannot be analysed is a result with `error` set, not a rejection. A probe rejects only with a `ProbeError`: an abort, a timeout, a failed worker, or an engine that is not registered. A lazy stub can also reject with the import error of its own load ([Lazy stubs](#lazy-stubs)).
- **Fallback.** With a chain of two or more, the next engine runs when the current one returns an error, no video track or no frame rate, skips the container (mp4box on WebM), times out or crashes. An abort stops the chain at once. If every engine fails, the result of the last engine that returned one comes back, with `attempts` listing the others (`{ engine, error }`); if none returned a result, the last error rejects.
- **`tryAnalyze`** is `analyze` that resolves `null` instead of rejecting.
- **`prewarm`** loads ahead of the first file: the probe client (for a stub), the worker, and the parser chunks for `containers` (default `['isobmff']`), for `engines` (default: the probe's `engine`). One warm request goes to each worker kind; in-thread engines load their chunks. It never rejects.
- **`dispose`** terminates idle workers now. Busy workers finish their job; the next call starts new workers.
- **`destroy`** rejects every queued and running job with `ProbeError('aborted')` and terminates every worker. After it, `analyze` and `compare` reject with `ProbeError('aborted')`, `tryAnalyze` resolves `null`, and `prewarm` does nothing.

### Workers, queues and timeouts

Each worker kind has its own pool of `workers` workers, started on demand. Jobs queue first in, first out.

- **Timeout.** `timeoutMs` starts when a worker takes the job, not while it waits in the queue. When it fires, the call rejects with `ProbeError('timeout')`, the worker is terminated at once (it is presumed stuck), and the next job starts a new worker. In the calling thread (`'inline'`, rvfc) the call rejects and the engine's signal is aborted.
- **Abort.** A queued job is removed and rejected at once. A running job is rejected at once and its worker gets a `cancel`; the worker is reused when it acknowledges, or terminated after 1.5 s. Pass one `signal` to every call of a batch to cancel the whole batch, queued jobs included.
- **Main-thread loads.** Neither `signal` nor `timeoutMs` covers code downloaded on the main thread: the probe client of a lazy stub, and the fallback, compare and inline chunks. A stalled download keeps the call pending; only `destroy()` ends it. The worker script and the chunks a worker loads do count toward `timeoutMs`.
- **Crashes.** A worker `error` event rejects its job with `ProbeError('worker-failed')` and the worker is replaced on the next job.
- **Routing of own.** Own runs on the custom worker if it lists own; otherwise on the worker of the default engine when that engine also serves own (mp4box, mediabunny); otherwise on the own worker; otherwise on the worker of the first registered descriptor that also serves own. Inline, the same order picks the in-thread modules, with the built-in in-thread own last. So `createProbe({ engines: [mp4box()], engine: 'mp4box', fallback: ['own'] })` starts one worker for both engines.
- **Inline.** In the calling thread each engine loads as a lazy chunk. An engine listed only on a custom worker (mp4box or mediabunny without its descriptor) cannot run there and rejects with `ProbeError('unsupported-environment')`.

### Cancellation and failing open

For an upload flow that must go on when the check cannot finish:

```ts
probe.prewarm(); // when the upload dialog opens: the client, the worker and the MP4 parser

const deadline = new AbortController(); // AbortSignal.timeout needs Chrome 103, above the browser floor
const late = new Promise<null>((resolve) => setTimeout(() => (deadline.abort(), resolve(null)), 5000));
const checks = Promise.all(files.map((f) => probe.tryAnalyze(f, { timeoutMs: 3000, signal: deadline.signal })));
const results = await Promise.race([checks, late]);
// results null, an entry null, or summarize(entry).ok false: upload without the check
```

- `tryAnalyze` resolves `null` wherever `analyze` would reject, a failed stub load included.
- `timeoutMs` bounds each job once a worker takes it; queued jobs are not timed. Aborting the shared signal rejects queued jobs at once and cancels the running ones, so their `tryAnalyze` resolves `null`.
- Neither bounds the [main-thread loads](#workers-queues-and-timeouts). `prewarm()` moves the probe client download to the dialog open, and the race bounds the batch even when a download stalls.

### WireOptions (parser options)

Accepted by `CallOptions`, `defaults` and the root `analyze`. They cross the worker boundary as data.

| Option | Default | Meaning |
|---|---|---|
| `matroskaMode` | `'auto'` | `'header'`: headers only; `'probe'`: sampled blocks (no frame count or average); `'exact'`: every block header; `'auto'`: exact when the predicted cost is within `exactBudgetMs`, else probe |
| `exactBudgetMs` | `150` | budget for the predicted exact-scan cost in `auto` mode |
| `readAhead` | `{ head: 65536, fragment: 1048576, matroskaScan: 1048576, tail: 262144 }` | read window sizes in bytes: the first read, ISO BMFF fragment read-ahead, Matroska scan windows, Matroska tail scan |
| `costModel` | `{ perReadMs: 0.8, bytesPerMs: 500000, perBlockMs: 0.0002 }` | the exact-scan cost prediction: `reads x perReadMs + bytes / bytesPerMs + blocks x perBlockMs` |
| `maxExpandedSamples` | `5_000_000` | most samples or blocks expanded into per-frame statistics; above it the statistics are skipped with a warning |

Progress phases: `fragments` (ISO BMFF, every 64 fragments), `matroska-exact` (bytes after the first Cluster), `read` and `analyze` (mp4box), `packets` (mediabunny), `play xN` (rvfc).

## In-thread analyze

```ts
function analyze(input: Blob | BlobLike, options?: InThreadOptions): Promise<ProbeResult>; // video-fps-probe

interface InThreadOptions extends AnalyzeOptions { // WireOptions plus signal and onProgress
  name?: string; // default: File.name, or ''
  engine?: EngineDescriptor; // default: own
}

interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
```

Runs in the calling thread, without a worker: for Node, scripts and tests. `analyze(await fs.openAsBlob(path), { name: path })` in Node; in Node 24 `openAsBlob` wraps the size of files above 4 GiB modulo 2^32, so pass a `BlobLike` over a file handle for those. The parser chunks load with `import()` on first use. `{ engine: mp4box() }` or `{ engine: mediabunny() }` runs that library instead (the peer must be installed). With own it rejects only on an abort (the signal's reason, or an `AbortError`); a library engine can also reject when its chunk fails to load, and rvfc without a host or a DOM.

## Engines

### Descriptors

```ts
function mp4box(): EngineDescriptor<'mp4box'>; // video-fps-probe/mp4box, needs the mp4box peer (^2.4.1)
function mediabunny(): EngineDescriptor<'mediabunny'>; // video-fps-probe/mediabunny, needs the mediabunny peer (^1.62.0)
function rvfc(options?: { host?: HTMLElement | (() => HTMLElement) }): EngineDescriptor<'rvfc'>; // video-fps-probe/rvfc

interface EngineDescriptor<Id extends EngineId = EngineId> {
  readonly id: Id;
  readonly thread: 'worker' | 'main';
  readonly createWorker?: () => Worker; // the prebuilt worker of mp4box and mediabunny
  readonly load: () => Promise<EngineModule>; // the engine for the calling thread, by dynamic import
  readonly loadOwn?: () => Promise<EngineModule>; // mp4box and mediabunny also serve own
}
```

| Engine | Containers | Notes |
|---|---|---|
| `own` | MP4, MOV, WebM, Matroska | the default; exact rationals, provenance, rate profile |
| `mp4box` | MP4, MOV | other containers are skipped (`unsupported by mp4box`); durations come from the stts box, not the last sample; verified with mp4box 2.4.1 (`MP4BOX_VERSION`); BSD-3-Clause; needs Safari 16.4 (class static blocks) |
| `mediabunny` | MP4, MOV, WebM, Matroska | its average is the packet rate; reads whole Matroska clusters; verified with mediabunny 1.62.0 (`MEDIABUNNY_VERSION`); MPL-2.0 |
| `rvfc` | anything the browser plays | main thread; plays the file muted in a 320 px video element appended to `host`; every value is `estimated`; needs a visible foreground tab; never part of a default compare set or fallback chain |

The host of rvfc comes from the per-call `host`, else from `rvfc({ host })`. Without one, or without a DOM, it rejects (`worker-failed` and `unsupported-environment` respectively).

- The peers are optional and never installed with the package: `npm install mp4box` or `npm install mediabunny` (or the yarn, pnpm or bun equivalent). Importing `video-fps-probe/mp4box` or `video-fps-probe/mediabunny` without its peer fails the build, because the peer cannot be resolved.
- Engine ids are typed from what you register: `engine: 'mp4box'` without `mp4box()` is a type error, and `ProbeError('engine-not-registered')` at run time.

### Custom worker

```ts
// fps.worker.ts, in the host app
import { ownEngine, serveProbeWorker } from 'video-fps-probe/worker-runtime';

serveProbeWorker({
  own: ownEngine,
  mp4box: () => import('video-fps-probe/engines/mp4box'),
});
```

```ts
function serveProbeWorker(engines: Partial<Record<WorkerEngineId, EngineSource>>): void; // installs self.onmessage
type EngineSource = EngineModule | (() => Promise<EngineModule>);
const ownEngine: EngineModule;

interface EngineModule<R extends FileResult = FileResult> {
  readonly run: (blob: BlobLike, name: string, opts: AnalyzeOptions) => Promise<R>;
  readonly containers: readonly ContainerFamily[] | 'any'; // 'isobmff' | 'matroska'
  readonly warm?: (containers: readonly ContainerFamily[]) => Promise<void>;
}
```

A loader function runs on the first job for that engine, in parallel with the shared statistics chunk, and is retried after a failure. When an engine lists `containers`, the runtime sniffs the file first and replies `skipped` for any other container. Pair the worker with `createProbeClient` or `lazyProbeClient` and list the same engines in `worker.engines`; recipes per bundler are in [bundlers.md](bundlers.md#custom-combined-worker).

### Standalone worker

`video-fps-probe/standalone/own.worker.js` is the own worker as one minified classic script with no imports. Load it as a classic worker (no `type: 'module'`) through the client flavor:

```ts
import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import ownWorkerUrl from 'video-fps-probe/standalone/own.worker.js?url'; // Vite; other bundlers: copy the file and use its URL

export const probe = lazyProbeClient({ worker: { create: () => new Worker(ownWorkerUrl), engines: ['own'] } });
```

## Results

### ProbeResult and FileResult

```ts
type ProbeResult = FileResult & {
  mp4box?: Mp4boxNative; // experimental: what the library reported natively
  mediabunny?: MediabunnyNative; // experimental
  rvfc?: RvfcDetails; // experimental: display rate, passes, confidence, flags
  attempts?: readonly { engine: EngineId; error: string }[]; // engines of a fallback chain that failed before this result
};
```

| `FileResult` field | Type | Meaning |
|---|---|---|
| `name`, `size` | string, number | the file name passed or read from the `File`, and its size in bytes |
| `container` | `'mp4' \| 'mov' \| 'webm' \| 'matroska' \| 'unknown'` | from the ftyp brand or the EBML DocType |
| `brand` | string or null | major brand or DocType |
| `formatDurationSec` | number or null | the format duration ffprobe prints |
| `scan` | `'header' \| 'probe' \| 'exact'` or null | how far a Matroska scan went; null for ISO BMFF |
| `videoTracks` | `VideoTrackResult[]` | every video track |
| `audioTrackCount` | number | audio tracks seen |
| `primaryTrackId` | number or null | the track the summary uses: the enabled ISO BMFF track with the most samples, or the first Matroska video track |
| `error` | string or null | why the file could not be analysed, for example `not a recognised container: PNG image` |
| `warnings` | string[] | file-level warnings in plain words |
| `io` | `{ reads, bytesRead, ms }` | `Blob.slice()` reads, unique bytes read, and the analysis time in the thread that ran it (chunk loading excluded) |
| `engine` | `'own' \| 'mp4box' \| 'mediabunny' \| 'rvfc'` | which engine produced the result |

### VideoTrackResult

| Field | Meaning |
|---|---|
| `trackId`, `fourccOrCodecId`, `codecName` | track id, sample entry or CodecID, and ffprobe's `codec_name` |
| `width`, `height`, `rotation`, `timescale` | display size, rotation in degrees as ffprobe reports it, ticks per second |
| `frames` | stored samples or blocks (ffprobe `nb_frames`, or `nb_read_packets` for fragmented MP4 and Matroska) |
| `presentedFrames` | frames inside the first non-empty edit (ffprobe `nb_read_frames`); equals `frames` without an edit list |
| `durationSec`, `startSec` | track duration and start |
| `avgFps` | `Rational`: presented frames over the presentation span |
| `avgFpsFfprobe` | the `avg_frame_rate` string ffprobe 8.1.1 prints, or null when it cannot be reproduced |
| `rFpsFfprobe` | ffprobe's `r_frame_rate` when it can be reproduced (equal intervals), else null |
| `nominalFps` | `Rational & { kind: 'exact' \| 'snapped' \| 'declared' }`: the rate when every interval is equal, a standard rate when CFR timestamps jitter, or the declared Matroska rate |
| `dominantFps` | `{ rate, share }` for a VFR track where one interval covers at least half of the frames; `share` counts frames |
| `minFps`, `maxFps` | from the longest and the shortest frame interval |
| `isVfr` | true when any interval differs from the median by more than `max(1 tick, 0.5%)`, plus 1 ms on millisecond grids ([the VFR rule](benchmarks.md#statistics-and-the-vfr-rule)); null when unknown |
| `vfrRatio`, `distinctDeltas` | share of intervals off the median, number of distinct intervals |
| `duplicateTimestamps` | frames sharing a timestamp (excluded from the statistics) |
| `timestampsQuantized` | CFR content on 1 ms ticks (Matroska, MP4 remuxed from Matroska) |
| `isStill` | a single frame or a still image track |
| `rateProfile` | `RateProfile` or null; only for tracks whose intervals differ by more than 7.5% and not only by timestamp rounding (Matroska only after an exact scan) |
| `provenance` | `Partial<Record<TrackField, Provenance>>`: where each value came from |
| `warnings` | track-level warnings in plain words |

`Rational` is `{ num, den, value }`, reduced exactly the way FFmpeg's `av_reduce` does. The exact rules and how each value maps to ffprobe are in [benchmarks.md](benchmarks.md#ffprobe-equivalence).

### RateProfile

| Field | Meaning |
|---|---|
| `segments` | up to 50 `{ startSec, endSec, frames, fps, kind: 'steady' \| 'variable' }` |
| `moreSegments` | how many segments were left out |
| `anomalies` | up to 50 `{ kind: 'rate-change' \| 'freeze' \| 'burst' \| 'gap', atSec, durationSec, fromFps, toFps }` |
| `moreAnomalies` | how many anomalies were left out |
| `buckets` | `{ bucketSec, fps[] }`: frames per second in up to 120 buckets, for a sparkline |
| `uneven` | the steady segments within one 15% band cover less than 80% of the time or the frames, or steady segments differ by more than 15% |
| `dominantShare` | the time share of that dominant band |
| `summary` | one line starting with `Steady`, `Mostly steady` or `Uneven`, for example `Uneven: 5 fps for 4 s, 200 fps for 4 s` |

### Provenance

| Tag | Meaning |
|---|---|
| `header` | read from the container headers |
| `exact` | computed from every sample or block timestamp |
| `sampled` | from a sample of Matroska blocks (probe mode); never used for an average |
| `estimated` | derived under an assumption, such as a playback measurement (rvfc) |
| `computed` | a value ffprobe prints as N/A, computed here (a Matroska frame count) |

### summarize

```ts
function summarize(result: FileResult): VideoFpsSummary; // video-fps-probe, video-fps-probe/client
```

Flattens the primary track: `ok`, `name`, `container`, `engine`, `fps` (`avgFps.value`), `fpsRational` (`'num/den'`), `nominalFps`, `frames` (`presentedFrames ?? frames`), `durationSec` (track, else format), `width`, `height`, `rotation`, `isVfr`, `minFps`, `maxFps`, `approximate`, `error` and `warnings` (file and track). `ok` is false and `error` is set when the result has an error, no video track (`no video track`) or no average (`no frame rate`). `approximate` is true when the average, the nominal rate or the frame count is `estimated` or `sampled`.

## Compare and agreement

`compare` is experimental: its shape can change in a minor release.

```ts
interface CompareOptions<K> {
  engines?: readonly K[]; // default: every registered engine except rvfc
  reference?: K; // default: own when it has a usable result, else the first engine with one; null when the given one has none
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: AnalyzeProgress & { engine: K }) => void;
}

interface CompareResult<K> {
  name: string;
  size: number;
  reference: K | null;
  outcomes: Partial<Record<K, EngineOutcome>>;
  agreement: Agreement<K>;
}

type EngineOutcome =
  | { status: 'ok'; result: ProbeResult; ms: number }
  | { status: 'failed'; result: ProbeResult; error: string; ms: number } // error, no video track or no frame rate
  | { status: 'skipped'; reason: 'unsupported-container' | 'unsupported-environment' }
  | { status: 'timeout' | 'crashed'; error: ProbeError };
```

Engines on different worker kinds run in parallel, engines that share a worker kind one after another, and rvfc on the main thread at the same time. The probe's `defaults` apply; per-call parser options do not. An abort rejects the whole call; an unregistered engine rejects with `engine-not-registered`.

```ts
function compareResults<K extends EngineId>(results: Partial<Record<K, FileResult>>, reference?: K): Agreement<K>;

interface Agreement<K> {
  reference: K | null;
  engines: K[]; // engines with a usable primary track
  fields: { field: 'avgFps' | 'nominalFps' | 'minFps' | 'maxFps' | 'frames' | 'durationSec'; values: Partial<Record<K, Rational | number | null>>; agree: boolean | null; differ: K[] }[];
  agree: boolean | null;
}
```

Agreement rules, applied to the primary track of every result without an error:

- Rationals (`avgFps`, `nominalFps`, `minFps`, `maxFps`) must be equal after reduction. A 0.003 relative tolerance applies only when either side's provenance for that field is `estimated` or `sampled`.
- Frames (`presentedFrames ?? frames`) must be equal.
- Durations must agree within 1e-6 s.
- Each engine is compared with the reference. A field's `agree` is null when nothing could be compared (the reference or every other engine has no value); the overall `agree` is null when no field was decided, else true only when every decided field agrees.

## Errors

```ts
class ProbeError extends Error {
  readonly code: ProbeErrorCode; // name is 'ProbeError'
  readonly engine: EngineId | null;
  // cause: the underlying error, when there is one
}
function isAbortError(e: unknown): boolean; // ProbeError 'aborted', or any error named AbortError
function isTimeoutError(e: unknown): boolean; // ProbeError 'timeout', or any error named TimeoutError
```

| Code | When |
|---|---|
| `aborted` | the call's `signal` was aborted, or the probe was destroyed |
| `timeout` | `timeoutMs` passed after a worker took the job (or after an in-thread start) |
| `worker-failed` | a worker could not start or crashed, a chunk the probe loads failed to load (in a worker or on the main thread), or an engine threw |
| `engine-not-registered` | the engine id has no route in this probe (thrown at creation for `engine` and `fallback`, rejected at call time otherwise) |
| `unknown-engine` | the worker does not serve the engine it was asked for: `worker.engines` lists an engine that `serveProbeWorker` was not given |
| `unsupported-environment` | the engine cannot run here: a worker-only engine without `Worker`, or rvfc without a DOM |
| `protocol` | the worker speaks another protocol version or got a malformed message, usually a worker from another package version |

Problems with the file itself are never errors: they are `result.error` (and `ok: false` in `summarize`).

Every rejection of a probe is a `ProbeError`. The exception is the load of a lazy stub: when its factory rejects, the stub rejects with that error as it is ([Lazy stubs](#lazy-stubs)).

## Worker protocol

Messages carry `v: 1` (`PROTOCOL_VERSION`). Requests are `analyze { id, file, name, engine, options }`, `warm { id, engines, containers }` and `cancel { id }`; responses are `progress` (at most every 50 ms), `result`, `skipped { reason, family }`, `warmed` and `error { message, aborted, code? }`. The protocol is internal: the client and the worker must come from the same package version, and a mismatch is reported as `protocol`. A breaking protocol change bumps the version and is a major release.

## Versioning

The package follows semantic versioning, with these rules:

- **Patch**: fixes, including accuracy changes toward ffprobe.
- **Minor**: new optional result fields, new engines or entries, new options.
- **Major**: removing or retyping a field, a new major of a peer, or a higher browser floor.
- Items marked experimental here (`compare`, `CompareResult`, the native `mp4box`, `mediabunny` and `rvfc` details on `ProbeResult`) can change in a minor release.

The package stays on 0.x until a production consumer has completed a release cycle with it; during 0.x a minor release may contain breaking changes, listed in the [changelog](../CHANGELOG.md).
