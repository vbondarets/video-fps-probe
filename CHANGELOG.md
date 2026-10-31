# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver with the [0.x policy](docs/api.md#versioning).

## Unreleased

### Added

- `video-fps-probe/color`: `colorOf(track)` and `withColor(result)` read the codec configuration of a video track and give `color`: the range, primaries, transfer and matrix names that ffprobe 8.1.1 prints, where they came from (`sps`, `colr`, `vpcC` or `Colour`), the bit depth, the numeric profile, the RFC 6381 codec string, `hdr` (`'pq'` or `'hlg'`) and the Dolby Vision configuration record. The container wins over the H.264 or HEVC SPS, as in FFmpeg, and the SPS speaks when the container is silent. A value that is not null equals ffprobe on every committed fixture ([color](docs/api.md#color)).
- `video-fps-probe/aspect`: `aspectOf(track)` and `withAspect(result)` give `sampleAspectRatio`, `displayAspectRatio`, `displayWidth` and `displayHeight`, with the pasp, tkhd matrix, tkhd size and SPS VUI precedence of ffprobe 8.1.1 for MP4 and MOV and the Display and PixelCrop elements for Matroska and WebM. The display size has the rotation applied, for Matroska and WebM the ProjectionPoseRoll that ffprobe reports as the display matrix ([aspect ratio and display size](docs/api.md#aspect-ratio-and-display-size)).
- `codecConfig: true` keeps the raw codec configuration of each video track in `codecConfig` for both entries: the TrackEntry of a Matroska or WebM track in `analyze` and the probes, and the stsd, tkhd and mvhd boxes of an MP4 or MOV track in `analyzeHeader` and in the root `analyze`, which reads the moov once more for them. A probe does not capture MP4 and MOV, and its result carries the warning `codec configuration unavailable` instead, so the option is never a silent no-op. A configuration whose bytes are missing or no longer `Uint8Array` values, as after `JSON.parse`, gives `color` and the aspect fields undefined, as a track without one does.
- `analyzeHeader` options `codecConfig`, `color` and `aspect`. `color: true` and `aspect: true` apply the two entries from a chunk loaded with `import()` and read no extra byte. Each chunk loads under the deadline and the signal of the call. A chunk never turns a result into an error: one that fails to load or has not loaded by `maxMs` leaves the result as it is with a coded warning, and one that an earlier call loaded is applied even after the deadline, since it reads no byte.
- The warning codes `codec-config-unavailable`, for the prefix `codec configuration unavailable`, and `metadata-unavailable`, for `color and aspect unavailable`, which `warningCodeOf` gives to a result whose codec configuration or color and aspect step did not run.
- The new optional result fields `codecConfig`, `color`, `sampleAspectRatio`, `displayAspectRatio`, `displayWidth` and `displayHeight` on `VideoTrackResult`, and the types `CodecConfig`, `ColorInfo`, `ColorSource` and `DolbyVisionConfig`.
- CommonJS copies of `video-fps-probe/color` and `video-fps-probe/aspect`, so the seven server entries load with `require()` and in Jest with no configuration, and their types name no DOM type.

### Frozen from 0.4.0-beta.2

The members of `ColorInfo` and `DolbyVisionConfig`, the `ColorSource` values, the `codecConfig`, `color` and `aspect` options of `analyzeHeader`, the warning codes `codec-config-unavailable` and `metadata-unavailable` with their prefixes and the signatures of `colorOf`, `withColor`, `aspectOf` and `withAspect` join the list of 0.4.0-beta.1. Later releases only add to them. `CodecConfig` is raw bytes for the two entries and may gain members.

### Changed

- The installed package may take up to 936 KB unpacked (867 KB in 0.4.0-beta.1), measured at 921 KB, for the two entries, their CommonJS copies and the longer docs.
- The first MKV or WebM loads 25.77 KB gzip (25.73 KB in 0.4.0-beta.1) for the TrackEntry copy: the Matroska header walk copies every TrackEntry, and the analyzer attaches the copy to the video tracks only with the option. The first MP4 loads 23.10 KB (23.07 KB in 0.4.0-beta.1), 24.88 KB with Vite's default worker format, for the coded warning of a `codecConfig` request that the worker does not capture.
- `video-fps-probe/color` puts 4.67 KB gzip in the entry chunk of an app that imports it, under a budget of 5.0 KB rather than the 4.00 KB the 0.4.0 plan set: the two SPS walkers and the FFmpeg name tables are what make the color result equal to ffprobe.
- `video-fps-probe/header` puts 19.69 KB gzip of package code in the entry chunk (19.28 KB in 0.4.0-beta.1). It loads the codec configuration capture and the two entries with `import()`, so an app whose only dynamic import is this one gets Vite's preload helper, 0.75 KB, in its entry chunk too.
- Still 0 mismatches against ffprobe 8.1.1 on the 168 committed fixtures, now with checks of the color names, bit depth, profile, codec string, Dolby Vision record and both aspect ratios: 4878 checks, with 5 new known deviations where ffprobe takes the color range or matrix from a bitstream the color entry does not read (the AV1 sequence header, ProRes, MPEG-4 Part 2).

### Known limitations

- A probe gives an MP4 or MOV track no `codecConfig`, with the warning `codec configuration unavailable`, so `withColor` and `withAspect` leave it unchanged. `analyzeHeader` and the root `analyze` capture it. Capturing it in the worker measured 0.25 KB on the first MP4 path, over the 0.05 KB this release allows there.
- The color entry does not read the AV1 sequence header, the VP9 frame header, ProRes or HDR10 static metadata (`mdcv`, `clli`, MasteringMetadata), so their values stay null where ffprobe takes them from the decoder. An HLG stream signalled only by an alternative transfer characteristics SEI keeps the `bt2020-10` transfer of its VUI, as the stream keys of ffprobe do. The `rotation` of a Matroska or WebM track stays 0, while `withAspect` applies its ProjectionPoseRoll to the display size.

## 0.4.0-beta.1 - 2026-10-31

### Added

- `errorCode` on every own result: a code for `error` from a closed list, such as `no-header`, `truncated` or `read-failed`, null exactly when `error` is null. Every `error` text is unchanged ([error codes](docs/api.md#error-codes)).
- `errorCodeOf`, `errorClass`, `warningCodeOf` and `warningCodesOf` in the root entry, for results of any engine or version, with stable warning codes: `invalid-timescale`, `truncated-mdat`, `truncated-box` and `trailing-data` from the parsers, `fragment-index-unread`, `duration-unresolved` and `fragments-ignored` from the header entry, and `structure-limit` for `too many top-level boxes` ([error codes](docs/api.md#error-codes)).
- `layout` on ISO BMFF results: `faststart`, `moov-at-end` or `fragmented`, the moov offset and size, a sidx before the first moof, and an empty moov.
- `medianFrameInterval` on video tracks of own, mp4box and mediabunny, and `enabled` (tkhd or FlagEnabled) on own tracks. `TrackField` gains `'medianFrameInterval'`, so an exhaustive `switch` needs the case.
- `video-fps-probe/header`: `analyzeHeader(source, options)` reads only the header of an MP4 or MOV file, in the calling thread, under limits on the bytes requested, the reads, the wall time, the tracks and the top-level boxes (`HEADER_DEFAULT_LIMITS`: 16 MiB, 8 reads, 10 s, 64 tracks and 1024 boxes). A fragmented file gets its duration from a covering sidx, the mfra index or mehd, and new codes name what stopped it: `no-duration`, `byte-limit`, `read-limit`, `time-limit` and `structure-limit`. It rejects only on the caller's abort and on an invalid option, with a `TypeError`, and adds at most 1 byte to the other entries ([header-only analysis](docs/api.md#header-only-analysis)). `readAhead` takes only `head` and `tail`, so the `fragment` or `matroskaScan` of `analyze` there is a `TypeError` rather than a silent no-op, and the options and `limits` ignore keys they do not know, so an option or a limit of a later version does not fail here. The entry also exports `isAbortError` and `isTimeoutError`. The signature, the members of `HeaderOptions` and `HeaderLimits`, these rules for keys, the error and warning codes and these exports are frozen from 0.4.0-beta.1.
- `video-fps-probe/url`: `rangeSource(fetcher, { size })`, `openRangeSource(fetcher)`, `httpRange(url)`, `readCapped(body, expectedLength)` and `RangeSourceError` turn any function that fetches a byte range, such as `fetch` with a presigned URL or the client of an object-storage SDK, into a source for `analyzeHeader` and the in-thread `analyze`. No SDK dependency, one request per read and no retries. Every reply is checked before its body is read, its status, its `Content-Range` with the object size and its `Content-Length`, and the body is capped while it streams, so a server that ignores the range, an object whose size changed or an oversized body fails the read as `read-failed` instead of giving wrong bytes. An object overwritten at the same size is caught only by an `If-Match` with its ETag, which the caller sends. A failed or aborted body is discarded, and a Node stream body is destroyed, so its socket closes. `openRangeSource` learns the size from one request for the first 64 KiB, accepts the clamped 206 of a smaller object and serves the first read of `analyzeHeader` from those bytes, so the requests equal `io.reads`. `RangeSourceError` carries a `code`, such as `unexpected-status` or `size-changed`, and the `status` ([Range source](docs/api.md#range-source)).
- A CommonJS copy of the five server entries, `video-fps-probe`, `video-fps-probe/header`, `video-fps-probe/url`, `video-fps-probe/check` and `video-fps-probe/presets`, minified with the names of classes and functions kept, so `error.name`, `error.constructor.name` and the export names equal the ESM build, with `.d.cts` types, under the conditions `module-sync`, `module` and `require`, and `main`. Node 22.12 and newer still load one ESM instance from `require()` and bundlers that match the `module` condition, as Vite, webpack, Rspack and esbuild do by default, still resolve the ESM build, so the copy serves only `require()` where `require(esm)` is off. Jest 30 runs these entries with no configuration and `jest` as the only dependency, and with `--experimental-vm-modules` on Node 24.9 and newer it loads the ESM build ([CommonJS](docs/api.md#commonjs), [Jest](docs/api.md#jest)).
- The types of `video-fps-probe/header`, `video-fps-probe/url`, `video-fps-probe/check` and `video-fps-probe/presets` name no DOM type, so a server that imports only those compiles with `"lib": ["ES2022"]` and the node types, without `skipLibCheck`.

### Frozen from 0.4.0-beta.1

These are API from 0.4.0-beta.1 on, and 0.4.0-beta.2, 0.4.0 and every later release only add to them ([versioning](docs/api.md#versioning)):

- `FileErrorCode`: `empty-file`, `unrecognised`, `unsupported-container`, `unsupported`, `too-large`, `no-header`, `truncated`, `corrupt`, `no-duration`, `byte-limit`, `read-limit`, `time-limit`, `structure-limit`, `read-failed`, `load-failed`, `engine-failed` and `internal`, with the `ErrorClass` of each.
- `WarningCode`: `invalid-timescale`, `truncated-mdat`, `truncated-box`, `trailing-data`, `fragment-index-unread`, `duration-unresolved`, `fragments-ignored` and `structure-limit`, with the warning prefixes they classify. The four parser prefixes are `invalid mdhd timescale ` or `invalid timescale `, `'mdat' at <offset> is truncated`, `'<type>' at <offset> is truncated` and `ignored trailing data at `, and the header entry adds `fragment index not read: `, `format duration unresolved: `, `fragments ignored: ` and `too many top-level boxes`.
- `LayoutKind`, `faststart`, `moov-at-end` and `fragmented`, and the members of `ContainerLayout`: `kind`, `moovOffset`, `moovSize`, `sidx` and `emptyMoov`.
- The members of `HeaderLimits`, `maxBytes`, `maxReads`, `maxMs`, `maxTracks` and `maxTopLevelBoxes`, and of `HeaderOptions`, `name`, `signal`, `limits`, `readAhead` with `head` and `tail` only and `fragmentedDuration`, with the export `HEADER_DEFAULT_LIMITS` and its keys, the signature `analyzeHeader(source: Blob | BlobLike, options?: HeaderOptions): Promise<HeaderResult>`, and the exports `isAbortError` and `isTimeoutError` of `video-fps-probe/header`. A default value of `HEADER_DEFAULT_LIMITS` may change later, as a behaviour change that the changelog names.
- How `analyzeHeader` treats keys: `readAhead` refuses any key but `head` and `tail` with a `TypeError`, and the options and `limits` ignore keys they do not know.
- The whole `video-fps-probe/url` API: `rangeSource`, `openRangeSource`, `httpRange`, `readCapped`, `RangeSourceError` with its `code` and `status`, the `RangeSourceErrorCode` values `unverifiable-reply`, `unexpected-status`, `range-mismatch`, `size-changed`, `length-mismatch`, `body-too-long`, `body-too-short` and `invalid-reply`, and the types `RangeRequest`, `RangeReply`, `RangeFetcher`, `RangeSource`, `RangeSourceInit`, `OpenRangeSourceInit`, `HttpRangeInit` and `RangeSourceErrorOptions`, with `BlobLike` and `BlobSlice`, the types of the root entry that it re-exports unchanged.

`ColorInfo` and `DolbyVisionConfig` join this list at 0.4.0-beta.2.

### Changed

- The installed package may take up to 867 KB unpacked (580 KB in 0.3.0), measured at 842 KB: about 80 KB more for the error codes, layout, median frame interval, the header-only entry, the Range source and the longer README and CHANGELOG, and about 190 KB for the CommonJS copy of the server entries, with the names of its classes and functions kept, and its declarations, which took the cap from 632 KB to 867 KB, 3 percent above the measurement. A bundler still takes only the modules a host imports, and no browser bundle holds the CommonJS copy.
- Node 22.12 is the lowest supported version, as in 0.3.0, and now the only line the docs name: Node 20 is past its end of life.
- The first MP4 loads 23.07 KB gzip (22.73 KB in 0.3.0), 24.85 KB with Vite's default worker format (24.47 KB), and the first WebM or MKV 25.73 KB (25.54 KB) ([size matrix](report/size-matrix.md)).
- Still 0 mismatches against ffprobe 8.1.1, now on 168 committed fixtures, with 2 known deviations on a new `+cmaf+global_sidx` fixture with B-frames: ffprobe adds the largest negative composition offset of the fragments it reads to every video timestamp, and own does not yet, so its video starts at 0 instead of 0.066667 s and the file ends 0.045 s earlier ([accuracy](docs/benchmarks.md#accuracy-vs-ffprobe)).

### Fixed

- A `readAhead.tail` that is NaN no longer spins the Matroska probe forever: it scans the smallest tail, as every value below 4096 does.

### Known limitations

- In a browser `httpRange` checks the `Content-Range` of a cross-origin reply only when the server lists it in `Access-Control-Expose-Headers`, and the status and length checks remain. `openRangeSource` needs that header, or a known `size`, because discovery learns the size from it, and rejects with `unverifiable-reply` without it.
- The Range source checks the size of the object on every read, so an overwrite at the same size between two reads is caught only by an `If-Match` that the caller sends. `httpRange` does not keep the ETag of its first reply.
- Full mode reads every fragment, so on a `+cmaf+global_sidx` output of several fragments where every track has a sidx that covers the file and the last AAC fragment runs past its sidx, it reports that end, 1024 samples later than ffprobe 8.1.1, for example 20.521333 s against 20.5 s, as in 0.3.0. `analyzeHeader` gives the ffprobe value there. On ffmpeg's `+cmaf+global_sidx` output with a `mov_text` or `-timecode` track, whose sidx is written last and ends early, ffprobe reads every fragment too, and both modes give its value. On `+cmaf+global_sidx` files patched so that the one sidx left before the first moof covers the file and another track has none, ffprobe 8.1.1 gave the sidx end for every stream in the cases measured, 6.0 s where full mode gives 6.021333 s. Whether that holds as a rule is a hypothesis with counter-cases, so `analyzeHeader` gives the full-mode value there through the mfra, or without one keeps the video duration and leaves `formatDurationSec` null with a warning ([notes](docs/implementation-notes.md#what-the-header-walk-reads)).

## 0.3.0 - 2026-10-30

### Added

- `byContainer` on a custom worker: `{ create, engines, byContainer: { matroska: () => new Worker(...) } }` runs own on the worker of the file's container family, and every other engine and family on `create` ([api](docs/api.md#createprobeclient-client-flavor)).
- `video-fps-probe/standalone/own-isobmff.worker.js` and `own-matroska.worker.js`: the two own workers as classic scripts with no imports, about 21.1 and 23.7 KB gzip, for `byContainer`. The combined `own.worker.js` stays.
- `video-fps-probe/presets/sources.json`: the source page of every preset, keyed by the name of its export, such as `sources.klingO1ReferenceVideo` ([presets](docs/api.md#presets)).
- CommonJS is tested from the packed tarball: `require()` on Node 22.12 and 24, a TypeScript `commonjs` and `node10` project as in NestJS 11, and Jest 30 with babel-jest ([Jest](docs/api.md#jest)).
- Issue templates for bugs and feature requests, and GitHub Discussions for questions and for showing how you use the package ([feedback](README.md#feedback)).

### Changed

- **Behaviour change:** own runs on one worker per container family, `own-isobmff.worker` or `own-matroska.worker`, picked by the file's first 4 bytes, so a first file loads only the parser of its family.
- The first MP4 loads about 22.7 KB gzip (23.6 KB in 0.2.0) and the first WebM or MKV without DefaultDuration 25.5 KB (26.7 KB). With Vite's default worker format they load 24.5 and 27.1 KB instead of 38.9 KB ([size matrix](report/size-matrix.md)).
- `workers` counts per worker kind, so `workers: 1` can run one MP4 and one WebM at once. `prewarm()` starts the worker of each container family it is given, ISO BMFF by default.
- A missing own worker file, such as a 404 after a redeploy, rejects only the jobs of its container family with `reason: 'load'`, and the next call retries.
- Service worker precache lists that name `own.worker` need both new worker files. A custom worker that runs `serveProbeWorker({ own: ownEngine })` from `video-fps-probe/worker-runtime` keeps the 0.2.0 layout.
- `lazyProbeClient` and `createProbeClient` load the 0.4 KB routing by container family only with `byContainer`, so a custom worker without it loads 23.6 KB for the first MP4 (23.5 KB in 0.2.0).
- The package is about 569 KB unpacked (442 KB in 0.2.0), mostly the two new standalone files, which a bundler takes only when imported.
- Still 0 mismatches against ffprobe 8.1.1, now on 130 committed fixtures ([accuracy](docs/benchmarks.md#accuracy-vs-ffprobe)).
- CI also tests Node 22.12, the lowest supported version. A weekly canary builds with the latest mp4box, mediabunny, Vite and rolldown and fails when an own result changes, an own size budget is exceeded or the build breaks, not when only mp4box or mediabunny code grows.

### Deprecated

- `sourceUrl` of a preset: use `video-fps-probe/presets/sources.json`. Presets keep it until the next major, which leaves the URL strings that supply-chain scanners flag in `sources.json` only.

### Fixed

- A version 1 `mehd` or `elst` holding 0xFFFFFFFFFFFFFFFF, an unknown duration, failed the whole file. `mehd` is now ignored, as ffprobe does, and such an edit lasts to the end of the media, with a warning.
- A top-level header after the moov that runs past the end of the file, such as the trailer of some phone MOV files, marked the file truncated. Unless it is an `mdat` or a `moof`, it now ends the walk with a warning, and samples past the end are still cut.
- Warnings could hold raw NUL and other control characters from the file, such as a box type. Every engine now replaces them with `?`.
- An unreadable file, such as a picked file deleted since (`NotReadableError`), now gives `file read failed: <error>` for every container and engine, not `corrupt file: ...` or the browser's bare message.
- A `ProbeError` from another copy of the package, such as one from an engine module or a custom probe given to `VideoFpsProvider`, became `worker-failed`. It now keeps its code everywhere ([errors](docs/api.md#errors)).
- `check` judged the `duration` of a VFR WebM or Matroska track by its measured span, up to one frame shorter than ffprobe's. It now judges `formatDurationSec` when it is within one typical frame interval of the span ([check](docs/api.md#check)).

### Known limitations

- React 18 and 19 only: next to another React major npm refuses the install with `ERESOLVE` unless you pass `--legacy-peer-deps` or add `"overrides": { "video-fps-probe": { "react": "$react" } }`.
- Zero-config Vite (iife workers) builds each own worker as one file, so the first MP4 loads about 1.7 KB more than with `worker: { format: 'es' }`.
- Only Vite 8 and npm are tested in CI ([bundlers](docs/bundlers.md)). Browser floors (Chrome and Edge 94, Firefox 114, Safari 15.4) are derived, not tested.
- A TypeScript project for Node needs `"DOM"` in `lib` or `skipLibCheck: true`, and Jest needs babel-jest to transform the package ([Jest](docs/api.md#jest)).
- For a WebM or Matroska duration `check` takes the interval of `dominantFps`, `nominalFps` or `avgFps`, so a recording without a dominant rate uses its average interval, not its median.
- `check` judges the stored frame size: a `pasp` box or a Matroska DisplayWidth is not applied.
- The only real recordings in the corpus come from Chromium's MediaRecorder. More in [benchmarks](docs/benchmarks.md#limitations).

### Not yet

- 0.3.x: a bundler matrix in CI: webpack 5, Rspack, Next.js, Angular CLI, SvelteKit, Nuxt, Parcel, Bun and Deno, with pnpm, Yarn PnP and bun installs.
- 0.4.0: a header-only ISO BMFF mode with byte, read and time limits, machine-readable error codes, a layout field, a Range source for object storage (a fetcher, no SDK), color, HDR and Dolby Vision basics, PAR and display size, a median frame interval for `check` and CommonJS server entries only.
- 0.5.0: a Node entry (`fromPath`, DOM-free types, a `worker_threads` pool), NestJS validators, a CLI, bitrate, GOP and audio details, cadence detection, Vue, Svelte and Angular adapters, and later MPEG-TS and HLS.

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
