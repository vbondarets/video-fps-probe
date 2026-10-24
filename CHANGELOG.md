# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver with the [0.x policy](docs/api.md#versioning).

## Unreleased

### Added

- `ProbeError.reason` on every `worker-failed` the probe raises: `'load'` when code it needs did not load (the worker script, a chunk a worker loads for an engine, a main-thread chunk, or `new Worker()` threw), `'crash'` when it failed after loading. The code stays `worker-failed`. The worker protocol's `error` reply gets an optional `reason: 'load'`; the version stays 1 ([Errors](docs/api.md#errors)).
- [Deploy skew](docs/bundlers.md#deploy-skew): what a tab opened before a redeploy sees and how to recover.

### Fixed

- A worker script that failed to load, for example a 404 in a tab opened before a redeploy, was reported as a bare `worker failed`. It now rejects with `reason: 'load'`, the message `worker script failed to load; the app may have been redeployed` and the error event as `cause`, and, while no worker of the pool has replied, it rejects the queued jobs once instead of fetching the script again for every queued file. The next call loads the worker again.
- Demo: the build time and commit moved from the bundle into meta tags of `index.html`, so a deploy without code changes no longer renames every lazy chunk and breaks the first file in tabs opened before it.

### Changed

- The probe client grows by 0.18 KB gzip, so the first MP4 loads 23.46 KB instead of 23.26 KB in the default configuration; the critical path stays 0.67 KB.

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
