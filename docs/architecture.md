# Architecture

The app computes FPS statistics for local video files without decoding them. All parsing runs in a module Web Worker; `src/core` has no DOM dependency, so the same code runs in the worker and in Node 24 (tests, the comparison script and benchmarks). The binding formulas and tolerances are in [research.md](research.md).

## Module map

| Path | Role |
|---|---|
| `src/core/types.ts` | Result model (`FileResult`, `VideoTrackResult`, `Rational`, `Provenance`), options and the `ContainerAnalyzer` contract |
| `src/core/reader.ts` | `BlobReader`: the only IO path. One primitive `read(offset, length)` over `Blob.slice().arrayBuffer()`, plus `view()` with up to 4 cached windows, IO counters, abort checks and big-endian DataView helpers (`u8` .. `u64`, `fourcc`) |
| `src/core/rational.ts` | Exact BigInt port of FFmpeg `av_reduce`, `avgFrameRate(ts, N, D)`, ffprobe-style `num/den` strings |
| `src/core/stats.ts` | Container-independent timeline statistics (research 4.3): average, presented frames, duplicates, tail exclusion, VFR rule, min/max, nominal and dominant rate |
| `src/core/sniff.ts` | Container detection from the first bytes, never from the file name |
| `src/core/options.ts` | Option defaults (read-ahead sizes, read cost model, exact-scan budget, expansion limit) |
| `src/core/result.ts` | `emptyAnalysis()` / `emptyTrack()` builders shared by the parsers |
| `src/core/analyze.ts` | `analyze(blob, name, opts)`: timing, sniffing, dispatch, error capture |
| `src/core/isobmff/` | MP4/MOV parser, entry point `analyzeIsoBmff` |
| `src/core/matroska/` | Matroska/WebM parser, entry point `analyzeMatroska` |
| `src/worker/` | Worker entry: receives `File` objects, calls `analyze`, posts `FileResult` |
| `src/engines/` | Comparison engines (mediabunny, mp4box, rVFC), loaded lazily |
| `src/ui/` | React UI |

## Data flow

```
main thread                worker                         core
-----------                ------                         ----
File (drop / picker) --->  analyze(file, name, opts) ---> BlobReader(file)
                                                          read head window (64 KiB, 1 read)
                                                          sniff(head) -> isobmff | matroska | unknown
                                                          analyzeIsoBmff / analyzeMatroska(reader, opts)
                                                             box or EBML walk through reader.view()
                                                             timeline -> analyzeTimeline() -> stats
                                                          FileResult + io { reads, bytesRead, ms }
FileResult <-------------  postMessage(result)
```

- The head window read by `analyze` stays in the reader cache, so a faststart MP4 or a Matroska header usually needs no second read.
- `io.bytesRead` counts unique bytes fetched; overlapping reads are not counted twice. `io.ms` covers the whole `analyze` call, measured where it runs.
- Cancellation: pass an `AbortSignal`. Every read checks it before and after the fetch, and `analyze` rethrows `AbortError` instead of returning a result. Every other failure becomes `FileResult.error`; `analyze` never throws for a bad file.

## ContainerAnalyzer contract

```ts
type ContainerAnalyzer = (reader: BlobReader, opts: ResolvedAnalyzeOptions) => Promise<ContainerAnalysis>;
type ContainerAnalysis = Omit<FileResult, 'name' | 'size' | 'io' | 'engine'>;
```

- Do all IO through `reader` (`view`, `viewExact`, `bytes`, `read`, `readMany`). Never touch the Blob directly, or the IO counters and abort checks are bypassed.
- Offsets are Numbers. Never apply 32-bit bit operations to offsets or sizes; decode 64-bit fields with `u64` / `i64`, which reject values above 2^53-1.
- Throw (or return `error`) for files that cannot be analysed; `analyze` keeps the sniffed container kind on a throw. Return partial results with `warnings` when the header is usable.
- Set `container` precisely (`mp4` vs `mov` from the ftyp brand, `webm` vs `matroska` from DocType) and `brand` to the major brand or DocType.
- Build per-track statistics with `analyzeTimeline()` from `stats.ts`, passing run-length stts/ctts or trun arrays as `segments` (MP4) or block timestamps as `pts` with `tickQuantized` (Matroska). The ffprobe-equivalent strings (`avgFpsFfprobe`, `rFpsFfprobe`) are the parser's job, because they are container specific (research 2.1 and 2.2).
- Respect `opts.maxExpandedSamples`, `opts.matroskaMode`, `opts.exactBudgetMs`, `opts.readAhead` and report long scans through `opts.onProgress`.

## Provenance

Each `VideoTrackResult` field can carry a provenance tag in `provenance`:

| Value | Meaning |
|---|---|
| `header` | Read or derived directly from container headers (stts, DefaultDuration, Info Duration) |
| `exact` | Computed from every sample or block timestamp of the track |
| `sampled` | Computed from a sample of blocks (Matroska probe); never used for an average |
| `estimated` | Derived under an assumption, for example a frame count from duration x declared rate (assumes CFR) |
| `computed` | A value ffprobe prints as N/A, computed by the app (for example a Matroska frame count) |
