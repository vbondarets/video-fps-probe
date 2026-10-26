# video-fps-probe

Frame rate, frame count, VFR detection and a rate profile for MP4, MOV, WebM and MKV files, read from the container headers in a Web Worker. Nothing is decoded and nothing leaves the browser, and the values match ffprobe 8.1.1 on the test corpus (0 mismatches). ESM only, no runtime dependencies, types included.

**[Live demo](https://vbondarets.github.io/video-fps-probe/)** · [API](docs/api.md) · [Bundlers](docs/bundlers.md) · [Benchmarks](docs/benchmarks.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

## Install

```
npm install video-fps-probe
yarn add video-fps-probe   # Yarn classic and berry
pnpm add video-fps-probe
bun add video-fps-probe
```

The first npm release is 0.2.0; one publish serves every package manager ([publishing](docs/publishing.md)). npm is the tested package manager: CI installs the packed tarball with npm. Yarn, pnpm and bun are expected to work but are not tested in CI yet (pnpm and Yarn PnP join the matrix in 0.3.0). The package has no dependencies. Its peers are optional and no package manager installs them for you: install one yourself, only for the entry you import: `mp4box` for `video-fps-probe/mp4box`, `mediabunny` for `video-fps-probe/mediabunny`, React 18 or 19 for `video-fps-probe/react`.

For a commit that is not released yet, install a packed tarball. A git dependency gets no code with npm (Yarn, pnpm and bun are not tested): `prepack` builds `dist/`, and npm does not run it for a git install.

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

The first call loads the probe client and the own worker of the file's container family, picked by its first 4 bytes, with the parser inside; `probe.prewarm()` loads them ahead, for example when an upload dialog opens. `createProbe()` from `video-fps-probe` is the probe without the stub; `summarize(result)` flattens the primary track.

## React

```tsx
import { useState } from 'react';
import { lazyProbe } from 'video-fps-probe/lazy';
import { VideoFpsProvider, useVideoFps } from 'video-fps-probe/react';

const probe = lazyProbe(); // once, at module scope

export const App = () => (
  <VideoFpsProvider probe={probe}>
    <Upload />
  </VideoFpsProvider>
);

function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const { status, summary } = useVideoFps(file); // 'idle', 'pending', 'success' or 'error'; also result, error, progress, cancel(), retry()
  return (
    <>
      <input type="file" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
      {status === 'success' && <p>{summary?.ok ? `${summary.fps?.toFixed(3)} fps` : summary?.error}</p>}
    </>
  );
}
```

React 18 and 19. `useVideoFps` caches each result by the file and the options, runs one analysis through the double effects of `StrictMode`, and aborts a pending one when the last component using it unmounts; `usePrewarmVideoFps()` returns a function that prewarms the probe ([details](docs/api.md#react)).

## Engines

Own, the default, needs nothing else. mp4box.js and mediabunny are optional peers for a second opinion or a fallback, and rVFC estimates by playing the file:

```ts
import { lazyProbe } from 'video-fps-probe/lazy';
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

In-thread `analyze()` is tested on Node 24, the version in `.nvmrc`, and on Node 22.12, the lowest supported version: CI runs the unit, fixture and package tests on both. The example needs `fs.openAsBlob`, available since Node 19.8 and stable in Node 24. Files above 4 GiB need a `BlobLike` in Node 24 ([in-thread analyze](docs/api.md#in-thread-analyze)). The type declarations name DOM types such as `Worker` and `HTMLElement`, so a TypeScript project for Node needs `"DOM"` in `lib` or `skipLibCheck: true`.

CommonJS works on Node 22.12 and newer, which load ES modules from `require()`: `const { analyze } = require('video-fps-probe')`, the subpaths included, and a TypeScript project with `"module": "commonjs"` and `moduleResolution` `node10`, such as a NestJS 11 app. The package test checks both from the packed tarball on Node 22.12 and 24. Jest needs the package transformed or native ES modules ([CommonJS](docs/api.md#commonjs)).

## Cancellation, timeouts and failing open

```ts
probe.prewarm(); // when the upload dialog opens
const deadline = new AbortController();
const late = new Promise<null>((resolve) => setTimeout(() => (deadline.abort(), resolve(null)), 5000));
const checks = Promise.all(files.map((f) => probe.tryAnalyze(f, { timeoutMs: 3000, signal: deadline.signal })));
const results = await Promise.race([checks, late]); // null, or null entries: upload without the check
```

`tryAnalyze` resolves `null` where `analyze` rejects. `timeoutMs` counts per job once a worker takes it and the signal cancels queued and running jobs, but neither covers main-thread chunk downloads: hence `prewarm()` and the race. A probe and a lazy stub reject only with a `ProbeError`; code that did not load, such as a chunk that is gone after a redeploy, has `reason: 'load'`. [Details](docs/api.md#cancellation-and-failing-open).

## Check before upload

```ts
import { check } from 'video-fps-probe/check';
import { klingO1ReferenceVideo } from 'video-fps-probe/presets';

const report = check(await probe.tryAnalyze(file, { timeoutMs: 3000 }), klingO1ReferenceVideo.rules);
if (report.verdict === 'fail') showErrors(report.violations, report.suggestedFps?.reason); // for example 'convert to 24 fps'
else upload(file); // 'pass', 'warn', or 'unknown': no result, an error or a missing field fails open
```

Rules are JSON, such as `{ fps: { min: 24, max: 60 }, duration: { max: 10 }, vfr: 'warn' }`, and frame rates compare as exact rationals: 23.976 fps (`24000/1001`) is below a minimum of 24, 59.94 meets a maximum of 60. The presets hold the published input limits of Kling O1 and Motion Control, Runway Aleph 2.0, Veo 3.1, and Wan 2.6 on fal and Seedance 2.0 on EvoLink (gateways, so they only warn), each with the day it was verified; their source pages are in `video-fps-probe/presets/sources.json` ([check](docs/api.md#check), [presets](docs/api.md#presets)).

## Size

<!-- tables:size:start -->

**0.67 KB gzip on the critical path**: the package code in the entry chunk of a Vite 8.3.5 app that imports `video-fps-probe/lazy` (1.39 KB with Vite's preload helper). The rest loads lazily, on the first file:

| Host Vite config | Critical path | First MP4 | First MKV | All own paths | Worker files |
|---|---:|---:|---:|---:|---:|
| `worker: { format: 'es' }` (recommended) | **0.67 KB** | 22.84 KB | 25.64 KB | 48.81 KB | 2 |
| none (Vite's default, 'iife') | **0.66 KB** | 24.64 KB | 27.17 KB | 48.52 KB | 2 |

Own runs on one worker per container family, picked by the first four bytes of the file, so a first file loads only the worker of its family. An iife worker cannot split, so without the option each own worker is one file with its lazy parts inlined:

```js
import { defineConfig } from 'vite';

export default defineConfig({ worker: { format: 'es' } });
```

Engines cost nothing until imported. Importing a descriptor grows the critical path a little, from 0.67 KB to 0.89 KB with mp4box or mediabunny, 0.76 KB with rVFC and 1.00 KB with all three, and the engine itself loads lazily: mp4box 44.86 KB, mediabunny 53.97 KB, rVFC 2.19 KB. Gzip -9 of production builds from the packed tarball, budgeted in CI; every configuration is in [docs/benchmarks.md](docs/benchmarks.md#package-size).

`video-fps-probe/react` adds 1.19 KB to the critical path for the provider, `useVideoFps` and its store (React itself not counted); its first analysis also fetches a 0.43 KB summary module, in parallel with the probe client. `video-fps-probe/check` adds 3.95 KB when imported statically, and nothing lazily; one preset from `video-fps-probe/presets` adds 0.41 KB.

<!-- tables:size:end -->

## Accuracy

<!-- tables:accuracy-summary:start -->

**0 mismatches against ffprobe 8.1.1** on the 130 committed fixtures: 2054 field checks, 1976 exact, 13 within tolerance (9 of them a definition difference by design: the measured average of a Matroska file that stores no duration for its last frame, which avgFps gives the median interval and ffprobe its own estimate), 0 known deviations with a recorded reason, 65 not applicable. The same comparison runs mp4box.js 2.4.1 and mediabunny 1.62.1 in 5 arms (their idiomatic recipes, mediabunny with a full scan, and this package's tuned adapters) and sorts each difference into wrong, definition differs, unverified, not provided or unsupported container; the [accuracy section](docs/benchmarks.md#accuracy-vs-ffprobe) has the outcomes and where the libraries win.

Of the 130 committed fixtures, 118 are synthetic files made with ffmpeg and 12 are real MediaRecorder recordings from headless Chromium, committed as recorded; per-engine tables, speed and method: [docs/benchmarks.md](docs/benchmarks.md).

<!-- tables:accuracy-summary:end -->

## Browser support

Chrome and Edge 94, Firefox 114, Safari and iOS 15.4: floors derived from the features used, not tested on those versions; CI runs Chromium, Firefox and WebKit. mp4box.js needs Safari 16.4; rVFC needs `requestVideoFrameCallback` (Chrome 83, Firefox 132, Safari 15.4), a visible foreground tab and a playable codec. [Details](docs/benchmarks.md#browser-support).

Known limitations: [changelog](CHANGELOG.md#known-limitations), [benchmarks](docs/benchmarks.md#limitations). Development: [demo/README.md](demo/README.md), [scripts](docs/benchmarks.md#reproducing-the-numbers).

## License

[MIT](LICENSE). The optional peers have their own licenses: mediabunny is MPL-2.0, mp4box is BSD-3-Clause.
