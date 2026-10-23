# Reports

Generated files, except `average-user.md`. Do not edit the generated ones by hand: each one is written by a script, and `scripts/readme-tables.ts` reads the JSON files to fill the tables in the [main README](../README.md).

| Report | Written by | What it holds |
|---|---|---|
| [accuracy.md](accuracy.md), `accuracy.json` | `node scripts/compare-ffprobe.ts` (`npm run compare`) | Every field check of the own, mp4box and mediabunny engines against the ffprobe 8.1.1 references, with verdicts, plus reads, bytes and Node timings per fixture |
| [size.md](size.md), `size.json` | `node scripts/size-report.mjs` (`npm run size`) | Raw, gzip and brotli size of every chunk in `dist/`, the budgets with their reasoning, and the initial and first-analysis totals |
| [size-matrix.md](size-matrix.md), `size-matrix.json` | `node scripts/size-matrix.mjs` (`npm run size:matrix:write`) | What the package adds to a Vite app per configuration (default, zero-config with Vite's default worker format, custom worker, each engine, all, the standalone worker through ?url, iife-nosplit, the standalone file): the critical path, the lazy totals, worker files, must-not-exist sourcemap checks and the budgets with their reasoning |
| [browser-bench.md](browser-bench.md), `browser-bench.json` | `node scripts/bench/run-bench.mjs` (`npm run bench`) | The built app measured in headless Chrome (and Edge when installed): cold start, warm timings per fixture, library engines, long files, the requestVideoFrameCallback fallback and a Chrome vs Node identity check |
| [integration-cost.md](integration-cost.md), `integration-cost.json` | `node scripts/bench/integration.mjs` | What embedding the probe costs a large SPA: critical-path and lazy bytes, first-file latency on throttled links (cold, prefetched, prewarmed), main-thread blocking, memory and worker time per file |
| [average-user.md](average-user.md) | written by hand | A model of the cost on the devices and networks real visitors use: device tiers with traffic shares, session cost, network, file IO unknowns; measured and modelled numbers are labelled |

## Regenerate everything

Run from the repository root, in this order (the size report and the benchmark need the build):

```
npm run build
node scripts/compare-ffprobe.ts --engines own,mp4box,mediabunny --with-large --repeat 3
node scripts/size-report.mjs dist --check
npm run bench
node scripts/bench/integration.mjs
node scripts/readme-tables.ts
```

Timings depend on the machine and on what else runs on it; verdicts, reads, bytes and sizes do not. Commit the reports together with the README so the tables and the reports agree. `node scripts/readme-tables.ts --check` exits 1 when the README is out of date.

## accuracy.md, accuracy.json

- Runs every fixture of `fixtures/manifest.tsv` that is present through each engine and compares the result with `fixtures/ref/<file>.ref.json` under the tolerances of [research 6.4](../docs/research.md#64-tolerances).
- Each check gets a verdict: `exact`, `within-tol`, `known-deviation` (with the reason from `fixtures/known-deviations/`), `mismatch` or `n/a`. Only the own engine gates: the script exits 1 on an unexpected own mismatch and 2 on a harness error. mp4box and mediabunny are informational.
- `io` per fixture: reads, unique bytes read, percent of the file and the median `analyze()` time in Node over `--repeat` runs (library engines run the long files once).
- JSON: `engines[].fixtures[]` with `io`, `fileChecks` and `tracks[].checks` (`id`, `verdict`, `app`, `ffprobe`, optional `deviation`); `rules` maps `<family>:<check>` to the rule text.
- `--with-large` adds the local files in `fixtures/large` (generated with `npm run fixtures:generate -- --with-long`, not committed). The README tables need the two long files, so regenerate with this flag.
- The committed `accuracy.md` and `accuracy.json` cover 116 fixtures: the 111 committed ones plus 5 local files of `fixtures/large` that are not committed (the two `--with-long` files and the three `--with-big` 1080p files). Its own-engine totals (1832 checks, 1769 exact) therefore include those 5 files. On the committed corpus alone, `npm run compare -- --no-write` gives the own engine 1747 checks: 1690 exact, 2 within-tol, 1 known-deviation, 0 mismatch and 54 n/a.
- `--filter <text>` writes `accuracy.local.*` (git-ignored) instead; `--mkv-mode header|probe|exact|auto` sets the Matroska scan mode; `--self-test` checks the comparison rules.

## size.md, size.json

- Reads a production build (`npm run build` first). The page chunks come from `index.html`, the worker from its `Worker()` reference, the parser and engine chunks from the import graph.
- Per chunk: raw bytes, gzip level 9 and brotli quality 11. KB means 1000 bytes.
- Budgets (`BUDGETS` in `scripts/size-report.mjs`) cover the main chunk, the worker entry, each parser chunk, the rate profile chunks (core and panel), the rVFC chunk, the initial load and the first MP4, first VFR MP4 and first Matroska analysis. `size.md` gives the reason for every limit.
- `--check` exits 1 when a budget is exceeded or a required chunk is missing; CI runs it. `--self-test` checks chunk discovery on synthetic builds.

## size-matrix.md, size-matrix.json

- Reads the consumer fixture builds: `npm run consumers:setup` packs the package and installs the tarball, Vite and the peers into a directory outside the repository (`--dir`, else `$CONSUMERS_DIR`, else the OS temp directory), then `npm run consumers:build` builds every fixture of `tests/consumers/fixtures/` there with hidden sourcemaps.
- `CONSUMERS_OFFLINE=1 npm run consumers:setup` installs from the npm cache only (`npm install --offline`) with an empty npmrc, created in the OS temp directory for the run, as `--userconfig`, so a local run neither contacts the registry nor reads a registry token from the user's npmrc. It needs Vite, the peers and React in the cache from an earlier online install. CI keeps the online install.
- Per configuration: the critical path (the package code inside the host entry chunk, cut out by its sourcemap), the entry chunk with Vite's preload helper, the first MP4 and all own paths as lazy totals, the emitted lazy total (every file outside the entry chunk, including the main-thread copies that a browser with a Worker global fetches only for worker: 'inline' or a root analyze()), the engine chunks and the worker files. Sizes are gzip level 9; KB means 1000 bytes.
- Checks: the worker files each configuration must build, must-not-exist patterns against the `sources` of every sourcemap, and the request chain check of `size-report.mjs`.
- Budgets (`BUDGETS` in `scripts/size-matrix.mjs`) with a reason each. `npm run size:matrix` (`--check`) exits 1 on any failure and when the committed `size-matrix.md` or `.json` differs from the measurement, and writes nothing; `npm run size:matrix:write` rewrites them. CI runs the check in the consumers job.

## browser-bench.md, browser-bench.json

- Needs a build in `dist/` and Chrome, found through `CHROME_PATH` or the standard install location. Edge is measured too when installed.
- Serves `dist/` from `127.0.0.1` with `Cache-Control: no-store`, starts headless Chrome with a throwaway profile, and picks files through the app's real file input over the DevTools Protocol, so every `File` is disk-backed.
- `ms` is the worker-side analysis time (`FileResult.io.ms`); `UI ms` runs from the input's change event to the rendered result.
- Every own-engine result in Chrome is compared field by field with `analyze()` in Node on the same file; the script exits 1 when they differ and 2 on a harness error.
- Also writes the screenshots in `docs/screenshots/`.
- `--filter <text>` writes `browser-bench.local.*` and skips the screenshots; `--skip warm,engines,large,cold-first,rvfc,edge,node,shots` drops sections; `--self-test` checks the helpers without a browser.
- Only Chromium browsers are measured, on one desktop. Results (not timings) in Chromium, Firefox and WebKit are checked by the Playwright suite (`npm run test:e2e`).

## integration-cost.md, integration-cost.json

- Needs a build in `dist/` and Chrome. Serves `dist/` gzip-compressed from `127.0.0.1` and measures two pages: a near-empty host model whose only probe code in the critical path is a small trigger, and the demo app as a reference.
- Network profiles (none, cable, fast 4G, slow 4G, 3G) are CDP request-level throttling; each first-file scenario (cold, prefetched, prewarmed) is the median of 5 page loads.
- Main-thread blocking (long tasks, TBT, frame and input gaps), memory per renderer process (3 fresh browsers) and worker time per file.
- The batch rows pick every file in `fixtures/files` at once (the 111 committed fixtures in the committed report); the 3 h row and the long-file CPU rows need the two `--with-long` files in `fixtures/large` and are left out without them.
- `--render report/integration-cost.json` redraws the Markdown without measuring; `--skip latency,main,memory,cpu` drops sections; `--no-write` prints only.

## average-user.md

Not generated. It combines the measured numbers of `integration-cost.md` and `browser-bench.md` with published device, traffic and network data and labels each number as measured, published or modelled. Update it by hand when those reports change materially.

## README tables

`node scripts/readme-tables.ts` rewrites the README sections between `<!-- tables:<name>:start -->` and `<!-- tables:<name>:end -->` from `accuracy.json`, `size.json`, `browser-bench.json`, `integration-cost.json` and `fixtures/manifest.tsv`. Sections: `headline`, `profile`, `integration`, `reads`, `approaches`, `engines`, `bundle`, `speed`, `accuracy`, `deviations`, `rvfc`, `corpus`. Running it twice changes nothing. It stops with an error when a marker or a value it needs is missing, for example when the accuracy report was generated without `--with-large`.
