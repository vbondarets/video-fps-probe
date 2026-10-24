# video-fps-probe

Frame rate, frame count, VFR detection and a rate profile for MP4, MOV, WebM and MKV files, read from the container headers in a Web Worker. Nothing is decoded and nothing leaves the browser, and the values match ffprobe 8.1.1 on the test corpus (0 mismatches). ESM only, no runtime dependencies, types included.

**[Live demo](https://vbondarets.github.io/video-fps-probe/)** · [API](docs/api.md) · [Bundlers](docs/bundlers.md) · [Benchmarks](docs/benchmarks.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

## Install

**Not published yet; install from GitHub or wait for the first npm release.** One registry publish will serve every package manager:

```
npm install video-fps-probe
yarn add video-fps-probe
pnpm add video-fps-probe
bun add video-fps-probe
```

With npm a git dependency gets no code: `prepack` builds `dist/`, and npm does not run it for git installs. That is verified for npm only; what yarn, pnpm and bun do for a git install is not verified. Install a packed tarball:

```
git clone https://github.com/vbondarets/video-fps-probe.git && cd video-fps-probe
npm ci && TGZ="$PWD/$(npm pack | tail -n 1)"   # builds and checks dist/, writes the tarball, keeps its path
cd ../your-app && npm install "$TGZ"
```

In PowerShell: `$tgz = Join-Path $PWD (npm pack | Select-Object -Last 1)`, then `cd ../your-app; npm install $tgz`.

## Quick start

```ts
import { lazyProbe } from 'video-fps-probe/lazy';

const probe = lazyProbe(); // a small stub: loads nothing until the first call

const result = await probe.analyze(file); // a broken file is result.error, not a rejection
const track = result.videoTracks.find((t) => t.trackId === result.primaryTrackId);
track?.avgFps; // exact rational { num, den, value }
track?.avgFpsFfprobe; // the avg_frame_rate string of ffprobe, for example '30000/1001'
track?.presentedFrames; // the frame count
track?.isVfr;
track?.rateProfile?.summary; // for example 'Uneven: 5 fps for 4 s, 200 fps for 4 s'
```

The first call loads the probe client, the worker and the parser of the sniffed container; `probe.prewarm()` loads them ahead, for example when an upload dialog opens. `createProbe()` from `video-fps-probe` is the probe without the stub; `summarize(result)` flattens the primary track. React support comes in 0.2.0.

## Engines

Own, the default, needs nothing else. mp4box.js and mediabunny are optional peers for a second opinion or a fallback, and rVFC estimates by playing the file:

```ts
import { mediabunny } from 'video-fps-probe/mediabunny'; // npm install mediabunny
import { mp4box } from 'video-fps-probe/mp4box'; // npm install mp4box

const probe = lazyProbe({ engines: [mp4box(), mediabunny()] });
await probe.analyze(file, { engine: 'mediabunny' });
await probe.analyze(file, { fallback: ['mediabunny'] }); // on an error, no frame rate, a timeout or a crash
const { outcomes, agreement } = await probe.compare(file); // experimental
```

`agreement.agree` is `true`, `false`, or `null` when nothing could be compared ([rules](docs/api.md#compare-and-agreement)). rVFC (`video-fps-probe/rvfc`) is never used implicitly and needs a visible host element ([engines](docs/api.md#engines)).

## Node

```ts
import { openAsBlob } from 'node:fs';
import { analyze } from 'video-fps-probe';

const result = await analyze(await openAsBlob(path), { name: path }); // in the calling thread, no worker
```

In-thread `analyze()` is tested on Node 24 only, the version in `.nvmrc` that every CI job uses. The example needs `fs.openAsBlob`, available since Node 19.8 and stable in Node 24. Files above 4 GiB need a `BlobLike` in Node 24 ([in-thread analyze](docs/api.md#in-thread-analyze)).

## Cancellation, timeouts and failing open

```ts
probe.prewarm(); // when the upload dialog opens
const deadline = new AbortController();
const late = new Promise<null>((resolve) => setTimeout(() => (deadline.abort(), resolve(null)), 5000));
const checks = Promise.all(files.map((f) => probe.tryAnalyze(f, { timeoutMs: 3000, signal: deadline.signal })));
const results = await Promise.race([checks, late]); // null, or null entries: upload without the check
```

`tryAnalyze` resolves `null` where `analyze` rejects. `timeoutMs` counts per job once a worker takes it and the signal cancels queued and running jobs, but neither covers main-thread chunk downloads: hence `prewarm()` and the race. A probe and a lazy stub reject only with a `ProbeError`; code that did not load, such as a chunk that is gone after a redeploy, has `reason: 'load'`. [Details](docs/api.md#cancellation-and-failing-open).

## Size

<!-- tables:size:start -->

**0.66 KB gzip on the critical path**: the package code in the entry chunk of a Vite 8.3.5 app that imports `video-fps-probe/lazy` (1.39 KB with Vite's preload helper). The rest loads lazily, on the first file:

| Host Vite config | Critical path | First MP4 | All own paths | Worker files |
|---|---:|---:|---:|---:|
| `worker: { format: 'es' }` (recommended) | **0.66 KB** | 23.59 KB | 36.58 KB | 1 |
| none (Vite's default, 'iife') | **0.67 KB** | 35.12 KB | 35.12 KB | 1 |

An iife worker cannot split, so without the option the own worker is one file with both parsers:

```js
export default defineConfig({ worker: { format: 'es' } });
```

Engines cost nothing until imported. Importing a descriptor grows the critical path a little, from 0.66 KB to 0.89 KB with mp4box, 0.90 KB with mediabunny, 0.77 KB with rVFC and 1.01 KB with all three, and the engine itself loads lazily: mp4box 44.77 KB, mediabunny 53.97 KB, rVFC 2.19 KB. Gzip -9 of production builds from the packed tarball, budgeted in CI; every configuration is in [docs/benchmarks.md](docs/benchmarks.md#package-size).

<!-- tables:size:end -->

## Accuracy

<!-- tables:accuracy-summary:start -->

**0 mismatches against ffprobe 8.1.1** on the 111 committed fixtures: 1747 field checks, 1690 exact, 2 within tolerance, 1 known deviation with a recorded reason, 54 not applicable. The same comparison runs mp4box.js 2.4.1 and mediabunny 1.62.1 in 5 arms (their idiomatic recipes, mediabunny with a full scan, and this package's tuned adapters) and sorts each difference into wrong, definition differs, unverified, not provided or unsupported container; the [accuracy section](docs/benchmarks.md#accuracy-vs-ffprobe) has the outcomes and where the libraries win.

<!-- tables:accuracy-summary:end -->

Synthetic fixtures made with ffmpeg; per-engine tables, speed and method: [docs/benchmarks.md](docs/benchmarks.md).

## Browser support

Chrome and Edge 94, Firefox 114, Safari and iOS 15.4: floors derived from the features used, not tested on those versions; CI runs Chromium, Firefox and WebKit. mp4box.js needs Safari 16.4; rVFC needs `requestVideoFrameCallback` (Chrome 83, Firefox 132, Safari 15.4), a visible foreground tab and a playable codec. [Details](docs/benchmarks.md#browser-support).

Known limitations: [changelog](CHANGELOG.md#known-limitations), [benchmarks](docs/benchmarks.md#limitations). Development: [demo/README.md](demo/README.md), [scripts](docs/benchmarks.md#reproducing-the-numbers).

## License

[MIT](LICENSE). The optional peers have their own licenses: mediabunny is MPL-2.0, mp4box is BSD-3-Clause.
