# Changelog

All notable changes to this package are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows [semantic versioning](https://semver.org/) with the policy in [docs/api.md](docs/api.md#versioning): 0.x until a production consumer has completed a release cycle with it.

## 0.1.0 - 2026-10-23

The first release of the package. It is not on npm yet (`"private": true`); the README explains how to install a packed tarball.

### Added

- **Analysis from container headers, without decoding**, in a module Web Worker: average FPS as an exact rational next to the `avg_frame_rate` string ffprobe 8.1.1 prints, nominal, minimum and maximum FPS, frame count and presented frames, duration, codec, dimensions and rotation for every video track, a VFR flag, and a rate profile (steady and variable segments, rate changes, freezes, gaps, bursts, an `uneven` flag, sparkline buckets). Every value carries a provenance tag; file problems are `result.error`, never exceptions.
- **Containers**: MP4 and MOV (ISO BMFF, including fragmented MP4, edit lists and 64-bit boxes), WebM and Matroska, sniffed from the bytes. Matroska scan modes `header`, `probe`, `exact` and `auto`.
- **Entries**: `video-fps-probe` (`createProbe`, the in-thread `analyze` for Node), `video-fps-probe/lazy` (`lazyProbe`, `lazyProbeFrom`), `video-fps-probe/client` (`createProbeClient`, no built-in worker), `video-fps-probe/client/lazy` (`lazyProbeClient`, `lazyProbeFrom`), `video-fps-probe/mp4box`, `video-fps-probe/mediabunny`, `video-fps-probe/rvfc` (engine descriptors), `video-fps-probe/worker-runtime` (`serveProbeWorker`, `ownEngine`), `video-fps-probe/engines/mp4box`, `video-fps-probe/engines/mediabunny` (engine modules for a custom worker) and `video-fps-probe/standalone/own.worker.js` (a classic worker file with no imports).
- **Probe API**: `analyze` with an `engine` and a `fallback` chain, `tryAnalyze`, `compare` with per-engine outcomes and `compareResults` agreement (experimental), `prewarm`, `dispose`, `destroy`, `summarize`, and `ProbeError` with the codes `aborted`, `timeout`, `worker-failed`, `engine-not-registered`, `unknown-engine`, `unsupported-environment` and `protocol`.
- **Engines**: the own parsers by default; mp4box.js (optional peer `mp4box` `^2.4.1`), mediabunny (optional peer `mediabunny` `^1.62.0`, MPL-2.0) and a `requestVideoFrameCallback` playback estimate. Each costs nothing until its entry is imported.
- **Workers**: one prebuilt module worker per engine kind (the mp4box and mediabunny workers also serve own), a host-built combined worker through `worker-runtime`, the standalone classic worker, and `worker: 'inline'` (automatic without a `Worker` global). Protocol v1; one worker per kind by default, terminated after 30 s idle; a timed-out worker is terminated at once.
- **Browsers**: Chrome and Edge 94, Firefox 114, Safari and iOS Safari 15.4 (derived from the features used); tested in Chromium, Firefox and WebKit. mp4box.js needs Safari 16.4; rVFC needs Chrome 83, Firefox 132 or Safari 15.4.
- **Size** (Vite 8.3.5, gzip -9, from the packed tarball): 0.67 KB on the host's critical path (1.40 KB with Vite's preload helper); the first MP4 loads 23.26 KB lazily with `worker: { format: 'es' }`, every own path 36.24 KB; mp4box.js 44.77 KB, mediabunny 53.87 KB and rVFC 2.19 KB more, lazily and only when imported; the standalone worker file is 32.04 KB.
- **Accuracy**: 0 mismatches against ffprobe 8.1.1 on the 111 committed fixtures (1747 checks: 1690 exact, 2 within tolerance, 1 known deviation, 54 not applicable).

### Known limitations

- Vite builds workers as `'iife'` unless `worker.format` is `'es'`, so a zero-config Vite host loads the first MP4 as one 34.77 KB worker file.
- A regular cadence (2:3 pulldown, a regular frame drop pattern) is VFR, but the rate profile reads it as "Steady", not uneven.
- rVFC needs playback: a visible foreground tab, a codec the browser can play, seconds per file, and wrong averages on VFR files.
- Files above 2^53 bytes and 64-bit values above 2^53-1 are rejected with an error result, as are compressed movie headers (`cmov`) and a moov above 256 MiB. Only the first sample entry of a track is used.
- In `auto` mode a large Matroska file gets a sampled probe, without a frame count or an average, unless the exact scan is predicted to take at most 150 ms.
- In Node 24, `fs.openAsBlob` reports the size of files above 4 GiB modulo 2^32; pass a `BlobLike` over a file handle instead.
- Only Vite 8 is verified in CI. webpack 5, Rspack, Parcel, Next.js and Vite 5 to 7 are documented but not verified; esbuild needs the standalone or a custom worker.
- The browser floors are derived, not tested on those versions; real Safari, iOS and Android devices are not tested. The fixture corpus is synthetic.

### Not yet

- React entry (`video-fps-probe/react`): 0.2.0.
- Bundler matrix (Vite 5 to 7, webpack, Rspack, Next.js, Yarn PnP) and the weekly job against the latest peers: 0.3.0.
- npm publishing: 1.0.0.
