# Reports

Generated files. Do not edit them by hand: each one is written by a script, and `scripts/readme-tables.ts` reads the JSON files to fill the tables in the [main README](../README.md).

| Report | Written by | What it holds |
|---|---|---|
| [accuracy.md](accuracy.md), `accuracy.json` | `node scripts/compare-ffprobe.ts` (`npm run compare`) | Every field check of the own, mp4box and mediabunny engines against the ffprobe 8.1.1 references, with verdicts, plus reads, bytes and Node timings per fixture |
| [size.md](size.md), `size.json` | `node scripts/size-report.mjs` (`npm run size`) | Raw, gzip and brotli size of every chunk in `dist/`, the budgets with their reasoning, and the initial and first-analysis totals |
| [browser-bench.md](browser-bench.md), `browser-bench.json` | `node scripts/bench/run-bench.mjs` (`npm run bench`) | The built app measured in headless Chrome (and Edge when installed): cold start, warm timings per fixture, library engines, long files, the requestVideoFrameCallback fallback and a Chrome vs Node identity check |

## Regenerate everything

Run from the repository root, in this order (the size report and the benchmark need the build):

```
npm run build
node scripts/compare-ffprobe.ts --engines own,mp4box,mediabunny --with-large --repeat 3
node scripts/size-report.mjs dist --check
npm run bench
node scripts/readme-tables.ts
```

Timings depend on the machine and on what else runs on it; verdicts, reads, bytes and sizes do not. Commit the reports together with the README so the tables and the reports agree. `node scripts/readme-tables.ts --check` exits 1 when the README is out of date.

## accuracy.md, accuracy.json

- Runs every fixture of `fixtures/manifest.tsv` that is present through each engine and compares the result with `fixtures/ref/<file>.ref.json` under the tolerances of [research 6.4](../docs/research.md#64-tolerances).
- Each check gets a verdict: `exact`, `within-tol`, `known-deviation` (with the reason from `fixtures/known-deviations/`), `mismatch` or `n/a`. Only the own engine gates: the script exits 1 on an unexpected own mismatch and 2 on a harness error. mp4box and mediabunny are informational.
- `io` per fixture: reads, unique bytes read, percent of the file and the median `analyze()` time in Node over `--repeat` runs (library engines run the long files once).
- JSON: `engines[].fixtures[]` with `io`, `fileChecks` and `tracks[].checks` (`id`, `verdict`, `app`, `ffprobe`, optional `deviation`); `rules` maps `<family>:<check>` to the rule text.
- `--with-large` adds the local files in `fixtures/large` (generated with `npm run fixtures:generate -- --with-long`, not committed). The README tables need the two long files, so regenerate with this flag.
- `--filter <text>` writes `accuracy.local.*` (git-ignored) instead; `--mkv-mode header|probe|exact|auto` sets the Matroska scan mode; `--self-test` checks the comparison rules.

## size.md, size.json

- Reads a production build (`npm run build` first). The page chunks come from `index.html`, the worker from its `Worker()` reference, the parser and engine chunks from the import graph.
- Per chunk: raw bytes, gzip level 9 and brotli quality 11. KB means 1000 bytes.
- Budgets (`BUDGETS` in `scripts/size-report.mjs`) cover the main chunk, the worker entry, each parser chunk, the rVFC chunk, the initial load and the first MP4 and first Matroska analysis. `size.md` gives the reason for every limit.
- `--check` exits 1 when a budget is exceeded or a required chunk is missing; CI runs it. `--self-test` checks chunk discovery on synthetic builds.

## browser-bench.md, browser-bench.json

- Needs a build in `dist/` and Chrome, found through `CHROME_PATH` or the standard install location. Edge is measured too when installed.
- Serves `dist/` from `127.0.0.1` with `Cache-Control: no-store`, starts headless Chrome with a throwaway profile, and picks files through the app's real file input over the DevTools Protocol, so every `File` is disk-backed.
- `ms` is the worker-side analysis time (`FileResult.io.ms`); `UI ms` runs from the input's change event to the rendered result.
- Every own-engine result in Chrome is compared field by field with `analyze()` in Node on the same file; the script exits 1 when they differ and 2 on a harness error.
- Also writes the screenshots in `docs/screenshots/`.
- `--filter <text>` writes `browser-bench.local.*` and skips the screenshots; `--skip warm,engines,large,cold-first,rvfc,edge,node,shots` drops sections; `--self-test` checks the helpers without a browser.
- Only Chromium browsers are measured, on one desktop.

## README tables

`node scripts/readme-tables.ts` rewrites the README sections between `<!-- tables:<name>:start -->` and `<!-- tables:<name>:end -->` from `accuracy.json`, `size.json`, `browser-bench.json` and `fixtures/manifest.tsv`. Sections: `headline`, `reads`, `approaches`, `engines`, `bundle`, `speed`, `accuracy`, `deviations`, `rvfc`, `corpus`. Running it twice changes nothing. It stops with an error when a marker or a value it needs is missing, for example when the accuracy report was generated without `--with-large`.
