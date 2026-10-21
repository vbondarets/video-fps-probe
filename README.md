# Video FPS Probe

Frame rate, frame count and variable frame rate detection for local video files, computed in the browser from the container headers. Nothing is uploaded or decoded, and the results are checked against ffprobe 8.1.1.

**[Live demo](https://vbondarets.github.io/video-fps-probe/)**: drop your own files or press "Try sample files".

<!-- tables:headline:start -->

- **Accuracy.** The own parsers were checked against ffprobe 8.1.1 on 102 fixtures (100 committed, 2 long local files): 1527 field checks, 1480 exact, 3 known deviations with a recorded reason, 0 mismatches, 44 not applicable.
- **Reads.** Median 2 reads per committed fixture, at most 2. The 3 h, 648000-frame MP4 (12.42 MiB) takes 2 reads and 2.56 MiB (20.6% of the file).
- **Speed.** In Chrome 155, warm: median 1.60 ms per file in the worker and 2.50 ms from file pick to rendered result; the 3 h file takes 5.00 ms.
- **Size.** The page plus the first MP4 result loads 93.99 KB gzip (page, worker entry, ISO BMFF parser); the first Matroska result 92.78 KB.
- **Same result in Node and Chrome.** 102 of 102 files give identical results field by field (timing excluded).
- **Machine.** Windows 10 Pro, Intel Core i7-10700KF (16 threads), 32 GiB, Node v24.20.0, Chrome 155 headless; ffprobe 8.1.1-full_build-www.gyan.dev.

<!-- tables:headline:end -->

Every measured number in this README is generated from the reports in [report/](report/README.md) by `node scripts/readme-tables.ts`.

<p>
  <img src="docs/screenshots/app-light.png" width="280" alt="Results for eight files, light theme">
  <img src="docs/screenshots/app-dark.png" width="280" alt="The same results, dark theme">
  <img src="docs/screenshots/app-mobile.png" width="220" alt="First screen at phone width">
</p>
<p>
  <img src="docs/screenshots/compare-vfr.png" width="546" alt="Compare panel on a VFR file: own parser, mp4box.js, mediabunny and requestVideoFrameCallback">
</p>

## Features

Each file gets a card with:

- **Average FPS**, next to the exact `avg_frame_rate` rational ffprobe would print when that can be reproduced. The JSON export keeps every rate as an exact rational.
- **Nominal FPS**: the exact rate when every frame interval is equal, a standard rate (such as 30000/1001) when CFR timestamps jitter by a tick, the declared Matroska rate, or the dominant rate of a VFR track with its share. ffprobe's `r_frame_rate` is shown next to it when it can be reproduced.
- **Minimum and maximum FPS** from the longest and shortest frame interval.
- **Frame timing**: CFR, CFR with 1 ms quantized timestamps (Matroska), or VFR with the share of intervals that differ from the median.
- Frame count (presented frames, plus stored samples when an edit list hides some), duration, codec, dimensions, rotation and duplicate timestamps.
- Bytes read, number of reads and analysis time. For Matroska also the scan depth (header, probe or exact) and a "Scan all frames" button.
- A provenance mark on each value (header, exact, sampled, estimated, computed) and warnings in plain words.
- All video tracks of the file, primary track first.
- A **Compare engines** panel that runs the same file through mp4box.js and mediabunny and, on request, a playback estimate with `requestVideoFrameCallback`.

Many files can be dropped at once (two workers, cancel per file). The toolbar sets the Matroska scan mode and downloads all results as JSON. Light and dark themes follow the system, and the layout works at phone width.

## Quick start

Node 22.12 or newer (CI uses the version in `.nvmrc`).

```
npm ci
npm run dev                      # Vite dev server
npm test                         # vitest: unit and fixture tests in Node
npm run typecheck                # tsc -b
npm run lint                     # oxlint
npm run compare                  # own, mp4box and mediabunny vs the ffprobe references, writes report/accuracy.*
npm run build                    # type-check and build to dist/
npm run size                     # bundle size per chunk and budgets for dist/, writes report/size.*
npm run bench                    # headless Chrome benchmark of dist/, writes report/browser-bench.*
node scripts/readme-tables.ts    # refresh the tables in this README from report/
```

- `npm run compare -- --with-large` also runs the long files in `fixtures/large` when they exist.
- `npm run size -- dist --check` exits 1 when a budget is exceeded; CI runs it.
- `npm run bench` needs a built `dist/` and Chrome (or `CHROME_PATH`); Edge is added when installed.

Fixtures need ffmpeg and ffprobe **8.1.1** on PATH (Git Bash on Windows, bash on Linux and macOS):

```
npm run fixtures:generate                    # core fixtures into fixtures/files, rewrites manifest.tsv
npm run fixtures:generate -- --with-long     # adds the two long files to fixtures/large
npm run fixtures:generate -- --with-sparse   # adds the 4.5 GB sparse file to fixtures/large
npm run fixtures:refs                        # ffprobe references into fixtures/ref
```

The committed files and references come from the ffmpeg 8.1.1 gyan.dev full build. Another build can encode different bytes, so `fixtures:refs` refuses any other ffprobe version unless `ALLOW_FFPROBE_MISMATCH=1` is set. See [fixtures/README.md](fixtures/README.md).

## How it works

### Worker and reader

The main thread posts each `File` to one of two module Web Workers. The `File` is passed by reference, so no bytes are copied. In the worker, `analyze()` reads a 64 KiB head window and sniffs the container from its magic bytes, never from the file name. It then loads the matching parser chunk with a dynamic `import()` on first use and returns a `FileResult` with per-track values, warnings and IO counters. `src/core` has no DOM dependency, so the same code runs in the worker and in Node for the tests, the comparison script and the benchmark cross-check.

All IO goes through one primitive, `BlobReader.read(offset, length)` over `Blob.slice().arrayBuffer()`, with up to four cached windows and an abort check before and after each read. The `reads` and `bytesRead` (unique bytes) of every result come from this reader.

### Why the read count matters

In Chrome every `Blob.slice().arrayBuffer()` call has a fixed cost that is several times the Node cost ([research 4.1](docs/research.md#41-reader-worker-io)), so for small files the number of reads, not the number of bytes, decides the time. The parsers are built around that:

- one head window covers a faststart MP4 or a Matroska header;
- a moov at the end of the file costs one more read;
- fragmented files read many fragments per window;
- when fragments carry large mdat boxes, offsets known from a sidx or mfra index are fetched in parallel batches.

The same content stored two ways shows the effect (faststart puts the moov first):

<!-- tables:reads:start -->

| File | Size | Reads | Bytes read | Node ms | Chrome ms |
|---|---:|---:|---:|---:|---:|
| `mov_nobf_faststart.mov` | 86.4 KiB | 1 | 64.0 KiB | 0.42 | 0.90 |
| `mov_nobf_default.mov` | 86.4 KiB | 2 | 65.1 KiB | 0.47 | 1.80 |
| `av_h264_aac_faststart.mp4` | 101.4 KiB | 1 | 64.0 KiB | 0.32 | 0.80 |
| `av_h264_aac.mp4` | 101.4 KiB | 2 | 67.8 KiB | 0.43 | 1.70 |

| Committed fixtures read in | Files | Median bytes read | Node ms (median) | Chrome ms (median) |
|---|---:|---:|---:|---:|
| 1 read | 33 | 35.8 KiB | 0.32 | 1.00 |
| 2 reads | 66 | 70.2 KiB | 0.55 | 1.80 |

<!-- tables:reads:end -->

### ISO BMFF (MP4, MOV)

- The top-level walk peeks 16-byte box headers. It reads `ftyp`, reads `moov` exactly, skips `mdat`, `free`, `wide`, `uuid` and the rest by size, reads each `moof` together with the next header, and stops at `mfra`. 64-bit `largesize`, `co64` and version 1 boxes are supported; values above 2^53-1 are rejected.
- Per video track it reads `mdhd` (timescale), `stts` (durations, run-length), `ctts` (signed composition offsets), `elst` (edit list), `stss`, the `stsz` count, `stsd` (codec, dimensions), `tkhd` (enabled flag, rotation), and for fragments `trex`, `tfhd`, `tfdt` and `trun` with every flag combination.
- The timeline stays run-length when it can (constant composition offsets, no gaps), so long CFR files are summarized from a few stts runs instead of per frame.
- Presented frames follow the first non-empty edit, as ffprobe's decoder output does.
- ffprobe's header extent is emulated. With a complete sidx, ffprobe stops after the first fragment or before the last one; the app reports the full-file average and also the value ffprobe prints.

### Matroska and WebM

Matroska has no frame index, so exact values need the block timestamps. The parser works in stages and reports how far it went (`scan`):

1. **Header**, always: EBML header, Segment, SeekHead, Info, Tracks, Tags and Cues, within 5 reads and 1 MiB. Gives codec, dimensions, `DefaultDuration` (the declared rate ffprobe prints), the Info `Duration` and per-track DURATION tags.
2. **Probe**: 8 clusters x 32 video blocks, found through Cues or a validated cluster search, plus a tail scan for the end time. Gives a sampled min, max and VFR flag, never an average or a frame count.
3. **Exact**: walks every Cluster, reads only block headers and skips payloads by size, in 4 KiB or 1 MiB windows picked by a cost model. Gives the exact frame count, average, min, max, VFR flag and duplicates. It recovers from damaged elements the way ffmpeg does.

The default `auto` mode predicts the exact-scan cost as `reads x 0.8 ms + bytes / 500 kB per ms + blocks x 0.0002 ms` and runs the scan when the prediction is 150 ms or less. Otherwise it runs the probe and the card offers "Scan all frames". The toolbar can force any mode.

### Statistics and the VFR rule

Both parsers hand their timestamps to `src/core/stats.ts`, which works on the presented frame timestamps in track ticks:

1. Sort the timestamps and take the deltas. Deltas of 0 or less are duplicate timestamps: they are counted, reported and excluded.
2. Drop the last `1 + reorderDepth` deltas, where the reorder depth comes from the B-frame composition offsets, so a cut that leaves a missing B-frame at the end does not look like VFR.
3. Take the median delta `m`. The track is **VFR** when any delta differs from `m` by more than `max(1 tick, round(0.5% x m))`. The 1-tick floor absorbs timescale rounding: 29.97 fps at timescale 1000 alternates 33 and 34 ms.
4. Minimum FPS is timescale / largest delta and maximum FPS is timescale / smallest delta, both exact rationals.
5. Nominal FPS: one distinct delta gives the exact rate. A CFR track with jitter snaps its average, within 0.1%, to an NTSC rate (24, 30, 48, 60, 120 or 240 x 1000/1001) or to an integer rate up to 240. A VFR track gets a dominant rate when one delta covers at least half of the frames.

The average is frames x timescale / sum of durations, reduced exactly by a BigInt port of FFmpeg's `av_reduce`.

### ffprobe equivalence

| Value | MP4 / MOV | Matroska / WebM |
|---|---|---|
| `avg_frame_rate` | `av_reduce(timescale x N, D)` with N = sum of stts counts (plus trun samples inside ffprobe's header extent) and D = sum of count x delta; edit lists are ignored | `av_reduce(1e9, DefaultDuration, 30000)`: declared, not measured |
| `r_frame_rate` | stage 1 only: `timescale / d0` when every kept duration except the last equals the first; otherwise ffprobe uses probing heuristics and the app shows none | equals `avg_frame_rate` when it is between 5 and 1000 |
| frames | `nb_frames` = sum of stts counts; fragmented files: `nb_read_packets` | `nb_read_packets`: blocks, with laces counted |
| presented frames | `nb_read_frames`: samples inside the first non-empty edit | same as frames |
| measured average | same as `avg_frame_rate` | frames / (last PTS + last duration - first PTS), compared with the same value computed from ffprobe's packets |

A track keeps two averages when they differ: `avgFps`, the full-file value, and `avgFpsFfprobe`, the string ffprobe 8.1.1 prints. The card shows both. The full rules, with FFmpeg source references, are in [docs/research.md](docs/research.md#2-ffprobe-equivalence).

### Provenance labels

| Mark | Label | Meaning |
|---|---|---|
| H | header | read from container headers |
| E | exact | computed from every sample or block timestamp |
| S | sampled | from a sample of Matroska blocks (probe); never used for an average |
| ~ | estimated | derived under an assumption, such as a playback measurement (rVFC) |
| C | computed | a value ffprobe prints as N/A, computed by the app (Matroska frame count) |

### Edge cases handled

- moov at the end, no moov (interrupted recording), moov cut short, a moov size past the end of the file, truncated mdat (the rate comes from the header and frames are counted from complete samples, like ffprobe).
- Fragmented MP4: empty moov, hybrid moov plus fragments, default-base-is-moof, missing trex, sidx and mfra indexes, a fragment cut short.
- Edit lists: empty edits, trimmed starts, early ends, a duplicated elst box; B-frames with signed composition offsets.
- Several video tracks (the primary is the enabled track with the most samples in MP4, the first video track in Matroska), still image tracks, cover art and chapter tracks (not video), audio-only files.
- Wrong file extensions, empty files, text, PNG and random bytes (`not a recognised container`).
- Matroska: unknown-size Segment and Clusters from live recording, no DefaultDuration, a false Info Duration from pipe output, BlockGroups and lacing, CRC-32 and Void elements, TrackTimestampScale and CodecDelay, image attachments, damaged elements.
- Hostile input: every table is bounded by its box, and work and memory limits stop tiny headers that claim millions of samples. A bad file comes back as an error string, never as an exception.

## Approach comparison

Four ways to get a frame rate in the browser, run on the same fixtures (requestVideoFrameCallback on a subset, because it plays each file). The library engines are adapters in `src/engines` that fill the same result shape from the samples each library parses, so the libraries are compared as parsers.

<!-- tables:approaches:start -->

Node: `npm run compare` (`analyze()` on `fs.openAsBlob`), median of 3 runs per file; library engines run the long files once. Chrome 155: `npm run bench` on the built app, file picked through the real file input, median of 5 warm runs (own) or 3 runs (libraries, long files); "UI ms" runs from the input's change event to the rendered result. Times are worker-side `io.ms`.

|  | Own parsers (this repo) | mp4box.js 2.4.1 | mediabunny 1.62.0 | requestVideoFrameCallback (Chrome 155) |
|---|---|---|---|---|
| Containers | MP4, MOV, WebM, Matroska | MP4, MOV | MP4, MOV, WebM, Matroska | whatever the browser can play |
| Checks vs ffprobe, all fixtures | 1527 checks: 1480 exact, 3 known deviation, 0 mismatch | 1163 checks: 1047 exact, 2 known deviation, 98 mismatch (75 of them on WebM/MKV files it cannot open) | 1527 checks: 1373 exact, 2 known deviation, 110 mismatch | no ffprobe-equivalent fields |
| Frame-rate field mismatches | MP4: 0, MKV: 0 | MP4: 3, MKV: not supported | MP4: 8, MKV: 71 | 9 of 11 estimates equal ffprobe's average; VFR files off by -10.0% and +292.3%; 2 of 13 files did not play |
| Bytes read, 69 committed MP4/MOV files | 4.25 MiB of 6.49 MiB (65.5%) | 4.24 MiB of 6.49 MiB (65.3%) | 6.49 MiB of 6.49 MiB (100%) | the media element streams the file |
| Bytes read, 27 committed WebM/MKV files | 2.67 MiB of 2.68 MiB (99.6%) | not supported | 2.68 MiB of 2.68 MiB (100%) | the media element streams the file |
| Reads per file, median / max | 2 / 2 | 2 / 3 | 1 / 2 | n/a |
| Time per file, Node 24 (median; geometric mean vs own) | 0.50 ms | 0.62 ms (1.45x own) | 0.66 ms (1.33x own) | needs a browser |
| Time per file, Chrome 155 (median; geometric mean vs own) | 1.60 ms | 1.90 ms (1.24x own) | 1.30 ms (0.95x own) | 1.94 s (max 4.85 s) |
| 3 h CFR MP4, 12.42 MiB | 2 reads, 2.56 MiB; Node 4.50 ms, Chrome 5.00 ms | 3 reads, 2.56 MiB; Node 223 ms, Chrome 167 ms | 3 reads, 2.73 MiB; Node 1006 ms, Chrome 521 ms | not measured |
| 1 h VFR MP4, 3.76 MiB | 2 reads, 1.53 MiB; Node 31.7 ms, Chrome 31.1 ms | 3 reads, 1.53 MiB; Node 87.8 ms, Chrome 62.0 ms | 3 reads, 1.70 MiB; Node 249 ms, Chrome 140 ms | not measured |
| gzip, loaded on demand | worker entry 6.56 KB + ISO BMFF 11.94 KB or Matroska 10.73 KB | 43.66 KB + 1.48 KB shared | 52.76 KB + 1.48 KB shared | 1.94 KB |
| Main risk | own code to maintain; cases outside the corpus are flagged, not verified | last sample duration overridden; must be fed box by box; no Matroska | packet-rate average, edit-list start trim ignored, whole-cluster Matroska reads | needs a visible tab and a playable codec; wrong on VFR; seconds per file |

<!-- tables:approaches:end -->

Risks in detail:

- **Own parsers**: code to maintain. Behaviour outside the corpus (real recorder files, cmov, multi-segment edit lists) is flagged with a warning, not verified.
- **mp4box.js**: MP4 and MOV only. It overrides the last sample duration with `mdhd.duration - last dts`, so the adapter takes durations from the stts box. It has to be fed box by box; a plain append loop reads the whole file.
- **mediabunny**: its average is `averagePacketRate`, it ignores an edit list's start trim, it reads whole Matroska clusters, and its `packets()` iterator stalls on very long files (the adapter walks with `getNextPacket`). MPL-2.0 licence.
- **requestVideoFrameCallback**: needs a visible foreground tab and a codec the browser can play. It sees only the frames of a short playback, so VFR averages are wrong, it takes seconds per file, and it depends on the display refresh rate.

### requestVideoFrameCallback fallback

<!-- tables:rvfc:start -->

Headless Chrome 155, GPU decoding on, display 170 Hz.

| File | ffprobe avg | rVFC estimate | Error | VFR ffprobe / rVFC | Confidence | Passes | Time |
|---|---|---|---|---|---|---|---|
| `cfr_h264_24.mp4` | 24/1 (24.000) | 24/1 (24.000) | 0.0% | no / no | high | 1 (rate 1) | 2.02 s |
| `cfr_h264_25.mp4` | 25/1 (25.000) | 25/1 (25.000) | 0.0% | no / no | high | 1 (rate 1) | 1.94 s |
| `cfr_h264_29.97.mp4` | 30000/1001 (29.970) | 30000/1001 (29.970) | 0.0% | no / no | high | 1 (rate 1) | 1.83 s |
| `cfr_h264_30.mp4` | 30/1 (30.000) | 30/1 (30.000) | 0.0% | no / no | high | 1 (rate 1) | 1.83 s |
| `cfr_h264_60.mp4` | 60/1 (60.000) | 60/1 (60.000) | 0.0% | no / no | high | 1 (rate 1) | 1.84 s |
| `cfr_h264_120.mp4` | 120/1 (120.0) | 120/1 (120.0) | 0.0% | no / no | high | 2 (rate 0.5) | 3.33 s |
| `cfr_h264_240.mp4` | 240/1 (240.0) | 240/1 (240.0) | 0.0% | no / no | high | 3 (rate 0.25) | 4.85 s |
| `vfr_concat_10_30_60.mp4` | 100/3 (33.333) | 30/1 (30.000) | -10.0% | yes / yes | low | 1 (rate 1) | 3.44 s |
| `vfr_setpts_sine.mp4` | 13500000/445991 (30.270) | 118737/1000 (118.7) | +292.3% | yes / yes | low | 2 (rate 0.5) | 4.36 s |
| `cfr_vp9_29.97.webm` | 30000/1001 (29.970) | 30000/1001 (29.970) | 0.0% | no / no | medium | 1 (rate 1) | 1.86 s |
| `hevc_hvc1.mp4` | 30000/1001 (29.970) | error: The element has no supported sources. | - | no / - | - | - | 0.31 s |
| `mov_prores.mov` | 30000/1001 (29.970) | error: unplayable: PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_ST... | - | no / - | - | - | 0.00 s |
| `h264.mkv` | 30000/1001 (29.970) | 30000/1001 (29.970) | 0.0% | no / no | medium | 1 (rate 1) | 1.86 s |

<!-- tables:rvfc:end -->

## Bundle size

<!-- tables:bundle:start -->

| Chunk | Loaded | Raw | gzip -9 | brotli q11 | Budget (gzip) | Headroom | Status |
|---|---|---:|---:|---:|---:|---:|---|
| main (React, UI, store, worker pool) | page load | 236.43 KB | **73.86 KB** | 63.81 KB | 75.00 KB | 1.15 KB | ok |
| CSS | page load | 4.34 KB | **1.63 KB** | 1.38 KB | not budgeted | - | - |
| worker entry (reader, sniffing, statistics) | first file | 16.55 KB | **6.56 KB** | 6.01 KB | 7.50 KB | 0.94 KB | ok |
| ISO BMFF parser | first MP4 or MOV file, once per worker | 30.28 KB | **11.94 KB** | 10.82 KB | 13.50 KB | 1.56 KB | ok |
| Matroska parser | first WebM or MKV file, once per worker | 28.62 KB | **10.73 KB** | 9.76 KB | 12.00 KB | 1.27 KB | ok |
| rVFC fallback | click on Run (approximate) | 3.65 KB | **1.94 KB** | 1.76 KB | 2.50 KB | 0.56 KB | ok |
| Compare panel | first open of a Compare engines panel | 2.84 KB | **1.17 KB** | 1.06 KB | not budgeted | - | - |
| mp4box.js engine | Compare engines on an MP4 or MOV card | 187.74 KB | **43.66 KB** | 37.34 KB | not budgeted | - | - |
| mediabunny engine | Compare engines | 201.47 KB | **52.76 KB** | 44.40 KB | not budgeted | - | - |
| shared by mp4box and mediabunny | with mp4box or mediabunny | 2.98 KB | **1.48 KB** | 1.34 KB | not budgeted | - | - |
| initial: main + CSS + worker entry |  | 257.31 KB | **82.05 KB** | 71.20 KB | 85.00 KB | 2.95 KB | ok |
| first MP4 analysis: initial + ISO BMFF parser |  | 287.59 KB | **93.99 KB** | 82.01 KB | 100.00 KB | 6.01 KB | ok |
| first Matroska analysis: initial + Matroska parser |  | 285.93 KB | **92.78 KB** | 80.95 KB | 100.00 KB | 7.22 KB | ok |

<!-- tables:bundle:end -->

The research spec planned one parser worker chunk sized from early prototypes. The complete parsers turned out about twice as large ([research errata](docs/research.md#8-errata-found-during-implementation)), so each parser became a lazy chunk with its own budget and the user-facing limit moved to the first analysis of each container. [report/size.md](report/size.md) explains every limit; CI fails on an overrun.

## Speed

Own parsers on representative files and the long local files.

<!-- tables:speed:start -->

Node: `npm run compare` (`analyze()` on `fs.openAsBlob`), median of 3 runs per file; library engines run the long files once. Chrome 155: `npm run bench` on the built app, file picked through the real file input, median of 5 warm runs (own) or 3 runs (libraries, long files); "UI ms" runs from the input's change event to the rendered result. Times are worker-side `io.ms`.

| File | What it is | Size | Duration | Frames | Reads | Bytes read | Node ms | Chrome 155 ms | Chrome 155 UI ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `av_h264_aac_faststart.mp4` | MP4, moov before mdat (faststart) | 101.4 KiB | 3 s | 90 | 1 | 64.0 KiB (63.1%) | 0.32 | 0.80 | 1.50 |
| `av_h264_aac.mp4` | same file, moov at the end | 101.4 KiB | 3 s | 90 | 2 | 67.8 KiB (66.9%) | 0.43 | 1.70 | 2.60 |
| `mp4_bf_elst.mp4` | MP4 with B-frames and an edit list | 35.8 KiB | 3.003 s | 90 | 1 | 35.8 KiB (100%) | 0.32 | 0.90 | 1.70 |
| `fmp4_frag_duration.mp4` | fragmented MP4 | 117.2 KiB | 4.004 s | 120 | 2 | 108.7 KiB (92.7%) | 0.56 | 1.60 | 2.40 |
| `frag_vfr_global_sidx.mp4` | fragmented VFR MP4 with a global sidx | 121.0 KiB | 4.967 s | 140 | 2 | 117.9 KiB (97.4%) | 0.55 | 2.00 | 3.20 |
| `vfr_screenrec_ts1000.mp4` | VFR screen recording, timescale 1000 | 188.6 KiB | 6.004 s | 246 | 2 | 67.6 KiB (35.8%) | 0.71 | 2.00 | 2.70 |
| `cfr_vp9_30.webm` | WebM, VP9 | 70.7 KiB | 3 s | 90 | 2 | 70.6 KiB (99.9%) | 0.62 | 2.10 | 3.30 |
| `vp9_unknown_clusters.webm` | WebM with unknown-size clusters (live) | 71.9 KiB | - | 90 | 2 | 71.1 KiB (99.0%) | 0.61 | 2.10 | 3.00 |
| `h264_vfr_remux.mkv` | Matroska, stream-copied VFR with BlockGroups | 200.0 KiB | 6 s | 260 | 2 | 199.6 KiB (99.8%) | 1.02 | 2.80 | 3.80 |
| `corrupt_trunc_no_moov.mp4` | interrupted recording, no moov (error) | 85.6 KiB | - | - | 1 | 64.0 KiB (74.8%) | 0.29 | 0.90 | 1.50 |
| `long_cfr_3h_60fps.mp4` | long CFR MP4, moov at the end | 12.42 MiB | 3 h | 648000 | 2 | 2.56 MiB (20.6%) | 4.50 | 5.00 | 6.10 |
| `long_vfr_1h_screenrec.mp4` | long VFR screen recording MP4 | 3.76 MiB | 1 h | 133920 | 2 | 1.53 MiB (40.7%) | 31.7 | 31.1 | 32.0 |
| **all 100 committed fixtures** | median per file; bytes are totals | 9.23 MiB |  |  | 2 (max 2) | 6.98 MiB (75.6%) | 0.50 | 1.60 | 2.50 |

- Cold start, Chrome 155: the app is ready 181 ms after navigation; 100 files picked at once on a fresh profile show all results after 268 ms (median of 265 ms over reloads, range 259 to 282 ms).
- Edge 155, same warm run: median 1.60 ms per file, geometric mean 0.95x of Chrome 155.

| First file of a container | File | UI ms, fresh page | UI ms, 2nd pick | UI ms, steady | Extra ms (fresh - steady) | Chunks fetched (raw) |
|---|---|---:|---:|---:|---:|---|
| ISO BMFF | `cfr_h264_30.mp4` | 14.4 | 3.40 | 2.80 | 11.6 | analyze.worker.js 16.55 KB, isobmff.js 30.28 KB |
| Matroska | `h264.mkv` | 15.2 | 4.00 | 2.70 | 12.5 | analyze.worker.js 16.55 KB, matroska.js 28.62 KB |

<!-- tables:speed:end -->

Per-file timings for every fixture, the library engines and the cold start are in [report/browser-bench.md](report/browser-bench.md).

## Accuracy vs ffprobe

Every fixture has an ffprobe 8.1.1 reference in `fixtures/ref/`. `npm run compare` checks the outcome, track selection, average, nominal rate, frames, presented frames, track and format duration, start, min, max, VFR flag, duplicates, codec and dimensions of every video track against it. Each check gets a verdict: exact, within-tol, known-deviation (differs for a recorded reason), mismatch or n/a. Only the own engine gates the run; the library engines are informational.

<!-- tables:engines:start -->

| Engine | Role | Fixtures | Checks | exact | within-tol | known-deviation | mismatch | n/a | Fixtures with a mismatch |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| own parsers | gating | 102 | 1527 | 1480 | 0 | 3 | 0 | 44 | 0 |
| mp4box.js | informational | 102 | 1163 | 1047 | 0 | 2 | 98 | 16 | 46 |
| mediabunny | informational | 102 | 1527 | 1373 | 0 | 2 | 110 | 42 | 51 |

| Engine | Files | Fixtures | Checks | Frame-rate mismatches | Other mismatches | Fixtures with a mismatch | Note |
|---|---|---:|---:|---:|---:|---:|---|
| own parsers | ISO BMFF (MP4, MOV) | 71 | 1078 | 0 | 0 | 0 |  |
| own parsers | Matroska, WebM | 27 | 445 | 0 | 0 | 0 |  |
| own parsers | not a video container | 4 | 4 | 0 | 0 | 0 |  |
| mp4box.js | ISO BMFF (MP4, MOV) | 71 | 1078 | 3 | 20 | 19 |  |
| mp4box.js | Matroska, WebM | 27 | 81 | 0 | 75 | 27 | container not supported by the library |
| mp4box.js | not a video container | 4 | 4 | 0 | 0 | 0 |  |
| mediabunny | ISO BMFF (MP4, MOV) | 71 | 1078 | 8 | 30 | 28 |  |
| mediabunny | Matroska, WebM | 27 | 445 | 71 | 1 | 23 |  |
| mediabunny | not a video container | 4 | 4 | 0 | 0 | 0 |  |

- mp4box.js mismatches by field: `formatDurationSec` 39, `error` 28, `trackSelection` 26, `presentedFrames` 2, `codecName` 1, `frames` 1, `startSec` 1.
- mediabunny mismatches by field: `avgFps.declared` 22, `avgFps.measured` 22, `formatDurationSec` 22, `nominalFps` 22, `presentedFrames` 5, `error` 3, `frames` 3, `avgFps` 2, `durationSec` 2, `startSec` 2, `codecName` 1, `isVfr` 1, `maxFps` 1, `minFps` 1, `trackSelection` 1.

<!-- tables:engines:end -->

Frame-rate checks are `avgFps` (for Matroska its declared and measured variants), `nominalFps`, `frames`, `presentedFrames`, `minFps`, `maxFps`, `isVfr` and `duplicateTimestamps`. mp4box.js cannot open WebM or Matroska, which accounts for most of its mismatches.

The table below shows the primary track of every fixture. Frames are app / ffprobe. For Matroska, the declared rate is what ffprobe prints and the measured average comes from the block timestamps. For files without a video track, the two average columns show the outcome instead.

<!-- tables:accuracy:start -->

<details><summary>Own parsers: all 102 fixtures</summary>

| Fixture | Category | ffprobe avg_frame_rate | App average | Frames app / ffprobe | Min to max FPS | VFR | Verdict | Reads | Bytes read | Chrome 155 ms |
|---|---|---|---|---|---|---|---|---:|---:|---:|
| `cfr_h264_23.976.mp4` | cfr | 24000/1001 | 24000/1001 | 72 / 72 | 23.976 to 23.976 | no | all exact (16) | 2 | 65.1 KiB (90.5%) | 1.60 |
| `cfr_vp9_23.976.webm` | cfr | 24000/1001 | 24000/1001; measured 36000/1501 | 72 / 72 | 23.810 to 24.390 | no | all exact (16) | 1 | 59.4 KiB (100%) | 1.20 |
| `cfr_h264_24.mp4` | cfr | 24/1 | 24/1 | 72 / 72 | 24.000 to 24.000 | no | all exact (16) | 2 | 65.1 KiB (91.2%) | 1.50 |
| `cfr_vp9_24.webm` | cfr | 24/1 | 24/1; measured 72000/2999 | 72 / 72 | 23.810 to 24.390 | no | all exact (16) | 1 | 59.2 KiB (100%) | 1.00 |
| `cfr_h264_25.mp4` | cfr | 25/1 | 25/1 | 75 / 75 | 25.000 to 25.000 | no | all exact (16) | 2 | 65.1 KiB (93.4%) | 1.70 |
| `cfr_vp9_25.webm` | cfr | 25/1 | 25/1; measured 25/1 | 75 / 75 | 25.000 to 25.000 | no | all exact (16) | 1 | 58.8 KiB (100%) | 1.10 |
| `cfr_h264_29.97.mp4` | cfr | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 2 | 65.1 KiB (75.4%) | 1.70 |
| `cfr_vp9_29.97.webm` | cfr | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 71.2 KiB (98.9%) | 1.70 |
| `cfr_h264_30.mp4` | cfr | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 2 | 65.1 KiB (75.1%) | 1.90 |
| `cfr_vp9_30.webm` | cfr | 30/1 | 30/1; measured 30/1 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 70.6 KiB (99.9%) | 2.10 |
| `cfr_h264_50.mp4` | cfr | 50/1 | 50/1 | 150 / 150 | 50.000 to 50.000 | no | all exact (16) | 2 | 65.4 KiB (59.4%) | 2.10 |
| `cfr_vp9_50.webm` | cfr | 50/1 | 50/1; measured 50/1 | 150 / 150 | 50.000 to 50.000 | no | all exact (16) | 2 | 104.1 KiB (99.9%) | 1.90 |
| `cfr_h264_59.94.mp4` | cfr | 60000/1001 | 60000/1001 | 180 / 180 | 59.940 to 59.940 | no | all exact (16) | 2 | 65.5 KiB (52.0%) | 1.50 |
| `cfr_vp9_59.94.webm` | cfr | 19001/317 | 19001/317; measured 90000/1501 | 180 / 180 | 58.824 to 62.500 | no | all exact (16) | 2 | 122.3 KiB (99.8%) | 2.00 |
| `cfr_h264_60.mp4` | cfr | 60/1 | 60/1 | 180 / 180 | 60.000 to 60.000 | no | all exact (16) | 2 | 65.5 KiB (51.8%) | 1.80 |
| `cfr_vp9_60.webm` | cfr | 60/1 | 60/1; measured 180000/2999 | 180 / 180 | 58.824 to 62.500 | no | all exact (16) | 2 | 120.7 KiB (99.5%) | 2.00 |
| `cfr_h264_120.mp4` | cfr | 120/1 | 120/1 | 360 / 360 | 120.0 to 120.0 | no | all exact (16) | 2 | 66.2 KiB (35.8%) | 1.90 |
| `cfr_vp9_120.webm` | cfr | 120/1 | 120/1; measured 120/1 | 360 / 360 | 111.1 to 125.0 | no | all exact (16) | 2 | 203.8 KiB (99.9%) | 2.70 |
| `cfr_h264_240.mp4` | cfr | 240/1 | 240/1 | 720 / 720 | 240.0 to 240.0 | no | all exact (16) | 2 | 67.7 KiB (21.0%) | 1.80 |
| `cfr_vp9_240.webm` | cfr | 240/1 | 240/1; measured 240/1 | 720 / 720 | 200.0 to 250.0 | no | all exact (16) | 2 | 354.8 KiB (99.8%) | 2.70 |
| `mov_nobf_default.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 2 | 65.1 KiB (75.4%) | 1.80 |
| `mov_nobf_faststart.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 64.0 KiB (74.1%) | 0.90 |
| `mov_bf_elst.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.7 KiB (100%) | 0.80 |
| `mov_bf_noelst.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.7 KiB (100%) | 1.00 |
| `mov_bf_faststart.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.7 KiB (100%) | 1.10 |
| `mov_prores.mov` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 2 | 65.0 KiB (29.7%) | 1.60 |
| `mp4_bf_elst.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.8 KiB (100%) | 0.90 |
| `mp4_bf_noelst.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.7 KiB (100%) | 1.10 |
| `mp4_bf_faststart.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.8 KiB (100%) | 1.10 |
| `mp4_elst_empty_offset.mp4` | mov | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 1 | 35.2 KiB (100%) | 1.00 |
| `mp4_elst_trim_start.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.8 KiB (100%) | 1.00 |
| `mp4_elst_trim_output_seek.mp4` | mov | 30000/1001 | 30000/1001 | 60 / 60 | 29.970 to 29.970 | no | all exact (16) | 1 | 25.1 KiB (100%) | 1.00 |
| `fmp4_keyframe_empty_moov.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.0 KiB (80.6%) | 1.80 |
| `fmp4_default_base_moof.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.0 KiB (80.6%) | 1.70 |
| `fmp4_frag_duration.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 108.7 KiB (92.7%) | 1.60 |
| `fmp4_bframes.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 1 | 48.8 KiB (100%) | 1.00 |
| `fmp4_hybrid_no_empty_moov.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.0 KiB (80.6%) | 1.90 |
| `fmp4_cmaf.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.0 KiB (80.6%) | 1.60 |
| `fmp4_global_sidx.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.0 KiB (80.5%) | 1.60 |
| `fmp4_dash_flag.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.1 KiB (80.5%) | 1.80 |
| `mp4_hybrid_fragmented_finalized.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 65.2 KiB (55.4%) | 1.60 |
| `fmp4_dash_single_file.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.0 KiB (80.4%) | 1.80 |
| `fmp4_dash_concat_segments.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (16) | 2 | 94.0 KiB (80.4%) | 1.60 |
| `hevc_hvc1.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 45.1 KiB (100%) | 0.90 |
| `hevc_hev1.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 45.1 KiB (100%) | 0.90 |
| `av1.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 20.8 KiB (100%) | 1.00 |
| `vp9.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 2 | 65.1 KiB (90.4%) | 1.50 |
| `vp9.webm` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 71.2 KiB (98.9%) | 1.90 |
| `vp8.webm` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 160.3 KiB (99.9%) | 2.00 |
| `av1.webm` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 21.2 KiB (100%) | 0.90 |
| `h264.mkv` | matroska | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 85.8 KiB (99.3%) | 1.90 |
| `hevc.mkv` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 44.3 KiB (100%) | 1.10 |
| `vp9_live.webm` | live | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 71.1 KiB (99.0%) | 1.70 |
| `vp9_pipe.webm` | live | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 71.1 KiB (99.0%) | 1.90 |
| `vp9_unknown_clusters.webm` | live | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 71.1 KiB (99.0%) | 2.10 |
| `vp9_no_defaultduration.webm` | matroska | 30000/1001 | none; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (14) | 2 | 71.2 KiB (98.9%) | 1.90 |
| `vfr_concat_10_30_60.mp4` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.000 | yes | all exact (15) | 2 | 65.6 KiB (40.6%) | 1.60 |
| `vfr_concat_bframes.mp4` | vfr | 1200/37 | 1200/37 | 200 / 200 | 10.000 to 60.000 | yes | all exact (15) | 2 | 66.7 KiB (100%) | 1.60 |
| `vfr_concat_10_30_60_ts1M.mp4` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.002 | yes | all exact (15) | 2 | 66.5 KiB (40.9%) | 1.70 |
| `vfr_concat_10_30_60.mov` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.000 | yes | all exact (15) | 2 | 65.6 KiB (40.5%) | 1.60 |
| `vfr_concat_10_30_60.webm` | vfr | 0/0 | none; measured 100/3 | 200 / 200 | 10.000 to 62.500 | yes | 14 exact; known deviation: avgFps.measured | 2 | 140.1 KiB (99.8%) | 1.80 |
| `vfr_concat_10_30_60_fmp4.mp4` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.000 | yes | all exact (15) | 2 | 140.9 KiB (86.6%) | 1.80 |
| `vfr_setpts_sine.mp4` | vfr | 13500000/445991 | 13500000/445991 | 150 / 150 | 17.149 to 119.7 | yes | all exact (15) | 2 | 66.5 KiB (46.8%) | 2.10 |
| `vfr_select_drop.mp4` | vfr | 36/1 | 36/1 | 180 / 180 | 20.000 to 60.000 | yes | all exact (15) | 2 | 66.9 KiB (44.0%) | 1.80 |
| `vfr_mpdecimate.mp4` | vfr | 182/9 | 182/9 | 91 / 91 | 0.667 to 30.000 | yes | all exact (15) | 2 | 65.2 KiB (74.9%) | 1.70 |
| `vfr_screenrec_ts1000.mp4` | vfr | 61500/1501 | 61500/1501 | 246 / 246 | 2.959 to 100.0 | yes | all exact (15) | 2 | 67.6 KiB (35.8%) | 2.00 |
| `vfr_screenrec_ts1000.webm` | vfr | 60/1 | 60/1; measured 246000/5999 | 246 / 246 | 2.994 to 62.500 | yes | all exact (16) | 2 | 179.3 KiB (98.7%) | 2.00 |
| `vfr_pulldown_2_3.mp4` | vfr | 24/1 | 24/1 | 120 / 120 | 20.000 to 30.000 | yes | all exact (15) | 2 | 66.2 KiB (53.9%) | 1.80 |
| `box64_mdat64_wide.mov` | box64 | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 2 | 65.1 KiB (75.4%) | 1.50 |
| `box64_mdat64_free.mp4` | box64 | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 2 | 65.1 KiB (75.1%) | 1.90 |
| `box64_co64_mdat64.mp4` | box64 | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (16) | 1 | 35.8 KiB (100%) | 1.10 |
| `av_h264_aac.mp4` | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 2 | 67.8 KiB (66.9%) | 1.70 |
| `av_h264_aac_faststart.mp4` | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 1 | 64.0 KiB (63.1%) | 0.80 |
| `multi_video_2tracks.mp4` (+1 track) | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (29) | 2 | 68.7 KiB (22.9%) | 1.60 |
| `still_image_track_first.mp4` (+1 track) | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (28) | 2 | 68.4 KiB (65.2%) | 1.90 |
| `cover_art_audio.m4a` | cover | opens as mov,mp4,m4a,3gp,3g2,mj2, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 16.3 KiB (100%) | 1.00 |
| `cover_art_plus_video.mp4` | cover | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 2 | 69.9 KiB (67.6%) | 1.60 |
| `audio_only.m4a` | audio | opens as mov,mp4,m4a,3gp,3g2,mj2, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 13.3 KiB (100%) | 0.80 |
| `audio_only_aac.mp4` | audio | opens as mov,mp4,m4a,3gp,3g2,mj2, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 13.3 KiB (100%) | 0.90 |
| `audio_only_opus.webm` | audio | opens as matroska,webm, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 13.5 KiB (100%) | 0.80 |
| `edge_single_frame.mp4` | edge | 30/1 | 30/1 | 1 / 1 | - | - | all exact (15) | 1 | 4.0 KiB (100%) | 0.90 |
| `corrupt_empty_0byte.mp4` | corrupt | fails: moov atom not found | error: not a recognised container: empty file | - | - | - | all exact (1) | 0 | 0 B | 0.00 |
| `corrupt_garbage_random.mp4` | corrupt | fails: moov atom not found | error: not a recognised container: no known signature | - | - | - | all exact (1) | 1 | 64.0 KiB (100%) | 1.10 |
| `corrupt_text_named.mp4` | corrupt | fails: moov atom not found | error: not a recognised container: text file | - | - | - | all exact (1) | 1 | 63 B (100%) | 0.80 |
| `corrupt_png_named.mp4` | corrupt | opens as png_pipe, 1 video stream(s) | error: not a recognised container: PNG image | - | - | - | all exact (1) | 1 | 2.2 KiB (100%) | 0.70 |
| `corrupt_trunc_moov_partial.mp4` | corrupt | fails: error reading header | error: incomplete file: moov is truncated | - | - | - | all exact (1) | 2 | 64.6 KiB (74.9%) | 1.80 |
| `corrupt_trunc_no_moov.mp4` | corrupt | fails: moov atom not found | error: incomplete file: no moov | - | - | - | all exact (1) | 1 | 64.0 KiB (74.8%) | 0.90 |
| `corrupt_trunc_mdat_faststart.mp4` | corrupt | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 1 | 60.8 KiB (100%) | 1.10 |
| `corrupt_fmp4_truncated_mid_fragment.mp4` | corrupt | 30000/1001 | 30000/1001 | 73 / 73 | 29.970 to 29.970 | no | all exact (16) | 1 | 64.0 KiB (91.4%) | 1.10 |
| `box_mdat_size0.mp4` | box64 | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 1 | 64.0 KiB (63.1%) | 0.90 |
| `corrupt_stts_count_huge.mp4` | corrupt | fails: error reading header | ok, 1 video track | - | - | - | all exact (1) | 2 | 65.1 KiB (75.1%) | 1.60 |
| `sniff_webm_named_mp4.mp4` | sniff | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 71.2 KiB (98.9%) | 2.40 |
| `sniff_mp4_named_webm.webm` | sniff | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 2 | 65.1 KiB (75.1%) | 1.60 |
| `sniff_mp4_named_mkv.mkv` | sniff | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (16) | 2 | 65.1 KiB (75.1%) | 1.90 |
| `frag_vfr_global_sidx.mp4` | fmp4 | 60/1 | 4200/149 | 140 / 140 | 20.000 to 60.000 | yes | 14 exact; known deviation: avgFps | 2 | 117.9 KiB (97.4%) | 2.00 |
| `frag_vfr_dash.mp4` | fmp4 | 30/1 | 4200/149 | 140 / 140 | 20.000 to 60.000 | yes | 14 exact; known deviation: avgFps | 2 | 118.0 KiB (97.4%) | 1.90 |
| `h264_vfr_remux.mkv` | vfr | 130/3 | 130/3; measured 130/3 | 260 / 260 | 10.000 to 62.500 | yes | all exact (16) | 2 | 199.6 KiB (99.8%) | 2.80 |
| `vp9_pipe_t10.webm` | live | 30/1 | 30/1; measured 30/1 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 70.6 KiB (99.9%) | 1.80 |
| `vp9_opus_live_audiotail.webm` | live | 30/1 | 30/1; measured 30/1 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 2 | 98.2 KiB (99.5%) | 2.00 |
| `h264_25_cover.mkv` | cover | 25/1 | 25/1; measured 25/1 | 75 / 75 | 25.000 to 25.000 | no | all exact (16) | 2 | 71.6 KiB (99.5%) | 2.00 |
| `long_cfr_3h_60fps.mp4` | long | 60/1 | 60/1 | 648000 / 648000 | 60.000 to 60.000 | no | all exact (16) | 2 | 2.56 MiB (20.6%) | 5.00 |
| `long_vfr_1h_screenrec.mp4` | long | 186/5 | 186/5 | 133920 / 133920 | 2.941 to 100.0 | yes | all exact (15) | 2 | 1.53 MiB (40.7%) | 31.1 |

</details>

<!-- tables:accuracy:end -->

The field-level table, with app and ffprobe values for every check of all three engines, is in [report/accuracy.md](report/accuracy.md).

### Known deviations

<!-- tables:deviations:start -->

- `vfr_concat_10_30_60.webm`, `avgFps.measured`: app 100/3, ffprobe 3125/94. The file has no DefaultDuration, so ffprobe fills the last packet duration from its estimated r_frame_rate 30/1 (33 ms) and avgFromPts is 200 / 6.016 s = 3125/94. The app follows research 4.5 and uses the median delta (17 ms) for the last frame: 200 / 6.000 s = 100/3, which also matches format.duration and the DURATION tag of 6.000 s.
- `frag_vfr_global_sidx.mp4`, `avgFps`: app 4200/149, ffprobe 60/1. The global sidx covers the whole file, so ffprobe 8.1.1 stops its header walk after the first moof and mdat (mov.c:9740-9746) and computes avg_frame_rate 60/1 from 30 of 140 samples. The app reads every moof and reports the full-file average 4200/149, which equals avgFromPts; avgFpsFfprobe still reproduces 60/1.
- `frag_vfr_dash.mp4`, `avgFps`: app 4200/149, ffprobe 30/1. Each fragment has its own sidx and the last one completes the index, so ffprobe 8.1.1 stops right after it and never parses the last moof: avg_frame_rate 30/1 comes from 120 of 140 samples. The app reads every moof and reports the full-file average 4200/149, which equals avgFromPts; avgFpsFfprobe still reproduces 30/1.
- Not run: `sparse_4_5gb_co64.mp4`, optional file not present (generate it with npm run fixtures:generate).

<!-- tables:deviations:end -->

## Recommendation

- **Use the own parsers as the primary path.** They are the only option here with no mismatch against ffprobe on the corpus. They read only the boxes and elements they need (see the bytes-read rows above), add a small worker entry plus one parser chunk per container, and report exact min, max and VFR from every timestamp with provenance on each value.
- **mp4box.js** fits when an app already ships it for other MP4 work (box access, segmentation, muxing). For frame rates, take durations from the stts box instead of the per-sample info, feed it box by box, and add a Matroska parser.
- **mediabunny** fits when the app also demuxes or decodes through WebCodecs, or as a second opinion. Expect its `averagePacketRate` average, a larger chunk, whole-cluster reads on Matroska and the edit-list gaps above.
- **requestVideoFrameCallback** only as a last-resort, opt-in fallback when the parser cannot give a rate (an unsupported container or sample entry) and the browser can play the file. Label the result approximate: it matched ffprobe on CFR clips but missed on every VFR file, needs a visible tab and takes seconds.

## Limitations

- Matroska has no frame index: an exact frame count, min, max and VFR flag need a block scan. `auto` mode runs it only when the predicted cost is within budget; otherwise the card shows a sampled probe until "Scan all frames" is pressed.
- Matroska timestamps are usually 1 ms ticks. CFR content shows a quantized min and max, and VFR between rates whose frame periods differ by less than about 1 ms is invisible.
- `r_frame_rate` is reproduced only for tracks with equal intervals (ffprobe's stage 1). For VFR ffprobe uses probing heuristics; the app shows a dominant rate or nothing.
- With a complete sidx, ffprobe 8.1.1 reads only part of a fragmented file. The app reports the full-file average and records the difference as a known deviation.
- Compressed movie headers (`cmov`) and a moov above 256 MiB are unsupported. Only the first stsd entry is used.
- Multi-segment edit lists, edits with a rate other than 1 and dwell edits get a warning; presented frames follow the first non-empty edit.
- Browser IO was measured only in Chromium (headless Chrome and Edge on one Windows desktop). Firefox, Safari, mobile browsers, network shares and cloud placeholder files are unmeasured, and the Matroska cost model and exact-scan budget were tuned in Node.
- Files above 4 GiB: offsets are 64-bit safe and a 4.5 GB sparse MP4 passes an opt-in Node test, but a browser `File` that large was not tested.
- requestVideoFrameCallback needs a visible foreground tab and a playable codec: HEVC did not play in headless Chrome and ProRes does not play in Chrome.
- The corpus is synthetic (ffmpeg lavfi sources). Real recorder output (phones, OBS, screen recorders, MediaRecorder, action cameras), mkvmerge files and interlaced content are not in it.
- The references are pinned to ffprobe 8.1.1; later FFmpeg versions changed some edge cases (trun bounds, edit lists).

## Project structure

```
src/
  core/            reader, sniffing, statistics, exact rationals, options, analyze() (no DOM)
    isobmff/       MP4 and MOV parser (lazy chunk)
    matroska/      Matroska and WebM parser (lazy chunk)
  worker/          module worker entry and message protocol
  engines/         comparison engines: mp4box.js, mediabunny, requestVideoFrameCallback
  ui/              store, worker pool, result card, compare panel
  App.tsx          drop zone, toolbar, summary, result list
tests/             vitest in Node: unit/, isobmff/, matroska/, engines/
scripts/
  compare-ffprobe.ts, compare/   accuracy harness against the ffprobe references
  size-report.mjs                bundle sizes and budgets
  bench/                         headless Chrome benchmark over the DevTools Protocol
  fixtures/                      fixture generator and reference extraction
  readme-tables.ts               regenerates the tables in this README
fixtures/          fixtures, manifest.tsv, ffprobe references, known deviations
report/            generated reports
docs/              research spec, architecture, implementation notes, screenshots
public/samples/    sample files for the demo
```

[docs/architecture.md](docs/architecture.md) has the module map and data flow, [docs/research.md](docs/research.md) the formulas and tolerances, and [docs/implementation-notes.md](docs/implementation-notes.md) where the code deviates from the spec and why.

## Testing

**Fixture corpus.** Synthetic files generated with ffmpeg 8.1.1 from lavfi test sources, so there is no third-party content. `fixtures/manifest.tsv` lists each file with its expected outcome:

<!-- tables:corpus:start -->

| Category | Fixtures | Committed | Expected outcome | Covers |
|---|---:|---:|---|---|
| cfr | 20 | 20 | ok | H.264 MP4 and VP9 WebM at film, PAL, NTSC and high frame rates |
| mov | 11 | 11 | ok | MOV and MP4 with and without B-frames, edit lists (empty edit, trimmed start), faststart |
| codec | 9 | 9 | ok | HEVC (hvc1, hev1), AV1, VP8, VP9 and ProRes in MP4, MOV, WebM and Matroska |
| fmp4 | 13 | 13 | ok | fragmented MP4: empty moov, default-base-is-moof, CMAF, DASH, sidx, hybrid |
| matroska | 2 | 2 | ok | H.264 in Matroska, WebM without DefaultDuration |
| live | 5 | 5 | ok | WebM from live, pipe and MediaRecorder-like muxing: unknown sizes, no Duration or Cues, a false Duration, an audio-only tail |
| vfr | 13 | 13 | ok | VFR from concatenation, non-linear setpts, frame dropping, mpdecimate, screen recording and pulldown, also with B-frames, fragmented, in MOV, WebM and Matroska |
| box64 | 4 | 4 | ok | 64-bit mdat headers, co64 chunk offsets, an mdat with size 0 |
| multi | 4 | 4 | ok | video plus audio, two video tracks, a still image track before the video |
| cover | 3 | 3 | no-video, ok | cover art in M4A, MP4 and Matroska |
| audio | 3 | 3 | no-video | audio-only MP4, M4A and WebM |
| edge | 1 | 1 | still | a single-frame video |
| corrupt | 9 | 9 | error, ok | empty, random, text and PNG files, truncated moov, mdat or fragment, a lying stts count |
| sniff | 3 | 3 | ok | files with the wrong extension |
| long | 2 | 0 | ok | long CFR and VFR MP4 (generated, not committed) |
| sparse | 1 | 0 | ok | sparse MP4 above 4 GiB with 64-bit offsets (generated, not committed) |
| **total** | 103 | 100 |  |  |

<!-- tables:corpus:end -->

**References.** `npm run fixtures:refs` stores, per fixture, ffprobe's stream and format JSON with `-count_frames -count_packets` and the packet timestamps of each video stream. From those it derives the presented timestamps, the deltas with and without the reorder tail, duplicates, the VFR flag under the same rule as the app, and the average from timestamps.

**Tolerances** ([research 6.4](docs/research.md#64-tolerances)):

| Field | MP4 / MOV | Matroska / WebM |
|---|---|---|
| average | exact reduced rational vs `avg_frame_rate` | declared string exact; measured average vs the packet average within 1e-9 relative |
| nominal | exact vs `r_frame_rate` when CFR (stage 1), else not checked | declared string exact when DefaultDuration exists |
| frames, presented frames | exact vs `nb_frames` (fragmented: `nb_read_packets`) and `nb_read_frames` | exact vs `nb_read_packets` |
| min, max, VFR, duplicates | exact rationals and flags vs the reference timestamps | same, on 1 ms ticks |
| durations | `duration_ts`, `start_pts` exact; format duration within 1e-6 s | `format.duration` exact when Info Duration exists |
| codec, width, height | exact | exact |

**Known deviations** live in `fixtures/known-deviations/<engine>*.json`, one reason per fixture and field. An entry that no longer matches is reported as stale ([format](fixtures/known-deviations/README.md)).

**Tests.** `npm test` runs unit tests (EBML VINTs, `av_reduce`, box headers, entry bounding, statistics, cost model, lazy parser loading), fixture tests over every manifest row, regression tests from hostile-input reviews, and engine contract tests. `FPS_PROBE_LARGE=1` adds the long files and a generated 4.5 GB sparse MP4.

**CI.** [ci.yml](.github/workflows/ci.yml) runs the type check, lint, tests, the comparison against the committed references, the build and the size budgets. [pages.yml](.github/workflows/pages.yml) deploys `dist/` to GitHub Pages.

## License

[MIT](LICENSE)
