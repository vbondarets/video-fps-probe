# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver with the [0.x policy](docs/api.md#versioning).

## Unreleased

### Added

- `byContainer` on a custom worker: `{ create, engines, byContainer: { matroska: () => new Worker(...) } }` runs own on the worker of the file's container family, and every other engine and family on `create` ([api](docs/api.md)).
- `video-fps-probe/standalone/own-isobmff.worker.js` and `own-matroska.worker.js`: the two own workers as classic scripts with no imports, about 21.1 and 23.7 KB gzip, for `byContainer`. The combined `own.worker.js` stays.
- `lazyProbeClient` and `createProbeClient` load the routing by container family only with `byContainer`, as a chunk of about 0.4 KB gzip, so a custom worker without it loads none of it: about 23.6 KB for the first MP4 with `lazyProbeClient` (23.5 KB in 0.2.0).
- A weekly canary builds the package with the latest mp4box, mediabunny, Vite and rolldown: the comparison against ffprobe, the size budgets and the browser smoke test. It fails only when an own result changes or a size check fails, never when only a library arm changes: its smoke test asserts own only, and the job summary lists what changed in the library arms, in the comparison and in the browsers.

### Changed

- **Behaviour change:** own runs on one worker per container family, `own-isobmff.worker` or `own-matroska.worker`, picked by the file's first 4 bytes. The first MP4 loads about 22.7 KB (23.6 KB in 0.2.0), or 24.5 KB instead of 38.9 KB with Vite's default worker format ([size matrix](report/size-matrix.md)).
- The first WebM or MKV without DefaultDuration, such as a MediaRecorder recording, loads about 25.5 KB (26.7 KB in 0.2.0), and about 27.1 KB instead of 38.9 KB with Vite's default worker format.
- `workers` counts per worker kind, so `workers: 1` can run one MP4 and one WebM at once. `prewarm()` starts the worker of each container family it is given: ISO BMFF by default, nothing for `containers: []`.
- A missing own worker file, such as a 404 after a redeploy, rejects only the jobs of its container family with `reason: 'load'`, and the next call retries; in 0.2.0 a missing parser chunk came back as an error string in the result.
- Service worker precache lists that name `own.worker` need both new worker files. A host that wants one own worker can keep the 0.2.0 layout with a custom worker that runs `serveProbeWorker({ own: ownEngine })` from `video-fps-probe/worker-runtime`.
- `video-fps-probe/presets/sources.json` holds the source page of every preset, keyed by the name of the export (`sources.klingO1ReferenceVideo`). `sourceUrl` is deprecated, not removed: every preset keeps it with the same page, so a 0.2.0 consumer still works, and it will be removed in the next major, which leaves the URL strings that supply-chain scanners such as Socket report in `sources.json` only ([presets](docs/api.md#presets)).
- The installed package grows from about 442 KB to 570 KB unpacked, mostly for the two new standalone files; a bundler still takes only what the app imports.
- CI also runs the unit, fixture and package tests on Node 22.12, the lowest version the package supports, next to Node 24; 0.2.0 tested Node 24 only.
- `require('video-fps-probe')` from CommonJS is tested: the package test `require()`s the packed tarball on Node 22.12 and 24 and compiles a TypeScript project with `module` `commonjs` and `moduleResolution` `node10`, as a NestJS 11 app has, with TypeScript 6.0.3 and 5.9.3; the Jest setup it needs is documented ([CommonJS](docs/api.md#commonjs)).
- Still 0 mismatches against ffprobe 8.1.1, now on 130 committed fixtures: the new ones are byte patches of ffmpeg output with header values that other parsers fail on ([fixtures](fixtures/README.md#header-values-other-parsers-trip-on-section-o)).

### Fixed

- A version 1 `mehd` or `elst` holding 0xFFFFFFFFFFFFFFFF, an unknown duration, failed the whole file with `unsupported: ... above 2^53-1`. `mehd` is now ignored, as ffprobe does. Such an edit lasts from its media time to the end of the media, so one that trims the start keeps the trimmed `durationSec` and `formatDurationSec`, and such an empty edit is ignored, each with a warning; ffprobe 8.1.1 fails both files, so `avgFpsFfprobe` and `rFpsFfprobe` are null.
- A top-level header after the moov that runs past the end of the file, such as the trailer of some phone MOV files, marked the file truncated, and its warning held raw NUL characters. Unless it is an `mdat` or a `moof`, it now ends the walk with `ignored trailing data at N: not a box`, and samples that lie past the end are still cut with a truncation warning on the track.
- Warnings could hold raw NUL and other control characters from the file, such as a box type in an own or mp4box warning. Every engine now replaces them with `?`, and own does so where it reads a box type, a sample entry code (`fourccOrCodecId`) or a Matroska string such as the CodecID or the DocType.
- A file that could not be read, such as a picked file that was changed or deleted since (`NotReadableError`, `InvalidStateError`) or got shorter while it was read, gave `corrupt file: ...` for MP4 and MOV and the browser's bare message for WebM and MKV. `result.error` now reads `file read failed: <error>` for every container, and from the mediabunny engine too, which gave `not a recognised container: <message>` for a failed first read, the bare message for a later one and only a track warning for one in the packet walk of a WebM or MKV track ([api](docs/api.md#proberesult-and-fileresult)).
- A `ProbeError` from another copy of the package, such as one from an engine module or a custom probe given to `VideoFpsProvider`, became `worker-failed` in the lazy stubs, main-thread engines, `compare`, fallback chains and the React store. They now recognize it by its name and a string code, as `isAbortError` does, so it keeps its code ([errors](docs/api.md#errors)).
- `check` judged the `duration` of a VFR WebM or Matroska track by its measured span, up to one frame shorter than the duration ffprobe prints: `vfr_screenrec_ts1000.webm` lasted 5.999 s against 6.000000, so `duration: { min: 6 }` failed it. For a WebM or Matroska track, for which ffprobe prints only the format duration, `check` now judges `formatDurationSec` when it is within one typical frame interval of the span at microsecond resolution, that of `dominantFps`, else of `nominalFps` on a constant track, else of `avgFps`, rather than 1 / `minFps`, which a freeze stretches to seconds; `durationSec` keeps the measured span ([check](docs/api.md#check)).

### Known limitations

- React 18 and 19 only. React is an optional peer, `^18.0.0 || ^19.0.0`: next to another React major npm refuses the install with `ERESOLVE`, unless you pass `--legacy-peer-deps` or add `"overrides": { "video-fps-probe": { "react": "$react" } }` to your `package.json`.
- Zero-config Vite (iife workers) builds each own worker as one file with its lazy parts inlined, so the first MP4 loads about 1.7 KB more than with `worker: { format: 'es' }` ([size matrix](report/size-matrix.md)).
- Only Vite 8 and npm are tested in CI; other bundlers are documented ([bundlers](docs/bundlers.md)), and Yarn, pnpm and bun are expected to work.
- Browser floors (Chrome and Edge 94, Firefox 114, Safari 15.4, mp4box.js Safari 16.4) are derived, not tested; CI runs Playwright's Chromium, Firefox and WebKit, and in-thread `analyze()` is tested on Node 22.12 and 24.
- The type declarations name DOM types, so a TypeScript project for Node needs `"DOM"` in `lib` or `skipLibCheck: true`.
- Jest runs the package only when it transforms it or runs native ES modules; neither setup is tested ([CommonJS](docs/api.md#commonjs)).
- The corpus has real recordings from Chromium's MediaRecorder only: none from Firefox, Safari, phones, cameras or screen recorders.
- A regular cadence such as 2:3 pulldown is VFR, but its rate profile reads as Steady.
- `check` judges the stored frame size: the sample aspect ratio of a `pasp` box or a Matroska DisplayWidth is not applied.
- `check` judges the format duration of a WebM or Matroska track when it is within one frame interval of the measured span, the interval of `dominantFps`, else of `nominalFps` on a constant track, else of `avgFps`. The result holds no median interval, so a recording without a dominant rate, such as the Chromium ones, takes its average interval of about 27 ms rather than its median of 17 ms; 0.4.0 is to expose a median frame interval and use it in `check()` ([check](docs/api.md#check)).
- rVFC needs playback: a visible foreground tab, a playable codec and seconds per file.
- Files above 2^53 bytes, `cmov` headers and a moov above 256 MiB are rejected as error results.
- In `auto` mode a large Matroska file gets a sampled probe unless the exact scan is predicted to take at most 150 ms.

## 0.2.0 - 2026-10-25

### Added

- First release on npm: `npm install video-fps-probe`; Yarn, pnpm and bun install the same publish ([Publishing](docs/publishing.md)).
- `video-fps-probe/react`: `VideoFpsProvider`, `useVideoFps(file)`, `useVideoFpsProbe()` and `usePrewarmVideoFps()` for React 18 and 19. The hook caches results per file, runs one analysis under `StrictMode` and aborts it when its last component unmounts ([React](docs/api.md#react)).
- `video-fps-probe/check`: `check(result, rules)` judges a result against upload limits before the upload: frame rate, duration, frame size, aspect ratio, pixels, file size, container, codec, audio, VFR and uneven pacing. The rules are plain JSON ([Check](docs/api.md#check)).
- `check` compares exact rationals, so 23.976 fps is below `min: 24`, and an NTSC decimal such as 29.97 also matches its x/1001 rate. A missing, failed or malformed result is `unknown` where it lacks a value, never an exception, so an upload can fail open; a broken rule throws a `TypeError` naming it.
- The `check` report has a verdict, one violation per broken rule with a readable message, and a `suggestedFps` to convert to: a clean 1-in-k frame drop when the file is at least 1.5 times the nearest allowed rate (50 fps under `max: 30` gets 25), else the nearest allowed rate (31 fps gets 30).
- `video-fps-probe/presets`: the published input limits of six video generation APIs as `check` rules, with sources, verified on 2026-10-25: Kling O1 and Motion Control 3.0, Runway Aleph 2.0, Veo 3.1, and Wan 2.6 on fal and Seedance 2.0 on EvoLink, which only warn ([Presets](docs/api.md#presets)).
- `ProbeError.reason`: `'load'` when code did not load, such as a chunk that is gone after a redeploy ([deploy skew](docs/bundlers.md#deploy-skew)), `'crash'` when it failed after loading. The code stays `worker-failed`.
- `avgFpsFfprobe` and `rFpsFfprobe` for a WebM or Matroska track without DefaultDuration, such as a MediaRecorder recording: ffprobe's estimate for VP8, VP9, AV1 and Baseline H.264 in the [listed cases](docs/implementation-notes.md#ffprobe-frame-rates-without-defaultduration-020), else null with a warning.

### Changed

- **Behaviour change:** a lazy stub whose probe client fails to load rejects with `ProbeError('worker-failed')`, `reason: 'load'` and the import error as `cause`, instead of the browser's import error. Code that caught that error should test `e.reason === 'load'`.
- `isAbortError` and `isTimeoutError` check the error's name and code instead of `instanceof`, so they also recognize a `ProbeError` from another copy of the package.
- A file smaller than 465,536 bytes is read whole in one read, so a small MP4 with its moov at the end takes 1 read instead of 2; that read is at most 1 MiB whatever the cost model.
- In `auto` mode the exact scan of a Matroska track without DefaultDuration also feeds the ffprobe estimate, so the first Clusters are read once; the track's warning says whether the estimate was reproduced.
- The mediabunny engine is verified with mediabunny 1.62.1; the peer range stays `^1.62.0`.
- Sizes (gzip): the first MP4 of the default configuration loads about 23.6 KB (23.3 KB in 0.1.0) and the critical path stays under 0.7 KB. The React entry adds about 1.2 KB, `check` about 3.9 KB and one preset about 0.5 KB, each only when imported ([size matrix](report/size-matrix.md)).
- Still 0 mismatches against ffprobe 8.1.1, now on 126 committed fixtures: 114 made with ffmpeg and 12 real MediaRecorder recordings from Chromium ([benchmarks](docs/benchmarks.md#accuracy-vs-ffprobe)).

### Fixed

- A worker script that failed to load, such as a 404 after a redeploy, was reported as a crash. It now rejects with `reason: 'load'` and says the app may have been redeployed; when the last worker fails to load, the queued jobs reject once instead of each loading the script again.
- The mp4box engine ended a fragmented track at the sum of its sample durations. It now follows the tfdt timeline like ffprobe, so a Chrome MediaRecorder fMP4 gets ffprobe's duration (4.524533 s instead of 4.557667 s on `rec_chromium_h264.mp4`).

### Known limitations

- React 18 and 19 only. React is an optional peer, `^18.0.0 || ^19.0.0`: next to another React major npm refuses the install with `ERESOLVE`, unless you pass `--legacy-peer-deps` or add `"overrides": { "video-fps-probe": { "react": "$react" } }` to your `package.json`.
- Zero-config Vite (iife workers) loads about 39 KB for the first MP4, one worker with both parsers; `worker: { format: 'es' }` makes it about 23.6 KB.
- Only Vite 8 and npm are tested in CI; other bundlers are documented ([bundlers](docs/bundlers.md)), and Yarn, pnpm and bun are expected to work.
- Browser floors (Chrome and Edge 94, Firefox 114, Safari 15.4, mp4box.js Safari 16.4) are derived, not tested; CI runs Playwright's Chromium, Firefox and WebKit, and in-thread `analyze()` is tested on Node 24 only.
- The type declarations name DOM types, so a TypeScript project for Node needs `"DOM"` in `lib` or `skipLibCheck: true`.
- The corpus has real recordings from Chromium's MediaRecorder only: none from Firefox, Safari, phones, cameras or screen recorders.
- A regular cadence such as 2:3 pulldown is VFR, but its rate profile reads as Steady.
- `check` judges the stored frame size: the sample aspect ratio of a `pasp` box or a Matroska DisplayWidth is not applied.
- `check` takes the duration of a VFR WebM or Matroska track on 1 ms ticks from its measured span, up to one frame shorter than ffprobe's: `vfr_screenrec_ts1000.webm` lasts 5.999 s against 6.000000, so `duration: { min: 6 }` fails it.
- rVFC needs playback: a visible foreground tab, a playable codec and seconds per file.
- Files above 2^53 bytes, `cmov` headers and a moov above 256 MiB are rejected as error results.
- In `auto` mode a large Matroska file gets a sampled probe unless the exact scan is predicted to take at most 150 ms.

### Not yet

- Bundler matrix and peers job (0.3.0): Vite 6, webpack 5, Rspack, Next.js 16 on Turbopack and webpack, a pnpm install and a Yarn PnP install.
- Demo: no prewarm before the first file.

## 0.1.0 - 2026-10-24

First release; not on npm yet (`"private": true`).

### Added

- Frame rate (an exact rational and ffprobe's `avg_frame_rate`), nominal, minimum and maximum FPS, frame counts, duration, codec, size and rotation per video track, a VFR flag and a rate profile, read from MP4, MOV (fragmented included), WebM and Matroska headers in a module worker, without decoding. Values carry provenance tags; file problems are `result.error`.
- Entries: `.` and `./lazy` with the own worker, `./client` and `./client/lazy` for a host worker, the `./mp4box`, `./mediabunny` and `./rvfc` engines, `./worker-runtime` and `./engines/*` for a custom worker, and `./standalone/own.worker.js` ([API](docs/api.md)).
- `analyze` with `engine` and `fallback`, `tryAnalyze`, `compare` (experimental), `prewarm`, `dispose`, `destroy`, `summarize`, `ProbeError`, the in-thread `analyze` for Node, and worker protocol v1.
- Chrome and Edge 94, Firefox 114, Safari 15.4 (derived floors); CI runs Chromium, Firefox and WebKit.
- 0.67 KB gzip on the critical path of a Vite 8.3.5 host; the first MP4 loads 23.26 KB lazily with `worker: { format: 'es' }`.
- 0 mismatches against ffprobe 8.1.1 on the 111 committed fixtures.

### Known limitations

- Zero-config Vite (iife workers) loads 34.77 KB for the first MP4: the probe client and one 32.11 KB worker file with both parsers.
- A regular cadence such as 2:3 pulldown is VFR, but its rate profile reads as Steady.
- rVFC needs playback: a visible foreground tab, a playable codec and seconds per file.
- Files above 2^53 bytes, `cmov` headers and a moov above 256 MiB are rejected as error results.
- In `auto` mode a large Matroska file gets a sampled probe unless the exact scan is predicted to take at most 150 ms.
- Only Vite 8 is verified; the other bundlers are documented, not tested ([bundlers](docs/bundlers.md)).

### Not yet

- React entry (0.2.0), bundler matrix and peers job (0.3.0), npm publishing (1.0.0).
