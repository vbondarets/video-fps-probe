# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver with the [0.x policy](docs/api.md#versioning).

## Unreleased

These changes go into 0.2.0, a minor release under the [0.x policy](docs/api.md#versioning): `ProbeError.reason` is a new optional field, and a lazy stub whose probe client fails to load rejects with a `ProbeError` instead of the browser's import error, which code that tested that error has to follow (see Fixed).

### Added

- `ProbeError.reason` on every `worker-failed` the probe raises: `'load'` when code it needs did not load (the worker script, a chunk a worker loads for an engine or warms, a main-thread chunk, the probe client of a lazy stub, or `new Worker()` threw), `'crash'` when it failed after loading. The code stays `worker-failed`. The worker protocol's `error` reply gets an optional `reason: 'load'`; the version stays 1 ([Errors](docs/api.md#errors)).
- [Deploy skew](docs/bundlers.md#deploy-skew): what a tab opened before a redeploy sees and how to recover.
- Three late-change fixtures (Tier L, 443 KB together): `late_30_to_60.mp4`, `late_25_to_12.5.webm` and `late_freeze_10s.mkv`, constant for more than 5000 frames before the rate changes or the picture freezes. The own parsers are exact on every check; mediabunny's default recipe, which probes 256 packets, reports the first rate and no VFR, and its full scan is correct but several times slower. The predictions were committed before the first run, and the results, the one correction included, are in [the benchmarks](docs/benchmarks.md#late-rate-changes-tier-l).
- Twelve browser recordings (Tier R, 869 KiB together): real MediaRecorder output of headless Chromium 156, WebM VP8, VP9 and AV1, Matroska H.264, and fragmented MP4 with H.264 and VP9, each in one piece and with a 250 ms timeslice, recorded by the new `scripts/fixtures/record-mediarecorder.mjs` and committed as recorded (CC0, [provenance](fixtures/README.md#browser-recordings-tier-r)). The own parsers have no mismatch on them, and the rate profile recovers the recorded pacing. The eight WebM and Matroska files store no last frame duration: ffprobe estimates it from its rate, the own parsers take the median interval. `npm run compare` scores that difference within tolerance on Matroska when the average is exactly the frames over the timestamp span plus one median interval, which also replaces the per-file known deviation of `vfr_concat_10_30_60.webm`; the own deviation files are empty. WebKit on Windows has no MediaRecorder, and Firefox recordings wait for the manual `record-firefox` workflow.
- `npm run compare` runs the libraries in five arms: `mp4box-idiomatic` (the mp4box.js README recipe and its own fields), `mediabunny-idiomatic` (the mediabunny README metadata recipe, `input.computeDuration()` included, and `computeFrameRateMetrics()` with its defaults), `mediabunny-full` (`targetPacketCount: Infinity`, with its `probedPacketCount` as the frame count), and `mp4box-tuned` and `mediabunny-tuned`, this package's adapters, which were the `mp4box` and `mediabunny` engines (both names still select them). Each mismatch of an arm is classified as wrong, definition differs (the definition the library documents or implements for the field, evaluated on the file; each arm is checked against its own definitions only, mediabunny's `computeFrameRateMetrics()` replayed on the reference timestamps, `getDurationFromMetadata()` on the media headers, and its end timestamps with the zero duration it gives a Matroska last frame whose duration the file does not store), unverified (that definition cannot be evaluated on the file, or the value only equals a quantity the arm does not use, so it is counted neither as wrong nor as a definition difference), not provided or unsupported container, and [the accuracy section](docs/benchmarks.md#accuracy-vs-ffprobe) lists where the libraries win: every check where an arm is exact or within tolerance and the own parsers are not, over all fixtures with the large local files, and the files an arm reads with fewer bytes or reads or in less time, counted on the files that both it and the own parsers open.
- Demo: when a file fails because code did not load, the page checks whether another build is deployed. If so, it shows one banner, "A new version of this page was deployed. Reload to continue.", with a Reload button, and the files read "Not analyzed."; if not, each file reads `Worker could not be loaded:` with the error.

### Fixed

- A worker script that failed to load, for example a 404 in a tab opened before a redeploy, was reported as a crash: a bare `worker failed`, or `Uncaught SyntaxError: Unexpected token '<'` when Chromium parsed the 404 page as a classic worker. Any worker `error` event before the worker's first reply now rejects with `reason: 'load'`, the message `worker script failed to load or parse; the app may have been redeployed`, followed by the event's message when it has one, and the error event as `cause`. An `error` event after the first reply stays `reason: 'crash'`. While another worker of the pool is alive, the job waits for it and no further worker starts until the next call; when the failed worker was the last one, its job and the queued jobs reject once instead of fetching the script again for every queued file. The next call loads the worker again.
- A lazy stub whose probe client chunk failed to load rejected with the browser's import error as it was. It now rejects with `ProbeError('worker-failed')`, `reason: 'load'` and that error as `cause`, so every rejection of a probe or a stub is a `ProbeError`; a `ProbeError` of the factory is passed through. Code that read a stub rejection without `instanceof ProbeError` as a load failure should read `e.reason === 'load'`.
- A failed `warm` replied without `reason`, so a prewarm whose engine or parser chunk did not load was tagged `crash`. It now carries `reason: 'load'`.
- Release: the version step carried the intro of the Unreleased section ("These changes go into ...") into the released section. It now drops the text before the first `###` heading and prints it. `preversion` stopped with a bare git error when `user.name` or `user.email` was missing, and went on when one was set to an empty value; it now fails in both cases, before the gates, and names both values ([Releasing](docs/releasing.md)).
- `npm run compare` took the absence of a Matroska DefaultDuration, which makes the declared average not applicable, from a regex over the fixture's manifest note, so editing a note could turn a gating mismatch into n/a. It now scans the Tracks element of the file, and a note that says the element is absent while the file has it stops the run with exit code 2.
- `report/README.md` quoted hand-written accuracy totals that had gone stale (1832 checks where the report has 2087). `readme-tables` now writes that paragraph from `accuracy.json`, and `--check` and the version step cover the file.
- Demo: the build time and commit moved from the bundle into meta tags of `index.html`, so a deploy without code changes no longer renames every lazy chunk and breaks the first file in tabs opened before it. CI builds the demo twice with different stamps and fails when a file other than `index.html` differs (`npm run check:stable-chunks`).
- Demo: a rate profile or compare panel chunk that failed to load took the whole page down. The panel now reads "Panel failed to load." with a Retry button that imports the chunk again, so a transient network error does not leave the panels empty for the rest of the session, and the page runs its deploy check, also for a parser chunk that a worker started before the deploy cannot import.
- Demo: an error text above 100 characters was cut into a collapsed note, which hid the URL of a chunk that failed to load. The cut is at 200 characters now.

### Changed

- `isAbortError` and `isTimeoutError` check the name and the code instead of `instanceof`, so a `ProbeError` from another copy of the package counts too. They moved to their own module, which keeps the critical path at 0.67 KB with the stub's load error added.
- When the last worker of a pool fails to load, the queued jobs reject at once, a transient network error included; before, each queued job started a new worker. The next call retries. A worker that throws at the top level, before its first reply, counts as a load failure too.
- `compare` reports a load failure of an engine as `crashed`, as before; `error.reason` now tells it apart from a crash.
- The mediabunny engine is verified with mediabunny 1.62.1: `MEDIABUNNY_VERSION` and `result.mediabunny.version` read `'1.62.1'`. Its results on the corpus did not change, and the peer range stays `^1.62.0`.
- A file smaller than 465,536 bytes, the 64 KiB head window plus `perReadMs x bytesPerMs` of the cost model, is read whole in its first read, so a small MP4 with the moov at the end takes 1 read instead of 2. Every committed fixture takes 1 read (the median was 2) and every result is unchanged; `io.bytesRead` of such a file is its size. `costModel: { perReadMs: 0 }` keeps the first read at `readAhead.head`, and the single read is at most 1 MiB (or `readAhead.head` when that is larger) whatever the cost model, so a cost model tuned for a fast disk cannot read a large file into memory at once ([parser options](docs/api.md#wireoptions-parser-options)).
- The probe client grows by 0.24 KB gzip and the own worker entry by 0.10 KB (0.03 KB for the load reason, 0.07 KB for the single read and its cap), so the first MP4 loads 23.59 KB instead of 23.26 KB in the default configuration. The package's size promise is the consumer size matrix: its budgets did not change, every configuration passes them, and the critical path is 0.66 KB (0.67 KB in 0.1.0; the difference is the hashed chunk names it imports).
- Demo: the Compare panel heads the mp4box and mediabunny columns "mp4box (tuned adapter)" and "mediabunny (tuned adapter)": they run this package's adapters over each library, not the libraries' own recipes.
- `readme-tables` decides whether the Chrome timings were measured on the current build by a content hash of each chunk the bench fetched (hashed import names reduced to their stems), recorded by `npm run bench` and `report/size.json`, instead of the chunk stem and byte size, which two different builds can share. A bench report without hashes counts as current only when every fetched file name is in the current build.
- `readme-tables` names the bench browser from the headless mode the run recorded: "Chrome headless shell" for `chrome-headless-shell`, "Chrome N (headless=new)" for the new headless mode, and "mode not recorded" for a report without one. Before, every `HeadlessChrome` user agent read as the headless shell, which is wrong for the new headless mode.
- Demo: the sample file loader is a lazy chunk. The demo budgets are the measurement plus 3 percent, rounded up to 0.5 KB: main 77.0 KB (was 75.0 KB), initial 83.0 KB (was 85.0 KB), first MP4 103.0 KB (was 100.0 KB; it measured 99,995 bytes when the budgets were set), first VFR MP4 105.0 KB (101.5 KB in 0.1.0; it measured 101.84 KB when set, with the load reason, the reload banner with its deploy check and the panel retry) and first Matroska 102.0 KB (was 100.0 KB). They cover the demo page only and left 2.51 to 3.16 KB of headroom per row when set, so a smaller demo regression passes the check. The size promise of the package is the consumer size matrix, whose budgets did not change.

### Not yet

- Demo: no prewarm before the first file. Prewarming on load or on idle would move about 19.5 KB of lazy loads onto every page view, and a tab that sits unused across a deploy still needs the reload banner.

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
