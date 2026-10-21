# Implementation notes

What the implementation decided and learned, relative to [research.md](research.md). Research stays the spec for formulas and tolerances; this file lists where the code deviates from it, why, and what was measured. Factual errors found in research are corrected in [research.md section 8](research.md#8-errata-found-during-implementation). Module layout and data flow are in [architecture.md](architecture.md).

**State.** `tsc -b` is clean, oxlint is clean, 667 vitest tests pass. The own engine has 0 mismatches against ffprobe 8.1.1 on the 100 committed fixtures (1495 checks: 1449 exact, 3 known-deviation, 43 n/a; the 3 deviations are listed in section 9). Timings below are Node 24.20, warm, best of several runs, unless a browser is named.

## 1. Reader and IO

- **Header peek is 16 bytes, not 32** (research 4.2). Skipping a `uuid` box never needs its extended type, and a unit test covers the old 16-byte uuid bug. A moof read covers `size + 16`, so the next header is already in the same window.
- **No speculative tail read.** Instead, after a final `mdat` with no `moov` seen yet, the walk reads the whole remainder when it is at most 16 MiB. Moov-at-end therefore costs 2 reads for any moov up to that size (2.68 MB on the 3 h file).
- **`readMany` defaults to concurrency 4** (research allows 4-8). It is used only where offsets are known up front: sidx or tfra moof offsets.
- **64-bit values.** Offsets are Numbers. `u64`/`i64` and the box-level `boxU64`/`boxI64` reject values above 2^53-1. In boxes the error is `unsupported: box 'x' at N holds a value above 2^53-1`. In the ISO BMFF parser any other RangeError becomes `corrupt file: ...`. `analyze()` returns every failure as `FileResult.error` and rethrows only an abort.
- **Files above 4 GiB.** Node 24.20 `openAsBlob().size` wraps modulo 2^32, so that test uses a `FileSlice` over `fs.promises.open`. It is opt-in: `FPS_PROBE_LARGE=1`, scratch dir `FPS_PROBE_SCRATCH`, and it is skipped when sparse files are unsupported. Measured on the 4.5 GB co64 file: 4,500,088,814 B logical, 2 reads, 66,712 B, about 6.7 ms. A browser `File` above 4 GiB is untested.
- **Sniffing** looks at the first 1024 bytes. Unknown content gets `not a recognised container: <reason>`, where the reason names known non-video signatures (PNG, JPEG, GIF, RIFF, Ogg, FLV, MPEG-PS, PDF, ZIP, MP3, plain text).

## 2. ISO BMFF

### Walk and limits

- **moov** is read exactly, up to 256 MiB (`MOOV_HARD_CAP`); above that the result is `unsupported: moov larger than 256 MiB`. The selective moov walk of research 4.2 was not implemented: the 3 h file (648,000 samples, moov 2.6 MB) takes 3.8 ms. When a moov claims to extend past EOF, at most 16 MiB (`MOOV_SUSPECT_CAP`) are parsed and a warning is added, as ffprobe recovers such files too.
- A second moov is ignored with a warning. A moof before moov, a moof above 64 MiB and a missing moov are errors. Garbage after moov stops the walk with a warning. The walk also stops with a warning after 4,000,000 top-level boxes; 2M tiny boxes take 1.2 s and 246 reads.
- **Entry tables** (stts, ctts, stss, trun) are bounded by their box size and an overrun is recorded. An overrun turns off ffprobe equivalence for that table, because 8.1.1 reads past the box.
- **stts** ports `max_stts_delta` (deltas above 4294487295 become 1, with the mov.c drift correction). **ctts** offsets are signed 32-bit in both versions.
- **Fragment read-ahead** follows research 4.2 (1 MiB when the next mdat is at most 64 KiB, else `clamp(2 x moof + 64, 1 KiB, 64 KiB)`).
- **Prefetch hints** come from a top-level sidx with more than one subsegment, or from mfra/tfra. Only fragments with mdat above 64 KiB use them, in batches of 8 ranges at concurrency 4. The mfra path runs only when no sidx hints exist and more than 16 fragments remain; it costs one 64 KiB tail read. Hints must never change a result:
  - mfra parsing never throws (abort excepted);
  - tfra offsets that are 0, beyond EOF or above 2^53 are skipped;
  - hints are dropped after the first window that does not start with moof, styp, sidx, ssix, emsg, prft, free, skip or uuid.

  Stale tfra offsets (+100) cost 40 reads against 35 without hints.
- **trun** with no per-sample fields claims `count` samples from 12-20 bytes. Zero-size record-less samples are capped by the bytes left in the file. One crafted file went from 33.5M frames in 2.7 s to 142 frames in 11 ms.

### ffprobe emulation

- **Two averages.** `avgFps` is the full-file truth. `avgFpsFfprobe` emulates the 8.1.1 header phase and is what the compare script checks.
- **Header extent** is research 2.1 plus these conditions. A sidx counts as complete only when it is non-hierarchical, has `first_offset` 0, references an existing track and ends at EOF or at EOF minus the mfra size (the last 4 bytes are read only when needed). A sidx cut by EOF is ignored. A truncated sidx header is an error, as in ffprobe.
- **`ffprobeReject`.** 8.1.1 resets `found_tfhd` per moof, not per traf, so a missing trex, `tfhd` track_ID 0 or an unknown track makes it fail with `error reading header`, and a traf without trex after a valid one is read as another track. When the offending moof lies inside the ffprobe extent, every track gets `avgFpsFfprobe` and `rFpsFfprobe` null plus a file warning. The truth values are kept. Outside the ffprobe extent a missing trex only adds `no trex: sample defaults taken from tfhd`.
- **`avgFpsFfprobe` is null** (never `0/0`) when N or D is 0 (ffprobe fills the value from packets), when stts or a visible trun overran its box, or on `ffprobeReject`. The UI shows the ffprobe string only when it is not null.
- **`rFpsFfprobe` is stage 1 only** and a port of `mov_merge_tts_data` and `mov_fix_index` (n8.1.1):
  - Without ctts, the kept durations are `stts[0..retained)`, continuing across edits, because `tts_index_old` is not repositioned. With ctts they start at the found index.
  - The rate is constant when every kept duration except the last equals the first.
  - It is null when the edit list has no media edit, for pure fragmented files, when a table overran its box, for a rejected file and for a broken track. A uniform stts plus at least one media edit gives that delta.
  - Work is lazy and bounded: run-length tables, an stss key list and binary searches, with a 2,000,000-step limit (or `maxExpandedSamples` if lower) when ctts forces a keyframe walk. At the limit it returns null with `r_frame_rate not reproduced: edit list walk limit reached`.
  - Why: the first version collected durations into arrays. A 12.6 KB file with 1000 elst entries and a VFR stts took 249 MB of heap and died with a fatal OOM at a 256 MB limit. Now it takes 12 ms with no RSS growth; 10,000 edits over 100,000 samples take 26 ms; a 599-byte file with 10M samples takes 9 ms; ctts with 20,000 edits over 1M samples takes 101 ms and reports not reproduced.
  - A sweep of 27 edit windows over each of three VFR fixtures (81 cases): 0 mismatches against ffprobe, 4 agreements, the rest null.

### Tracks and timing

- **Which traks are video.** Handler `vide` in `mdia/hdlr`, or any non-`soun` handler whose sample entry (the original format for encv/sinf) is a known video fourcc. Chapter-referenced traks (`tref chap`) are never video. **`auxv` is kept as video**: ffprobe 8.1.1 lists it and counts it in format duration. It gets a warning and a lower primary score.
- **Primary track score:** enabled with more than 1 sample = 2, disabled with more than 1 sample = 1, `auxv` = 0.5, still = 0; higher wins, then more frames, then file order. The last step gives `expect=still` files a primary whose `isStill` is true. Stills keep the ffprobe-equal `avgFps`, `avgFpsFfprobe` and `rFpsFfprobe`; min, max and VFR are null.
- **Duplicate track_IDs.** The first track keeps its id (as ffmpeg's fragment mapping does); later ones are reported as max id + 1, +2, ... with track and file warnings. Without this `primaryTrack()` resolved to the wrong track.
- **Broken tracks** (ffmpeg `sanity_checks`: chunks without stts/stsc/sizes, or sample count without chunks) stay in `videoTracks` because ffprobe lists them. They get null duration and start, `presentedFrames` 0 and no stats; in format duration they add only their mdhd duration at 1/90000.
- **elst.** The declared count is trusted only if it fills the box exactly, otherwise `box size / entry size` is used. A later non-empty elst replaces the earlier one (`duplicated elst: the last one is used`). Presented frames follow the first non-empty edit only, with a warning when more exist. For fragmented tracks the media_time start is applied and the end is not, because ffmpeg never discards fragment samples by edit list. The window is dropped when it provably covers every sample (no ctts, no fragments), a speed shortcut.
- **Format duration** is a port of `update_stream_timings` over audio and video in integer microseconds; text and data tracks count when they extend it by less than 1 s.
- **`frames`.** Non-fragmented: the stts sum (`nb_frames`), capped at the stsz count with a warning when they disagree. Fragmented: moov samples plus present trun samples. `presentedFrames` is the timeline count inside the edit window.
- **Codecs.** About 40 common fourccs from `isom_tags.c`; the esds object type remaps `mp4v` (mpeg4 or mjpeg); `dvh1` with hvcC is handled; anything else is `unknown`. The AVI bmp-tag fallback is not ported.
- **Rotation** is tkhd x mvhd, `-atan2` truncated like ffprobe's `print_int`. It matched ffprobe in 27 of 27 matrix combinations.

### Truncated files

- Non-fragmented: `frames` stays the stts sum, but `presentedFrames` and the statistics use only complete samples, counted from stsc/stco/co64/stsz/stz2 (53 of 90, the ffprobe value). Average and duration stay header based, as in ffprobe. Only then are the chunk and size tables walked.
- Fragmented: `frames` counts samples whose data starts before EOF (73, equal to `nb_read_packets`); presented counts complete samples (72, equal to `nb_read_frames`).
- The build phase after the walk runs inside the same error handler as the walk, so any out-of-bounds read becomes a `corrupt file: ...` result.

## 3. Matroska

- **Primary track** is the first TrackType 1 entry. `trackId` is the TrackNumber. Audio-only files return `error: null`, no tracks and the warning `no video track`.
- **Modes.** `header` reads only the head window and Stage A; `probe` adds sampled blocks; `exact` walks every block; `auto` picks exact or probe from a cost prediction. `scan` records the depth reached.
- **Header (Stage A).** Budget is 5 reads and 1 MiB, checked against bytes already fetched plus the next read, including the Segment search. It follows SeekHead (and a chained one) for Info, Tracks and Tags.
  - Resync: only level-1 IDs, Void and CRC-32 are accepted. Anything else triggers a search from just after the last good element. An element that claims to end beyond EOF is parsed as far as it goes. A damaged Segment ID falls back to the first valid level-1 element. A Segment size above 2^53 or too small is read to EOF with a warning. Cluster discovery falls back to up to 4 Cues positions.
  - A Tracks element above the cap is read entry by entry, skipping children above 64 KiB such as CodecPrivate.
  - `parseMaster` has an allowed-children table per parent and a nesting limit of 16 (ffmpeg's `EBML_MAX_DEPTH`). Before this, 3000 nested SimpleTags overflowed the stack. A TrackEntry outside Tracks is ignored.
  - Tags: Targets and DURATION are collected per Tag and matched after the Tag is read, so element order does not matter. Only a SimpleTag directly under a Tag counts. The UID is a BigInt.
  - A Video FrameRate substitutes a missing DefaultDuration, with a warning.
- **Timestamps** follow ffmpeg: ticks are `cluster / TrackTimestampScale + relative - CodecDelay` in the track time base `trunc(TimestampScale x TrackTimestampScale) / 1e9` (this corrects research 2.2). Blocks before time 0 have no PTS in ffmpeg; the scan fills them from the neighbouring frames the way libavformat does and counts them. Codecs with B-frames may differ there.
- **Durations.** BlockDuration, else `DefaultDuration x laces / TimestampScale` with integer division, else the median delta (research 4.5). The last-frame rule is the one known deviation (section 9).
- **Exact scan recovery** is a port of how ffmpeg 8.1.1 recovers, which the first version lacked (one flipped bit gave 6 frames instead of 235):
  - it remembers the last good element, and after any error searches again from just after it, backwards if needed;
  - children are checked against their parent's end, so a block that overruns its Cluster drops the rest of that Cluster;
  - Cluster and BlockGroup have fixed allowed-children lists, and unknown IDs are skipped by size without counting as good;
  - after any error the Segment is treated as unknown-size, so data past its declared end is read;
  - `truncated` is reported only when the error was running into EOF and nothing valid follows;
  - it is stricter than ffmpeg in one place: a Cluster found by resync must have a Timestamp child, and other level-1 elements must fit in the file and start with a valid first child;
  - resync warnings are capped at 5, then one `N more` line.
- **Block validation** as in ffmpeg: the track number must exist in Tracks, at least 3 bytes must follow it, fixed, Xiph and EBML lacing are validated (EBML lace sizes with BigInt), a Timestamp, BlockDuration, ReferenceBlock or DiscardPadding above 8 bytes is invalid, and so is a block above 256 MiB.
- **Concatenated files.** A second Segment, or data after a known-size Segment, is counted like ffprobe does, with a warning (a file concatenated with itself: 180 frames).
- **Duration values.** An Info Duration of 0, or of 0 bytes, means absent (N/A). A negative Duration is kept (ffprobe prints -5.000000). NaN or Infinity gives `invalid Duration value`. A false Info Duration is kept in `formatDurationSec` exactly like ffprobe (10.0 for a 3.0 s pipe recording) and the scan reports the real span with a warning.
- **Cost model for `auto`.**
  - The block density of all tracks is sampled from up to 16 KiB at the first Cluster. The first version divided all bytes by video frames only, so interleaved audio inflated the frame size and a slideshow with Opus ran exact with 1429 reads (about 1155 ms) against 8 reads (20.9 ms) now.
  - Both plans are computed with the research cost formula and the cheaper wins: 4 KiB windows (reads = large blocks + small bytes / 4 KiB) or 1 MiB windows. Under the default model 4 KiB wins only above about 290 KB per frame, not at 32 KiB as research 4.5 says.
  - A CPU term was added: `perBlockMs` 0.0002 in `CostModel` (measured about 0.18 us per block in Node). Without it a 648,000-block file was predicted at 40.9 ms and took 116-170 ms; now it is predicted at 172 ms and runs probe. It needs browser tuning.
  - Exact runs when the prediction is at most `exactBudgetMs` (150 ms). If 4 KiB windows need more than `2 x planned + 16` reads the scan switches to 1 MiB windows. A false small Duration can only raise the block estimate, never shrink it (the earlier plan trusted a 1 ms Duration and ran exact with 3449 reads).
- **Probe** samples 8 clusters x 32 video blocks (from Cues, always including the first cluster, or by validated sync search) and merges per-run deltas with the shared VFR rule. A tail scan reads 256 KiB growing x4 up to 16 MiB and steps back to the last video block. Probe output is `sampled` and never contains an average or a frame count. A frame estimate appears only as a warning (`assumes CFR`).
- **Provenance.** `frames` and `presentedFrames` are `computed` after an exact scan. The exact average is `frames / span` (an exact rational through `avgFrameRate` when some frames have no PTS). `nominalFps` is `declared` when DefaultDuration exists, else the timeline's exact or snapped rate after a scan. Header mode leaves min, max and VFR null.
- Image attachments are counted in a warning, never listed as tracks.

## 4. Statistics and VFR

`src/core/stats.ts` follows research 4.3. Deviations and details:

- **Tail exclusion.** The last `1 + reorderDepth` deltas are dropped, but all deltas are kept when fewer than 2 would remain. On very short tracks the reference data (`ref-extract.mjs`) drops `min(positive deltas, 1 + reorderDepth)` and reports no min or max; no fixture hits the difference.
- **Median** is the lower median by cumulative count. VFR is any remaining delta farther than `max(1 tick, round(0.5% x median))`. `dominantFps` is set only for VFR tracks where the most common delta covers at least 50%.
- **Nominal rate.** One distinct delta gives an exact rate. A CFR track with two or more distinct deltas snaps the average to {24, 30, 48, 60, 120, 240} x 1000/1001 or an integer 1..240 within 0.1%. `timestampsQuantized` marks CFR with quantized ticks (Matroska 1 ms).
- **Fast path.** With constant ctts, no discontinuities and no negative durations, stats are computed from stts runs in O(runs). Otherwise a `Float64Array` of PTS is built, refused above 50M samples (`per-sample analysis skipped`).
- **PTS input** (Matroska) takes `lastDuration`; reorder depth comes from the `ctsRange` or, when absent, from the largest PTS lag.
- **Cost.** On the 1 h VFR file (124,761 stts runs) stats dominate the 21 ms total because the run generator is walked 2-4 times; plain index loops should roughly halve it. This is a performance note, not a correctness issue.
- `avgFrameRate(ts, N, D)` uses BigInt and a port of `av_reduce` (`807689923/26949920` and `19001/317` are unit tests).

## 5. Comparison engines

All engines return `FileResult` and fill the shared fields from `analyzeTimeline`, so mp4box and mediabunny are measured as parsers, not as timelines. They import only `core/{types,reader,rational,result,sniff,stats,options}`, never `analyze.ts` or `core/index.ts`, so no own parser is bundled with them. Native library values go into track warnings (`mp4box native: ...`, `mediabunny native: ...`) and into `result.mp4box` / `result.mediabunny`.

### mp4box 2.4.1

- **Feeding.** A `BlobReader` over a `CountingBlob` walks the top level and feeds ftyp, moov, sidx and other boxes whole, each mdat as a 16-byte header only (mp4box needs a contiguous stream to jump over it), and each moof plus the next mdat header. It stops after moov when there is no mvex. A naive append loop reads 100% of the file. Cost: 1 read (faststart) or 2 reads, fragmented 2-3 reads (96-131 KB), the 3 h file 3 reads and 2.68 MB in 214-313 ms.
- `Log.error` is replaced once (a global side effect) because mp4box prints with `console.error` and has no switch; messages become `mp4box log: ...` warnings.
- **Native pitfalls**, recorded per track:
  - the last sample duration is overridden to `mdhd.duration - last dts` (fires on 2 of 65 tracks; last 3003 vs stts 1001, 29.32 fps against 29.97 true);
  - fps from sample durations is off by more than 1e-6 on 4 tracks, from mdhd duration on 3, from movie duration on 10 (hybrid fragmented: 119.88 vs 29.97);
  - the ProRes sample entry is not parsed (dimensions fall back to tkhd);
  - a corrupt stts count raises a RangeError, turned into an error result.
- Matroska input returns the error `unsupported by mp4box` after one read.

### mediabunny 1.62.0

- **Source.** `CustomSource` (the `StreamSource` alias is deprecated) with `prefetchProfile: 'fileSystem'` like `BlobSource`, over `CountingBlob`. Formats are MP4, QTFF, WEBM and MATROSKA only. `Logging.level` is set to Silent (global) and log lines become `mediabunny log: ...` warnings.
- **Packet walk.** `sink.packets()` (also used inside `computePacketStats`) stalls about 90 s once a metadata-only walk passes roughly 500k packets (profiled to `timestamps.shift()` on a huge array in `media-sink.js`). The engine walks with `getFirstPacket`/`getNextPacket` (648,000 packets in 0.75 s) and calls the real `computePacketStats()` only for tracks up to 150,000 packets. Above that it applies the same formula to its own pass and says so in a warning.
- **Fields.** `avgFps` and `avgFpsFfprobe` hold the native `averagePacketRate` turned into a rational by a continued fraction, so CFR gives exact rationals while 1 ms WebM stays visibly off. Min, max, VFR, duplicates and frames come from `analyzeTimeline` in PTS mode on tick-rounded timestamps. The native stats pass is excluded from `io` and reported as `nativeStatsMs`. `brand` is null. The rotation sign mapping is untested (no rotated fixture).
- **Library gaps** found: `vp9_unknown_clusters.webm` yields 0 packets silently; edit-list start trim is ignored (`mp4_elst_trim_start` presented 90 vs 69); hybrid fMP4 sees only moov samples (30 vs 120); a truncated fragment gives 90 vs 73; a truncated no-moov file exposes zero tracks without an error (the engine adds a warning); mp4v and mjpeg both read as mpeg4. Cost: 1 read on small files; whole clusters for Matroska; 3 h file 3 reads, 2.87 MB, 749-872 ms.

### Informational deviation tally (never failing)

| Engine | Fixtures | Checks | exact | known-deviation | mismatch | n/a |
|---|---:|---:|---:|---:|---:|---:|
| mp4box | 100 | 1131 | 1017 | 2 | 97 (45 fixtures) | 15 |
| mediabunny | 100 | 1495 | 1343 | 2 | 109 (50 fixtures) | 41 |

mp4box is exact on min, max, VFR, duplicates and dimensions for all 65 MP4/MOV tracks it parses; its mismatches come from the 35 files it cannot parse (27 Matroska, 7 corrupt, 1 empty), fragmented under-reads and truncated files. mediabunny `avgFps` is exact on 65 of 91 tracks, within tolerance on 19 (all 1 ms WebM/Matroska) and off on 7.

### rVFC (main thread, Chrome 155 only)

- **Contract.** `estimateWithRvfc(file, { host, signal, onProgress })`. The host element must be attached, visible and in a foreground tab, or no frames are presented; a hidden tab gives an error instead of a hang (1.5 s refresh probe, 6 s guard per pass, 8 s metadata timeout). `container` is always `unknown`, `io` is `{0, 0, ms}`, every value is `estimated` and the first warning is `approximate: estimated by playback`. The object URL and element are always released.
- **Passes.** Pass 1 runs at rate 1. Later passes continue playback with `currentTime = 0` and a halved `playbackRate`, without waiting for `seeked`. The first 3 callbacks are skipped, and only pairs whose `presentedFrames` advanced by exactly 1 count. A pass is accepted when `fps x rate <= 0.51 x refresh` and it is the first pass, shows variable intervals, or agrees with the previous pass within 0.3%. At most 5 passes, so 240 fps needs 5 passes (9.3 s on the 33 Hz default headless display).
- **Estimates.** `fps` is the median of the deltas in and next to the most common log-scale bin; `avg` is presented frames over media time. `spread` is the share of deltas more than `max(5%, 1.2 ms)` from the typical one, and above 2% the clip is flagged `vfr`. Snapping uses 24/25/30/48/50/60/100/120/144/240 plus the x1000/1001 variants of multiples of 6, tried on the typical delta, then on the average.
- **Confidence.** Flags are `few-samples` (under 20 pairs), `passes-differ`, `display-limited`, `vfr`, `estimates-differ` and `non-standard`. Zero flags is high, one is medium, two or more low.
- **Measured** (throwaway headless profile): H.264 CFR at 23.976, 25, 29.97, 30, 60, 120 and 240 fps all snapped to the exact ffprobe rate. At 60 Hz, 30 fps took 1.87 s in one pass, 60 fps 3.4 s, 120 fps 4.9 s. WebM 1 ms timestamps cannot separate 29.97 from 30, so 30 fps content came out as 30000/1001 on the 33 Hz regime (30/1 at 60 Hz) with `estimates-differ` and medium confidence. VFR files were flagged `vfr`, `passes-differ`, `estimates-differ` with low confidence. HEVC in headless Chrome, ProRes, audio-only and garbage give clear errors. Node tests use a simulated display and fake timers (single pass, NTSC snapping, aliasing with adaptive halving, confirming pass, quantized timestamps, VFR early stop, short clip, restart of a short clip, unplayable codec, hidden tab, missing API, abort).

## 6. UI and worker

- **Protocol** (`src/worker/protocol.ts`): requests `analyze {id, file, engine, options}` and `cancel {id}`; responses `progress`, `result`, `error {message, aborted}`. `engine` is `own | mp4box | mediabunny`; rVFC never goes through the worker. Options exclude `signal` and `onProgress`; the worker creates an `AbortController` per job id and throttles progress to one message per 50 ms. The `File` travels by structured clone, with no byte copy.
- **Pool** (`workerPool.ts`): up to 2 module workers, spawned lazily, FIFO queue. Cancel removes a queued job, or posts `cancel` and rejects with `AbortError` at once; a worker that is still busy 1.5 s later is terminated and replaced. A worker crash rejects the job and respawns.
- **Store** (`store.ts`): an external store read with `useSyncExternalStore`. The Matroska mode (default `auto`) applies to files added later and re-runs finished Matroska rows. "Scan all frames" is a rescan in exact mode. A cancelled first analysis leaves `Cancelled`; a cancelled rescan keeps the previous result.
- **Compare panel** is a lazy chunk. Opening it auto-runs mp4box (MP4/MOV only) and mediabunny; rVFC runs only on an explicit click (`Run (approximate)`), in the panel's host element or in a temporary fixed visible div on `body`. Closing the panel during an rVFC run detaches its host and is not handled.
- **Download JSON** exports the own results, plus a `compare` object keyed by engine for rows with finished comparison runs.
- **Hooks for benchmarks.** `window.__fpsProbe` has `results` (finished rows in display order), `pending` and `runEngine(index, engine)`. DOM hooks: `input[data-testid="file-input"]` (multiple, focusable), `article.card`, `.summary` (`role=status`), `details.cmp`, `.rvfc-host`.
- **Samples.** `public/samples/` holds 6 files (741,065 B) fetched into in-memory `File` objects, so their reads never touch the disk and timings are optimistic; the UI says so.
- **Layout.** Light and dark through CSS variables, a 2-column card grid at 480 px and below, no horizontal scroll at 360 px.
- **Verified in headless Chrome 155** (own profile, driven over CDP): 100 fixtures dropped at once gave 100 results in drop order in 0.2-0.4 s wall with the pool of 2 and zero console errors; header mode shows "Scan all frames" on Matroska cards and the click upgrades them to `exact`; all 6 samples run through own, mp4box and mediabunny; no overflow at 360 px with the compare table open. The real rVFC engine was verified separately (section 5); a full visible-tab GPU run is not covered.
- **Bundle.** The first build, with both parsers inside the worker entry, measured main 73.67 KB gzip (limit 75), worker 23.93 KB (limit 12) and initial total 99.24 KB (limit 85); lazy mp4box 43.59 KB, mediabunny 52.46 KB, Compare 1.19 KB, shared counting 1.48 KB. The research prototypes were 5.5 KB (MP4) and 4.9 KB (EBML); the complete parsers are about twice that. Loading each parser as its own chunk on first use moves them out of the worker entry (architecture.md, Lazy chunks), and the budgets are now per chunk in `BUDGETS` of `scripts/size-report.mjs`. `npm run build && npm run size` gives the current numbers. The rVFC engine is 2,136 B gzip alone, of which about 270 B are core result builders that disappear when `core/result.ts` is shared with another chunk.

## 7. Compare rules and harness

- **Known deviations** are per engine files, `fixtures/known-deviations/<engine>*.json`, merged for `own` (`own-isobmff.json`, `own-matroska.json`); the format is in `fixtures/known-deviations/README.md`. They replace the single `fixtures/known-deviations.json` of research 6.3. An entry applies only to a would-be mismatch, and an unused one is reported as stale.
- **Built-in sidx rule.** The `avgFps` check is `known-deviation` (source `[built-in]`) when the app differs from ffprobe, equals the reference `avgFromPts` within 1e-9 relative, and the file is fragmented with a sidx (found by an independent top-level scan, not by the app). A file entry for the same fixture and field overrides the reason.
- **Primary track** for MP4/MOV uses ffprobe `disposition.default` as the tkhd enabled flag; Matroska uses the first video stream.
- **Matroska `avgFps`** is two checks: `declared` (`avgFpsFfprobe` vs `avg_frame_rate`) and `measured` (only after an exact scan, vs `avgFromPts`, within 1e-9). A file with no declared rate is `n/a` only when the manifest notes say DefaultDuration is absent, so a parser that silently loses DefaultDuration is still caught.
- Matroska `frames`, `presentedFrames`, `startSec` and measured `avgFps` apply only after an exact scan; estimated or sampled counts are `n/a`.
- **Hybrid fragmented** files: `frames` is the total packet count when `nb_frames` is smaller. The moov-only count is not checked because `FileResult` has no field for it. When `nb_frames` is larger (truncated mdat), `frames` equals `nb_frames`.
- **Outcome rule** for `error`: `expect=ok` needs no error, at least one track and a primary; `no-video` needs zero tracks and no error other than "no video"; `still` needs only single-sample tracks; `error` needs an error and zero tracks.
- Per-track checks run for every video track, one table row each (`name (track N)`), primary first.
- **Library engines** are loaded by the single `analyze*` export of `src/engines/<name>.ts`; large fixtures run once for them, and `--with-large` adds the 3 h and 1 h files. mp4box and mediabunny are exact on the 3 h CFR file (648,000 frames); both report 3600.001 s against 3600.000 s format duration for the 1 h VFR file.
- Exit codes: 0 ok, 1 an unexpected own mismatch or throw, 2 harness error. `--filter` writes `report/accuracy.local.*`, which is git-ignored. `--self-test` runs 142 checks, including an oracle round trip that builds a synthetic app result from each of 102 ffprobe references and requires zero mismatches.
- **Size report.** `scripts/size-report.mjs [dist] [--check]` finds the worker through the `Worker()` reference or the manifest, classifies the chunks, checks the limits in its `BUDGETS` table and reports the remaining lazy chunks without a limit.
- **Header-mode caveat.** With `--mkv-mode header`, min, max and VFR are null by design; they must be rated `n/a` rather than compared (78 false mismatches otherwise).

## 8. Hostile-input verification

All runs used synthetic or mutated copies of fixtures, with ffprobe 8.1.1 as the oracle where it opens the file. In every run: 0 uncaught throws and 0 hangs. ISO BMFF error strings all carry one of the prefixes `incomplete file`, `corrupt file`, `unsupported` or `not a recognised container`; Matroska truncation gives clean errors or truncation warnings.

| Area | Runs | Outcome |
|---|---|---|
| ISO BMFF fuzz (truncation at every box boundary and every moov byte, sizes 0/1/7/8/16/+-1/half/0xFFFFFFFF, largesize 0/7/2^53/2^64-1, payload bytes 0x00/0xFF/0x80) over 5 fixtures | 42,659 | 0 bad, max 52 ms, at most 5 reads |
| ISO BMFF truncated and byte-flipped variants of every ISO fixture | 4,140 | 0 throws, max 6 ms |
| ISO BMFF verifier findings (edit-list DoS, crafted trun, mfra 2^54, stale tfra, tiny-header amplification and others) | 13 | all reproduced against ffprobe, all fixed, regression tests added |
| Matroska truncation sweep (every element boundary, 5 files) | 37,316 | frame counts never decrease as the cut moves later; 24 of 24 sampled cuts equal ffprobe |
| Matroska mutation fuzz | 3,360 | max 6.6 ms, about 1 read per 64 KiB |
| Matroska random mutations (insert, overwrite, delete) over 18 fixtures vs ffprobe | 560 | frame counts 560 of 560 equal; averages differ only on `vfr_concat_10_30_60.webm` |
| Matroska header bit flips vs ffprobe | 385 | 334 matched, 46 broke ffprobe too, 5 differed and were fixed |
| Matroska block-size bit flips vs ffprobe | 18 | 18 of 18 frame counts equal |
| Matroska random EBML blobs and mutated `vp9.webm` (builder fuzz) | 300 + 600 | none |
| Matroska read-window independence (13 B, 128 B, 4 KiB, 256 KiB) | 4 window sizes | identical results |
| Matroska nesting depth | 1000 to 10000 | no error |

Two verifier passes returned FAIL on first review (13 ISO and 11 Matroska findings, one high each: an edit-list heap exhaustion and an exact scan that stopped at the first corrupt size). Every finding was reproduced, fixed and re-checked. Regression tests: 12 in the `adversarial review regressions` block of `tests/isobmff/unit.test.ts`, and `tests/matroska/robustness.test.ts` (33 tests whose frame counts equal ffprobe `nb_read_packets`).

## 9. Known differences from ffprobe outside the fixture set

Deviations that the 100 fixtures exercise (3 accepted):
- `frag_vfr_global_sidx.mp4`, `frag_vfr_dash.mp4`: ffprobe under-reads fragments; the app reports 4200/149 and still reproduces 60/1 and 30/1 in `avgFpsFfprobe`.
- `vfr_concat_10_30_60.webm`: no DefaultDuration, so ffprobe fills the last packet duration from its estimated 30/1 and gets 3125/94; the app uses the median delta and gets 100/3.

Not covered by fixtures, known or suspected:
- **ISO BMFF.**
  - Several edits: presented frames use the first non-empty edit only.
  - `stts` sum smaller than the `stsz` count: ffprobe presents 90, the app 50.
  - Files ffprobe rejects but the app reads: huge ctts count, `sidx` with zero references, `stsc` whose last first_chunk exceeds the chunk count. `avgFpsFfprobe` is still filled there.
  - `rFpsFfprobe` is null where ffprobe prints `1/0` (all deltas 0) and wherever ffprobe's stages 2-4 decide.
  - Exotic fourccs read as `unknown`; width and height come from stsd, not the SPS; `cmov` and moov above 256 MiB are unsupported; only the first stsd entry is used.
  - 8.1.3 and later reject a trun whose sample count exceeds its payload (the app bounds it and warns), and master changed edit-list handling on 2026-10-12.
  - Real recorder output (iPhone, Android, OBS, GoPro) and interlaced content were never tested.
- **Matroska.**
  - Laced blocks with no duration and no DefaultDuration: ffprobe average 75, app 37.5 (same last-frame class).
  - Damage to the EBML header: the app still produces a result, ffprobe fails (35 flips).
  - A zero Tracks or TrackEntry size: ffprobe reports no video plus a format duration, the app returns "no Tracks".
  - `TrackTimestampScale` 1e9: ffprobe rejects, the app reports an average near 0.
  - Blocks before time 0 on codecs with B-frames; lace checks run on every track, not tested with `-select_streams`.
  - Without DefaultDuration the ffprobe rate estimate is not reproduced.
  - At 1 ms ticks, VFR between rates whose periods differ by under about 1 ms is invisible.
  - mkvmerge output was not tested.
- **Browser.** All IO and cost numbers are Node. The 150 ms exact-scan budget, the 4 KiB versus 1 MiB window choice, the fragment coalescing gap and the 16 MiB moov threshold need tuning with Chrome costs (0.65-0.85 ms per read). Firefox and Safari were not measured. rVFC was measured in Chrome 155 only.

## 10. Open items

- `fixtures/README.md` still describes the placeholder `fixtures/known-deviations.json`.
- A single stats pass over run-length tables would remove most of the 20 ms on the 1 h VFR file.
- The mediabunny `packets()` stall is worth reporting upstream.
