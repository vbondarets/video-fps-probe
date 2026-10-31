# API

Everything the package exports, by entry, with options, defaults, errors and the result schema. The [README](../README.md) has the short version; [bundlers.md](bundlers.md) covers worker setup per bundler, and [architecture.md](architecture.md) how the pieces fit together.

The package is ESM, targets ES2022 and ships its own types. The five server entries, `video-fps-probe`, `video-fps-probe/header`, `video-fps-probe/url`, `video-fps-probe/check` and `video-fps-probe/presets`, also ship a minified CommonJS copy for `require()` where `require(esm)` is off, such as in Jest. Every entry except the standalone worker files can be imported in Node and during SSR: nothing touches `Worker`, `window` or `document` at import time. CommonJS code can `require()` every entry on Node 22.12 and newer, the lowest supported version ([CommonJS](#commonjs)).

## Entries

| Entry | Exports | Worker literal in the build |
|---|---|---|
| `video-fps-probe` | `createProbe`, `analyze`, `summarize`, `compareResults`, `ProbeError`, `isAbortError`, `isTimeoutError`, `errorCodeOf`, `errorClass`, `warningCodeOf`, `warningCodesOf`, every type on this page except `HeaderOptions`, `HeaderLimits`, `HeaderResult`, the Range types (`RangeSourceError`, `RangeSourceErrorCode`, `RangeSourceErrorOptions`, `RangeRequest`, `RangeReply`, `RangeFetcher`, `RangeSource`, `RangeSourceInit`, `OpenRangeSourceInit`, `HttpRangeInit`), `EngineSource`, `RvfcPluginOptions`, `VideoFpsProviderProps`, `UseVideoFpsOptions`, `VideoFpsState` and the check types (`CheckRules`, `CheckReport`, `CheckViolation`, `CheckVerdict`, `CheckSeverity`, `CheckExpected`, `SuggestedFps`, `FpsRule`, `FpsSource`, `AspectRatioRule`, `FrameSizeRule`, `RangeRule`, `RatioValue`, `RatePolicy`) and the preset types (`ProviderPreset`, `PresetSourceKind`) | the two own workers |
| `video-fps-probe/lazy` | `lazyProbe`, `lazyProbeFrom`, `LazyProbe`, `ProbeOptions` | the two own workers |
| `video-fps-probe/client` | `createProbeClient`, `summarize`, `compareResults`, `ProbeError`, `isAbortError`, `isTimeoutError`, every type on this page except `InThreadOptions`, `ErrorClass`, `HeaderOptions`, `HeaderLimits`, `HeaderResult`, the Range types (`RangeSourceError`, `RangeSourceErrorCode`, `RangeSourceErrorOptions`, `RangeRequest`, `RangeReply`, `RangeFetcher`, `RangeSource`, `RangeSourceInit`, `OpenRangeSourceInit`, `HttpRangeInit`), `EngineSource`, `RvfcPluginOptions`, `VideoFpsProviderProps`, `UseVideoFpsOptions`, `VideoFpsState` and the check types (`CheckRules`, `CheckReport`, `CheckViolation`, `CheckVerdict`, `CheckSeverity`, `CheckExpected`, `SuggestedFps`, `FpsRule`, `FpsSource`, `AspectRatioRule`, `FrameSizeRule`, `RangeRule`, `RatioValue`, `RatePolicy`) and the preset types (`ProviderPreset`, `PresetSourceKind`) | none |
| `video-fps-probe/client/lazy` | `lazyProbeClient`, `lazyProbeFrom`, `ClientOptions`, `LazyProbe`, `Probe` | none |
| `video-fps-probe/header` | `analyzeHeader`, `HEADER_DEFAULT_LIMITS`, `errorCodeOf`, `errorClass`, `warningCodeOf`, `warningCodesOf`, `isAbortError`, `isTimeoutError`, `HeaderOptions`, `HeaderLimits`, `HeaderResult`, `FragmentedDuration`, `ErrorClass`, `BlobLike`, `BlobSlice` and the result types of `video-fps-probe/client` such as `FileResult`, `VideoTrackResult`, `FileErrorCode` and `ContainerLayout` ([header-only analysis](#header-only-analysis)) | none |
| `video-fps-probe/url` | `rangeSource`, `openRangeSource`, `httpRange`, `readCapped`, `RangeSourceError`, `RangeSourceErrorCode`, `RangeSourceErrorOptions`, `RangeRequest`, `RangeReply`, `RangeFetcher`, `RangeSource`, `RangeSourceInit`, `OpenRangeSourceInit`, `HttpRangeInit`, `BlobLike`, `BlobSlice` ([Range source](#range-source)) | none |
| `video-fps-probe/check` | `check`, `CheckRules`, `CheckReport`, `CheckViolation`, `CheckVerdict`, `CheckSeverity`, `CheckExpected`, `SuggestedFps`, `FpsRule`, `FpsSource`, `AspectRatioRule`, `FrameSizeRule`, `RangeRule`, `RatioValue`, `RatePolicy` | none |
| `video-fps-probe/presets` | `klingO1ReferenceVideo`, `klingMotionControl`, `runwayAleph2`, `veoExtend`, `wan26ReferenceToVideoFal`, `seedance2ReferenceVideo`, `ProviderPreset`, `PresetSourceKind` | none |
| `video-fps-probe/presets/sources.json` | a JSON file, not a module: the source page of every preset, keyed by the name of its export, which replaces the deprecated sourceUrl of a preset | none |
| `video-fps-probe/react` | `VideoFpsProvider`, `useVideoFps`, `useVideoFpsProbe`, `usePrewarmVideoFps`, `VideoFpsProviderProps`, `UseVideoFpsOptions`, `VideoFpsState`, `VideoFpsSummary` | none |
| `video-fps-probe/mp4box` | `mp4box()` descriptor | the mp4box worker |
| `video-fps-probe/mediabunny` | `mediabunny()` descriptor | the mediabunny worker |
| `video-fps-probe/rvfc` | `rvfc(options)` descriptor, `RvfcPluginOptions` | none (main thread) |
| `video-fps-probe/worker-runtime` | `serveProbeWorker`, `ownEngine`, `EngineSource` | none |
| `video-fps-probe/engines/mp4box` | the mp4box.js engine module (`run`, `containers`, `analyzeWithMp4box`, `MP4BOX_VERSION`) | none |
| `video-fps-probe/engines/mediabunny` | the mediabunny engine module (`run`, `containers`, `analyzeWithMediabunny`, `MEDIABUNNY_VERSION`, `NATIVE_STATS_MAX_PACKETS`) | none |
| `video-fps-probe/standalone/own.worker.js` | a classic worker file, no imports, serving own | it is the worker |
| `video-fps-probe/standalone/own-isobmff.worker.js`, `video-fps-probe/standalone/own-matroska.worker.js` | classic worker files, no imports, serving own for one container family each, for `byContainer` | they are the workers |

There are two flavors because bundlers emit a worker file for every `new Worker(new URL(..., import.meta.url))` they see in the module graph, whether or not it runs:

- **Default flavor** (`video-fps-probe`, `video-fps-probe/lazy`): the own engine and its two prebuilt workers, one per container family, are built in. Use it unless you build your own worker.
- **Client flavor** (`video-fps-probe/client`, `video-fps-probe/client/lazy`): no worker is built in. You pass a worker, `'inline'`, or prebuilt descriptors. A host with its own worker uses this flavor so the unused own worker is never emitted.

The `mp4box` and `mediabunny` descriptors each carry their own prebuilt worker, which serves that engine and own. `rvfc`, `worker-runtime`, `header`, `url` and `engines/*` never reach a worker literal, `header` reaches neither the full ISO BMFF parser nor the statistics, and `url`, `check` and `presets` import no other module, in the ESM build and in the CommonJS copy. `check-dist` enforces all of this on every build.

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
  byContainer?: Readonly<Partial<Record<ContainerFamily, () => Worker>>>; // own only: a worker per container family
}
```

`byContainer` runs own on the worker of the file's container family, picked by the first 4 bytes of the file like the own workers of the default flavor ([routing](#workers-queues-and-timeouts)). A family without a worker, and every other engine, stays on `create`. It applies only when `engines` lists own, and it is ignored without a `Worker` global, where own runs in the calling thread. The [split standalone files](#standalone-worker) are made for it. `lazyProbeClient` loads the routing by container family as a chunk of its own, about 0.4 KB gzip, right after the probe client, and only with `byContainer`; `createProbeClient` loads the same chunk on the first own analysis, and only with `byContainer`.

Own must be routable: list it on the custom worker, pass `worker: 'inline'`, or register a prebuilt `mp4box()` or `mediabunny()` descriptor (each also serves own). Otherwise `createProbeClient` throws `ProbeError('engine-not-registered')`.

### BaseOptions (both flavors)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `engine` | engine id | `'own'` | default engine of `analyze` and `tryAnalyze` |
| `fallback` | engine ids | `[]` | default fallback chain, tried in order after `engine` |
| `workers` | number | `1` | workers per worker kind (the ISO BMFF and the Matroska worker of own, mp4box, mediabunny, custom, each `byContainer` worker); values below 1 or not finite give 1 |
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
- A failed load rejects with `ProbeError('worker-failed')`, `reason: 'load'`, the factory's error as `cause` and its text as the message: for the built-in stubs that is the browser's dynamic-import error, for example `TypeError: Failed to fetch dynamically imported module: <url>` when the probe client chunk returns 404 after a redeploy ([Errors](#errors)). A `ProbeError` the factory rejects with, such as an option error of the probe it creates, is passed through as it is. `load()` rejects the same way, `tryAnalyze` still resolves `null` and `prewarm` still resolves.
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

- **`analyze`** resolves with the result of the first engine of the chain (`engine`, then `fallback`, duplicates removed). A file that cannot be analysed is a result with `error` set, not a rejection. A probe rejects only with a `ProbeError`: an abort, a timeout, a failed worker, or an engine that is not registered. So does a lazy stub whose own load fails: `ProbeError('worker-failed')` with `reason: 'load'` and the import error as `cause` ([Lazy stubs](#lazy-stubs)).
- **Fallback.** With a chain of two or more, the next engine runs when the current one returns an error, no video track or no frame rate, skips the container (mp4box on WebM), times out or crashes. An abort stops the chain at once. If every engine fails, the result of the last engine that returned one comes back, with `attempts` listing the others (`{ engine, error }`); if none returned a result, the last error rejects.
- **`tryAnalyze`** is `analyze` that resolves `null` instead of rejecting.
- **`prewarm`** loads ahead of the first file: the probe client (for a stub), the worker, and the parser chunks for `containers` (default `['isobmff']`), for `engines` (default: the probe's `engine`). Own in the default flavor, and own with `byContainer`, starts only the worker of each family in `containers`, so `containers: []` starts none of them. One warm request goes to each worker kind, with the engines it serves and the union of their containers, so a `create` worker that serves own for a family without a `byContainer` worker and another engine gets one and starts one worker, whatever `workers` is. In-thread engines load their chunks. It never rejects.
- **`dispose`** terminates idle workers now. Busy workers finish their job; the next call starts new workers.
- **`destroy`** rejects every queued and running job with `ProbeError('aborted')` and terminates every worker. After it, `analyze` and `compare` reject with `ProbeError('aborted')`, `tryAnalyze` resolves `null`, and `prewarm` does nothing.

### Workers, queues and timeouts

Each worker kind has its own pool of `workers` workers, started on demand. Jobs queue first in, first out. With `workers: 1`, the default flavor can run one MP4 and one WebM at once, one on each own worker.

- **Timeout.** `timeoutMs` starts when a worker takes the job, not while it waits in the queue. When it fires, the call rejects with `ProbeError('timeout')`, the worker is terminated at once (it is presumed stuck), and the next job starts a new worker. In the calling thread (`'inline'`, rvfc) the call rejects and the engine's signal is aborted.
- **Abort.** A queued job is removed and rejected at once. A running job is rejected at once and its worker gets a `cancel`; the worker is reused when it acknowledges, or terminated after 1.5 s. Pass one `signal` to every call of a batch to cancel the whole batch, queued jobs included.
- **Main-thread loads.** Neither `signal` nor `timeoutMs` covers code downloaded on the main thread: the probe client of a lazy stub, and the fallback, compare and inline chunks. A stalled download keeps the call pending; only `destroy()` ends it. The worker script and the chunks a worker loads do count toward `timeoutMs`.
- **Crashes.** A worker `error` event after the worker's first reply rejects its job with `ProbeError('worker-failed')`, `reason: 'crash'` and the event's message, and the worker is replaced on the next job.
- **Load failures.** Any `error` event before the worker's first reply means the worker script cannot run: it did not load (a 404 after a redeploy, a network error, a wrong MIME type, a static import that failed), did not parse (syntax the browser does not support, or a 404 page served as `text/html` and parsed as a classic worker, which Chromium reports as `Uncaught SyntaxError: Unexpected token '<'`), or threw before it could reply. It rejects with `ProbeError('worker-failed')`, `reason: 'load'` and the message `worker script failed to load or parse; the app may have been redeployed`, followed by `: ` and the event's message when the event has one, with the event as `cause`. While another worker of that kind is still running, the job goes back to the front of the queue and waits for it, and no further worker of that kind starts until the next call. When the failed worker was the last one, its job and every queued job of that kind reject with that error at once, instead of each starting a worker that would fail the same way. The next call starts a new worker, so a load failure is retried, not remembered.
- **Routing read.** Own in the default flavor, and own with `byContainer`, picks its worker by reading the first 4 bytes of the file on the main thread: `1A 45 DF A3` (the EBML magic) goes to the Matroska worker; everything else, ISO BMFF, an unknown or empty file, a read that fails or a value that is not a `Blob`, goes to the ISO BMFF worker, which answers an unknown file with the same error result as the combined worker of 0.2.0. The read is bounded by `signal` and `destroy()`, not by `timeoutMs`, which still starts when a worker takes the job, and it is not counted in `io`. Jobs of one worker kind queue in the order their reads complete. A missing worker file of one family rejects only the jobs of that family with `reason: 'load'`.
- **Routing of own.** Own runs on the custom worker if it lists own; otherwise on the worker of the default engine when that engine also serves own (mp4box, mediabunny); otherwise on the own worker of the file's container family; otherwise on the worker of the first registered descriptor that also serves own. Inline, the same order picks the in-thread modules, with the built-in in-thread own last. So `createProbe({ engines: [mp4box()], engine: 'mp4box', fallback: ['own'] })` starts one worker for both engines.
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
| `matroskaMode` | `'auto'` | `'header'`: headers only (so no `avgFpsFfprobe` or `rFpsFfprobe` for a track without DefaultDuration); `'probe'`: sampled blocks and the first packets of a track without DefaultDuration (no frame count or average); `'exact'`: every block header; `'auto'`: exact when the predicted cost is within `exactBudgetMs` plus, for a track without DefaultDuration, the predicted cost of the first packets probe mode reads for its ffprobe estimate, else probe. A file below the single-read size (see `readAhead`) is read whole in the first read in every mode |
| `exactBudgetMs` | `150` | budget for the predicted exact-scan cost in `auto` mode, on top of the first packets probe mode would read anyway for the ffprobe estimate of a track without DefaultDuration |
| `readAhead` | `{ head: 65536, fragment: 1048576, matroskaScan: 1048576, tail: 262144 }` | read window sizes in bytes: the first read, ISO BMFF fragment read-ahead, Matroska scan windows, Matroska tail scan. A file smaller than `head + perReadMs x bytesPerMs` (465,536 bytes by default), at most 1 MiB or `head` when that is larger, is read whole in the first read |
| `costModel` | `{ perReadMs: 0.8, bytesPerMs: 500000, perBlockMs: 0.0002 }` | the exact-scan cost prediction: `reads x perReadMs + bytes / bytesPerMs + blocks x perBlockMs`; `perReadMs x bytesPerMs` also sizes the single first read, up to the 1 MiB cap (`perReadMs: 0`, or a negative or NaN product, keeps the first read at `readAhead.head`) |
| `maxExpandedSamples` | `5_000_000` | most samples or blocks expanded into per-frame statistics; above it the statistics are skipped with a warning |

Progress phases: `fragments` (ISO BMFF, every 64 fragments), `matroska-exact` (bytes after the first Cluster), `read` and `analyze` (mp4box), `packets` (mediabunny), `play xN` (rvfc).

## React

`video-fps-probe/react` puts a probe behind React hooks: a provider that takes the probe, a hook that analyzes a file and re-renders with its state, and two helpers. It works with React 18 and 19, an optional peer (`^18.0.0 || ^19.0.0`, widened in the release that tests the next React major), and needs nothing else. An app without React installs the package without it; next to another React major, npm 11 refuses the install with `ERESOLVE` (`peerOptional react@"^18.0.0 || ^19.0.0"`) unless the app passes `--legacy-peer-deps` or adds `"overrides": { "video-fps-probe": { "react": "$react" } }` to its `package.json`, at its own risk.

```tsx
import { useState } from 'react';
import { lazyProbe } from 'video-fps-probe/lazy';
import { VideoFpsProvider, useVideoFps } from 'video-fps-probe/react';

const probe = lazyProbe(); // once, at module scope: a new probe object starts a new cache

export function App() {
  return (
    <VideoFpsProvider probe={probe}>
      <Upload />
    </VideoFpsProvider>
  );
}

function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const { status, summary, error, retry } = useVideoFps(file);
  return (
    <>
      <input type="file" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
      {status === 'pending' && <p>Reading the frame rate...</p>}
      {status === 'success' && <p>{summary?.ok ? `${summary.fps?.toFixed(3)} fps${summary.isVfr ? ', variable' : ''}` : `No frame rate: ${summary?.error}`}</p>}
      {status === 'error' && <button onClick={retry}>Retry ({error?.code})</button>}
    </>
  );
}
```

```ts
function VideoFpsProvider(props: VideoFpsProviderProps): React.ReactElement;
function useVideoFps(file: Blob | null | undefined, options?: UseVideoFpsOptions): VideoFpsState;
function useVideoFpsProbe<P extends Probe<EngineId> = Probe<EngineId>>(): P;
function usePrewarmVideoFps(options?: PrewarmOptions<EngineId>): () => void;

interface VideoFpsProviderProps {
  probe: Probe<EngineId>; // required: lazyProbe(), lazyProbeClient({ ... }), createProbe() or createProbeClient({ ... })
  children?: React.ReactNode;
}

interface UseVideoFpsOptions extends Omit<CallOptions<EngineId>, 'signal' | 'onProgress'> {
  enabled?: boolean; // default true; false keeps the state idle and analyzes nothing
  progress?: boolean; // default false; true re-renders on every progress event
}

interface VideoFpsState {
  status: 'idle' | 'pending' | 'success' | 'error';
  result: ProbeResult | null; // set on success
  summary: VideoFpsSummary | null; // summarize(result), set on success
  error: ProbeError | null; // set on error
  progress: AnalyzeProgress | null; // with progress: true, while pending
  cancel(): void;
  retry(): void;
}
```

- **The provider is required.** There is no default probe, so `video-fps-probe/react` does not reach the own worker literal and suits a host with its own worker (`lazyProbeClient`). A hook outside a provider throws `ProbeError('engine-not-registered')` with the message `wrap in VideoFpsProvider`. Keep the probe object stable, at module scope or in state: the provider keys its cache by it.
- **States.** `idle` without a file or with `enabled: false`; `pending` from the first render with a file; `success` when the call resolved, a file the parsers cannot read included (`result.error` set, `summary.ok` false), as `analyze` resolves; `error` when it rejected, with the probe's `ProbeError` (`timeout`, `worker-failed` with its `reason`, `aborted`). The summary module is a lazy chunk fetched in parallel with the first analysis; if it fails to load, the state is `error` with `worker-failed` and `reason: 'load'`. Any other failure, a rejection that is not a `ProbeError` or an `analyze` that throws synchronously (both from a custom probe; a thrown `ProbeError` is kept as it is) or a summary that throws on a malformed result, is `worker-failed` with `reason: 'crash'` and the error as `cause`, so deploy-skew handling that reads `reason === 'load'` does not take it for a new deployment. With `progress: true` a component re-renders on each progress event (at most every 50 ms from a worker); without it, progress does not re-render it.
- **When it runs.** The analysis starts when the component mounts, from an effect, so server rendering and a render that React throws away start nothing. The options are the `CallOptions` of `analyze` without `signal` and `onProgress`, which the hook owns: `engine`, `fallback`, `name`, `host` (rvfc), `timeoutMs` and the parser options.
- **Cache.** Results are cached per provider in a `WeakMap` keyed by the Blob, then by the options (key order does not matter; `host` counts by identity). Another component, a re-render or a remount with the same Blob and options gets the cached state without a second analysis, and the double effects of `StrictMode` run one analysis. Finished results and errors stay cached as long as the Blob lives; `retry()` analyzes again.
- **Aborts.** When the last component using a pending analysis unmounts, switches to another file or options, or is hidden by `<Activity>`, the analysis is aborted and its cache entry goes back to pending without a run, so the next component that subscribes to it starts it again, a memoized component that `<Activity>` shows again included. The check runs in a microtask, after the current effects have run, so the remount of `StrictMode` keeps the analysis. `cancel()` aborts at once and sets `error` to `ProbeError('aborted', 'cancelled')`.
- **`useVideoFpsProbe()`** returns the provider's probe, for `compare`, `tryAnalyze` or `dispose`. Name the type when you need the stub's fields: `useVideoFpsProbe<LazyProbe<'own'>>().loaded`.
- **`usePrewarmVideoFps(options)`** returns a stable function that calls `probe.prewarm(options)` and fetches the summary module, for example on the focus of an upload button.
- **`'use client'`** is the first statement of `dist/react/index.js`, so the hooks run on the client in the Next.js App Router and other server-component frameworks. A bundler that does not know the directive, such as Vite without `@vitejs/plugin-react`, warns that it may not be preserved; outside such a framework it has no effect.

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

Runs in the calling thread, without a worker: for Node, scripts and tests. `analyze(await fs.openAsBlob(path), { name: path })` in Node. In Node 24 `openAsBlob` wraps the size of files above 4 GiB modulo 2^32, so pass a `BlobLike` over a file handle for those. The parser chunks load with `import()` on first use. `{ engine: mp4box() }` or `{ engine: mediabunny() }` runs that library instead (the peer must be installed). With own it rejects on an abort (the signal's reason, or an `AbortError`) and, with the import error as it is, when the chunk with the worker runtime fails to load. A parser or statistics chunk that fails to load is not a rejection: own returns a result whose `error` is the import error's message. A library engine also rejects when its chunk fails to load, and rvfc without a host or a DOM. The type declarations name DOM types such as `Worker` and `HTMLElement`, so a TypeScript project for Node compiles them with `"DOM"` in `lib` or with `skipLibCheck: true`, and without either `tsc` reports `TS2304: Cannot find name 'Worker'`. The declarations of `video-fps-probe/header`, `video-fps-probe/url`, `video-fps-probe/check` and `video-fps-probe/presets` name no DOM type, so a server that imports only those compiles with `"lib": ["ES2022"]`, `"types": ["node"]` and no `skipLibCheck`, which `tests/package/dom-free.test.ts` checks from an ESM and a CommonJS file.

### CommonJS

Node 22.12 and newer load an ES module from `require()` (`require(esm)`), so CommonJS code takes the package as it is, every entry included, and no entry has a top-level `await`. Node 22.12 prints an `ExperimentalWarning` for it, Node 24 prints nothing. Node 22.12 is the lowest supported version, since Node 20 is past its end of life.

The five server entries, `video-fps-probe`, `video-fps-probe/header`, `video-fps-probe/url`, `video-fps-probe/check` and `video-fps-probe/presets`, also ship a CommonJS copy in `dist/cjs`, minified like the standalone worker files but with the names of its classes and functions kept, so `error.name`, `error.constructor.name` and the `name` of every export equal the ESM build, with `.d.cts` declarations, for the loaders that do not run `require(esm)`. Each of them takes these conditions, with its own files:

```json
".": {
  "module-sync": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "module": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "require": { "types": "./dist/cjs/index.d.cts", "default": "./dist/cjs/index.cjs" },
  "types": "./dist/index.d.ts",
  "default": "./dist/index.js"
}
```

| Loader | Server entries resolve to | Why |
|---|---|---|
| Node 22.12 and newer, `import` or `require()` | the ESM build, one instance | `module-sync`, with `require(esm)` on by default |
| Node with `--no-experimental-require-module`, `require()` | the CommonJS copy, a second instance next to the ESM one | `require` |
| Jest 30 without vm modules, in the node environment | the CommonJS copy | Jest resolves `require()` with `require`, `default` and the `node` condition of the environment |
| Jest 30 without vm modules, in the jsdom environment | the CommonJS copy | derived from Jest's conditions, `require`, `default` and the `browser` condition of the environment, which no server entry lists, and not run by the tests |
| Jest 30 with `--experimental-vm-modules` on Node older than 24.9 | the CommonJS copy | Jest adds `module-sync` only where it can evaluate ES modules from `require()` |
| Jest 30.5 with `--experimental-vm-modules` on Node 24.9 and newer | the ESM build | Jest adds `module-sync` when it can evaluate ES modules from `require()` |
| Vite, webpack, Rspack and esbuild with their default conditions, `import` or `require()` | the ESM build | `module`, so no browser bundle holds the CommonJS copy. The tests build with Vite only. A configuration whose conditions leave out `module`, such as custom condition names, gets the CommonJS copy, which a browser build cannot run because it requires `url` |
| TypeScript `node16` or `nodenext`, a CommonJS file | the `.d.cts` declarations | `require` |
| TypeScript, an ES module file or `bundler` | the `.d.ts` declarations | `types` |
| TypeScript `node10` | the `.d.ts` declarations | `typesVersions` |
| a tool that reads no `exports` map | `dist/cjs/index.cjs` | `main` |

The other entries (`lazy`, `client`, `client/lazy`, `react`, `mp4box`, `mediabunny`, `rvfc`, `worker-runtime`, `engines/*` and the standalone worker files) stay ESM only. The CommonJS copy has no `import.meta` and no `import()`: the parser chunks load lazily through `require()`, and the root entry turns the worker URLs into file URLs that only the worker factories of `createProbe` build. In Node, where `Worker` is undefined, `createProbe` runs the own engine in the calling thread, so those factories, and the file URLs, are never called. It requires no peer and no builtin but `url`, and the copies of `url`, `check` and `presets` require nothing, which `check-dist` enforces.

**Two copies in one process.** Where `require(esm)` is off, an app that mixes `import` and `require()` loads both copies. Their module state is only caches, so a result of one copy is a plain object that the other copy's `check`, `errorCodeOf` and `warningCodesOf` read as their own. Each copy has its own classes, so test errors with `isAbortError`, `isTimeoutError` and the `name` and `code` of `ProbeError` and `RangeSourceError`, not with `instanceof`. `tests/package/dual-instance.test.ts` loads both copies under `--no-experimental-require-module` and checks all of this.

```js
const { openAsBlob } = require('node:fs');
const { analyze } = require('video-fps-probe');
const { check } = require('video-fps-probe/check');
const { klingO1ReferenceVideo } = require('video-fps-probe/presets');

openAsBlob(path)
  .then((blob) => analyze(blob, { name: path }))
  .then((result) => console.log(check(result, klingO1ReferenceVideo.rules).verdict));
```

A TypeScript project that compiles to CommonJS, such as a NestJS 11 app (`"module": "commonjs"`, `moduleResolution` `node10`, `skipLibCheck: true`), writes `import { analyze } from 'video-fps-probe'` and gets a `require()` in its output. `moduleResolution: node10` reads no `exports` map, so the package also lists every subpath's types under `typesVersions`; TypeScript 6.0 needs `"ignoreDeprecations": "6.0"` for `node10`, TypeScript 5.9 does not. `tests/package/commonjs.test.ts` installs the packed tarball, `require()`s it from a `.cjs` file and compiles such a project with TypeScript 6.0.3 and with 5.9.3 (the nested project `tests/package/ts59`, with its own `package.json` and `package-lock.json`, so its `tsc` stays out of the repo's `node_modules/.bin`: CI installs it with `npm ci --prefix tests/package/ts59` before the package tests, which fail in CI without it; locally the test installs it with `npm ci --offline` and an empty npmrc, and skips the 5.9.3 cases with a message when the npm cache lacks it), runs `analyze` on an MP4 and `check` with a preset, and compares both with the source, on Node 24 and on Node 22.12 in CI.

`tests/package/commonjs.test.ts` also checks from the packed tarball that `require.resolve` of every server entry lands on its ESM file by default and on its `.cjs` file under `--no-experimental-require-module`, with the results of the source either way, and `tests/package/cjs-parity.test.ts` checks that the CommonJS copy exports the names of the ESM build and gives its results on every committed fixture, with `analyze`, `analyzeHeader`, a Range source and every preset.

### Jest

Jest 30 runs the server entries with no configuration and with `jest` as the only dependency. A test file writes `const { analyze } = require('video-fps-probe')`, `const { analyzeHeader } = require('video-fps-probe/header')` or `const { rangeSource } = require('video-fps-probe/url')`. Without vm modules Jest loads the CommonJS copy, and Jest 30.5 with `NODE_OPTIONS=--experimental-vm-modules` on Node 24.9 and newer loads the ESM build from `require()`. `tests/package/jest-plain` and `tests/package/jest-vm` prove both. They are nested projects with their own `package.json` and `package-lock.json`, Jest 30.5.2 alone and the same test file, which calls `analyze` and `analyzeHeader` on an MP4, `analyzeHeader` over a `rangeSource`, `check` with a preset and the guards, and `tests/package/jest-plain.test.ts` and `jest-vm.test.ts` compare its results with the source. CI installs them with `npm ci --prefix tests/package/jest-plain` on Node 24 and 22.12 and `npm ci --prefix tests/package/jest-vm` on Node 24. Locally the tests install them with `npm ci --offline` and an empty npmrc, and skip with a message when the npm cache lacks Jest.

The other entries, such as `video-fps-probe/lazy`, `video-fps-probe/mp4box` and `video-fps-probe/mediabunny`, are ESM only and reach `import.meta.url`, which is a syntax error in a CommonJS module, so Jest without vm modules needs babel-jest to transform them:

```js
// jest.config.cjs, with jest, babel-jest, @babel/core, @babel/plugin-transform-dynamic-import,
// @babel/plugin-transform-modules-commonjs and babel-plugin-transform-import-meta installed
module.exports = {
  testEnvironment: 'node',
  transformIgnorePatterns: ['/node_modules/(?!video-fps-probe/)'],
  transform: {
    '\\.[cm]?js$': ['babel-jest', { plugins: ['babel-plugin-transform-import-meta', '@babel/plugin-transform-dynamic-import', '@babel/plugin-transform-modules-commonjs'] }],
  },
};
```

`transformIgnorePatterns` lets babel-jest into the package, `babel-plugin-transform-import-meta` rewrites `import.meta.url`, and `@babel/plugin-transform-dynamic-import` turns the `import()` of the parser chunks into `require()`, which Jest needs without `--experimental-vm-modules`. A test file then writes `const { analyze } = require('video-fps-probe')` and `const { check } = require('video-fps-probe/check')`. Unit tests that need no real result can instead map the package to a stub of their own, such as `moduleNameMapper: { '^video-fps-probe$': '<rootDir>/test/stubs/video-fps-probe.cjs' }` with an `analyze` that resolves a fixed result.

`tests/package/jest-cjs` proves the first setup. It is a nested project with its own `package.json` and `package-lock.json`, Jest 30.5.2, babel-jest 30.5.2, Babel 7.29.7 and babel-plugin-transform-import-meta 2.3.3, pinned exactly, and the configuration above. `tests/package/jest-cjs.test.ts` installs the packed tarball into it, runs its one Jest test, which calls `analyze` on an MP4 and `check` with a preset, and compares both with the source. CI installs it with `npm ci --prefix tests/package/jest-cjs` before the package tests on Node 24 and 22.12, which fail in CI without it. Locally the test installs it with `npm ci --offline` and an empty npmrc, and skips with a message when the npm cache lacks it. Babel 7 is used because Babel 8 needs Node 22.18 or newer, above the 22.12 floor of the package.

## Header-only analysis

```ts
function analyzeHeader(source: Blob | BlobLike, options?: HeaderOptions): Promise<HeaderResult>; // video-fps-probe/header

interface HeaderOptions {
  name?: string; // default: File.name, or ''
  signal?: AbortSignal | null;
  limits?: HeaderLimits;
  readAhead?: { head?: number; tail?: number }; // head (default 65536, at least 1024) and tail (default 262144, at least 16)
  fragmentedDuration?: 'header' | 'index'; // default 'index'
}

interface HeaderLimits {
  maxBytes?: number; // bytes requested from the source, read-ahead included, default 16 MiB
  maxReads?: number; // source reads issued, default 8
  maxMs?: number; // wall clock from the call, default 10000
  maxTracks?: number; // trak boxes in the moov, default 64
  maxTopLevelBoxes?: number; // top-level box headers visited, default 1024
}

type HeaderResult = FileResult & { io: IoStats & { bytesRequested: number } };
const HEADER_DEFAULT_LIMITS: Readonly<Required<HeaderLimits>>;
```

`analyzeHeader` reads only the container header of an MP4 or MOV file, in the calling thread, under hard limits on the bytes it requests, the reads it issues, the wall time, the tracks and the top-level boxes. It never expands a sample table, never loads the statistics and never walks every fragment, so its cost does not grow with the length of the file. The entry also exports `HEADER_DEFAULT_LIMITS`, `errorCodeOf`, `errorClass`, `warningCodeOf`, `warningCodesOf`, `isAbortError`, `isTimeoutError` and the result types. It reaches neither the full ISO BMFF parser nor the statistics, which `check-dist` enforces, and it starts no worker. WebM and Matroska files answer `unsupported-container` with the text `container not read by the header entry: webm` or `matroska` and `container` set from the DocType.

**Contract.** `analyzeHeader` resolves for every file, read and limit problem, with `error` and `errorCode` set. It rejects only on the caller's abort, with the signal's reason, and on an invalid argument, with a `TypeError`. The reason of `AbortSignal.timeout()` is a `TimeoutError`, so a caller checks `isAbortError(e) || isTimeoutError(e)`. After the call settles no timer and no listener is left behind. A read that cannot be cancelled, from a `Blob` or a `BlobLike` without `read`, may finish in the background, and its rejection is caught.

**Validation.** Every option is checked before the first read. `source.size` must be a non-negative safe integer, every limit a non-negative safe integer or `Infinity`, `readAhead.head` at least 1024 (the sniff window) and `readAhead.tail` at least 16. `readAhead` takes only `head` and `tail`: header mode uses no other read-ahead size, so another key with a value, such as the `fragment` or `matroskaScan` of `analyze`, is refused rather than ignored, with `readAhead takes only head and tail, got fragment`. The options and `limits` ignore keys they do not know, so code written for a later version, with an option or a limit this version lacks, still runs here, and a misspelt limit such as `maxbytes` keeps the default of `maxBytes`. A key whose value is `undefined` counts as absent. `fragmentedDuration` must be `'header'` or `'index'`, `name` a string and `signal` an `AbortSignal`. The text follows the reader, for example `limits.maxReads must be a non-negative safe integer or Infinity, got -1` or `readAhead.head must be a non-negative safe integer of at least 1024, got 512`.

**A source with a signal.** A `BlobLike` may have `read(start, end, signal)`, which returns the bytes as a `Uint8Array` or an `ArrayBuffer`. Header mode calls it instead of `slice()`, with a signal that aborts on the caller's abort and at the deadline, so a Range source can close its socket. A read that rejects with an `AbortError` of its own while the caller's signal is still open, such as a socket the server's own controller closed, and a read that resolves anything other than bytes are `read-failed`, for example `file read failed: AbortError: aborted` or `file read failed: the source returned null instead of bytes`.

**Limits.** A read is checked when it is issued: one that would pass `maxReads` or `maxBytes`, or that starts after the deadline, is not issued, and the result carries `read-limit`, `byte-limit` or `time-limit`. The text names the limit, for example `limit reached: maxBytes 2097152 (582927 more bytes needed at offset 10670878)`. Read-ahead is clipped to the bytes left, so it never trips a limit itself. One deadline covers the call: a source that hangs, or that ignores its signal, settles at `maxMs` exactly. The deadline timer keeps a Node process alive until then, also when the source itself holds nothing open. The deadline bounds waiting, not parsing: a moov that arrived in time is parsed to the end. `maxTracks` counts the trak boxes of the moov before it is parsed, and `maxTopLevelBoxes` every top-level box header visited, before the moov, after it and in the fragment walk. Both stop with `structure-limit` and the text `limit reached: maxTracks 16` or `limit reached: maxTopLevelBoxes 32`. The walk after a moov without an `mvex` goes over the headers already read, with at most one peek past them, so at `maxTopLevelBoxes` it only stops, with the warning `too many top-level boxes` that full mode gives at its own limit, code `structure-limit`, and the result keeps its tracks and durations with no error. A limit hit after the moov is parsed keeps the tracks. A fragmented file falls back to its mehd as in step 3 of the fragmented duration below, and when a track is then left to mehd, left out of `formatDurationSec` or without a duration, the result carries the warning `fragment index not read: <the limit text>`, code `fragment-index-unread`. A fragmented file where no video track has a duration, or no sound track when it has no video, and a file without fragments carry the limit code as their error instead, with their tracks. So a result that a limit cut short always carries a limit code: its `errorCode`, `fragment-index-unread`, or the `structure-limit` of `too many top-level boxes`. Every result keeps `io.reads <= maxReads` and `io.bytesRequested <= maxBytes`. `io.reads` and `io.bytesRead` mean what they mean in full mode, and `io.bytesRequested` is the byte count charged against `maxBytes`, read-ahead included.

**Read plan.** The first read takes `readAhead.head` bytes, 64 KiB by default. A box header outside the bytes already read costs one peek of `readAhead.head` bytes, or of `readAhead.tail` bytes (256 KiB) right after an mdat while no moov has been seen. The rest of a moov that did not fit is read in one more read of that rest and the 32 bytes after it, so the header of the next box is in the bytes read. Without an `mvex` the walk goes on over the box headers already read. When it reaches one outside them before the end of the file, such as the box after an mdat larger than the head window, it peeks there once, `readAhead.head` bytes, and it stops at the next header outside the bytes read. So a truncated mdat, trailing data or a moof after the mdat gets the warning full mode gives, and a faststart file whose mdat runs to the end of the file takes no further read. A limit hit on that peek is the error of the result, with its tracks, as for any limit after the moov. A peek that fails for another reason, such as a range the source cannot serve, ends the walk there as if that header were outside the file, and the result keeps the moov with no error, but with the warning `fragments ignored: read at <offset> after a moov without an mvex failed: <the source error>`, code `fragments-ignored`, so a server can tell that a moof may follow. It does not read a moof after a moov without an `mvex`, which ffprobe 8.1.1 rejects: the result keeps the samples of the moov and carries the warning `fragments ignored: moof at <offset> after a moov without an mvex`, code `fragments-ignored`, where full mode reads the moof and warns `ffprobe 8.1.1 rejects this file: trun without a tfhd that has a trex`. With an `mvex` the walk goes on past every box to the first moof, an mdat after the moov of a hybrid file included, and reads every top-level sidx on the way, then resolves the fragmented duration. A file whose walk reaches the mfra or the end without a moof has no fragments, so it reads as a file without them, with the frame count and the durations of the moov. Measured with the default limits:

| Layout | Reads | Bytes requested |
|---|---:|---|
| a file of 64 KiB or less | 1 | the whole file |
| faststart, ftyp and moov within 64 KiB | 1 | 64 KiB |
| faststart, a moov that ends past 64 KiB | 2 | 64 KiB plus the rest of the moov and 32 bytes |
| moov at the end, inside the 256 KiB tail window | 2 | 64 KiB plus up to 256 KiB |
| moov at the end, a larger moov (2.6 MB in a 3 h file) | 3 | 64 KiB plus 256 KiB plus the rest of the moov |
| k boxes between the mdat and the moov that the windows miss | 2 + k | bounded by `maxReads` and `maxTopLevelBoxes` |
| without an `mvex`, a box after an mdat that ends outside the bytes read, such as a moof | 1 more than the row that fits | one peek of 64 KiB past that mdat |
| fragmented, a sidx for every track that covers the file, and no mfra | 1 | 64 KiB |
| fragmented, one moof whose mdat ends the file or ends at its mfra, both headers inside the bytes read | 1 | 64 KiB |
| hybrid, samples in the moov and an mdat before the first moof | 1 more than the row that fits | one peek past that mdat when the windows miss it |
| fragmented with an mfra, its last indexed moof inside the 64 KiB tail | 2 | 128 KiB |
| fragmented with an mfra, that moof outside the tail | 3, plus 1 per later moof the windows miss | about 128 KiB plus the moofs |
| fragmented, mehd only or nothing | 1 (`'header'`) or 2 (`'index'`) | an estimated duration, or `no-duration` |

**Fragmented duration.** Every video and sound track, and every text, subtitle, timecode or metadata track with an mdhd and fragment data, which counts for the duration of the file as in full mode, resolves from the first moof when that moof is the only fragment of the file: the box after it is an mdat that ends the file, or that ends where an mfra ending the file starts, and both headers are in the bytes read. The tracks then get the full-mode durations in either mode, with no further read and whatever sidx the file has. Otherwise each track is resolved by the first step that applies:

1. A sidx before the first moof that references the track in its timescale, is not hierarchical and covers the file to its end, or to the start of the mfra when the tail was read. The track resolves once the first moof is read, at the later of its sidx end, earliest presentation time plus the sum of its durations, and the end of its fragments in that moof, with provenance `header`. When every track with fragment data has such a sidx, text, subtitle and timecode tracks included, that is the end ffprobe 8.1.1 prints on ffmpeg's `+cmaf+global_sidx` output, whose AAC runs 1024 samples past its sidx, so one fragment of 10 s of sound lasts 10.021333 s. Full mode reads every fragment, so on a file of several fragments whose last one runs past the sidx it gives that later end, 20.521333 s where ffprobe and header mode give 20.5 s, a known deviation of full mode. When a track has no such sidx, the tracks that have one keep the durations of this step, so the video `durationSec` stays set, but they go on to step 2 as well and do not make `formatDurationSec` on their own: the mfra walk gives the full-mode end of every track it reaches, and without an index `formatDurationSec` is null with `format duration unresolved: track N` for each track without such a sidx. On ffmpeg's `+cmaf+global_sidx` output with a `mov_text` or `-timecode` track, whose sidx is written last and ends at the last fragment with a sample of that track, ffprobe reads every fragment, so the sound ends 1024 samples after its sidx in ffprobe, in full mode and in header mode alike, 4.021333 s for 4 s in `fmp4_cmaf_global_sidx_subtitle.mp4`. That is the only layout of this kind checked against ffprobe so far. When the one sidx left right before the first moof covers the file and another track has none, ffprobe 8.1.1 gives the sidx end for every stream, 6.0 s where full mode, and header mode through the mfra, give 6.021333 s, an open question recorded in the [implementation notes](implementation-notes.md#what-the-header-walk-reads). A limit that stops the read of the first moof leaves these tracks to the next steps. ffmpeg ends every `frag_keyframe` output with an mfra, its global sidx included, so in `'header'` mode such a sidx cannot be checked against the end of the file.
2. In `'index'` mode only, the mfra index. The 64 KiB tail is read when the budget holds it, so one read left is enough when the last indexed moof is inside that tail, and an mfra that its mfro declares larger than 16 MiB is not read, as in full mode. For each track the largest tfra offset is its last indexed moof, and the moofs from the earliest of those of the video and sound tracks to the end are parsed, with every sidx among them. The 4 KiB before the first of those moofs are searched for a sidx whose run of sidx, styp, prft and emsg boxes ends at that moof, also when the first moof of the file has no sidx before it. A text, subtitle, timecode or metadata track whose last indexed moof comes earlier gets a second walk from that moof up to the first one, after the video and sound tracks have resolved, so a limit hit there leaves their durations set. The end of a track is the end of its last fragment, or the end of the last sidx that references it in its timescale when that is later, as in full mode, so the composition delay of B-frames is kept. When the walk did not read every fragment and the last sidx found for a track lies before the walk, its coverage ends at or before the start of the walk and it ends before the track's last fragment, a later sidx may have been missed, so the track does not resolve in this step. A global sidx whose coverage reaches into the walk, such as the one of a sound track that ends before the video, still resolves its track. When that walk starts at the first moof, every fragment is read, so a file of a single moof resolves from it, and a track with no fragment there resolves from its moov. Provenance `header`. A limit hit here falls through to the next step, with the warning `fragment index not read: limit reached: ...` described under limits above.
3. A valid `mehd`, neither 0 nor all ones, gives the duration of every track and of the file, with provenance `estimated`. ffprobe never reads mehd.
4. Otherwise the error `incomplete header: fragmented file without a sidx, mfra or mehd duration`, code `no-duration`, with the tracks. When a limit stopped the reads, the result carries that limit code instead.

`formatDurationSec` of a fragmented file is the longest duration of its video and sound tracks, or their span from the earliest start to the latest end when that is longer, with the start offset of each track from its first fragment, as in full mode. A text, subtitle, timecode or metadata track that resolved exactly and starts or ends less than 1 s outside them extends it, as in full mode too. The first moof is read whole for these offsets, also when the head window cuts it. When a video or sound track with fragment data does not resolve, when two or more of the tracks counted resolve and one of them has its first fragment outside the first moof and the walk did not read every fragment, or when a track keeps the duration of its own sidx from step 1 beside a track without one and the mfra walk does not resolve it again, `formatDurationSec` is null, with the warning `format duration unresolved: track N`, code `duration-unresolved`, and the video `durationSec` stays set. A recording whose audio outlasts its video therefore never gets a short duration. A text, subtitle, timecode or metadata track that does not resolve, resolves only from mehd or has no known start never shortens or disables the span of the video and sound tracks: when they all resolved exactly, `formatDurationSec` comes from them and that track gets the same warning, since full mode may add up to 1 s for it. A track that keeps the duration of its sidx from step 1 beside a track without one is not exact in this sense, since its later fragments can end past that sidx, as the AAC of ffmpeg's `+cmaf+global_sidx` output does. Only when a video or sound track is itself the mehd estimate is `formatDurationSec` an estimate. The warning is left out when the result has an error, which already says the duration is missing.

**Results.** A header result has `scan: 'header'`. Its tracks keep `presentedFrames`, `minFps`, `maxFps`, `nominalFps`, `dominantFps`, `isVfr`, `rFpsFfprobe`, `medianFrameInterval` and `rateProfile` at null, and `vfrRatio`, `distinctDeltas` and `duplicateTimestamps` at 0, with no provenance for them. On a file without fragments every other field equals full mode: `codecName`, `fourccOrCodecId`, `width`, `height`, `rotation`, `frames`, `isStill`, `enabled`, `durationSec`, `startSec`, `avgFpsFfprobe`, `formatDurationSec`, `layout`, `error` and `errorCode`, and `avgFps` wherever full mode reports `provenance.avgFps` `header`. On a fragmented file with at least one moof `frames`, `avgFps`, `avgFpsFfprobe` and `startSec` are null, `isStill` is true only when the moov and the fragments read hold at most one sample, every indexed fragment was read and the duration is at most one frame interval, and the primary track is the enabled one first, then not a still image, then the largest stored area, then the lowest track ID. `tests/header/parity.test.ts` checks all of this against full mode on every ISO BMFF fixture, and `node scripts/compare-ffprobe.ts --header --no-write` against ffprobe too.

| When | Result |
|---|---|
| before the moov is parsed: a limit, `truncated`, `too-large`, `no-header`, `corrupt` or `structure-limit` | `error`, `errorCode`, `container`, `brand` and `layout` as far as seen, `videoTracks: []`, `primaryTrackId: null` |
| after the moov: the fragmented duration not resolved, or a limit hit | `error` and `errorCode`, with `videoTracks`, `enabled` and `primaryTrackId` |

A warning that repeats, such as `fragment for unknown track 77` for every traf of a large moof, is reported once with its count, for example `fragment for unknown track 77 (1000 times)`, so a hostile file cannot grow the stored result past the bytes read. Full mode keeps every copy.

`check()` judges any result with an `error` as unknown, as in 0.3.0.

**Stable from 0.4.0-beta.1.** The `analyzeHeader` signature, the members of `HeaderOptions` and `HeaderLimits` listed above, `readAhead` with `head` and `tail` only and a `TypeError` for any other key with a value, unknown keys of the options and of `limits` ignored, the keys of `HEADER_DEFAULT_LIMITS`, the error codes and the warning codes with the prefixes they classify, and the exports `isAbortError` and `isTimeoutError` of `video-fps-probe/header` are frozen from 0.4.0-beta.1: beta.2, 0.4.0 and later releases only add to them.

**A tight server configuration.** The defaults are generous, so that a header of any size within reason is read. A server that reads uploads from object storage can bound each call much tighter:

```ts
import { analyzeHeader } from 'video-fps-probe/header';

const result = await analyzeHeader(source, {
  name: key,
  signal,
  limits: { maxBytes: 2 * 1024 * 1024, maxReads: 3, maxMs: 2500, maxTracks: 16, maxTopLevelBoxes: 32 },
});
```

With these limits the 3 h moov-at-end file stops with `byte-limit` after 2 reads, with `layout.kind` `moov-at-end` and `layout.moovSize` set, the 604 MB moov-at-end file takes 2 reads and about 77 KB, and the 604 MB faststart file 1 read. A hybrid file, with samples in the moov and an mdat before the first moof such as the plain `frag_keyframe` output of ffmpeg, costs a peek past that mdat, so it resolves in the 3 reads when its last indexed moof is inside the 64 KiB tail. `fragmentedDuration: 'header'` reads neither the tail nor any fragment after the first moof, and it completes a first moof that the head window cuts only when every track has a sidx that covers the file, so a fragmented file costs the reads up to its first moof, at the cost of `no-duration` for files whose duration only the mfra gives, such as the browser recordings of MediaRecorder.

A file in object storage reaches `analyzeHeader` through a [Range source](#range-source).

## Range source

```ts
function rangeSource(fetcher: RangeFetcher, init: RangeSourceInit): RangeSource; // video-fps-probe/url
function openRangeSource(fetcher: RangeFetcher, init?: OpenRangeSourceInit): Promise<RangeSource>;
function httpRange(url: string | URL, init?: HttpRangeInit): RangeFetcher;
function readCapped(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, expectedLength: number, signal?: AbortSignal | null): Promise<Uint8Array>;

interface RangeSourceInit {
  size: number; // the object size in bytes, a non-negative safe integer
  signal?: AbortSignal | null; // aborts every read of the source
}

interface OpenRangeSourceInit {
  size?: number; // a known size: no request, as rangeSource
  headBytes?: number; // the discovery window, default 65536, at least 1
  signal?: AbortSignal | null;
}

interface HttpRangeInit {
  headers?: Readonly<Record<string, string>>; // sent with every request, such as If-Match
  fetch?: typeof globalThis.fetch; // default: the global fetch
}

interface RangeRequest {
  readonly start: number; // inclusive
  readonly end: number; // exclusive
  readonly range: string; // the Range header value, bytes=start-(end-1)
  readonly signal: AbortSignal | null; // aborts on the caller's abort and at the analyzeHeader deadline
}

interface RangeReply {
  readonly status?: number | null;
  readonly contentRange?: string | null;
  readonly contentLength?: number | null;
  readonly bytes?: ArrayBuffer | ArrayBufferView | null; // a body already read
  readonly body?: (expectedLength: number) => Promise<ArrayBuffer | ArrayBufferView>; // called only after the reply passes its checks
  readonly discard?: () => void; // releases a body that will not be read
}

type RangeFetcher = (request: RangeRequest) => Promise<RangeReply>;

interface RangeSource extends BlobLike {
  read(start: number, end: number, signal?: AbortSignal | null): Promise<Uint8Array>;
}

class RangeSourceError extends Error {
  constructor(code: RangeSourceErrorCode, message: string, options?: RangeSourceErrorOptions);
  readonly code: RangeSourceErrorCode;
  readonly status: number | null; // the status of the reply, when it had one
}

interface RangeSourceErrorOptions {
  status?: number | null;
  cause?: unknown;
}

type RangeSourceErrorCode =
  | 'unverifiable-reply' | 'unexpected-status' | 'range-mismatch' | 'size-changed'
  | 'length-mismatch' | 'body-too-long' | 'body-too-short' | 'invalid-reply';
```

`video-fps-probe/url` turns any function that fetches a byte range into a source for `analyzeHeader` and for the in-thread `analyze`: `fetch` with a presigned URL, or the client of an object-storage SDK that the caller creates. It depends on no SDK, imports nothing at run time and runs in the calling thread in Node and in browsers, and the [size matrix](../report/size-matrix.md) measures what a bundler takes of it. A `RangeSource` is a `BlobLike`: `slice(start, end)` clamps as `Blob.slice` does and its `arrayBuffer()` reads with `init.signal`, and `read(start, end, signal)` is what `analyzeHeader` calls with its own signal. The worker client accepts only a `Blob`.

**Size.** `rangeSource` takes the size the caller knows, for example from a HEAD request or an upload record, and issues no request. `init.size` must be a non-negative safe integer, else `TypeError`.

**Discovery.** `openRangeSource` without a size issues one request for `bytes=0-(headBytes-1)`, 65536 bytes by default, and accepts three replies:

- a 206 whose `Content-Range` is `bytes 0-b/total` with a numeric total, `b` equal to `min(headBytes, total) - 1`, and a `Content-Length`, when present, of `b + 1`. Object stores and HTTP servers clamp a range that runs past the end, so a 1000-byte object answers `bytes 0-999/1000`, which is accepted. A reply with such a `Content-Range` and no status counts as a 206.
- a 200 with a `Content-Length` of at most `headBytes`, the whole small object, read with that cap.
- a 416 with `bytes */0`, an empty object.

Anything else, such as a 200 for a larger object or a `*` total, rejects with a `RangeSourceError` after `discard()`. A 206 without a `Content-Range`, as a browser reads a cross-origin reply whose server does not list that header in `Access-Control-Expose-Headers`, rejects with `unverifiable-reply`, because the size is unknown: pass `size` there. The bytes of the accepted reply are kept and serve every later read inside them, so with `headBytes` equal to the `readAhead.head` of `analyzeHeader`, both 65536 by default, the first read of the analysis costs no request and the requests equal `io.reads`. Discovery runs before the deadline of `analyzeHeader` starts, so pass the same signal to both. Its request is not counted against the `maxBytes` and `maxReads` of `analyzeHeader`, which count the reads of the analysis, so a tight byte budget also needs a `headBytes` of at most `maxBytes`, such as the smaller of `readAhead.head` and `maxBytes`. With `size`, `openRangeSource` issues no request, as `rangeSource` does.

**Every other read** is one fetcher call, with no retry and no option for one. The source never reads ahead of the analysis and never sends a suffix range. Each reply is checked before its body is read, in this order, and fails closed:

| Check | Code when it fails |
|---|---|
| the reply has a `status` or a `contentRange` | `unverifiable-reply` |
| `status`, when present, is 206, or 200 when the read is the whole object | `unexpected-status`, with `error.status` set |
| `contentRange`, when present, reads `bytes first-last/total` | `range-mismatch` |
| that `total` is the size of the source, or `*` | `size-changed` |
| `first-last` is `start-(end-1)` | `range-mismatch` |
| `contentLength`, when present, is `end - start` | `length-mismatch` |

So a server that clamps a read of a source opened at a stale size reports `size-changed`. An empty `contentRange` counts as absent, as in a browser that does not expose the header of a cross-origin reply, where the status and length checks remain. When a check fails, `discard()` runs and the read rejects. The body, `bytes` or else `await body(end - start)`, must then be bytes of exactly `end - start`, else `body-too-long`, `body-too-short` or `invalid-reply`, which also covers a reply that is not an object or has neither `bytes` nor `body`. When the body fails that way, rejects or is cut by an abort, `discard()` runs too. A view is copied only when it does not cover its whole buffer.

These checks catch an object whose size changed between two reads, not one overwritten at the same size: only an `If-Match` with the ETag of the object, sent by the caller, catches that, as under httpRange below.

**Errors.** In `analyzeHeader` and `analyze` every read failure becomes `file read failed: <error>` with `errorCode` `read-failed`, for example `file read failed: RangeSourceError: status 200 to bytes=0-65535 of an object of 100000 bytes, expected 206`. An error of the fetcher passes through as it is. `httpRange` adds the code of a network error to the `TypeError` of `fetch`, which keeps the original as its `cause`, for example `file read failed: TypeError: fetch failed: ECONNREFUSED`, or `TypeError: terminated: UND_ERR_SOCKET` for a body cut mid-stream in Node. An `AbortError` that the fetcher raises while the signal of the read is open, such as the timeout of an SDK client, is a read failure, not an abort. `openRangeSource` and `read` reject with the `RangeSourceError` itself: branch on its `code` and `status` and test it by `name === 'RangeSourceError'`, because `instanceof` fails across the ESM and the CommonJS copy ([CommonJS](#commonjs)).

**Signals.** The signal of a request aborts on the signal of the read, on `init.signal` and, in `analyzeHeader`, at the `maxMs` deadline. `httpRange` passes it to `fetch`, so the socket closes. A read settles on an abort even when the fetcher ignores its signal, a reply that arrives later is discarded, and a caller abort rejects with the signal's reason.

**Body cap.** `readCapped(body, expectedLength, signal)` reads a `ReadableStream` or an async iterable, such as a Node stream, chunk by chunk into one buffer of `expectedLength` bytes. It cancels the stream and rejects with `body-too-long` as soon as the total passes `expectedLength`, rejects with `body-too-short` on an early end, and stops the stream on an abort and on a chunk that is not bytes, also while a chunk is pending: it cancels a `ReadableStream`, and destroys a Node stream and returns its iterator, so the socket closes even when the client of an SDK no longer watches the signal once the reply has arrived. That needs `body` to be the stream itself, such as the `Body` of the reply, and not a generator that wraps it: a wrapper has no `destroy()`, and its `return()` waits behind the pending chunk, so an abort leaves the socket open until the next chunk or the end of the stream. An invalid `expectedLength` or `signal` rejects with a `TypeError` before the body is touched, and leaves the body to the caller. `httpRange` reads `res.body` through it, so a 206 without a `Content-Length` whose chunked body runs past the range is cut at `end - start` bytes and never buffered whole. A custom fetcher gets the same cap from the `expectedLength` argument of `body()`.

**httpRange** sends `Range` and `Accept-Encoding: identity`, which a browser drops and which `fetch` adds by itself to a Range request, and the caller's `headers`, such as `If-Match` with the ETag from the server's own HEAD, so that an overwritten object fails the read with a 412, `unexpected-status`, instead of mixing two versions. Its `discard` cancels `res.body`. A URL presigned for GET has no HEAD, so where a same-size overwrite matters, a fetcher of the caller's own over `fetch` can keep the `ETag` of the discovery reply and send it as `If-Match` on every later read. Either way only a strong ETag, one without the `W/` prefix, works: `If-Match` compares strongly, so a weak ETag, which some web servers send by default, fails every read that sends it with a 412. In a browser `If-Match` is not a CORS-safelisted header, so a cross-origin server must also list it in `Access-Control-Allow-Headers`, or the preflight of every read fails. In a browser a cross-origin server must list `Content-Range` in `Access-Control-Expose-Headers`, or that check is skipped on later reads and discovery rejects with `unverifiable-reply`.

**Full mode.** The in-thread `analyze` takes a Range source too, without limits, and reads it through `slice()`, whose reads use only `init.signal`. Without it an abort of `analyze` waits for the pending read to finish, which against a stalled server lasts until the server or the connection gives up. So pass the same signal as `init.signal`: the read then settles on the abort and the socket closes.

A URL presigned for GET usually fails on HEAD, so the size comes from the first ranged GET:

```ts
import { analyzeHeader, errorClass } from 'video-fps-probe/header';
import { httpRange, openRangeSource } from 'video-fps-probe/url';

const signal = AbortSignal.timeout(3000);
const source = await openRangeSource(httpRange(presignedGetUrl), { signal });
const result = await analyzeHeader(source, {
  name: key,
  signal,
  limits: { maxBytes: 2 * 1024 * 1024, maxReads: 3, maxMs: 2500, maxTracks: 16, maxTopLevelBoxes: 32 },
});
if (result.errorCode && errorClass(result.errorCode) === 'file') rememberPermanentFailure(key, result.errorCode);
```

A rejection of `analyzeHeader` here is the caller's own abort or timeout, `isAbortError(e) || isTimeoutError(e)`, and a rejection of `openRangeSource` is a `RangeSourceError` of the discovery reply or an error of `fetch`.

The client of an object-storage SDK works the same way from CommonJS. The library imports no SDK. Give the probe a client of its own with one attempt and explicit connection and request timeouts, because a default client retries, which a degraded store should not cost every upload, and send the ETag of the caller's HEAD as the precondition:

```js
const { analyzeHeader } = require('video-fps-probe/header');
const { rangeSource, readCapped } = require('video-fps-probe/url');

const probeClient = createStorageClient({ maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 } });

async function probeObject(bucket, key, signal) {
  const head = await probeClient.headObject({ Bucket: bucket, Key: key });
  const fetcher = async ({ range, signal: abortSignal }) => {
    const out = await probeClient.getObject({ Bucket: bucket, Key: key, Range: range, IfMatch: head.ETag }, { abortSignal });
    return {
      status: out.$metadata?.httpStatusCode ?? null,
      contentRange: out.ContentRange ?? null,
      contentLength: out.ContentLength ?? null,
      body: (expectedLength) => readCapped(out.Body, expectedLength, abortSignal),
      discard: () => out.Body?.destroy?.(),
    };
  };
  return analyzeHeader(rangeSource(fetcher, { size: head.ContentLength, signal }), {
    name: key,
    signal,
    limits: { maxBytes: 2 * 1024 * 1024, maxReads: 3, maxMs: 2500, maxTracks: 16, maxTopLevelBoxes: 32 },
  });
}
```

`createStorageClient` stands for the constructor of the SDK client in use, and its option names follow a common SDK shape: map them to the SDK. `tests/url` runs every committed fixture through a fetcher and through `httpRange` against a `node:http` server, both against the `Blob` results, with one request per read, and covers each failed check, the body cap, a caller abort and a stalled server under `maxMs`, which closes the socket.

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
| `mediabunny` | MP4, MOV, WebM, Matroska | its average is the packet rate; reads whole Matroska clusters; verified with mediabunny 1.62.1 (`MEDIABUNNY_VERSION`); MPL-2.0 |
| `rvfc` | anything the browser plays | main thread; plays the file muted in a 320 px video element appended to `host`; every value is `estimated`; needs a visible foreground tab; never part of a default compare set or fallback chain |

The host of rvfc comes from the per-call `host`, else from `rvfc({ host })`. Without one, or without a DOM, it rejects (`worker-failed` and `unsupported-environment` respectively).

- The peers are optional, and no package manager installs them with the package (npm and pnpm leave optional peers out, bun uses only a copy that is already installed, Yarn takes peers from the app; [publishing](publishing.md#one-publish-for-every-package-manager)): `npm install mp4box` or `npm install mediabunny` (or the Yarn, pnpm or bun equivalent). The consumer tests verify this for npm only. Importing `video-fps-probe/mp4box` or `video-fps-probe/mediabunny` without its peer fails the build, because the peer cannot be resolved.
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

`video-fps-probe/standalone/own-isobmff.worker.js` and `own-matroska.worker.js` are the two own workers of the default flavor as classic scripts, about 21 and 24 KB gzip against about 36 KB for `own.worker.js`. Each reads one container family and returns an error result with the container for the other one. Register them with `byContainer`, so a first file loads only the file of its family:

```ts
import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import isobmffWorkerUrl from 'video-fps-probe/standalone/own-isobmff.worker.js?url';
import matroskaWorkerUrl from 'video-fps-probe/standalone/own-matroska.worker.js?url';

export const probe = lazyProbeClient({
  worker: { create: () => new Worker(isobmffWorkerUrl), engines: ['own'], byContainer: { matroska: () => new Worker(matroskaWorkerUrl) } },
});
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
| `scan` | `'header' \| 'probe' \| 'exact'` or null | how far the scan went: `'exact'` for an ISO BMFF file read in full, the depth of a Matroska scan, `'header'` on every result of `video-fps-probe/header`, and null when a full-mode analysis failed |
| `videoTracks` | `VideoTrackResult[]` | every video track |
| `audioTrackCount` | number | audio tracks seen |
| `primaryTrackId` | number or null | the track the summary uses: the enabled ISO BMFF track with the most samples, or the first Matroska video track |
| `error` | string or null | why the file could not be analysed, for example `not a recognised container: PNG image`. `file read failed: <error>` when the file itself could not be read, whatever its container, from the own and mediabunny engines and from mp4box before it has read the moov: a picked file that was changed, moved or deleted since (`file read failed: NotReadableError: ...`, `InvalidStateError` or `NotFoundError`), one that got shorter while it was read (`file read failed: short read at ...`), or a `BlobLike` whose read rejected or threw. A read failure is not a file problem: picking the file again usually helps |
| `errorCode` | `FileErrorCode` or null | the machine-readable code of `error`, null exactly when `error` is null ([error codes](#error-codes)). Set by own. Absent on results of mp4box, mediabunny and rvfc and on results of 0.3.0, which `errorCodeOf` codes from their text |
| `layout` | `ContainerLayout` or null | the top-level layout of an ISO BMFF file, also when it failed, as far as it was read ([layout](#containerlayout)). Null for Matroska and WebM, for an unrecognised file, and when neither a moov nor an mdat was seen. Set by own |
| `warnings` | string[] | file-level warnings in plain words; NUL and other control characters from the file are replaced by `?` |
| `io` | `{ reads, bytesRead, ms }` | `Blob.slice()` reads, unique bytes read, and the analysis time in the thread that ran it (chunk loading excluded). Results of `video-fps-probe/header` add `bytesRequested`, the bytes requested from the source, read-ahead included, which `maxBytes` bounds |
| `engine` | `'own' \| 'mp4box' \| 'mediabunny' \| 'rvfc'` | which engine produced the result |

### VideoTrackResult

| Field | Meaning |
|---|---|
| `trackId`, `fourccOrCodecId`, `codecName` | track id, sample entry or CodecID (own reads a byte outside printable ASCII, or a control character in a CodecID, as `?`), and ffprobe's `codec_name` |
| `width`, `height`, `rotation`, `timescale` | stored frame size in pixels (the sample aspect ratio is not applied), rotation in degrees as ffprobe reports it, ticks per second |
| `frames` | stored samples or blocks (ffprobe `nb_frames`, or `nb_read_packets` for fragmented MP4 and Matroska) |
| `presentedFrames` | frames inside the first non-empty edit (ffprobe `nb_read_frames`); equals `frames` without an edit list |
| `durationSec`, `startSec` | track duration and start |
| `avgFps` | `Rational`: presented frames over the presentation span |
| `avgFpsFfprobe` | the `avg_frame_rate` string ffprobe 8.1.1 prints, or null when it cannot be reproduced. Matroska and WebM: the declared rate when the track has a DefaultDuration; without one, the estimate ffprobe makes from the first packets, `0/0` when ffprobe prints that, reproduced in `matroskaMode` `probe`, `exact` and `auto` and null in `header` mode, which reads no block. Outside the reproduced cases it is null and a warning names the reason ([implementation notes](implementation-notes.md#ffprobe-frame-rates-without-defaultduration-020)) |
| `rFpsFfprobe` | ffprobe's `r_frame_rate` when it can be reproduced, else null: MP4 and MOV with equal intervals; Matroska and WebM with a DefaultDuration between 5 and 1000 fps, or without a DefaultDuration the estimate described for `avgFpsFfprobe`, in the same modes |
| `nominalFps` | `Rational & { kind: 'exact' \| 'snapped' \| 'declared' }`: the rate when every interval is equal, a standard rate when CFR timestamps jitter, or the declared Matroska rate |
| `dominantFps` | `{ rate, share }` for a VFR track where one interval covers at least half of the frames; `share` counts frames |
| `minFps`, `maxFps` | from the longest and the shortest frame interval |
| `isVfr` | true when any interval differs from the median by more than `max(1 tick, round(0.005 x median), msGridTicks)`, where `msGridTicks` is 1 ms in ticks when the timescale is above 1000 and every interval is a whole number of milliseconds, else 0 ([the VFR rule](benchmarks.md#statistics-and-the-vfr-rule)); null when unknown |
| `vfrRatio`, `distinctDeltas` | share of intervals off the median, number of distinct intervals |
| `duplicateTimestamps` | frames sharing a timestamp (excluded from the statistics) |
| `timestampsQuantized` | CFR content on 1 ms ticks (Matroska, MP4 remuxed from Matroska) |
| `isStill` | a single frame or a still image track |
| `medianFrameInterval` | `Rational` in seconds: the lower-median presented frame interval, with the tail of the reorder depth left out as for `minFps` and `maxFps`, reduced. ISO BMFF, Matroska after a probe (`sampled`) or exact scan, mp4box and mediabunny. Null for one frame, in a Matroska header scan and when the per-sample analysis was skipped over `maxExpandedSamples` |
| `enabled` | the tkhd enabled bit (MP4 and MOV) or FlagEnabled (Matroska and WebM, true when absent). Set by own. A disabled primary track is not meant to be played: ffprobe prints `disposition.default` 0 for it in MP4 |
| `rateProfile` | `RateProfile` or null; only for tracks whose intervals differ by more than 7.5% and not only by timestamp rounding (Matroska only after an exact scan) |
| `provenance` | `Partial<Record<TrackField, Provenance>>`: where each value came from |
| `warnings` | track-level warnings in plain words; NUL and other control characters from the file are replaced by `?` |

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

### Error codes

```ts
type FileErrorCode =
  | 'empty-file' | 'unrecognised' | 'unsupported-container' | 'unsupported' | 'too-large'
  | 'no-header' | 'truncated' | 'corrupt' | 'no-duration'
  | 'byte-limit' | 'read-limit' | 'time-limit' | 'structure-limit'
  | 'read-failed' | 'load-failed' | 'engine-failed' | 'internal';
type ErrorClass = 'file' | 'limit' | 'io' | 'environment' | 'internal';
type WarningCode =
  | 'invalid-timescale' | 'truncated-mdat' | 'truncated-box' | 'trailing-data'
  | 'fragment-index-unread' | 'duration-unresolved' | 'fragments-ignored' | 'structure-limit';

function errorCodeOf(result: Pick<FileResult, 'error'> & Partial<Pick<FileResult, 'errorCode' | 'engine'>>): FileErrorCode | null; // video-fps-probe
function errorClass(code: FileErrorCode): ErrorClass;
function warningCodeOf(warning: string): WarningCode | null;
function warningCodesOf(result: Pick<FileResult, 'warnings' | 'videoTracks'>): WarningCode[];
```

The code travels with the failure, not with its text: every `error` reads as it did in 0.3.0, and code that branches should branch on `errorCode`.

| Code | Class | When (the message of own) |
|---|---|---|
| `empty-file` | file | `not a recognised container: empty file` |
| `unrecognised` | file | `not a recognised container: <reason>`, for example `PNG image` |
| `unsupported-container` | file | a container the engine or worker does not read: `the own Matroska worker does not read ISO BMFF`, `unsupported by <engine>`, and `container not read by the header entry: webm` or `matroska` from `video-fps-probe/header` |
| `unsupported` | file | `unsupported: compressed movie header (cmov)`, a 64-bit box value above 2^53-1 |
| `too-large` | file | `unsupported: moov larger than 256 MiB`, `corrupt file: moof larger than 64 MiB at <offset>` |
| `no-header` | file | `incomplete file: no moov`, `no Segment element`, `no Tracks element found` |
| `truncated` | file | `incomplete file: moov is truncated`, `no complete TrackEntry in Tracks` |
| `corrupt` | file | every other `corrupt file: ...` of a malformed file, `invalid EBML header`, and a malformed value that stopped the parser |
| `no-duration` | file | `incomplete header: fragmented file without a sidx, mfra or mehd duration`, from `video-fps-probe/header` only |
| `byte-limit`, `read-limit`, `time-limit`, `structure-limit` | limit | `limit reached: maxBytes <n> (<m> more bytes needed at offset <o>)`, `limit reached: maxReads <n>`, `limit reached: maxMs <n>`, `limit reached: maxTracks <n>` and `limit reached: maxTopLevelBoxes <n>`, from `video-fps-probe/header` only ([limits](#header-only-analysis)) |
| `read-failed` | io | `file read failed: <error>` and `file read failed: short read ...`, every failure of a [Range source](#range-source) such as `file read failed: RangeSourceError: ...`, and from `video-fps-probe/header` also an `AbortError` of the source itself while the caller's signal is open and a read that resolves no bytes |
| `load-failed` | environment | the parser or statistics chunk of own did not load, for example after a redeploy |
| `engine-failed` | file | a failure of mp4box, mediabunny or rvfc, from `errorCodeOf` only |
| `internal` | internal | an invalid argument to `analyze` or a probe, such as a `readAhead.head` or `readAhead.fragment` that is not a non-negative safe integer or a `BlobLike` whose `size` is not a non-negative safe integer, and any other exception, a bug in the package. Never a property of the file. In ISO BMFF its text starts with `corrupt file: ` as in 0.3.0, for example `corrupt file: readAhead must be a non-negative safe integer, got -1`. `analyzeHeader` checks every option before it reads and throws a `TypeError` for an invalid one instead, so its `internal` is a bug only |

One invalid argument to `analyze` can still read as a file code: a `readAhead.matroskaScan` that is not a safe integer, such as NaN, Infinity or 2^60, can fail the exact Matroska scan as `corrupt`, with the 0.3.0 text `length must be a non-negative safe integer, got NaN`. Pass a whole number of bytes. `analyzeHeader` refuses a `matroskaScan` or a `fragment` of any value but `undefined`, with the `TypeError` `readAhead takes only head and tail, got matroskaScan`.

`errorClass` sorts the codes for caching and retries. `file` codes are deterministic: the same bytes and package version give the same code, so a server can cache them per object. `engine-failed` is deterministic only for the parsing engines, mp4box and mediabunny. An rvfc failure, such as `tab not visible: keep it in the foreground` or `requestVideoFrameCallback unsupported`, comes from the browser and not from the file. `byte-limit`, `read-limit` and `structure-limit` repeat for the same limits, while `time-limit` depends on the source and the machine, so do not cache it. `read-failed` and `load-failed` are transient and worth a retry. `internal` describes the call, an invalid argument or a bug in the package, and not the file, so do not cache it per object. A code this version does not know, from a later one, is `internal` too, and is not cached either.

`errorCodeOf` returns `result.errorCode` when the result has the field. Otherwise it codes `result.error` from its text, best effort, which covers results of mp4box, mediabunny and rvfc and JSON stored by 0.3.0: a text no rule matches is `engine-failed` from another engine and `internal` from own. The text does not always tell the code the failure had: an ISO BMFF failure that is a bug in the package, or an invalid argument, also reads `corrupt file: ...` and is coded `corrupt` from its text, and a malformed value that stopped the Matroska parser has a text no rule matches, so it reads as `internal`. The helpers never throw on stored JSON of another shape: a value that is not a result, or an `error` that is neither a string nor null, gives `internal`, a warning that is not a string gives null, and a missing list of warnings or tracks counts as empty.

`warningCodeOf` gives a stable code to a warning that starts with one of these prefixes and null to every other warning, which stays free text: `invalid mdhd timescale ` and `invalid timescale ` give `invalid-timescale`, `'mdat' at <offset> is truncated` gives `truncated-mdat`, any other `'<type>' at <offset> is truncated` gives `truncated-box`, and `ignored trailing data at ` gives `trailing-data`. Four more come from the header entry: `fragment index not read: ` gives `fragment-index-unread` (a limit stopped a fragment read that the duration depends on, so a track fell back to mehd, was left out of `formatDurationSec` or has no duration, in a result without an error), `format duration unresolved: ` gives `duration-unresolved` (a track has no duration that counts, so `formatDurationSec` is null or leaves that track out), `fragments ignored: ` gives `fragments-ignored` (a moof after a moov without an `mvex` was not read, or the peek that looks for it failed), and `too many top-level boxes` gives `structure-limit` (the walk stopped at its box limit, with no error). Full mode gives the last one too, at its own limit of 4,000,000 boxes. `warningCodesOf` collects the codes of the file and its tracks once each.

A server can derive its own reasons from these fields:

| A server wants | From the result |
|---|---|
| not an MP4 | `empty-file` or `unrecognised`, or a `container` other than `mp4` and `mov` |
| unsupported container | `unsupported-container` or `unsupported` |
| no usable video track | `errorCode === null` and `primaryTrackId === null`, or a primary track with `isStill` true or `enabled` false. ISO BMFF prefers an enabled track as the primary one, while Matroska takes the first video track, so a Matroska file whose first video track has FlagEnabled 0 reads as no usable video track even when a later video track is enabled |
| truncated | `truncated`, or no error and `warningCodesOf(result)` holding `truncated-mdat` |
| duration missing or partial in header mode | `no-duration` or a limit code, or `warningCodesOf(result)` holding `duration-unresolved` (a track left out of `formatDurationSec`, or null) or `fragment-index-unread` (a limit cut the duration short, so a larger limit may resolve it) |
| corrupt or invalid values | `corrupt`, `unsupported` for a 64-bit box value above 2^53-1, or `warningCodesOf(result)` holding `invalid-timescale` |
| read failed | `read-failed` |
| hybrid fragmented | `layout?.kind === 'fragmented'` and `layout.emptyMoov === false` |
| moov at the end | `layout?.kind === 'moov-at-end'`, which a player must seek for before it can start |

### ContainerLayout

```ts
type LayoutKind = 'faststart' | 'moov-at-end' | 'fragmented';
interface ContainerLayout {
  kind: LayoutKind; // fragmented with an mvex, else moov-at-end when an mdat comes before the moov or no moov was reached, else faststart
  moovOffset: number | null; // offset and declared size of the first moov, null when no moov header was seen
  moovSize: number | null;
  sidx: boolean; // a top-level sidx comes before the first moof, in the boxes read
  emptyMoov: boolean; // fragmented, and no video track has a sample in the moov
}
```

### summarize

```ts
function summarize(result: FileResult): VideoFpsSummary; // video-fps-probe, video-fps-probe/client
```

Flattens the primary track: `ok`, `name`, `container`, `engine`, `fps` (`avgFps.value`), `fpsRational` (`'num/den'`), `nominalFps`, `frames` (`presentedFrames ?? frames`), `durationSec` (track, else format), `width`, `height`, `rotation`, `isVfr`, `minFps`, `maxFps`, `approximate`, `error` and `warnings` (file and track). `ok` is false and `error` is set when the result has an error, no video track (`no video track`) or no average (`no frame rate`). `approximate` is true when the average, the nominal rate or the frame count is `estimated` or `sampled`.

## Check

```ts
import { check } from 'video-fps-probe/check';

function check(result: FileResult | null | undefined, rules: CheckRules): CheckReport;
```

Judges a result against upload limits in the calling thread: a pure function with no worker, no parser and no import of its own (`check-dist` fails a `dist/check/index.js` that imports anything). The rules are plain JSON, so a server can send them, and [presets](#presets) carry the published limits of video generation providers.

```ts
type RatioValue = number | `${number}/${number}` | `${number}:${number}`; // 24, '24000/1001', '16:9'
type RatePolicy = 'allow' | 'warn' | 'reject';
type FpsSource = 'avg' | 'ffprobe' | 'nominal' | 'dominant';

interface RangeRule<T = number> {
  min?: T;
  max?: T;
}

interface FpsRule extends RangeRule<RatioValue> {
  exact?: RatioValue;
  oneOf?: readonly RatioValue[];
  source?: FpsSource; // default 'avg'
}

interface AspectRatioRule extends RangeRule<RatioValue> {
  oneOf?: readonly RatioValue[];
}

interface FrameSizeRule {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  minShortSide?: number;
  maxShortSide?: number;
  minLongSide?: number;
  maxLongSide?: number;
}

interface CheckRules {
  fps?: FpsRule;
  duration?: RangeRule; // seconds
  frameSize?: FrameSizeRule; // stored pixels, after rotation; the sample aspect ratio is not applied
  aspectRatio?: AspectRatioRule; // frame width over frame height
  pixels?: RangeRule; // frame width x height
  fileSize?: RangeRule; // bytes
  containers?: readonly ContainerKind[];
  codecs?: readonly string[]; // ffprobe codec names: 'h264', 'hevc', 'vp9', 'av1', 'prores', ...
  audio?: 'required' | 'forbidden';
  vfr?: RatePolicy;
  uneven?: RatePolicy;
  severity?: 'fail' | 'warn'; // of a broken limit, default 'fail'
}

type CheckVerdict = 'pass' | 'warn' | 'fail' | 'unknown';
type CheckSeverity = 'fail' | 'warn' | 'unknown';
type CheckExpected = number | string | readonly (number | string)[] | null;

interface CheckViolation {
  rule: string; // 'fps.min', 'frameSize.maxLongSide', 'containers', 'vfr', ...
  severity: CheckSeverity;
  expected: CheckExpected; // the rule value as given; null for unknown
  actual: number | string | boolean | null; // 'num/den' for a frame rate or an aspect ratio
  message: string;
}

interface SuggestedFps {
  value: number | null; // null when no rate meets every bound of the fps rule
  reason: string;
}

interface CheckReport {
  verdict: CheckVerdict;
  violations: CheckViolation[];
  suggestedFps?: SuggestedFps;
}
```

**Types and JSON.** The TypeScript types take numbers, and `'num/den'` and `'num:den'` strings for frame rates and aspect ratios. Rules parsed from JSON may also hold what this section accepts beyond them, decimal strings such as `'29.97'` or `'30'` and `null` bounds: `check` takes those at run time, and typed code casts such rules to `CheckRules`.

**Exact comparison.** Every bound is inclusive and compared as an exact rational with BigInt cross-multiplication, never as a float. A number counts as the decimal it prints as, so `24` is 24/1 and `23.976` is 2997/125. A frame rate or aspect ratio bound is a number or a string that is a decimal, `'num/den'` or `'num:den'`, each side a decimal. A decimal string is one or more digits, optionally a point and one or more digits, and optionally `e` or `E` with an optional sign and digits; whitespace around it, or around each side of a ratio, is ignored: `'30'`, `'29.97'`, `' 1e3 '`, `'2.5E-1'`. It is read exactly, as its digits times a power of ten, the exponent minus the number of digits after the point; that power must be from -400 to 400 and the string's value as a double must be finite. So `'1e-400'` is exactly 10^-400, while `'1e400'` (infinite as a double), `'1e-401'`, `'0e401'`, a point followed by more than 400 digits, `'.5'`, `'5.'`, `'+5'`, `'-5'` and `'0x10'` throw. NTSC film at 23.976 fps is `24000/1001`, which is below `min: 24`; 59.94 fps (`60000/1001`) is below `min: 60` and meets `max: 60`. Duration, sizes, pixels and the file size are compared the same way, but their bounds take only a finite non-negative number or a decimal string (`'30'`, `'2.5'`, `'1e3'`): a ratio string there throws a `TypeError` naming the path, so `duration: { min: '1:30' }` never reads as 1/30 s. A frame rate bound written as one of the NTSC decimals 23.976, 29.97, 47.952, 59.94 and 119.88 (a number or a decimal string, not a fraction) stands for two rates, the decimal and the x/1001 rate it abbreviates (24000/1001, 30000/1001, 48000/1001, 60000/1001 and 120000/1001), and the bound holds when it holds for either: `max: 29.97` accepts `30000/1001`, `min: 29.97` accepts `2997/100`, and `exact: 23.976` matches both `24000/1001` and `2997/125`. A fraction compares one rate, so `max: '2997/100'` rejects `30000/1001`. A message prints the actual frame rate or duration with as many decimals as it takes to differ from the bound it breaks, so it never reads as breaking a bound it equals: `fps.max: 29.97004 (749251/25000) fps is above the maximum 29.97 fps`. Whatever the result, `check` throws a `TypeError` naming the rule for a bound that is not a non-negative number or such a string, an allowlist that is not a list of strings, an `audio`, `vfr`, `uneven`, `severity` or `fps.source` value outside its list, a `min`, `max` or `exact` given as a list (only `oneOf` takes one), a rule group or rules that are not an object (a list included), and a key that is not a rule, such as `fps.mxa`, `exact` in `duration` or a top-level `fsp` (the message lists the keys that are), so a typo in rules from a server cannot turn a limit off or around.

**What is judged.** The primary track. `fps.source` picks the rate: `'avg'` is `avgFps`, presented frames over the presentation span, except on a constant track whose timestamps sit on 1 ms ticks (`timestampsQuantized`, as in most Matroska and WebM files and MP4 files remuxed from them). There the span is rounded to whole milliseconds, so the average lands a little off the rate: 180 frames of a 60 fps WebM span 2.999 s, `180000/2999`, which would break `max: 60`, and 2 of every 3 frame counts of a 30 fps WebM break `max: 30` the same way. On such a track `'avg'` judges `nominalFps` instead, when the span it gives the frames is within 3 ms of the measured span (the first timestamp, the last timestamp and the last frame's duration can each be off by up to 1 ms). A nominal rate further off, or none, leaves the average. On such a track the default source also holds a frame rate bound within the resolution of the timestamps: a rate the bound names counts as met when its frame interval is within 100 ns of the judged nominal rate's, or, when the average is judged, when it gives the frames a span within 3 ms of the measured span. A Matroska DefaultDuration stores the interval in whole nanoseconds, which ffprobe and the parser reduce to a fraction of at most 30000, so a 59.94 fps WebM declares `19001/317`, 0.9 ns per frame off `60000/1001`: `exact: '60000/1001'`, `oneOf: ['60000/1001']` and `max: 59.94` hold for it, while 60 fps is 16.7 microseconds per frame off and `exact: 60` and `min: 60` fail (the closest standard rates, 240 and 239.76 fps, are 4.2 microseconds apart, and the reduction to 30000 moves no standard rate by more than 15 ns). Off 1 ms ticks, on a VFR track and with another `source` the comparison is exact. `'ffprobe'` is `avgFpsFfprobe`, the `avg_frame_rate` ffprobe prints (unknown when it is null or `0/0`), `'nominal'` is `nominalFps`, and `'dominant'` is `dominantFps.rate` for a VFR track and `nominalFps` for a constant one. The frame size (`frameSize`, `aspectRatio` and `pixels`) is the stored `width` x `height`, swapped when `rotation` is 90 or 270 in either direction, and unknown when a side is not a positive whole number. It is not the display size: the sample aspect ratio (an MP4 `pasp` box, a Matroska `DisplayWidth` and `DisplayHeight`) is not applied, because the result does not carry it, so an anamorphic 1440x1080 file stored for 16:9 display is judged as 1440x1080 with an aspect ratio of 4:3. `duration` is the track's `durationSec`, else `formatDurationSec`, and on a constant track judged by its nominal rate the frames over that rate, so the 180 frames of the 60 fps WebM last 3 s rather than the 2.999 s their ticks span. The seconds are rounded half up to the microsecond, the 6 decimals ffprobe prints, before they are compared: the 180 frames of a 59.94 fps WebM that declares `19001/317` last 3.003 s, the 3.003000 ffprobe prints, rather than 3.0029998 s, so `min: 3.003` holds. ffprobe prints no stream duration for a WebM or Matroska track, only the format duration, so for such a track `duration` judges `formatDurationSec` when it is within one typical frame interval of the track's measured span `durationSec`. That interval is 1 / `dominantFps.rate` when the track has a dominant rate, else 1 / `nominalFps` when `isVfr` is `false`, else 1 / `avgFps`, the average interval: the first of the three that is not null decides, and when it is not a rate with a positive whole `num` and `den`, or all three are null, the span is kept. It is not the median interval: `check` does not use `medianFrameInterval` yet, so a VFR track without a dominant rate takes its average interval: the Chromium recordings, whose intervals are mostly 16 or 17 ms with gaps of up to 0.7 s, take 27 ms rather than their median of 17 ms. Judging by `medianFrameInterval` here is planned for 0.4.0. It is never 1 / `minFps`, the longest interval, which a freeze stretches: 10.04 s in `late_freeze_10s.mkv`, whose dominant 25 fps gives 40 ms. Both durations are rounded half up to the microsecond first and their gap is compared exactly with the interval, so the 259.96 s that `late_25_to_12.5.webm` spans is one 25 fps interval from the 260.000000 ffprobe prints and is judged as 260 s, while a gap one microsecond longer is not. The two differ by the last frame: the span ends at the last block plus a last frame duration (BlockDuration, else DefaultDuration rounded down to the tick, as ffprobe's demuxer reads them, else the median interval), the format duration where the muxer put the end. So the 6 s screen recording whose 1 ms ticks span 5.999 s is judged as the 6.000000 ffprobe prints, and a MediaRecorder file whose Duration sits at its last timestamp as that Duration. A format duration further off, such as audio that outlasts the video or a false Duration, leaves the span, and so does a track without any of these rates. An MP4 or MOV track always keeps `durationSec`, which is the stream duration ffprobe prints. `codecs` compares `codecName` without case. `audio` reads `audioTrackCount` of the engines that count audio tracks (own, mp4box and mediabunny) and is unknown for any other, such as rvfc, whose results always have 0, and `vfr` reads `isVfr`, unknown when it is missing or not a boolean. `uneven` reads `rateProfile.uneven`, unknown when a profile has no boolean `uneven`. Without a profile, a track that is not VFR, or whose shortest and longest frame intervals are within 7.5% of each other (below that no profile is built), is even, and any other track is unknown: a Matroska file outside an exact scan, or a profile chunk that failed to load.

**Violations and the verdict.** A broken limit is a violation with the rule, its severity, the rule value and the actual value. Its severity is `rules.severity`; a policy of `'warn'` gives `warn` and `'reject'` gives `rules.severity`. A rule whose field is missing gives one `unknown` entry for its group (`fps`, `frameSize`, `audio`, ...). A bound that is absent or null judges nothing, and neither does a group without a bound. The verdict is `fail` when any violation fails, else `unknown` when a field was missing, else `warn` when any violation warns, else `pass`.

**Failing open.** `check(null, rules)` is `unknown`, so the result of `tryAnalyze` goes straight in. A result with an `error` judges only `fileSize` (the Blob's size) and `containers` (the sniffed container, unless it is `'unknown'`). A result without a video track, or without `videoTracks` at all (a partial or older JSON result), also judges `audio`, which needs no video track, so an audio-only file passes `audio: 'required'`; every other rule is unknown. Malformed JSON never throws either: a result that is not an object, entries of `videoTracks` that are null or not objects, tracks without a `trackId`, a `primaryTrackId` that is missing or matches no track, and track or file fields of the wrong type all give `unknown`, and the message says what is missing: `fps: unknown, the result has no videoTracks list`, `fps: unknown, no primary track: primaryTrackId 1 matches no video track`; an `error` that is not a non-blank string is described, not printed: `the analysis failed, and its error is of type object`. An unknown `fileSize`, `containers` or `audio`, which need no video track, names its own field, followed by the analysis error when there is one: `fileSize: unknown, no file size`, `containers: unknown, no container; the analysis failed: moov box not found`, `audio: unknown, no audio track count (the rvfc engine reports none)`. A `fail` is a limit the file breaks for certain; an `unknown` means the probe could not tell, and an upload flow that fails open sends the file and lets the server decide.

**suggestedFps.** Set when a frame rate bound, `vfr` or `uneven` is broken (as a failure or a warning). `value` is a rate that every bound of the `fps` rule allows, as a number, and `reason` says what to do and names that rate exactly (`convert to 29.97 (30000/1001) fps`). The candidates are the allowed rates: the `exact` rate when it is between `min` and `max` and in `oneOf` (both readings of an NTSC decimal); else the `oneOf` rates between `min` and `max`; else the standard rates between `min` and `max`, 23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88 and 120 fps (the NTSC rates as their x/1001 fractions); and only when no standard rate is between them, any rate between `min` and `max`, the nearest of which is `min` for a slower track and `max` for a faster one. One rule then picks the rate. When the track's rate is at least 1.5 times the nearest candidate (the lower one on a tie), the suggestion is the track's rate divided by the smallest whole number k from 2 to 8 that gives a candidate, which keeps 1 of every k frames; otherwise, or when no such k exists, it is the nearest candidate. So 50 fps under `max: 30` gets 25 and 120 fps under `max: 60` gets 60, each keeping 1 of every 2 frames, and 59.94 fps under `max: 30` gets 29.97 (30000/1001) the same way; 60 fps under `max: 29.97` gets 29.97 (30000/1001), because 30 is above the maximum and 60 divided by 3 to 8 is no standard rate; 31 fps under `max: 30` gets 30 and 50 fps under `max: 49` gets 48, not 25, because neither is 1.5 times its nearest candidate; 50 fps under `oneOf: [25, 30]` gets 25. A slower track is never multiplied: 10 fps under `min: 24` gets 24. Every suggested rate passes the `fps` rule when checked again. A VFR or uneven track whose rate passes gets its dominant or nominal rate, else its rounded average, fitted the same way. When no rate meets every bound, as with an empty `oneOf`, a `min` above the `max`, an `exact` rate outside them or outside `oneOf`, or no `oneOf` rate between them, `value` is null and `reason` says so: `50 fps is not allowed, and no frame rate meets every bound of the fps rule`; an empty `oneOf` fails every file with `fps.oneOf: 50 fps is not one of an empty list`, and an empty `codecs` or `containers` list does the same with the same wording (`codecs: h264 is not one of an empty list`).

```ts
const report = check(await probe.tryAnalyze(file), { fps: { min: 24, max: 60 }, duration: { min: 3, max: 10 }, vfr: 'warn' });
report.verdict; // 'fail' for a 23.976 fps file
report.violations[0]; // { rule: 'fps.min', severity: 'fail', expected: 24, actual: '24000/1001', message: 'fps.min: 23.976 (24000/1001) fps is below the minimum 24 fps' }
report.suggestedFps; // { value: 24, reason: '23.976 (24000/1001) fps is not allowed: convert to 24 fps' }
```

## Presets

```ts
import { check } from 'video-fps-probe/check';
import { klingO1ReferenceVideo } from 'video-fps-probe/presets';
import sources from 'video-fps-probe/presets/sources.json' with { type: 'json' }; // only where the page is needed

type PresetSourceKind = 'official' | 'gateway';

interface ProviderPreset {
  readonly name: string;
  /** @deprecated Use video-fps-probe/presets/sources.json; sourceUrl will be removed in the next major. */
  readonly sourceUrl: string;
  readonly sourceKind: PresetSourceKind; // 'gateway': documented by a service that serves another company's model
  readonly verifiedAt: string; // YYYY-MM-DD, the day every number was read again from the source page
  readonly note: string; // what the rules leave out, and why
  readonly rules: { readonly [K in keyof CheckRules]: Readonly<CheckRules[K]> }; // typed read-only and frozen at every level: every importer shares the preset
}

check(result, klingO1ReferenceVideo.rules);
sources.klingO1ReferenceVideo; // 'https://kling.ai/document-api/api/video/o1/video-omni.md', the page every limit was read from
```

The source pages are in `video-fps-probe/presets/sources.json`, keyed by the name of the preset's export. `sourceUrl` is deprecated: use `video-fps-probe/presets/sources.json`; `sourceUrl` will be removed in the next major. Until then every preset keeps it, with the same page, so a 0.2.0 consumer that reads `klingO1ReferenceVideo.sourceUrl` still compiles and runs, and its type carries the `@deprecated` tag that editors strike through. The presets module therefore still holds the six URL strings, which a supply-chain scanner such as Socket may report as a possible network access; no code of the package fetches them, and the next major leaves them in `sources.json` only. A bundler and Node 22 read it with `with { type: 'json' }`, CommonJS with `require('video-fps-probe/presets/sources.json')`, and TypeScript with `resolveJsonModule`, under every `moduleResolution` (node10 through `typesVersions`).

The published input limits of video generation APIs for a reference or source video, as `check()` rules. Each preset is a named export with no import, so a bundler keeps only the presets a host imports. Every preset is frozen at every level with `Object.freeze` when the module loads, so writing to one throws a `TypeError` in strict mode (all ES modules) instead of changing the limits for every other importer; the freezing call is annotated `/*#__PURE__*/`, so a bundler still drops the presets a host does not import (the `preset` row of the [size matrix](../report/size-matrix.md) holds one preset, and a consumer test finds only its source in the build). A rule holds only a limit the source states; a limit the page leaves ambiguous or does not publish is left out, and the note says so. No source says whether its MB is decimal or binary, so a size limit holds the larger reading, MiB (1,048,576 bytes), and the note names it: a file over the limit is over it under either reading, and a file between the two readings passes and may still be refused. A gateway preset, documented by a service such as fal or EvoLink that serves another company's model, has `severity: 'warn'`, because its limits need not be the model owner's. Limits of a request rather than a file, such as the number of reference videos or their total duration, are outside `check()`, which judges one file.

| Export | Model and input | Source | Rules |
|---|---|---|---|
| `klingO1ReferenceVideo` | Kling O1 omni video: the feature or base video | official | 24 to 60 fps, 3 to 10 s, each side 700 to 2160 px, at most 200 MB (read as MiB), MP4 or MOV |
| `klingMotionControl` | Kling Motion Control 3.0: the motion video | official | 3 to 30 s (10 s when the character orientation follows the image, not checked), each side 340 to 3850 px, at most 100 MB (read as MiB), MP4 or MOV |
| `runwayAleph2` | Runway Aleph 2.0: the input video | official | at most 30 fps, 2 to 30 s, at most 200 MB read as MiB (the upload limit; 32 MB by URL), MP4, MOV, Matroska or WebM with H.264, HEVC, AV1, ProRes, VP8, VP9, MJPEG or MPEG-2 |
| `veoExtend` | Google Veo 3.1: the video to extend | official | exactly 24 fps, 1 to 30 s, 16:9 or 9:16, a short side of at least 720 px, MP4 |
| `wan26ReferenceToVideoFal` | Wan 2.6 reference to video, as the fal endpoint documents it: each reference video | gateway | at least 16 fps, 2 to 30 s, at most 30 MB (read as MiB), MP4 or MOV |
| `seedance2ReferenceVideo` | Seedance 2.0: a reference video, as the EvoLink gateway documents it | gateway | 24 to 60 fps, 2 to 15 s, each side 300 to 6000 px, 409,600 to 2,086,876 pixels, an aspect ratio of 0.4 to 2.5, at most 50 MB (read as MiB), MP4 or MOV |

Every number was read again from its source on 2026-10-25. The preset tests fail when a preset lacks a source, a kind, a date or a note, and warn without failing (a GitHub Actions warning in CI) when a `verifiedAt` is more than 90 days old: read the page again and move `verifiedAt` only after every number has been checked.

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

`crashed` covers every `worker-failed` of an engine, load failures included: an engine chunk or worker script that returns 404 after a redeploy is `crashed` with `error.reason === 'load'`, an engine that failed after it loaded has `error.reason === 'crash'`. Read `error.reason` before treating a `crashed` engine as broken.

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
  readonly reason?: 'load' | 'crash'; // set on worker-failed only
  // cause: the underlying error or the worker's error event, when there is one
}
function isAbortError(e: unknown): boolean; // an error named ProbeError with code 'aborted', or any error named AbortError
function isTimeoutError(e: unknown): boolean; // an error named ProbeError with code 'timeout', or any error named TimeoutError
```

| Code | When |
|---|---|
| `aborted` | the call's `signal` was aborted, or the probe was destroyed |
| `timeout` | `timeoutMs` passed after a worker took the job (or after an in-thread start) |
| `worker-failed` | a worker could not start or crashed; a worker could not load the engine of a job (the mp4box or mediabunny chunk or a custom loader, with the statistics chunk loaded next to it); a main-thread chunk failed to load (the probe client of a lazy stub, the inline, fallback or compare chunk, or the module of an in-thread engine); or an engine rejected. Not the parser and statistics chunks of own: see below. `reason` tells the two kinds apart |
| `engine-not-registered` | the engine id has no route in this probe (thrown at creation for `engine` and `fallback`, rejected at call time otherwise) |
| `unknown-engine` | the worker does not serve the engine it was asked for: `worker.engines` lists an engine that `serveProbeWorker` was not given |
| `unsupported-environment` | the engine cannot run here: a worker-only engine without `Worker`, or rvfc without a DOM |
| `protocol` | the worker speaks another protocol version or got a malformed message, usually a worker from another package version |

`reason` is set on every `worker-failed` the probe raises and on no other code:

| Reason | When | What helps |
|---|---|---|
| `load` | code the probe needs did not load: the worker script (any `error` event before the worker's first reply: the script did not load, did not parse or threw at the top level), `new Worker()` threw (for example a CSP or a cross-origin URL), a worker could not load the engine module of a job, or a main-thread chunk import rejected, the factory of a lazy stub included. The message keeps the browser's text (`Failed to fetch dynamically imported module: <url>` for a chunk); for the worker script it is `worker script failed to load or parse; the app may have been redeployed`, followed by the event's message when the browser gives one | after a redeploy the old hashed files are gone: reload the page ([deploy skew](bundlers.md#deploy-skew)); otherwise retry, the next call loads again. A worker script that does not parse in this browser fails the same way on every try |
| `crash` | the code loaded and then failed: a worker `error` event after the worker's first reply (an uncaught exception), or an engine that rejected or threw | a bug or a file the engine cannot handle; retrying the same file usually fails the same way |

A `ProbeError('worker-failed')` that an in-thread engine throws itself is passed through as it is, so its `reason` can be unset.

Problems with the file itself are never errors: they are `result.error` (and `ok: false` in `summarize`). So is a parser or statistics chunk of own that fails to load, in a worker or in the calling thread: own loads them itself and returns the import error's message as `result.error`, so the call resolves and a fallback chain moves on to its next engine. A rate profile chunk that fails to load leaves `rateProfile` null.

Every rejection of a probe or a lazy stub is a `ProbeError`. The guards check the name and the code instead of `instanceof`, so a `ProbeError` from another copy of the package counts too. The probe also goes by the name and a string code before it wraps an error (`compare`, fallback chains, main-thread engines, the lazy stubs and the React store): they pass a `ProbeError` of another copy (from an engine module, a lazy factory or a custom probe given to `VideoFpsProvider`) through with its code, instead of turning it into `worker-failed`.

## Worker protocol

Messages carry `v: 1` (`PROTOCOL_VERSION`). Requests are `analyze { id, file, name, engine, options }`, `warm { id, engines, containers }` and `cancel { id }`; responses are `progress` (at most every 50 ms), `result`, `skipped { reason, family }`, `warmed` and `error { message, aborted, code?, reason? }`, where `reason: 'load'` marks an engine module that failed to load, and any failed `warm`, which only loads code (an optional field: a client that does not know it reads the error as a crash). The protocol is internal: the client and the worker must come from the same package version, and a mismatch is reported as `protocol`. A breaking protocol change bumps the version and is a major release.

## Versioning

The package follows semantic versioning, with these rules:

- **Patch**: fixes, including accuracy changes toward ffprobe.
- **Minor**: new optional result fields, new engines or entries, new options.
- **Major**: removing or retyping a field, a new major of a peer, or a higher browser floor.
- Items marked experimental here (`compare`, `CompareResult`, the native `mp4box`, `mediabunny` and `rvfc` details on `ProbeResult`) can change in a minor release.
- **Frozen from 0.4.0-beta.1.** These are API from 0.4.0-beta.1 on, and 0.4.0-beta.2, 0.4.0 and every later release only add to them:
  - the `FileErrorCode` values `empty-file`, `unrecognised`, `unsupported-container`, `unsupported`, `too-large`, `no-header`, `truncated`, `corrupt`, `no-duration`, `byte-limit`, `read-limit`, `time-limit`, `structure-limit`, `read-failed`, `load-failed`, `engine-failed` and `internal`, and the `ErrorClass` of each.
  - the `WarningCode` values with the warning prefixes they classify: `invalid mdhd timescale ` and `invalid timescale ` (`invalid-timescale`), `'mdat' at <offset> is truncated` (`truncated-mdat`), `'<type>' at <offset> is truncated` (`truncated-box`), `ignored trailing data at ` (`trailing-data`), `fragment index not read: ` (`fragment-index-unread`), `format duration unresolved: ` (`duration-unresolved`), `fragments ignored: ` (`fragments-ignored`) and `too many top-level boxes` (`structure-limit`).
  - `LayoutKind` and the members of `ContainerLayout`: `kind`, `moovOffset`, `moovSize`, `sidx` and `emptyMoov`.
  - the members of `HeaderLimits` (`maxBytes`, `maxReads`, `maxMs`, `maxTracks`, `maxTopLevelBoxes`) and of `HeaderOptions` (`name`, `signal`, `limits`, `readAhead` with `head` and `tail` only, `fragmentedDuration`), the `analyzeHeader` signature, the export `HEADER_DEFAULT_LIMITS` and its keys, and the exports `isAbortError` and `isTimeoutError` of `video-fps-probe/header`. A default value of `HEADER_DEFAULT_LIMITS` may change in a later release, as a behaviour change that the changelog names.
  - how `analyzeHeader` treats keys: `readAhead` refuses any key but `head` and `tail` with a `TypeError`, and the options and `limits` ignore keys they do not know.
  - the whole `video-fps-probe/url` API: `rangeSource`, `openRangeSource`, `httpRange`, `readCapped`, `RangeSourceError` with its `code` and `status`, the `RangeSourceErrorCode` values, and the types `RangeRequest`, `RangeReply`, `RangeFetcher`, `RangeSource`, `RangeSourceInit`, `OpenRangeSourceInit`, `HttpRangeInit` and `RangeSourceErrorOptions`, with `BlobLike` and `BlobSlice`, the types of the root entry that it re-exports unchanged.
  - `ColorInfo` and `DolbyVisionConfig` join the list at 0.4.0-beta.2.
- A minor release may add error codes, error classes and warning codes. Treat an error code or an error class you do not know like `internal` and a warning code you do not know like null. Moving a failure to another code is a behaviour change and the changelog says so. The code `errorCodeOf` reads from the text of another engine (mp4box, mediabunny or rvfc) is best effort and may change in a minor release, because those texts come from the libraries and the browser. The text of an `error` or a warning outside the coded prefixes is not part of the API.
- The rules of a preset follow its source: when a provider changes its published limits, the preset changes with them in the next minor release, with the new `verifiedAt` and a changelog entry. Pin your own rules if they must not move.

The package stays on 0.x until a production consumer has completed a release cycle with it; during 0.x a minor release may contain breaking changes, listed in the [changelog](../CHANGELOG.md).
