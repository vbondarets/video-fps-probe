# video-fps-probe

Frame rate, frame count, VFR detection and a rate profile for MP4, MOV, WebM and MKV files, read from the container headers in a Web Worker. Nothing is decoded and nothing leaves the browser, and the values are ffprobe-exact on the test corpus.

**[Live demo](https://vbondarets.github.io/video-fps-probe/)** · [API](docs/api.md) · [Bundlers](docs/bundlers.md) · [Benchmarks and accuracy](docs/benchmarks.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

## What you get

- **Average FPS** as an exact rational, next to the `avg_frame_rate` string ffprobe 8.1.1 prints, plus nominal, minimum and maximum FPS.
- **Frame count** (presented frames and stored samples), duration, codec, dimensions and rotation for every video track, primary track first.
- **VFR detection** with the same rule as the ffprobe references, and a **rate profile** for timelines whose frame intervals differ: steady and variable segments, rate changes, freezes, gaps, bursts and an `uneven` flag.
- **Provenance** on each value (header, exact, sampled, estimated, computed) and warnings in plain words. A bad file comes back as `result.error`, never as an exception.
- **Containers**: MP4 and MOV (ISO BMFF, fragmented MP4 included), WebM and Matroska, sniffed from the bytes, never from the file name. Usually one or two `Blob.slice()` reads per file.
- **Small and lazy**: the parsers run in a module worker and load per container on first use. Optional engines (mp4box.js, mediabunny, a `requestVideoFrameCallback` playback estimate) cost nothing until imported.

ESM only, no runtime dependencies, TypeScript types included. A React entry (`video-fps-probe/react`) comes in 0.2.0.

## Install

**Not published yet; install from GitHub or wait for the first npm release.** Once it is on npm, one publish to the registry serves every package manager:

```
npm install video-fps-probe
yarn add video-fps-probe
pnpm add video-fps-probe
bun add video-fps-probe
```

Until then, install a tarball built from the repository. A plain git dependency (`npm install github:vbondarets/video-fps-probe`) does not work: `dist/` is not committed, the `prepack` script builds it, and npm runs only `prepare` for git dependencies, so the installed package would contain no code.

```
git clone https://github.com/vbondarets/video-fps-probe.git
cd video-fps-probe
npm ci
npm pack                     # prepack builds dist/ and checks it, then writes video-fps-probe-0.0.0.tgz
cd ../your-app
npm install ../video-fps-probe/video-fps-probe-0.0.0.tgz
```

This is how CI installs the package for its consumer tests. The optional engines need their own peer packages, see [Choosing engines](#choosing-engines).

## Quick start

```ts
import { lazyProbe } from 'video-fps-probe/lazy';

const probe = lazyProbe(); // loads nothing until the first call

export async function fpsOf(file: File) {
  const result = await probe.analyze(file);
  const track = result.videoTracks.find((t) => t.trackId === result.primaryTrackId);
  if (result.error || !track?.avgFps) return null;
  return {
    fps: track.avgFps.value, // exact rational in track.avgFps.num / track.avgFps.den
    ffprobe: track.avgFpsFfprobe, // the avg_frame_rate string ffprobe prints, when it can be reproduced
    frames: track.presentedFrames ?? track.frames,
    vfr: track.isVfr,
    profile: track.rateProfile?.summary ?? null, // for example "Uneven: 5 fps for 4 s, 200 fps for 4 s"
  };
}
```

- `lazyProbe()` keeps only a small stub in your bundle. The first call loads the probe client, starts the own worker, and the worker loads the parser for the sniffed container.
- Call `probe.prewarm()` when an upload dialog opens: it does all of that without a file, so the first result does not wait for the network.
- `summarize(result)` (from `video-fps-probe` or `video-fps-probe/client`) flattens the primary track into plain numbers with an `ok` flag.
- `createProbe()` from `video-fps-probe` is the same probe without the lazy stub. Every option, the result schema and the error codes are in [docs/api.md](docs/api.md).

## Choosing engines

The own parsers are the default and the only engine that needs no extra package. The other engines are descriptors you import and register; each is for comparison or fallback.

| Engine | Entry | Peer to install | Containers | Runs |
|---|---|---|---|---|
| own (default) | built into `video-fps-probe` and `video-fps-probe/lazy` | none | MP4, MOV, WebM, MKV | the own worker |
| mp4box.js | `video-fps-probe/mp4box` | `mp4box` (`^2.4.1`, verified with 2.4.1, BSD-3-Clause) | MP4, MOV | an mp4box worker, which also serves own |
| mediabunny | `video-fps-probe/mediabunny` | `mediabunny` (`^1.62.0`, verified with 1.62.0, MPL-2.0) | MP4, MOV, WebM, MKV | a mediabunny worker, which also serves own |
| rVFC | `video-fps-probe/rvfc` | none | whatever the browser can play | the main thread: plays the file in a visible element |

```ts
import { lazyProbe } from 'video-fps-probe/lazy';
import { mediabunny } from 'video-fps-probe/mediabunny';
import { mp4box } from 'video-fps-probe/mp4box';

const probe = lazyProbe({ engines: [mp4box(), mediabunny()] });

await probe.analyze(file); // own
await probe.analyze(file, { engine: 'mediabunny' }); // one engine per call
await probe.analyze(file, { fallback: ['mediabunny'] }); // own first, mediabunny when own returns an error or no frame rate, times out or crashes

const { outcomes, agreement } = await probe.compare(file); // every registered engine except rvfc, experimental
agreement.agree; // true, false, or null when nothing could be compared
```

- Optional peers are never installed for you: `npm install mp4box` or `npm install mediabunny`. Importing `video-fps-probe/mp4box` without the peer fails the build, because `mp4box` cannot be resolved.
- Engine ids are typed from what you register, so `engine: 'mp4box'` without `mp4box()` is a type error (and `ProbeError('engine-not-registered')` at run time).
- `compare` runs engines on different workers in parallel and reports per engine `ok`, `failed`, `skipped`, `timeout` or `crashed`, plus an `agreement` on the primary track: exact rationals, exact frame counts, durations within 1e-6 s ([agreement rules](docs/api.md#compare-and-agreement)).
- rVFC is never added to a compare set or a fallback chain implicitly. It needs a visible, attached host element (`rvfc({ host })` or the per-call `host` option), a foreground tab and a codec the browser can play, and it takes seconds per file.
- One worker serving several engines, a classic worker file for esbuild or a CDN, and a host-built worker are in [docs/bundlers.md](docs/bundlers.md).

## Node

```ts
import { openAsBlob } from 'node:fs';
import { analyze } from 'video-fps-probe';

const result = await analyze(await openAsBlob(path), { name: path });
```

The root `analyze()` runs in the calling thread, with no worker. It takes a `Blob` or any `BlobLike` (`size` plus `slice(start, end)` returning something with `arrayBuffer()`), and `{ engine: mp4box() }` runs a registered engine instead of own. In Node 24, `fs.openAsBlob` reports the size of files above 4 GiB modulo 2^32, so pass a `BlobLike` over a file handle for those.

## Cancellation, timeouts and failing open

File problems are data (`result.error`); only infrastructure problems reject, always with a `ProbeError` that carries a `code`. For an upload flow that must never block on the probe:

```ts
probe.prewarm(); // when the upload dialog opens

const deadline = new AbortController(); // AbortSignal.timeout needs Chrome 103, above the browser floor
const timer = setTimeout(() => deadline.abort(), 5000);
const results = await Promise.all(files.map((f) => probe.tryAnalyze(f, { timeoutMs: 3000, signal: deadline.signal })));
clearTimeout(timer);
// null, or summarize(result).ok === false: continue the upload without the check
```

- `tryAnalyze()` resolves `null` where `analyze()` would reject.
- `timeoutMs` counts from the moment a worker takes the job. A worker that times out is terminated at once and the next job starts a new one.
- Queued jobs wait without a limit, so one shared `signal` is what bounds a whole batch: aborting it rejects queued jobs at once and cancels the running one.
- `dispose()` terminates idle workers (they also stop after 30 s idle by default); `destroy()` aborts everything.

## Size

<!-- tables:size:start -->

**0.67 KB gzip on the critical path.** That is the package code in the entry chunk of a Vite 8.3.5 app that imports `video-fps-probe/lazy` (1.40 KB together with Vite's preload helper, which any app with a dynamic import already has). Everything else loads lazily, on the first file:

| Host Vite config | Critical path | First MP4, lazy | All own paths, lazy | Worker files |
|---|---:|---:|---:|---:|
| `worker: { format: 'es' }` (recommended) | **0.67 KB** | 23.26 KB | 36.24 KB | 1 |
| no worker option (Vite's default format, 'iife') | **0.67 KB** | 34.77 KB | 34.77 KB | 1 |

Vite builds workers as 'iife' unless told otherwise, and an iife worker cannot split, so without the option the own worker is one file with both parsers. One line in the host's Vite config splits it; module workers run on the whole browser floor:

```js
export default defineConfig({ worker: { format: 'es' } });
```

Engines cost nothing until their entry is imported. Each adds a lazy chunk, loaded on its first run: mp4box 44.77 KB (critical path 0.90 KB), mediabunny 53.87 KB (critical path 0.90 KB), rVFC 2.19 KB (critical path 0.77 KB). A custom worker (`video-fps-probe/client/lazy`) has a 0.68 KB critical path and a 23.15 KB first MP4; the standalone classic worker file is 32.04 KB.

Measured by `npm run size:matrix` on production builds installed from the packed tarball (gzip -9, KB = 1000 bytes); CI fails on any budget overrun. Every configuration is in [docs/benchmarks.md](docs/benchmarks.md#package-size), every budget with its reason in [report/size-matrix.md](report/size-matrix.md).

<!-- tables:size:end -->

## Accuracy

<!-- tables:accuracy-summary:start -->

**0 mismatches against ffprobe 8.1.1** on the 111 committed fixtures: 1747 field checks, 1690 exact, 2 within tolerance, 1 known deviation with a recorded reason, 54 not applicable. On the same fixtures mp4box.js has 109 mismatches on 50 fixtures (81 of them on WebM and Matroska files it cannot open) and mediabunny has 122 mismatches on 56 fixtures.

<!-- tables:accuracy-summary:end -->

Every check is against a stored ffprobe 8.1.1 reference of a synthetic fixture made with ffmpeg; real recorder output (phones, screen recorders, MediaRecorder) is not in the corpus. Per-engine tables, speed, the comparison with mp4box.js, mediabunny and rVFC, and the method are in [docs/benchmarks.md](docs/benchmarks.md).

## Browser support

**Chrome and Edge 94, Firefox 114, Safari and iOS Safari 15.4.** These floors are derived from the features the build uses (module workers with `import()`, `BigInt`, `Blob.arrayBuffer()`, ES2022), not tested on those versions. CI runs Chromium, Firefox and WebKit (Playwright builds).

- Firefox before 114 has no module workers; the classic standalone worker file (`video-fps-probe/standalone/own.worker.js`) is the route there, untested on old versions.
- The mp4box.js engine needs Safari 16.4 (class static blocks in mp4box).
- rVFC needs `requestVideoFrameCallback` (Chrome 83, Firefox 132, Safari 15.4), a visible foreground tab and a playable codec; HEVC did not play in headless Chrome and ProRes does not play in Chrome.

## Known limitations

- **Zero-config Vite builds one big worker.** Without `worker: { format: 'es' }`, the own worker is one file with both parsers ([Size](#size)).
- **Cadence reads as steady.** A regular cadence such as 2:3 pulldown or a regular frame drop pattern is VFR, but the rate profile calls it "Steady", not uneven.
- **rVFC needs playback**: seconds per file, a visible tab, a playable codec, and wrong averages on VFR files.
- **Matroska has no frame index.** In the default `auto` mode a large file gets a sampled probe (no frame count, no average) unless the exact scan is predicted to take at most 150 ms; pass `matroskaMode: 'exact'` to force it.
- **Size limits.** Files above 2^53 bytes, 64-bit values above 2^53-1, compressed movie headers (`cmov`) and a moov above 256 MiB are rejected with an error result. Only the first sample entry of a track is used.
- **Synthetic corpus.** The references are pinned to ffprobe 8.1.1; real recorder files and later FFmpeg versions can differ on edge cases.

The full list, with measured cases, is in [docs/benchmarks.md](docs/benchmarks.md#limitations).

## Development

Node 22.12 or newer. The demo lives in [demo/](demo/README.md) and consumes the library by package name.

```
npm ci
npm test                 # vitest: unit, fixture and API tests in Node
npm run typecheck        # tsc -b
npm run lint             # oxlint
npm run build:lib        # the library to dist/
npm run check:package    # publint and check-dist on dist/
npm run dev              # the demo on the Vite dev server
npm run test:e2e         # Playwright: the built demo in Chromium, Firefox and WebKit
```

Every script, the fixture generator and the report pipeline: [docs/benchmarks.md](docs/benchmarks.md#reproducing-the-numbers).

## License

[MIT](LICENSE). The optional peers have their own licenses: mediabunny is MPL-2.0 and mp4box is BSD-3-Clause. Neither is installed unless you add it.
