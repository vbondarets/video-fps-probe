# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver with the [0.x policy](docs/api.md#versioning).

## 0.1.0 - 2026-10-23

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
