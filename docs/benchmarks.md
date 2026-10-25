# Benchmarks, accuracy and method

The measurements behind the [README](../README.md): accuracy against ffprobe, speed, package and demo sizes, the cost of embedding, how the parsers work and what they do not cover. Every block between `<!-- tables:<name>:start -->` and `<!-- tables:<name>:end -->` markers is generated from the reports in [report/](../report/README.md) by `node scripts/readme-tables.ts`, and CI fails when a block differs from the committed reports (`--check`).

## At a glance

<!-- tables:headline:start -->

- **Accuracy.** The own parsers were checked against ffprobe 8.1.1 on 131 fixtures, 119 made with ffmpeg and 12 MediaRecorder recordings from headless Chromium (126 committed, 5 large local files; phone, camera, screen recorder, Firefox and Safari output is not in the corpus, see Limitations): 2087 field checks, 2003 exact, 13 within tolerance (9 of them a definition difference by design: the measured average of a Matroska file that stores no duration for its last frame, which avgFps gives the median interval and ffprobe its own estimate), 0 known deviations with a recorded reason, 0 mismatches, 71 not applicable.
- **Reads.** Median 1 read per committed fixture, at most 1. The 3 h, 648000-frame MP4 (12.42 MiB) takes 2 reads and 2.56 MiB (20.6% of the file).
- **Speed.** In Chrome headless shell 156, warm: median 0.80 ms per file in the worker and 1.40 ms from file pick to rendered result; the 3 h file takes 3.50 ms. A 604.42 MB 1080p MP4 with the moov at the end takes 2 reads (75.0 KiB) and 1.40 ms; the same stream in Matroska takes 110 ms in auto mode (126 reads; a probe, so no frame count until "Scan all frames"). Measured on an earlier build, so these figures are not current ([Speed](#speed)).
- **Size.** A default install (`video-fps-probe/lazy`) adds 0.66 KB gzip to a host app's critical path. Its first MP4 file loads 23.60 KB lazily when the host's Vite config sets `worker: { format: 'es' }`, and 38.75 KB with Vite's default worker format, 'iife', which builds the own worker as one file ([Package size](#package-size)). The demo page plus its first MP4 result loads 100.06 KB gzip (page, probe client, worker entry, shared statistics chunk, ISO BMFF parser); the first Matroska result 99.39 KB, or 102.90 KB for a file without DefaultDuration, such as a MediaRecorder recording, which also loads the ffprobe frame rate estimate.
- **Embedding.** In a host app with a 1.95 MB gzip initial load, prewarming the worker when the upload dialog opens makes the first result on fast 4G take 4.10 ms instead of 347 ms ([Embedding in an existing app](#embedding-in-an-existing-app)). Measured on an earlier build whose worker entry and parser chunks differ from the current ones, so these figures are not current.
- **Same result in Node and Chrome.** 116 of 116 files give identical results field by field (timing excluded).
- **Machine.** Windows 10 Pro, Intel Core i7-10700KF (16 threads), 32 GiB, Node v24.20.0, Chrome headless shell 156; ffprobe 8.1.1-full_build-www.gyan.dev.

The accuracy figures (131 fixtures, 2087 checks) and the large-file rows come from runs with `--with-large`, so they include 5 local large files that are not committed (2 long files, 3 1080p files of 604 MB). The Node and Chrome identity count (116 of 116) is from the last browser bench, which ran before 15 of the committed fixtures were added. On the 126 committed fixtures alone, `npm run compare -- --no-write` (without the flag it overwrites `report/accuracy.*`) reproduces the own engine at 2002 checks: 1924 exact, 13 within tolerance (9 of them a definition difference by design: the measured average of a Matroska file that stores no duration for its last frame, which avgFps gives the median interval and ffprobe its own estimate), 0 known deviations, 0 mismatches and 65 not applicable.

<!-- tables:headline:end -->

## Accuracy vs ffprobe

Every fixture has an ffprobe 8.1.1 reference in `fixtures/ref/`. `npm run compare` checks the outcome, track selection, average, nominal rate, frames, presented frames, track and format duration, start, min, max, VFR flag, duplicates, codec and dimensions of every video track against it. Each check gets a verdict: exact, within-tol, known-deviation (differs for a recorded reason), mismatch or n/a. Only the own engine gates the run.

The libraries run in five informational arms, so that a difference is not charged to a library when it comes from this package's adapter or from a different definition. The idiomatic arms use each library the way its documentation shows and report only the library's own fields; mediabunny's full arm scans every packet; the tuned arms are this package's adapters in `src/engines`, which run part of this package's code (the timeline statistics) and are the engines of the demo's Compare panel. Every mismatch of every arm gets one outcome:

- **wrong**: a value that differs from ffprobe, and neither the arm's own definition nor another checked one explains it;
- **definition differs**: the value follows the definition that the library documents or implements for the field, evaluated on the file and its reference. Each arm is checked only against its own definitions: for mediabunny, a float instead of the exact rational, `computeFrameRateMetrics()` replayed on the reference timestamps (its probe window, its deduplicated timestamps and the underlying rate it infers, whose whole frames it counts), `computeDuration()` as the end timestamp of the last packet (its timestamp alone when a Matroska file stores no duration for it, neither a DefaultDuration nor a BlockDuration, because mediabunny then gives it none), `getFirstTimestamp()` below zero under an edit list; for mp4box.js, the media and movie header durations of `getInfo()` and its moov sample count; for the tuned adapters, what the adapter code computes (the largest track end, `averagePacketRate` as frames over the presentation span, which ends at the last timestamp in that Matroska case and at the stored duration of the last sample in MP4, mediabunny's `getDurationFromMetadata()` as the largest first timestamp plus media header duration of any track); for every arm, a failure where ffprobe fails too;
- **unverified**: neither wrong nor a definition difference. Either the arm's own definition cannot be evaluated on the file (the long files' references keep no per-frame timestamps, an edit list discards packets that mediabunny reads, an audio track can end later than the video), or the value equals another quantity that the arm does not use for the field, such as the movie header duration from mediabunny, so the cause is not verified;
- **not provided**: the arm returns no value for the field, or the field is not part of its recipe (mp4box.js returns no frame rate by design, and mediabunny's default recipe no frame count; the full scan's `probedPacketCount` counts as one);
- **unsupported container**: the library does not read the container (mp4box.js and WebM or Matroska).

<!-- tables:engines:start -->

| Arm | Library | Role | Fixtures | Checks | exact | within-tol | known deviation | wrong | definition differs | unverified | not provided | unsupported container | n/a |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| own parsers | this package | gating | 131 | 2087 | 2003 | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| mp4box.js, idiomatic | mp4box.js 2.4.1 | informational | 131 | 1527 | 720 | 0 | 0 | 4 | 36 | 4 | 540 | 110 | 113 |
| mp4box.js, tuned adapter | mp4box.js 2.4.1 | informational | 131 | 1541 | 1369 | 4 | 2 | 9 | 18 | 0 | 0 | 110 | 29 |
| mediabunny, idiomatic | mediabunny 1.62.1 | informational | 131 | 2059 | 1440 | 0 | 0 | 13 | 111 | 5 | 214 | 0 | 276 |
| mediabunny, full scan | mediabunny 1.62.1 | informational | 131 | 2059 | 1632 | 0 | 0 | 13 | 156 | 5 | 173 | 0 | 80 |
| mediabunny, tuned adapter | mediabunny 1.62.1 | informational | 131 | 2087 | 1844 | 10 | 2 | 16 | 88 | 3 | 56 | 0 | 68 |

- **own parsers**: analyze() of src/core, the engine this package ships.
- **mp4box.js, idiomatic**: README recipe: createFile(), appendBuffer() of 1 MiB chunks at the offset it asks for until onReady, then its info fields (codec, video width and height, nb_samples, track and movie duration over timescale); no frame rate, by design.
- **mp4box.js, tuned adapter**: this package's adapter (video-fps-probe/engines/mp4box): boxes fed one by one, rates from the stts and ctts tables through this package's timeline statistics.
- **mediabunny, idiomatic**: the README metadata recipe (Input + BlobSource, input.computeDuration(), getPrimaryVideoTrack()), then the track computeDuration() and computeFrameRateMetrics() with its defaults (256 packets); mediabunny fields only.
- **mediabunny, full scan**: the idiomatic recipe with computeFrameRateMetrics({ targetPacketCount: Infinity }), its probedPacketCount as the frame count.
- **mediabunny, tuned adapter**: this package's adapter (video-fps-probe/engines/mediabunny): every packet timestamp through this package's timeline statistics (min, max, VFR), the average from computePacketStats().averagePacketRate.

| Arm | Files | Fixtures | Checks | exact | wrong | definition differs | unverified | not provided | unsupported container |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| own parsers | ISO BMFF (MP4, MOV) | 87 | 1417 | 1385 | 0 | 0 | 0 | 0 | 0 |
| own parsers | Matroska, WebM | 40 | 666 | 614 | 0 | 0 | 0 | 0 | 0 |
| own parsers | not a video container | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| mp4box.js, idiomatic | ISO BMFF (MP4, MOV) | 87 | 1403 | 707 | 4 | 36 | 4 | 540 | 0 |
| mp4box.js, idiomatic | Matroska, WebM | 40 | 120 | 9 | 0 | 0 | 0 | 0 | 110 |
| mp4box.js, idiomatic | not a video container | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| mp4box.js, tuned adapter | ISO BMFF (MP4, MOV) | 87 | 1417 | 1356 | 9 | 18 | 0 | 0 | 0 |
| mp4box.js, tuned adapter | Matroska, WebM | 40 | 120 | 9 | 0 | 0 | 0 | 0 | 110 |
| mp4box.js, tuned adapter | not a video container | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| mediabunny, idiomatic | ISO BMFF (MP4, MOV) | 87 | 1389 | 1047 | 9 | 55 | 5 | 165 | 0 |
| mediabunny, idiomatic | Matroska, WebM | 40 | 666 | 389 | 4 | 56 | 0 | 49 | 0 |
| mediabunny, idiomatic | not a video container | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| mediabunny, full scan | ISO BMFF (MP4, MOV) | 87 | 1389 | 1180 | 9 | 83 | 5 | 84 | 0 |
| mediabunny, full scan | Matroska, WebM | 40 | 666 | 448 | 4 | 73 | 0 | 89 | 0 |
| mediabunny, full scan | not a video container | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| mediabunny, tuned adapter | ISO BMFF (MP4, MOV) | 87 | 1417 | 1325 | 14 | 23 | 3 | 15 | 0 |
| mediabunny, tuned adapter | Matroska, WebM | 40 | 666 | 515 | 2 | 65 | 0 | 41 | 0 |
| mediabunny, tuned adapter | not a video container | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 |

- mp4box.js, idiomatic: wrong `codecName` 1, `error` 1, `frames` 1, `trackSelection` 1; definition differs `durationSec` 23, `formatDurationSec` 12, `error` 1; unverified `formatDurationSec` 4.
- mp4box.js, tuned adapter: wrong `formatDurationSec` 2, `presentedFrames` 2, `startSec` 2, `codecName` 1, `durationSec` 1, `frames` 1; definition differs `formatDurationSec` 17, `error` 1; unverified none.
- mediabunny, idiomatic: wrong `isVfr` 6, `error` 2, `durationSec` 1, `formatDurationSec` 1, `maxFps` 1, `minFps` 1, `trackSelection` 1; definition differs `maxFps` 29, `minFps` 27, `avgFps` 25, `formatDurationSec` 17, `durationSec` 7, `isVfr` 2, `startSec` 2, `error` 1, `nominalFps` 1; unverified `avgFps` 2, `durationSec` 1, `formatDurationSec` 1, `minFps` 1.
- mediabunny, full scan: wrong `isVfr` 3, `error` 2, `frames` 2, `avgFps.measured` 1, `durationSec` 1, `formatDurationSec` 1, `maxFps` 1, `minFps` 1, `trackSelection` 1; definition differs `avgFps.measured` 46, `maxFps` 28, `avgFps` 27, `minFps` 25, `formatDurationSec` 17, `durationSec` 7, `isVfr` 2, `startSec` 2, `error` 1, `nominalFps` 1; unverified `avgFps` 1, `avgFps.measured` 1, `durationSec` 1, `formatDurationSec` 1, `frames` 1.
- mediabunny, tuned adapter: wrong `presentedFrames` 6, `error` 3, `durationSec` 2, `frames` 2, `avgFps.measured` 1, `codecName` 1, `trackSelection` 1; definition differs `avgFps.declared` 33, `avgFps.measured` 32, `formatDurationSec` 13, `avgFps` 8, `startSec` 2; unverified `durationSec` 2, `frames` 1.

**Where the libraries win**, from the same reports:

- A library arm is exact or within tolerance where the own parsers are not (all 131 fixtures, the 5 large local files included): `late_30_to_60.mp4` `nominalFps`: exact (30/1 (exact)) in `mediabunny-idiomatic` (whose `isVfr` on this track is wrong); own n/a: not CFR: ffprobe derives r_frame_rate from heuristics (stages 2-4); `big_1080p.mkv` `avgFps.measured`: exact (30/1) in `mediabunny-full`; own n/a: no exact scan (scan=probe): a measured average is not produced; `big_1080p.mkv` `frames`: exact (1800) in `mediabunny-full` and `mediabunny-tuned`; own n/a: no exact scan (scan=probe, provenance=none): the count is not a block count; `big_1080p.mkv` `presentedFrames`: exact (1800) in `mediabunny-tuned`; own n/a: no exact scan (scan=probe); `big_1080p.mkv` `startSec`: exact (0.000000) in `mediabunny-idiomatic` and `mediabunny-full` and `mediabunny-tuned`; own n/a (0.000000, the same value): no exact scan (scan=probe).
- Fewer bytes read than the own parsers, on the committed files that both the arm and the own parsers open, then the large local files: mp4box.js, tuned adapter 58 of 80; mediabunny, idiomatic 8 of 119; mediabunny, full scan 6 of 119; mediabunny, tuned adapter 2 of 120.
- Fewer reads than the own parsers, on the committed files that both the arm and the own parsers open, then the large local files: mediabunny, tuned adapter 0 of 120, and `big_1080p.mkv` 122 against 126.
- Faster than the own parsers in Node (median of the runs; the library arms run each large file once), on the committed files that both the arm and the own parsers open, then the large local files: mp4box.js, idiomatic 11 of 80, and `long_vfr_1h_screenrec.mp4` 33.2 ms against 59.0 ms; mp4box.js, tuned adapter 10 of 80; mediabunny, idiomatic 6 of 119, and `long_vfr_1h_screenrec.mp4` 10.6 ms against 59.0 ms; mediabunny, full scan 15 of 119; mediabunny, tuned adapter 21 of 120.
- Faster than the own parsers in Chrome headless shell 156 (mp4box.js, tuned adapter): 2 of 78 files warm; `long_vfr_1h_screenrec.mp4` 51.1 ms against 62.4 ms.
- Faster than the own parsers in Chrome headless shell 156 (mediabunny, tuned adapter): 3 of 107 files warm.

<!-- tables:engines:end -->

Frame-rate checks are `avgFps` (for Matroska its declared and measured variants), `nominalFps`, `frames`, `presentedFrames`, `minFps`, `maxFps`, `isVfr` and `duplicateTimestamps`. The fixture counts above include the local large files that are not committed (see the note at the end of the headline). For the idiomatic and full mediabunny arms, reads are the read callbacks of its `BlobSource`, which streams the file in chunks, so their read counts are not `Blob.slice()` calls.

The libraries also win where this corpus does not measure: mediabunny reads MPEG-TS, HLS and audio formats and takes URLs and streams as input, where this package reads MP4, MOV, WebM and Matroska from a `Blob`; mediabunny returns colour, HDR, codec string and audio details that this package does not; both libraries have far more users and releases (as documented on 2026-10-24).

The table below shows the primary track of every fixture. Frames are app / ffprobe. For Matroska, the declared rate is what ffprobe prints (the DefaultDuration rate, or without one the estimate ffprobe makes from the first packets) and the measured average comes from the block timestamps. For files without a video track, the two average columns show the outcome instead.

<!-- tables:accuracy:start -->

<details><summary>Own parsers: all 131 fixtures</summary>

| Fixture | Category | ffprobe avg_frame_rate | App average | Frames app / ffprobe | Min to max FPS | VFR | Verdict | Reads | Bytes read | Chrome headless shell 156 ms |
|---|---|---|---|---|---|---|---|---:|---:|---:|
| `cfr_h264_23.976.mp4` | cfr | 24000/1001 | 24000/1001 | 72 / 72 | 23.976 to 23.976 | no | all exact (17) | 1 | 71.9 KiB (100%) | 0.80 |
| `cfr_vp9_23.976.webm` | cfr | 24000/1001 | 24000/1001; measured 36000/1501 | 72 / 72 | 23.810 to 24.390 | no | all exact (16) | 1 | 59.4 KiB (100%) | 0.70 |
| `cfr_h264_24.mp4` | cfr | 24/1 | 24/1 | 72 / 72 | 24.000 to 24.000 | no | all exact (17) | 1 | 71.3 KiB (100%) | 0.70 |
| `cfr_vp9_24.webm` | cfr | 24/1 | 24/1; measured 72000/2999 | 72 / 72 | 23.810 to 24.390 | no | all exact (16) | 1 | 59.2 KiB (100%) | 0.80 |
| `cfr_h264_25.mp4` | cfr | 25/1 | 25/1 | 75 / 75 | 25.000 to 25.000 | no | all exact (17) | 1 | 69.7 KiB (100%) | 0.70 |
| `cfr_vp9_25.webm` | cfr | 25/1 | 25/1; measured 25/1 | 75 / 75 | 25.000 to 25.000 | no | all exact (16) | 1 | 58.8 KiB (100%) | 0.70 |
| `cfr_h264_29.97.mp4` | cfr | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 86.4 KiB (100%) | 0.70 |
| `cfr_vp9_29.97.webm` | cfr | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 72.0 KiB (100%) | 0.80 |
| `cfr_h264_30.mp4` | cfr | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 86.7 KiB (100%) | 0.80 |
| `cfr_vp9_30.webm` | cfr | 30/1 | 30/1; measured 30/1 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 70.7 KiB (100%) | 0.70 |
| `cfr_h264_50.mp4` | cfr | 50/1 | 50/1 | 150 / 150 | 50.000 to 50.000 | no | all exact (17) | 1 | 110.0 KiB (100%) | 0.80 |
| `cfr_vp9_50.webm` | cfr | 50/1 | 50/1; measured 50/1 | 150 / 150 | 50.000 to 50.000 | no | all exact (16) | 1 | 104.2 KiB (100%) | 0.90 |
| `cfr_h264_59.94.mp4` | cfr | 60000/1001 | 60000/1001 | 180 / 180 | 59.940 to 59.940 | no | all exact (17) | 1 | 126.0 KiB (100%) | 0.80 |
| `cfr_vp9_59.94.webm` | cfr | 19001/317 | 19001/317; measured 90000/1501 | 180 / 180 | 58.824 to 62.500 | no | all exact (16) | 1 | 122.5 KiB (100%) | 0.80 |
| `cfr_h264_60.mp4` | cfr | 60/1 | 60/1 | 180 / 180 | 60.000 to 60.000 | no | all exact (17) | 1 | 126.5 KiB (100%) | 1.00 |
| `cfr_vp9_60.webm` | cfr | 60/1 | 60/1; measured 180000/2999 | 180 / 180 | 58.824 to 62.500 | no | all exact (16) | 1 | 121.3 KiB (100%) | 0.90 |
| `cfr_h264_120.mp4` | cfr | 120/1 | 120/1 | 360 / 360 | 120.0 to 120.0 | no | all exact (17) | 1 | 185.2 KiB (100%) | 0.90 |
| `cfr_vp9_120.webm` | cfr | 120/1 | 120/1; measured 120/1 | 360 / 360 | 111.1 to 125.0 | no | all exact (16) | 1 | 203.8 KiB (100%) | 1.10 |
| `cfr_h264_240.mp4` | cfr | 240/1 | 240/1 | 720 / 720 | 240.0 to 240.0 | no | all exact (17) | 1 | 322.5 KiB (100%) | 1.10 |
| `cfr_vp9_240.webm` | cfr | 240/1 | 240/1; measured 240/1 | 720 / 720 | 200.0 to 250.0 | no | all exact (16) | 1 | 355.4 KiB (100%) | 1.30 |
| `mov_nobf_default.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 86.4 KiB (100%) | 0.80 |
| `mov_nobf_faststart.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 86.4 KiB (100%) | 0.70 |
| `mov_bf_elst.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.7 KiB (100%) | 0.70 |
| `mov_bf_noelst.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.7 KiB (100%) | 0.70 |
| `mov_bf_faststart.mov` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.7 KiB (100%) | 0.70 |
| `mov_prores.mov` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 218.8 KiB (100%) | 0.90 |
| `mp4_bf_elst.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.8 KiB (100%) | 0.80 |
| `mp4_bf_noelst.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.7 KiB (100%) | 0.70 |
| `mp4_bf_faststart.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.8 KiB (100%) | 0.70 |
| `mp4_elst_empty_offset.mp4` | mov | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 35.2 KiB (100%) | 0.80 |
| `mp4_elst_trim_start.mp4` | mov | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.8 KiB (100%) | 0.70 |
| `mp4_elst_trim_output_seek.mp4` | mov | 30000/1001 | 30000/1001 | 60 / 60 | 29.970 to 29.970 | no | all exact (17) | 1 | 25.1 KiB (100%) | 0.70 |
| `fmp4_keyframe_empty_moov.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.7 KiB (100%) | 0.80 |
| `fmp4_default_base_moof.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.7 KiB (100%) | 0.80 |
| `fmp4_frag_duration.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 117.2 KiB (100%) | 0.80 |
| `fmp4_bframes.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 48.8 KiB (100%) | 0.70 |
| `fmp4_hybrid_no_empty_moov.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.7 KiB (100%) | 0.90 |
| `fmp4_cmaf.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.7 KiB (100%) | 0.80 |
| `fmp4_global_sidx.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.8 KiB (100%) | 0.90 |
| `fmp4_dash_flag.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.9 KiB (100%) | 0.70 |
| `mp4_hybrid_fragmented_finalized.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 117.9 KiB (100%) | 0.80 |
| `fmp4_dash_single_file.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.8 KiB (100%) | 0.80 |
| `fmp4_dash_concat_segments.mp4` | fmp4 | 30000/1001 | 30000/1001 | 120 / 120 | 29.970 to 29.970 | no | all exact (17) | 1 | 116.9 KiB (100%) | 0.80 |
| `hevc_hvc1.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 45.1 KiB (100%) | 0.80 |
| `hevc_hev1.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 45.1 KiB (100%) | 0.80 |
| `av1.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 20.8 KiB (100%) | 0.80 |
| `vp9.mp4` | codec | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 72.0 KiB (100%) | 0.90 |
| `vp9.webm` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 72.0 KiB (100%) | 0.80 |
| `vp8.webm` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 160.3 KiB (100%) | 0.90 |
| `av1.webm` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 21.2 KiB (100%) | 0.80 |
| `h264.mkv` | matroska | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 86.4 KiB (100%) | 0.80 |
| `hevc.mkv` | codec | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 44.3 KiB (100%) | 0.70 |
| `vp9_live.webm` | live | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 71.9 KiB (100%) | 0.90 |
| `vp9_pipe.webm` | live | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 71.9 KiB (100%) | 0.80 |
| `vp9_unknown_clusters.webm` | live | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 71.9 KiB (100%) | 0.80 |
| `vp9_no_defaultduration.webm` | matroska | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 72.0 KiB (100%) | 0.70 |
| `vfr_concat_10_30_60.mp4` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.000 | yes | all exact (16) | 1 | 161.8 KiB (100%) | 0.90 |
| `vfr_concat_bframes.mp4` | vfr | 1200/37 | 1200/37 | 200 / 200 | 10.000 to 60.000 | yes | all exact (16) | 1 | 66.7 KiB (100%) | 0.90 |
| `vfr_concat_10_30_60_ts1M.mp4` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.002 | yes | all exact (16) | 1 | 162.7 KiB (100%) | 1.10 |
| `vfr_concat_10_30_60.mov` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.000 | yes | all exact (16) | 1 | 161.7 KiB (100%) | 0.90 |
| `vfr_concat_10_30_60.webm` | vfr | 0/0 | 0/0; measured 100/3 | 200 / 200 | 10.000 to 62.500 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 140.3 KiB (100%) | 1.00 |
| `vfr_concat_10_30_60_fmp4.mp4` | vfr | 100/3 | 100/3 | 200 / 200 | 10.000 to 60.000 | yes | all exact (16) | 1 | 162.8 KiB (100%) | 0.90 |
| `vfr_setpts_sine.mp4` | vfr | 13500000/445991 | 13500000/445991 | 150 / 150 | 17.149 to 119.7 | yes | all exact (16) | 1 | 142.2 KiB (100%) | 1.10 |
| `vfr_select_drop.mp4` | vfr | 36/1 | 36/1 | 180 / 180 | 20.000 to 60.000 | yes | all exact (16) | 1 | 152.1 KiB (100%) | 1.10 |
| `vfr_mpdecimate.mp4` | vfr | 182/9 | 182/9 | 91 / 91 | 0.667 to 30.000 | yes | all exact (16) | 1 | 87.0 KiB (100%) | 0.90 |
| `vfr_screenrec_ts1000.mp4` | vfr | 61500/1501 | 61500/1501 | 246 / 246 | 2.959 to 100.0 | yes | all exact (16) | 1 | 188.6 KiB (100%) | 1.10 |
| `vfr_screenrec_ts1000.webm` | vfr | 60/1 | 60/1; measured 246000/5999 | 246 / 246 | 2.994 to 62.500 | yes | all exact (16) | 1 | 181.7 KiB (100%) | 1.00 |
| `vfr_pulldown_2_3.mp4` | vfr | 24/1 | 24/1 | 120 / 120 | 20.000 to 30.000 | yes | all exact (16) | 1 | 122.8 KiB (100%) | 1.00 |
| `vfr_two_phase_5_200.mp4` | vfr | 205/2 | 205/2 | 820 / 820 | 5.000 to 200.0 | yes | all exact (16) | 1 | 411.3 KiB (100%) | 1.20 |
| `vfr_two_phase_5_200.webm` | vfr | 0/0 | 0/0; measured 205/2 | 820 / 820 | 5.000 to 200.0 | yes | all exact (16) | 1 | 431.0 KiB (100%) | 1.80 |
| `vfr_two_phase_5_200.mkv` | vfr | 205/2 | 205/2; measured 205/2 | 820 / 820 | 5.000 to 200.0 | yes | all exact (16) | 1 | 421.5 KiB (100%) | 1.80 |
| `vfr_freeze_2s.mp4` | vfr | 3600/179 | 3600/179 | 120 / 120 | 0.500 to 30.000 | yes | all exact (16) | 1 | 117.0 KiB (100%) | 0.90 |
| `box64_mdat64_wide.mov` | box64 | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 86.4 KiB (100%) | 0.70 |
| `box64_mdat64_free.mp4` | box64 | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 86.7 KiB (100%) | 0.70 |
| `box64_co64_mdat64.mp4` | box64 | 30000/1001 | 30000/1001 | 90 / 90 | 29.970 to 29.970 | no | all exact (17) | 1 | 35.8 KiB (100%) | 0.70 |
| `av_h264_aac.mp4` | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 101.4 KiB (100%) | 0.80 |
| `av_h264_aac_faststart.mp4` | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 101.4 KiB (100%) | 0.80 |
| `multi_video_2tracks.mp4` (+1 track) | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (31) | 1 | 299.9 KiB (100%) | 0.90 |
| `still_image_track_first.mp4` (+1 track) | multi | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (30) | 1 | 105.0 KiB (100%) | 0.70 |
| `cover_art_audio.m4a` | cover | opens as mov,mp4,m4a,3gp,3g2,mj2, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 16.3 KiB (100%) | 0.70 |
| `cover_art_plus_video.mp4` | cover | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 103.5 KiB (100%) | 0.80 |
| `audio_only.m4a` | audio | opens as mov,mp4,m4a,3gp,3g2,mj2, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 13.3 KiB (100%) | 0.70 |
| `audio_only_aac.mp4` | audio | opens as mov,mp4,m4a,3gp,3g2,mj2, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 13.3 KiB (100%) | 0.60 |
| `audio_only_opus.webm` | audio | opens as matroska,webm, 0 video stream(s) | ok, 0 video tracks | - | - | - | all exact (3) | 1 | 13.5 KiB (100%) | 0.60 |
| `edge_single_frame.mp4` | edge | 30/1 | 30/1 | 1 / 1 | - | - | all exact (16) | 1 | 4.0 KiB (100%) | 0.60 |
| `corrupt_empty_0byte.mp4` | corrupt | fails: moov atom not found | error: not a recognised container: empty file | - | - | - | expected outcome (manifest) | 0 | 0 B | 0.00 |
| `corrupt_garbage_random.mp4` | corrupt | fails: moov atom not found | error: not a recognised container: no known signature | - | - | - | expected outcome (manifest) | 1 | 64.0 KiB (100%) | 0.70 |
| `corrupt_text_named.mp4` | corrupt | fails: moov atom not found | error: not a recognised container: text file | - | - | - | expected outcome (manifest) | 1 | 63 B (100%) | 0.60 |
| `corrupt_png_named.mp4` | corrupt | opens as png_pipe, 1 video stream(s) | error: not a recognised container: PNG image | - | - | - | expected outcome (manifest) | 1 | 2.2 KiB (100%) | 0.60 |
| `corrupt_trunc_moov_partial.mp4` | corrupt | fails: error reading header | error: incomplete file: moov is truncated | - | - | - | expected outcome (manifest) | 1 | 86.2 KiB (100%) | 0.60 |
| `corrupt_trunc_no_moov.mp4` | corrupt | fails: moov atom not found | error: incomplete file: no moov | - | - | - | expected outcome (manifest) | 1 | 85.6 KiB (100%) | 0.70 |
| `corrupt_trunc_mdat_faststart.mp4` | corrupt | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 60.8 KiB (100%) | 0.70 |
| `corrupt_fmp4_truncated_mid_fragment.mp4` | corrupt | 30000/1001 | 30000/1001 | 73 / 73 | 29.970 to 29.970 | no | all exact (17) | 1 | 70.0 KiB (100%) | 0.80 |
| `box_mdat_size0.mp4` | box64 | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 101.4 KiB (100%) | 0.80 |
| `corrupt_stts_count_huge.mp4` | corrupt | fails: error reading header | ok, 1 video track | - | - | - | expected outcome (manifest) | 1 | 86.7 KiB (100%) | 0.70 |
| `sniff_webm_named_mp4.mp4` | sniff | 30000/1001 | 30000/1001; measured 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 72.0 KiB (100%) | 0.80 |
| `sniff_mp4_named_webm.webm` | sniff | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 86.7 KiB (100%) | 0.70 |
| `sniff_mp4_named_mkv.mkv` | sniff | 30/1 | 30/1 | 90 / 90 | 30.000 to 30.000 | no | all exact (17) | 1 | 86.7 KiB (100%) | 0.80 |
| `frag_vfr_global_sidx.mp4` | fmp4 | 60/1 | 60/1 | 140 / 140 | 20.000 to 60.000 | yes | all exact (16) | 1 | 121.0 KiB (100%) | 0.90 |
| `frag_vfr_dash.mp4` | fmp4 | 30/1 | 30/1 | 140 / 140 | 20.000 to 60.000 | yes | all exact (16) | 1 | 121.2 KiB (100%) | 0.90 |
| `h264_vfr_remux.mkv` | vfr | 130/3 | 130/3; measured 130/3 | 260 / 260 | 10.000 to 62.500 | yes | all exact (16) | 1 | 200.0 KiB (100%) | 1.20 |
| `vp9_pipe_t10.webm` | live | 30/1 | 30/1; measured 30/1 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 70.6 KiB (100%) | 0.80 |
| `vp9_opus_live_audiotail.webm` | live | 30/1 | 30/1; measured 30/1 | 90 / 90 | 29.412 to 30.303 | no | all exact (16) | 1 | 98.7 KiB (100%) | 0.80 |
| `h264_25_cover.mkv` | cover | 25/1 | 25/1; measured 25/1 | 75 / 75 | 25.000 to 25.000 | no | all exact (16) | 1 | 71.9 KiB (100%) | 0.80 |
| `remux_cfr_120_ts16000.mp4` | cfr | 120/1 | 120/1 | 360 / 360 | 111.1 to 125.0 | no | 15 exact; within tolerance: avgFps.measured | 1 | 204.7 KiB (100%) | 0.90 |
| `remux_cfr_29.97_ts16000.mp4` | cfr | 30000/1001 | 30000/1001 | 90 / 90 | 29.412 to 30.303 | no | 15 exact; within tolerance: avgFps.measured | 1 | 72.5 KiB (100%) | 0.80 |
| `start_freeze_bf.mp4` | vfr | 1125/67 | 1125/67 | 150 / 150 | 0.500 to 30000.0 | yes | all exact (16) | 1 | 118.2 KiB (100%) | 0.90 |
| `fmp4_missing_fragment.mp4` | fmp4 | 30/1 | 30/1 | 150 / 150 | 0.968 to 30.000 | yes | all exact (16) | 1 | 147.9 KiB (100%) | 0.90 |
| `elst_trim_vfr_copy.mp4` | vfr | 205/2 | 205/2 | 820 / 820 | 5.000 to 200.0 | yes | all exact (16) | 1 | 411.3 KiB (100%) | 1.20 |
| `cfr_240_ts600.mp4` | cfr | 288000/1201 | 288000/1201 | 480 / 480 | 200.0 to 300.0 | no | all exact (16) | 1 | 93.1 KiB (100%) | 1.10 |
| `fmp4_global_sidx_bframes.mp4` | fmp4 | 25/1 | 25/1 | 100 / 100 | 25.000 to 25.000 | no | all exact (17) | 1 | 97.7 KiB (100%) | 0.80 |
| `late_30_to_60.mp4` | vfr | 360/11 | 360/11 | 7200 / 7200 | 30.000 to 60.000 | yes | all exact (16) | 1 | 137.7 KiB (100%) | - |
| `late_25_to_12.5.webm` | vfr | 25/1 | 25/1; measured 150000/6499 | 6000 / 6000 | 12.500 to 25.000 | yes | all exact (16) | 1 | 151.3 KiB (100%) | - |
| `late_freeze_10s.mkv` | vfr | 25/1 | 25/1; measured 625/26 | 6250 / 6250 | 0.100 to 25.000 | yes | all exact (16) | 1 | 144.0 KiB (100%) | - |
| `rec_chromium_vp8.webm` | recorder | 60000/1001 | 60000/1001; measured 166000/4509 | 166 / 166 | 1.449 to 333.3 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 86.9 KiB (100%) | - |
| `rec_chromium_vp8_sliced.webm` | recorder | 60/1 | 60/1; measured 83000/2253 | 166 / 166 | 1.456 to 142.9 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 86.2 KiB (100%) | - |
| `rec_chromium_vp9.webm` | recorder | 60/1 | 60/1; measured 41500/1127 | 166 / 166 | 1.433 to 125.0 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 55.0 KiB (100%) | - |
| `rec_chromium_vp9_sliced.webm` | recorder | 60/1 | 60/1; measured 41250/1127 | 165 / 165 | 1.416 to 100.0 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 54.1 KiB (100%) | - |
| `rec_chromium_av1.webm` | recorder | 60/1 | 60/1; measured 166000/4509 | 166 / 166 | 1.441 to 100.0 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 73.8 KiB (100%) | - |
| `rec_chromium_av1_sliced.webm` | recorder | 60/1 | 60/1; measured 16600/451 | 166 / 166 | 1.458 to 100.0 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 73.8 KiB (100%) | - |
| `rec_chromium_h264.mkv` | recorder | 60/1 | 60/1; measured 41500/1127 | 166 / 166 | 1.462 to 125.0 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 84.5 KiB (100%) | - |
| `rec_chromium_h264_sliced.mkv` | recorder | 60000/1001 | 60000/1001; measured 166000/4509 | 166 / 166 | 1.441 to 111.1 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 84.3 KiB (100%) | - |
| `rec_chromium_h264.mp4` | recorder | 45000/1243 | 45000/1243 | 165 / 165 | 1.459 to 114.9 | yes | all exact (16) | 1 | 85.2 KiB (100%) | - |
| `rec_chromium_h264_sliced.mp4` | recorder | 4980000/137219 | 4980000/137219 | 166 / 166 | 1.445 to 127.7 | yes | all exact (16) | 1 | 85.4 KiB (100%) | - |
| `rec_chromium_vp9.mp4` | recorder | 2490000/67343 | 2490000/67343 | 166 / 166 | 1.431 to 116.3 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 49.1 KiB (100%) | - |
| `rec_chromium_vp9_sliced.mp4` | recorder | 207500/5613 | 207500/5613 | 166 / 166 | 1.438 to 95.541 | yes | 15 exact; within tolerance: avgFps.measured | 1 | 50.7 KiB (100%) | - |
| `long_cfr_3h_60fps.mp4` | long | 60/1 | 60/1 | 648000 / 648000 | 60.000 to 60.000 | no | all exact (17) | 2 | 2.56 MiB (20.6%) | 3.50 |
| `long_vfr_1h_screenrec.mp4` | long | 186/5 | 186/5 | 133920 / 133920 | 2.941 to 100.0 | yes | all exact (16) | 2 | 1.53 MiB (40.7%) | 62.4 |
| `big_1080p_moov_end.mp4` | big | 30/1 | 30/1 | 1800 / 1800 | 30.000 to 30.000 | no | all exact (17) | 2 | 75.0 KiB (0.01%) | 1.40 |
| `big_1080p_faststart.mp4` | big | 30/1 | 30/1 | 1800 / 1800 | 30.000 to 30.000 | no | all exact (17) | 1 | 64.0 KiB (0.01%) | 0.60 |
| `big_1080p.mkv` | big | 30/1 | 30/1 | - / 1800 | 29.412 to 30.303 | no | all exact (12) | 126 | 16.51 MiB (2.86%) | 110 |

</details>

<!-- tables:accuracy:end -->

The field-level table, with app and ffprobe values for every check of all three engines, is in [report/accuracy.md](../report/accuracy.md).

### Known deviations

<!-- tables:deviations:start -->

- None.
- Not run: `sparse_4_5gb_co64.mp4`, optional file not present (generate it with npm run fixtures:generate -- --with-sparse).

<!-- tables:deviations:end -->

### Late rate changes (Tier L)

The other committed fixtures have at most 820 frames, and every rate change in them falls inside mediabunny's default probe of 256 packets. Three generated files put the change after more than 5000 constant frames, far past it. Each is at most 1 MB, 64x36, and constant-rate for more than 5000 frames before it changes. This paragraph was corrected after the first run: as committed with the predictions, it said that mediabunny's probe and its full scan gave the same rates on every older fixture, which is false. Their primary-track average, nominal rate, minimum, maximum or VFR flag differ on these fixtures, generated from `report/accuracy.json` (the three late-change files are in the table below):

<!-- tables:probe-full:start -->

- `vfr_two_phase_5_200.mp4`: average 3400/69 (49.275) from the probe, 4200/41 (102.4) from the full scan.
- `vfr_two_phase_5_200.webm`: average 3400/69 (49.275) from the probe, 4200/41 (102.4) from the full scan.
- `vfr_two_phase_5_200.mkv`: average 3400/69 (49.275) from the probe, 4200/41 (102.4) from the full scan.
- `h264_vfr_remux.mkv`: average 3060/71 (43.099) from the probe, 15540/359 (43.287) from the full scan.
- `remux_cfr_120_ts16000.mp4`: average 120/1 (120.0) from the probe, 44875/374 (120.0) from the full scan.
- `elst_trim_vfr_copy.mp4`: average 3400/69 (49.275) from the probe, 4200/41 (102.4) from the full scan.
- `cfr_240_ts600.mp4`: average 91800/383 (239.7) from the probe, 172440/719 (239.8) from the full scan.
- `long_vfr_1h_screenrec.mp4` (large, local): average 10625/296 (35.895) from the probe, 145712/3917 (37.200) from the full scan; minimum 500/169 (2.959) from the probe, 50/17 (2.941) from the full scan.

<!-- tables:probe-full:end -->

- `late_30_to_60.mp4`: H.264, 6000 frames at 30 fps (200 s), then 1200 frames at 60 fps (20 s); 7200 frames over 220 s, an average of 360/11 (32.727 fps).
- `late_25_to_12.5.webm`: VP9, 5500 frames at 25 fps (220 s), then 500 frames at 12.5 fps (40 s); 6000 frames over 260 s (23.077 fps).
- `late_freeze_10s.mkv`: H.264 in Matroska at 25 fps, frame 5999 held for 10.04 s, then 250 more frames; 6250 frames over 260 s (24.038 fps).

**Predictions, committed before the comparison first ran on these files (2026-10-24):**

1. Own parsers: every check exact against ffprobe 8.1.1 (0 mismatches), the VFR flag true on all three, and a rate profile with the change at about 200 s, 220 s and 240 s.
2. mediabunny idiomatic (`computeFrameRateMetrics()` with its default of 256 packets) misreports both: an average equal to the first rate (30, 25 and 25 fps) and `frameRateIsConstant` true, so a VFR flag of false on all three. The average counts as definition differs (the probe window is its documented definition), the VFR flag as wrong.
3. mediabunny full scan (`targetPacketCount: Infinity`) is correct: the VFR flag true, an average that differs from ffprobe's only by its own definition (the distinct timestamps less one over their span), and the minimum and maximum over the whole stream. It is slower than the idiomatic arm and than the own parsers.

The results below are reported whatever they are, including a prediction that fails.

**Results of the latest run** (`npm run compare -- --with-large`). The table is regenerated with every run, so it shows the current verdicts and timings; the first run, on 2026-10-24, is described below it.

<!-- tables:late:start -->

Each cell is the arm's value and its verdict, or the outcome of a mismatch. The average is `avgFps` for MP4 and the measured average for Matroska, whose rule scores it only after a full scan. Node ms is the median of 3 runs.

| File | Arm | Average | Min FPS | Max FPS | VFR flag | Node ms |
|---|---|---|---|---|---|---:|
| `late_30_to_60.mp4` | own parsers | 360/11 (32.727), exact | 30/1 (30.000), exact | 60/1 (60.000), exact | true, exact | 0.46 |
| `late_30_to_60.mp4` | mediabunny, idiomatic | 30/1 (30.000), definition differs | 30/1 (30.000), exact | 30/1 (30.000), definition differs | false, wrong | 1.23 |
| `late_30_to_60.mp4` | mediabunny, full scan | 431940/13199 (32.725), definition differs | 30/1 (30.000), exact | 60/1 (60.000), exact | true, exact | 11.5 |
| `late_30_to_60.mp4` | mediabunny, tuned adapter | 360/11 (32.727), exact | 30/1 (30.000), exact | 60/1 (60.000), exact | true, exact | 5.14 |
| `late_30_to_60.mp4` | mp4box.js, tuned adapter | 360/11 (32.727), exact | 30/1 (30.000), exact | 60/1 (60.000), exact | true, exact | 1.27 |
| `late_25_to_12.5.webm` | own parsers | 150000/6499 (23.080), exact | 25/2 (12.500), exact | 25/1 (25.000), exact | true, exact | 3.09 |
| `late_25_to_12.5.webm` | mediabunny, idiomatic | 25/1 (25.000), n/a | 25/1 (25.000), definition differs | 25/1 (25.000), exact | false, wrong | 1.88 |
| `late_25_to_12.5.webm` | mediabunny, full scan | 149975/6498 (23.080), definition differs | 25/2 (12.500), exact | 25/1 (25.000), exact | true, exact | 9.81 |
| `late_25_to_12.5.webm` | mediabunny, tuned adapter | 25000/1083 (23.084), definition differs | 25/2 (12.500), exact | 25/1 (25.000), exact | true, exact | 5.59 |
| `late_25_to_12.5.webm` | mp4box.js, tuned adapter | does not read the container |  |  |  |  |
| `late_freeze_10s.mkv` | own parsers | 625/26 (24.038), exact | 25/251 (0.100), exact | 25/1 (25.000), exact | true, exact | 2.10 |
| `late_freeze_10s.mkv` | mediabunny, idiomatic | 25/1 (25.000), n/a | 25/1 (25.000), definition differs | 25/1 (25.000), exact | false, wrong | 1.96 |
| `late_freeze_10s.mkv` | mediabunny, full scan | 156225/6499 (24.038), definition differs | 25/251 (0.100), exact | 25/1 (25.000), exact | true, exact | 10.3 |
| `late_freeze_10s.mkv` | mediabunny, tuned adapter | 625/26 (24.038), exact | 25/251 (0.100), exact | 25/1 (25.000), exact | true, exact | 6.12 |
| `late_freeze_10s.mkv` | mp4box.js, tuned adapter | does not read the container |  |  |  |  |

<!-- tables:late:end -->

1. **Own parsers: failed on the first run (a wrong manifest note); holds after the note was corrected.** The first run had one own mismatch, `avgFps.declared` of `late_25_to_12.5.webm`, against the prediction of 0: the file has no DefaultDuration, and the 25/1 that ffprobe prints as `avg_frame_rate` is its own estimate from the first packets. The manifest note had said the file declares 25 fps, and the rule then took the absence of a DefaultDuration from the note. With the note corrected, that rule scored the check not applicable; the note was wrong, not the parser. The rule now reads the absence from the file itself, so a note can no longer change the verdict, and since 0.2.0 the own parsers reproduce that estimate, so the WebM's declared average and nominal rate (25/1) are scored and exact. Every other check was exact on the first run. The own parsers report no nominal rate on the MP4, and the rules never score a Matroska track duration, so 3 own checks on these files are not applicable rather than exact (5 before the estimate). The rate profiles find the changes at 200 s and 220 s; the freeze is a freeze anomaly of 10.04 s at 239.96 s inside one steady 25 fps segment, not a rate change.
2. **mediabunny idiomatic: held for the values.** The averages are 30, 25 and 25 fps and the VFR flag is false on all three files, scored wrong each time. Its nominal rate on the MP4 and the WebM equals ffprobe's `r_frame_rate` (30/1 and 25/1) and is listed among the library wins above, but only because its probe saw just the constant head: its VFR flag on the same tracks is wrong. Only the MP4 average is scored (definition differs, its probe window); for WebM and Matroska the rules score a measured average only after a full scan, so those two averages are not applicable and are not counted against it. It reads the whole of these small files too, and its Node times are close to the own parsers, faster on some files (Node ms above).
3. **mediabunny full scan: held.** The VFR flag is true, the minimum and maximum are exact, and the averages differ from ffprobe's only by its own definition (32.725 against 32.727 fps on the MP4). It is slower than the own parsers and the idiomatic arm on all three files, by several times.

ffprobe's `avg_frame_rate` is not ground truth on these files: it reads 25/1 for both Matroska files, an estimate from the first packets for the WebM and the DefaultDuration for the MKV, while their averages are 23.08 and 24.04 fps. The measured averages above come from ffprobe's packet timestamps. mp4box.js (tuned adapter) is exact on the MP4 as well, and mediabunny's tuned adapter, which walks every packet, gets the VFR flag and the range right on all three.

### Browser recordings (Tier R)

Twelve files are real MediaRecorder output, recorded on 2026-10-24 in Playwright's headless Chromium 156 by `scripts/fixtures/record-mediarecorder.mjs`: a canvas animation drawn on rAF for 1.5 s, paused for 0.6 s, drawn by a 15 fps timer until 3.6 s and on rAF again until 4.5 s, at 320x180 and 250 kbps. Each type Chromium records is there twice, in one piece and with a 250 ms timeslice: WebM VP8, VP9 and AV1, Matroska H.264, and fragmented MP4 with H.264 and VP9 ([provenance](../fixtures/README.md#browser-recordings-tier-r)). They are committed as recorded, so the corpus keeps the browser's real timing, and they are frozen: a later recording is a new file.

<!-- tables:recorder:start -->

| Arm | Recordings | Checks | exact | within-tol | known deviation | wrong | definition differs | unverified | not provided | unsupported container | n/a |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| own parsers | 12 | 204 | 182 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 12 |
| mp4box.js, idiomatic | 12 | 92 | 32 | 0 | 0 | 0 | 6 | 2 | 24 | 20 | 8 |
| mp4box.js, tuned adapter | 12 | 92 | 66 | 2 | 0 | 0 | 0 | 0 | 0 | 20 | 4 |
| mediabunny, idiomatic | 12 | 204 | 128 | 0 | 0 | 0 | 8 | 0 | 24 | 0 | 44 |
| mediabunny, full scan | 12 | 204 | 140 | 0 | 0 | 0 | 20 | 0 | 28 | 0 | 16 |
| mediabunny, tuned adapter | 12 | 204 | 153 | 7 | 0 | 0 | 24 | 0 | 8 | 0 | 12 |

<!-- tables:recorder:end -->

- The own parsers have no mismatch on them. The 8 WebM and Matroska files store no duration for the last frame (no DefaultDuration, no BlockDuration), so ffprobe fills it from its estimated `r_frame_rate` (16 ms) while the own parsers use the median frame interval (17 ms): their measured averages differ by one millisecond of span. That is a definition difference by design, not a measurement error: `avgFps` is the presented frames over the presentation span, and ffprobe parity is `avgFpsFfprobe`. The Matroska rule scores exactly that difference within tolerance and labels it so, as for `vfr_concat_10_30_60.webm`: the average must be the frames over the timestamp span plus one median interval, so a last frame of any other length, zero included, is still a mismatch. The first version of these results recorded them as 8 per-file known deviations, which matched the field only, not the value. Their declared average and nominal rate are exact: without a DefaultDuration ffprobe estimates both from the first packets (60/1 or 60000/1001 on these files), and the own parsers reproduce that estimate.
- No value of mediabunny's own recipes is wrong on these recordings: their averages differ by definition, and the WebM durations they report are the last frame's timestamp. The tuned adapters have no wrong value on them either. The mediabunny one reports `computePacketStats().averagePacketRate` as the average of the two VP9 MP4 files: the packets over a span that ends at the last timestamp plus the stored duration of the last sample, a placeholder of 999 ticks where ffprobe gives that packet 500, so it differs by definition. The mp4box.js one ended Chrome's fragmented MP4 at the sum of its trun durations, which does not follow the tfdt timeline: Chrome gives the last sample of each fragment that placeholder duration and starts the next fragment at its own tfdt. The adapter now ends the track at the tfdt timeline as ffprobe does, and its track and format durations are exact.
- The rate profile recovers the recorded pacing on all twelve: about 60 fps for 1.49 s, a freeze of about 0.69 s (the 0.6 s pause plus the wait for the next timer frame), about 15 fps until 3.63 s and about 60 fps to the end. `tests/segments/fixtures.test.ts` asserts it.
- Firefox and Safari recordings are not in the corpus: Playwright's WebKit on Windows has no MediaRecorder, and its Firefox does not start on the maintainer machine. The manual workflow `.github/workflows/record-firefox.yml` records Firefox on Ubuntu in CI and uploads the files as an artifact; it has not run yet.

## Speed

Own parsers on representative files and the long local files.

<!-- tables:speed:start -->

Node: `npm run compare` (`analyze()` on `fs.openAsBlob`), median of 3 runs per file; library engines run the long files once. Chrome headless shell 156: `npm run bench` on the built app, file picked through the real file input, median of 5 warm runs (own) or 3 runs (libraries, long files); "UI ms" runs from the input's change event to the rendered result. Times are worker-side `io.ms`.

**Not current.** The Chrome headless shell 156 timings and the fetched chunks below were measured on 2026-10-24 on an earlier build (worker entry `probe-oihzfWcg.js`), whose chunks differ from the current ones (see [Demo bundle size](#demo-bundle-size)), so re-run `npm run bench` before quoting them.

| File | What it is | Size | Duration | Frames | Reads | Bytes read | Node ms | Chrome headless shell 156 ms | Chrome headless shell 156 UI ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `av_h264_aac_faststart.mp4` | MP4, moov before mdat (faststart) | 101.4 KiB | 3 s | 90 | 1 | 101.4 KiB (100%) | 0.35 | 0.80 | 1.50 |
| `av_h264_aac.mp4` | same file, moov at the end | 101.4 KiB | 3 s | 90 | 1 | 101.4 KiB (100%) | 0.36 | 0.80 | 1.40 |
| `mp4_bf_elst.mp4` | MP4 with B-frames and an edit list | 35.8 KiB | 3.003 s | 90 | 1 | 35.8 KiB (100%) | 0.27 | 0.80 | 1.40 |
| `fmp4_frag_duration.mp4` | fragmented MP4 | 117.2 KiB | 4.004 s | 120 | 1 | 117.2 KiB (100%) | 0.40 | 0.80 | 1.40 |
| `frag_vfr_global_sidx.mp4` | fragmented VFR MP4 with a global sidx | 121.0 KiB | 4.967 s | 140 | 1 | 121.0 KiB (100%) | 0.46 | 0.90 | 1.60 |
| `vfr_screenrec_ts1000.mp4` | VFR screen recording, timescale 1000 | 188.6 KiB | 6.004 s | 246 | 1 | 188.6 KiB (100%) | 0.82 | 1.10 | 2.00 |
| `cfr_vp9_30.webm` | WebM, VP9 | 70.7 KiB | 3 s | 90 | 1 | 70.7 KiB (100%) | 0.47 | 0.70 | 1.40 |
| `vp9_unknown_clusters.webm` | WebM with unknown-size clusters (live) | 71.9 KiB | - | 90 | 1 | 71.9 KiB (100%) | 0.43 | 0.80 | 1.50 |
| `h264_vfr_remux.mkv` | Matroska, stream-copied VFR with BlockGroups | 200.0 KiB | 6 s | 260 | 1 | 200.0 KiB (100%) | 0.82 | 1.20 | 2.00 |
| `corrupt_trunc_no_moov.mp4` | interrupted recording, no moov (error) | 85.6 KiB | - | - | 1 | 85.6 KiB (100%) | 0.25 | 0.70 | 1.10 |
| `long_cfr_3h_60fps.mp4` | long CFR MP4, moov at the end | 12.42 MiB | 3 h | 648000 | 2 | 2.56 MiB (20.6%) | 3.50 | 3.50 | 4.20 |
| `long_vfr_1h_screenrec.mp4` | long VFR screen recording MP4 | 3.76 MiB | 1 h | 133920 | 2 | 1.53 MiB (40.7%) | 59.0 | 62.4 | 63.8 |
| `big_1080p_moov_end.mp4` | 1080p MP4 of 1 min, moov at the end | 576.42 MiB | 1 min | 1800 | 2 | 75.0 KiB (0.01%) | 0.54 | 1.40 | 2.10 |
| `big_1080p_faststart.mp4` | same file, faststart | 576.42 MiB | 1 min | 1800 | 1 | 64.0 KiB (0.01%) | 0.26 | 0.60 | 1.30 |
| `big_1080p.mkv` | same stream in Matroska (auto mode) | 576.43 MiB | 1 min | - | 126 | 16.51 MiB (2.86%) | 87.4 | 110 | 111 |
| **all 126 committed fixtures** | median per file; bytes are totals | 12.97 MiB |  |  | 1 (max 1) | 12.97 MiB (100%) | 0.41 | 0.80 | 1.40 |

- Cold start, Chrome headless shell 156: the app is ready 118 ms after navigation; 111 files picked at once on a fresh profile show all results after 281 ms (median of 248 ms over reloads, range 214 to 263 ms).

| First file of a container | File | UI ms, fresh page | UI ms, 2nd pick | UI ms, steady | Extra ms (fresh - steady) | Chunks fetched (raw) |
|---|---|---:|---:|---:|---:|---|
| ISO BMFF | `cfr_h264_30.mp4` | 17.1 | 2.70 | 1.30 | 15.8 | probe.js 6.92 KB, probe.worker.js 10.39 KB, isobmff.js 30.75 KB, stats.js 10.21 KB |
| Matroska | `h264.mkv` | 18.2 | 2.90 | 1.50 | 16.7 | probe.js 6.92 KB, probe.worker.js 10.39 KB, matroska.js 29.05 KB, stats.js 10.21 KB |

<!-- tables:speed:end -->

Per-file timings for every fixture, the library engines and the cold start are in [report/browser-bench.md](../report/browser-bench.md).

## Package size

<!-- tables:package:start -->

**A default install adds 0.66 KB gzip to the host app's critical path:** the package code in the entry chunk of a Vite 8.3.5 app that imports `video-fps-probe/lazy` (with Vite's preload helper, which any app with a dynamic import already has, that entry chunk is 1.39 KB). With `worker: { format: 'es' }` in the host's Vite config the first MP4 or MOV file then loads 23.60 KB lazily: the probe client, the own worker, the statistics chunk and the ISO BMFF parser; every own path together is 40.58 KB. Without a worker option Vite builds workers as 'iife', which cannot split, so the own worker is one file with both parsers and the first file loads 38.75 KB (zero-config). mp4box.js and mediabunny are only in the build when their entries are imported. Everything the default build emits outside the entry chunk is 80.90 KB, because it also holds main-thread copies of the parsers, the statistics and the worker runtime. The default flavor keeps them as an in-thread own for environments without a `Worker` global (SSR, Node) and for `worker: 'inline'`; the client flavor keeps them for `worker: 'inline'` and for environments without a `Worker` global; the root `analyze()` always runs in the calling thread on them. A browser with a `Worker` global never fetches them otherwise.

Recommended: one line in the host's Vite config, so the own worker splits and the first MP4 loads 23.60 KB instead of 38.75 KB. Module workers run on the whole package floor (Chrome and Edge 94, Firefox 114, Safari 15.4).

```js
export default defineConfig({ worker: { format: 'es' } });
```

| Configuration | Imports | Vite worker option | Critical path | First MP4, lazy | All own paths, lazy | Engine chunks, lazy | Worker files | Budgets |
|---|---|---|---:|---:|---:|---:|---:|---|
| **default** | `video-fps-probe/lazy` | format: 'es' (recommended) | **0.66 KB** | 23.60 KB | 40.58 KB | - | 1 | ok (11 budgets) |
| zero-config | `video-fps-probe/lazy` | none, so Vite's default format: 'iife' | **0.66 KB** | 38.75 KB | 38.75 KB | - | 1 | ok (5 budgets) |
| custom | `video-fps-probe/client/lazy` + `video-fps-probe/worker-runtime` (host worker serving own) | format: 'es' | **0.67 KB** | 23.49 KB | 40.46 KB | - | 1 | ok (6 budgets) |
| mp4box | `video-fps-probe/lazy` + `video-fps-probe/mp4box` | format: 'es' | **0.89 KB** | 23.63 KB | 40.61 KB | mp4box 44.86 KB | 2 | ok (5 budgets) |
| mediabunny | `video-fps-probe/lazy` + `video-fps-probe/mediabunny` | format: 'es' | **0.89 KB** | 23.63 KB | 40.61 KB | mediabunny 53.97 KB | 2 | ok (5 budgets) |
| rvfc | `video-fps-probe/lazy` + `video-fps-probe/rvfc` | format: 'es' | **0.77 KB** | 23.61 KB | 40.59 KB | rVFC 2.19 KB | 1 | ok (4 budgets) |
| all | `video-fps-probe/lazy` + `video-fps-probe/mp4box` + `video-fps-probe/mediabunny` + `video-fps-probe/rvfc` | format: 'es' | **1.01 KB** | 23.65 KB | 40.62 KB | mp4box 44.86 KB, mediabunny 53.97 KB, rVFC 2.19 KB | 3 | ok (17 budgets) |
| standalone-url | `video-fps-probe/client/lazy` + `video-fps-probe/standalone/own.worker.js?url` (classic worker from the standalone file) | none needed: the file is copied as an asset | **0.70 KB** | 38.56 KB | 38.56 KB | - | 1 | ok (6 budgets) |
| iife-nosplit | `video-fps-probe/lazy` | format: 'iife', rolldownOptions.output.codeSplitting: false | **0.66 KB** | 38.75 KB | 38.75 KB | - | 1 | ok (4 budgets) |
| react | `video-fps-probe/lazy` + `video-fps-probe/react` (React 19.3.1) | format: 'es' | **1.63 KB** | 23.60 KB | 40.57 KB | - | 1 | ok (9 budgets) |
| react18 | `video-fps-probe/lazy` + `video-fps-probe/react` (React 18.3.1) | format: 'es' | **1.63 KB** | 23.60 KB | 40.57 KB | - | 1 | ok (4 budgets) |
| standalone worker file | `video-fps-probe/standalone/own.worker.js` | - | - | 35.77 KB | 35.77 KB | - | 1 file, no imports | ok |

Measured by `npm run size:matrix` on production builds of the fixtures in `tests/consumers/fixtures/`, installed from the packed tarball into a directory outside the repository with mp4box 2.4.1 and mediabunny 1.62.1; gzip -9, KB = 1000 bytes. The critical path is the package code in the entry chunk, cut out by the hidden sourcemap. CI fails when a budget is exceeded, a configuration builds an unexpected worker file, or a sourcemap lists a module that must not be there (mp4box or mediabunny where they are not imported, the prebuilt own worker in the custom-worker build); [report/size-matrix.md](../report/size-matrix.md) lists every budget with its reason.

<!-- tables:package:end -->

## Demo bundle size

The demo in `demo/` is a React app that consumes the package through a custom worker. Its budgets are checked by `node scripts/size-report.mjs demo/dist --check` and do not apply to the package; what the package adds to a host is the [package size](#package-size) above.

<!-- tables:bundle:start -->

| Chunk | Loaded | Raw | gzip -9 | brotli q11 | Budget (gzip) | Headroom | Status |
|---|---|---:|---:|---:|---:|---:|---|
| main (React, UI, store) | page load | 238.72 KB | **74.44 KB** | 64.40 KB | 77.00 KB | 2.56 KB | ok |
| CSS | page load | 4.98 KB | **1.81 KB** | 1.53 KB | not budgeted | - | - |
| probe client (lazy) | first file | 6.92 KB | **2.98 KB** | 2.75 KB | 3.50 KB | 0.52 KB | ok |
| probe fallback chain | first call with a fallback chain or a skipped engine | 1.01 KB | **0.64 KB** | 0.56 KB | not budgeted | - | - |
| probe compare (agreement rules) | first probe.compare | 2.60 KB | **1.32 KB** | 1.20 KB | not budgeted | - | - |
| in-thread engine runner | first main-thread engine run (rVFC) | 1.09 KB | **0.64 KB** | 0.55 KB | not budgeted | - | - |
| shared by the lazy client parts and rVFC (result builders, sniffing): `abort` | with the fallback chain, compare, rVFC or the own engine in this thread | 0.10 KB | **0.11 KB** | 0.09 KB | not budgeted | - | - |
| shared by the lazy client parts and rVFC (result builders, sniffing): `result` | with the fallback chain, compare, rVFC or the own engine in this thread | 0.71 KB | **0.38 KB** | 0.33 KB | not budgeted | - | - |
| shared by the lazy client parts and rVFC (result builders, sniffing): `sniff` | with the fallback chain, compare, rVFC or the own engine in this thread | 2.12 KB | **0.99 KB** | 0.89 KB | not budgeted | - | - |
| own engine in this thread (runtime and parser copies for worker inline): `isobmff` | only with worker inline or without a Worker global (own engine in this thread) | 30.82 KB | **12.23 KB** | 11.09 KB | not budgeted | - | - |
| own engine in this thread (runtime and parser copies for worker inline): `matroska` | only with worker inline or without a Worker global (own engine in this thread) | 30.58 KB | **11.80 KB** | 10.75 KB | not budgeted | - | - |
| own engine in this thread (runtime and parser copies for worker inline): `rfps` | only with worker inline or without a Worker global (own engine in this thread) | 7.16 KB | **3.53 KB** | 3.32 KB | not budgeted | - | - |
| own engine in this thread (runtime and parser copies for worker inline): `runtime` | only with worker inline or without a Worker global (own engine in this thread) | 6.11 KB | **2.55 KB** | 2.35 KB | not budgeted | - | - |
| own engine in this thread (runtime and parser copies for worker inline): `segments` | only with worker inline or without a Worker global (own engine in this thread) | 3.35 KB | **1.84 KB** | 1.70 KB | not budgeted | - | - |
| own engine in this thread (runtime and parser copies for worker inline): `stats` | only with worker inline or without a Worker global (own engine in this thread) | 10.32 KB | **4.34 KB** | 3.96 KB | not budgeted | - | - |
| worker entry (reader, sniffing, worker runtime) | first file | 10.39 KB | **4.32 KB** | 3.94 KB | 5.00 KB | 0.68 KB | ok |
| shared by the parsers and engines (timeline statistics) | with the first parser, in parallel, once per worker | 10.21 KB | **4.29 KB** | 3.93 KB | 5.00 KB | 0.70 KB | ok |
| ISO BMFF parser | first MP4 or MOV file, once per worker | 30.75 KB | **12.22 KB** | 11.02 KB | 13.50 KB | 1.28 KB | ok |
| Matroska parser | first WebM or MKV file, once per worker | 30.10 KB | **11.54 KB** | 10.50 KB | 12.00 KB | 0.46 KB | ok |
| ffprobe frame rate estimate (Matroska without DefaultDuration) | lazy | 7.17 KB | **3.52 KB** | 3.29 KB | 4.00 KB | 0.48 KB | ok |
| rate profile core (segments, anomalies, sparkline buckets) | first VFR timeline, once per worker | 3.35 KB | **1.84 KB** | 1.71 KB | 2.00 KB | 0.16 KB | ok |
| rate profile panel (UI) | first card with a rate profile | 2.17 KB | **0.94 KB** | 0.85 KB | 1.50 KB | 0.56 KB | ok |
| device info and JSON export | on idle after the first result, or the first export (footer device line, JSON export) | 5.02 KB | **2.29 KB** | 2.02 KB | not budgeted | - | - |
| sample file loader | click on Try sample files | 0.36 KB | **0.28 KB** | 0.24 KB | not budgeted | - | - |
| rVFC fallback | click on Run (approximate) | 4.24 KB | **2.19 KB** | 1.98 KB | 2.50 KB | 0.30 KB | ok |
| Compare panel | first open of a Compare engines panel | 2.92 KB | **1.22 KB** | 1.10 KB | not budgeted | - | - |
| mp4box.js engine | Compare engines on an MP4 or MOV card | 187.93 KB | **43.73 KB** | 37.38 KB | not budgeted | - | - |
| mediabunny engine | Compare engines | 201.10 KB | **52.87 KB** | 44.57 KB | not budgeted | - | - |
| shared by mp4box and mediabunny | with mp4box or mediabunny | 3.01 KB | **1.50 KB** | 1.35 KB | not budgeted | - | - |
| initial: main + CSS + worker entry |  | 254.09 KB | **80.57 KB** | 69.87 KB | 83.00 KB | 2.43 KB | ok |
| first MP4 analysis: initial + probe client + statistics + ISO BMFF parser |  | 301.97 KB | **100.06 KB** | 87.57 KB | 103.00 KB | 2.94 KB | ok |
| first VFR MP4 analysis: first MP4 + rate profile core |  | 305.32 KB | **101.91 KB** | 89.28 KB | 105.00 KB | 3.09 KB | ok |
| first Matroska analysis: initial + probe client + statistics + Matroska parser |  | 301.32 KB | **99.39 KB** | 87.05 KB | 102.00 KB | 2.61 KB | ok |
| first Matroska analysis without DefaultDuration: first Matroska + ffprobe frame rate estimate |  | 308.49 KB | **102.90 KB** | 90.34 KB | 105.50 KB | 2.60 KB | ok |

<!-- tables:bundle:end -->

The research spec planned one parser worker chunk sized from early prototypes. The complete parsers turned out about twice as large ([research errata](research.md#8-errata-found-during-implementation)), so each parser became a lazy chunk with its own budget and the user-facing limit moved to the first analysis of each container. [report/size.md](../report/size.md) explains every limit; CI fails on an overrun. The device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so neither the page load nor the first result waits for it, and it is not part of the initial or first-analysis totals.

## Embedding in an existing app

The target is a large React app (about 1.95 MB gzip initial load) where a user uploads up to about 10 videos of at most 30 s. The probe must not grow the critical bundle, must not block the main thread and must not touch a server. How to wire it:

- **Critical bundle: only a trigger.** Hold a lazy probe and import nothing else from the library statically: `lazyProbeClient` from `video-fps-probe/client/lazy` with a custom worker, or `lazyProbeFrom(() => import('./probe.ts').then((m) => m.probe))` over a module that calls `createProbeClient`, as the demo does (`demo/src/ui/probe.ts`, with its worker `demo/src/ui/probe.worker.ts`). The first call fetches the probe client and starts the module worker, and the worker loads the parser for the sniffed container on first use. Never import `src/core` statically from the app. The React UI of this demo is not needed.
- **Prefetch when the upload dialog opens**: call `probe.prewarm()`. It fetches the probe client, spawns the worker and sends a warm request, which fetches the ISO BMFF chunk without a file (the integration bench measures the same effect with a 16-byte `ftyp` blob run through the worker). The OS file dialog takes longer than the download, so the first result does not wait for the network.
- **One worker, one file at a time.** The demo keeps two workers alive (`workers: 2`, `idleTimeoutMs: 0`) for drag-and-drop of many files; for at most 10 videos the default single worker is enough. Call `dispose()` when the uploads are done, or keep the default idle timeout of 30 s: both terminate the idle workers to hand their memory back, and the next `analyze()` spawns a new one.
- **Fail open.** Give each file a timeout (a few seconds, `timeoutMs`) and let the upload continue without the FPS check if it fires or the result has an `error`; `tryAnalyze()` resolves `null` instead of rejecting. `timeoutMs` counts from the moment a worker takes the job, and the probe-wide value also bounds the warm request of `prewarm()`. A job queued behind a stalled one therefore waits without a limit: for a deadline over a whole batch, pass one `signal` to every call and abort it when the deadline passes. Per file the probe reads the head and, for camera files with the moov at the end, the tail: usually two reads and no decoding.
- **This thread without a worker.** With `worker: 'inline'`, or without a `Worker` global (SSR, Node), the client flavor (`video-fps-probe/client`) runs own in this thread through a lazy chunk, and a registered descriptor runs its engine there too (`mp4box()` and `mediabunny()` also serve own). An engine that only the custom worker lists, such as mp4box or mediabunny without a prebuilt descriptor, rejects with `ProbeError('unsupported-environment')`. The root `createProbe` and `analyze()` parse in this thread whenever no worker is used. Both flavors therefore emit lazy main-thread chunks with the runtime and parsers (see [Bundle size](#demo-bundle-size)); a browser with a `Worker` global fetches them only for `worker: 'inline'` or a root `analyze()` call. They exist for SSR, Node, inline mode and in-thread `analyze()`.

Measured with `scripts/bench/integration.mjs` (details and formulas in [report/integration-cost.md](../report/integration-cost.md)):

<!-- tables:integration:start -->

**Not current.** Measured on 2026-10-24 on an earlier build (worker entry `probe.worker-DzbF4AAw.js`). The worker entry and parser chunks of the current build differ (see [Demo bundle size](#demo-bundle-size)), so re-run `scripts/bench/integration.mjs` before quoting these sizes and timings.

Host model: an SPA with a 1.95 MB gzip initial load, Chrome headless shell 156, local server with CDP network throttling; the probe is the real worker pool, worker entry and parser chunks. "Prewarmed" means the worker was started and the parser loaded before the pick. The trigger is an inline script and the glue the WorkerPool class bundled by the bench, so the sizes below are not those of the package entries: what an app that imports `video-fps-probe/lazy` adds is in [Package size](#package-size).

|  | Lazy on the first pick | Lazy + prefetch when the upload dialog opens | Eager (in the critical bundle) |
|---|---|---|---|
| Critical path, gzip | 0.52 KB trigger (+0.027%) | same | 33.96 KB (+1.74%) |
| Downloaded on use, gzip | 22.35 KB for the first MP4, 33.44 KB with both parsers | the same, when the dialog opens | nothing more |
| First video, fast 4G (9 Mbps, 85 ms) | +345 ms once | 4.10 ms prewarmed, 12.5 ms HTTP-prefetched | 4.10 ms, plus 30.2 ms of transfer on every page load |
| First video, slow 4G (1.6 Mbps, 150 ms) | +627 ms once | 4.50 ms prewarmed, 13.1 ms HTTP-prefetched | 4.50 ms, plus 170 ms of transfer on every page load |
| First video, 3G (0.75 Mbps, 300 ms) | +1250 ms once | 4.90 ms prewarmed, 12.9 ms HTTP-prefetched | 4.90 ms, plus 362 ms of transfer on every page load |
| Main thread | 0 long tasks, TBT 0.00 ms for 111 files at once; 1.10 ms of main-thread CPU for the first file | same | same, plus a worker started on every page load |
| Memory (renderer private, probe share) | +5.14 MB after the first video, +17.18 MB idle after 111 | same, from the dialog open | +5.14 MB for every visitor |

Worker time per file after warm-up: `av_h264_aac_faststart.mp4` 1.10 ms, `av_h264_aac.mp4` 0.90 ms, `fmp4_cmaf.mp4` 1.00 ms, `vfr_concat_10_30_60.webm` 1.00 ms, `long_cfr_3h_60fps.mp4` 3.50 ms, `long_vfr_1h_screenrec.mp4` 36.3 ms.

<!-- tables:integration:end -->

These numbers come from one fast desktop. [report/average-user.md](../report/average-user.md) models what they become on the devices and networks real visitors use (CPU tiers by traffic share, mobile networks, file handover on iOS and Android).

## Approach comparison

Four ways to get a frame rate in the browser, run on the same fixtures (requestVideoFrameCallback on a subset, because it plays each file). The library columns are the tuned adapters in `src/engines`, which fill the same result shape from the samples each library parses, so the libraries are compared as parsers; the accuracy rows add the idiomatic arms.

<!-- tables:approaches:start -->

Node: `npm run compare` (`analyze()` on `fs.openAsBlob`), median of 3 runs per file; library engines run the long files once. Chrome headless shell 156: `npm run bench` on the built app, file picked through the real file input, median of 5 warm runs (own) or 3 runs (libraries, long files); "UI ms" runs from the input's change event to the rendered result. Times are worker-side `io.ms`.

|  | Own parsers (this repo) | mp4box.js 2.4.1 (tuned adapter) | mediabunny 1.62.1 (tuned adapter) | requestVideoFrameCallback (Chrome headless shell 156) |
|---|---|---|---|---|
| Containers | MP4, MOV, WebM, Matroska | MP4, MOV | MP4, MOV, WebM, Matroska | whatever the browser can play |
| Checks vs ffprobe, all fixtures (own: verdicts; libraries: outcome of each non-match) | 2087 checks: 2003 exact, 0 known deviation, 0 mismatch | tuned: 1541 checks: 1369 exact, 9 wrong, 18 definition differs, 0 unverified, 0 not provided, 110 unsupported container; idiomatic: 1527 checks: 720 exact, 4 wrong, 36 definition differs, 4 unverified, 540 not provided, 110 unsupported container | tuned: 2087 checks: 1844 exact, 16 wrong, 88 definition differs, 3 unverified, 56 not provided, 0 unsupported container; idiomatic: 2059 checks: 1440 exact, 13 wrong, 111 definition differs, 5 unverified, 214 not provided, 0 unsupported container | no ffprobe-equivalent fields |
| Frame-rate checks: own mismatches, library checks wrong | MP4: 0; MKV: 0 | MP4: 3 tuned, 1 idiomatic; MKV: not supported | MP4: 7 tuned, 4 idiomatic; MKV: 2 tuned, 4 idiomatic | 9 of 11 estimates equal ffprobe's average; VFR files off by -10.0% and +292.3%; 2 of 13 files did not play |
| Bytes read, 83 committed MP4/MOV files | 8.52 MiB of 8.52 MiB (100%) | 5.23 MiB of 8.52 MiB (61.4%) | 8.14 MiB of 8.52 MiB (95.6%) | the media element streams the file |
| Bytes read, 40 committed WebM/MKV files | 4.39 MiB of 4.39 MiB (100%) | not supported | 4.39 MiB of 4.39 MiB (100%) | the media element streams the file |
| Reads per file, median / max | 1 / 1 | 2 / 3 | 1 / 5 | n/a |
| Time per file, Node 24 (median; geometric mean vs own) | 0.41 ms | 0.58 ms (1.53x own) | 0.50 ms (1.23x own) | needs a browser |
| Time per file, Chrome headless shell 156 (median; geometric mean vs own) | 0.80 ms | 1.30 ms (1.46x own) | 0.90 ms (1.26x own) | 2.01 s (max 8.88 s) |
| 3 h CFR MP4, 12.42 MiB | 2 reads, 2.56 MiB; Node 3.50 ms, Chrome 3.50 ms | 3 reads, 2.56 MiB; Node 164 ms, Chrome 151 ms | 3 reads, 2.73 MiB; Node 680 ms, Chrome 422 ms | not measured |
| 1 h VFR MP4, 3.76 MiB | 2 reads, 1.53 MiB; Node 59.0 ms, Chrome 62.4 ms | 3 reads, 1.53 MiB; Node 71.0 ms, Chrome 51.1 ms | 3 reads, 1.70 MiB; Node 212 ms, Chrome 117 ms | not measured |
| gzip, loaded on demand | probe client 2.98 KB + worker entry 4.32 KB + statistics 4.29 KB + ISO BMFF 12.22 KB or Matroska 11.54 KB | 43.73 KB + 1.50 KB shared | 52.87 KB + 1.50 KB shared | 2.19 KB |
| Main risk | own code to maintain; cases outside the corpus are flagged, not verified | last sample duration overridden; must be fed box by box; no Matroska | adapter: packet-rate average, edit-trimmed packets counted as presented; whole-cluster Matroska reads | needs a visible tab and a playable codec; wrong on VFR; seconds per file |

<!-- tables:approaches:end -->

Risks in detail:

- **Own parsers**: code to maintain. Behaviour outside the corpus (real recorder files, cmov, multi-segment edit lists) is flagged with a warning, not verified.
- **mp4box.js**: MP4 and MOV only, and no frame rate in its info by design. It overrides the last sample duration with `mdhd.duration - last dts`, so the tuned adapter takes durations from the stts box. It has to be fed box by box; a plain append loop reads the whole file.
- **mediabunny**: it applies an edit list by shifting the timestamps, so the packets the edit trims come out with negative timestamps (21 of 90 on `mp4_elst_trim_start.mp4`, whose `computeDuration()` equals ffprobe's 2.303 s). The tuned adapter counts those packets as presented (90 against ffprobe's 69) and takes `averagePacketRate` as the average; both are this package's choices. mediabunny reads whole Matroska clusters, and its `packets()` iterator stalls on very long files (the adapter walks with `getNextPacket`). `computeFrameRateMetrics()` returns floats and probes 256 packets by default; with `targetPacketCount: Infinity` it reads every packet, which takes more than a minute on the 3 h MP4 in Node ([report](../report/accuracy.md)). MPL-2.0 licence.
- **requestVideoFrameCallback**: needs a visible foreground tab and a codec the browser can play. It sees only the frames of a short playback, so VFR averages are wrong, it takes seconds per file, and it depends on the display refresh rate.

### requestVideoFrameCallback fallback

<!-- tables:rvfc:start -->

Chrome headless shell 156, video decoding in software, display 170 Hz, 61 Hz animation frames.

| File | ffprobe avg | rVFC estimate | Error | VFR ffprobe / rVFC | Confidence | Passes | Time |
|---|---|---|---|---|---|---|---|
| `cfr_h264_24.mp4` | 24/1 (24.000) | 24/1 (24.000) | 0.0% | no / no | high | 1 (rate 1) | 2.01 s |
| `cfr_h264_25.mp4` | 25/1 (25.000) | 25/1 (25.000) | 0.0% | no / no | high | 1 (rate 1) | 1.95 s |
| `cfr_h264_29.97.mp4` | 30000/1001 (29.970) | 30000/1001 (29.970) | 0.0% | no / no | high | 1 (rate 1) | 1.85 s |
| `cfr_h264_30.mp4` | 30/1 (30.000) | 30/1 (30.000) | 0.0% | no / no | high | 1 (rate 1) | 1.85 s |
| `cfr_h264_60.mp4` | 60/1 (60.000) | 60/1 (60.000) | 0.0% | no / no | high | 2 (rate 0.5) | 3.38 s |
| `cfr_h264_120.mp4` | 120/1 (120.0) | 120/1 (120.0) | 0.0% | no / no | high | 3 (rate 0.25) | 4.90 s |
| `cfr_h264_240.mp4` | 240/1 (240.0) | 240/1 (240.0) | 0.0% | no / no | high | 4 (rate 0.125) | 6.45 s |
| `vfr_concat_10_30_60.mp4` | 100/3 (33.333) | 30/1 (30.000) | -10.0% | yes / yes | low | 1 (rate 1) | 3.03 s |
| `vfr_setpts_sine.mp4` | 13500000/445991 (30.270) | 118737/1000 (118.7) | +292.3% | yes / yes | low | 3 (rate 0.25) | 8.88 s |
| `cfr_vp9_29.97.webm` | 30000/1001 (29.970) | 30000/1001 (29.970) | 0.0% | no / no | medium | 1 (rate 1) | 1.86 s |
| `hevc_hvc1.mp4` | 30000/1001 (29.970) | error: unplayable: PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_ST... | - | no / - | - | - | 0.00 s |
| `mov_prores.mov` | 30000/1001 (29.970) | error: unplayable: PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_ST... | - | no / - | - | - | 0.00 s |
| `h264.mkv` | 30000/1001 (29.970) | 30000/1001 (29.970) | 0.0% | no / no | medium | 1 (rate 1) | 1.84 s |

<!-- tables:rvfc:end -->

## Recommendation

- **Use the own parsers as the primary path.** They are the only option here with no mismatch against ffprobe on the corpus. They read a file below the single-read size (465,536 bytes by default) whole in one read, so on the small committed files they read more bytes than the libraries but in fewer reads, which is what costs time in a browser ([Why the read count matters](#why-the-read-count-matters)); on larger files they read only the boxes and elements they need (the long and 604 MB rows in [Speed](#speed)). They add a small worker entry plus one parser chunk per container, and report exact min, max and VFR from every timestamp with provenance on each value.
- **mp4box.js** fits when an app already ships it for other MP4 work (box access, segmentation, muxing). For frame rates, take durations from the stts box instead of the per-sample info, feed it box by box, and add a Matroska parser.
- **mediabunny** fits when the app also demuxes or decodes through WebCodecs, or as a second opinion. Its `computeFrameRateMetrics()` returns float rates (`averageFrameRate`) over the first 256 packets unless asked for a full scan, and it marks the packets an edit list trims with negative timestamps instead of dropping them. Expect a larger chunk and whole-cluster reads on Matroska. The `averagePacketRate` average and the trimmed packets counted as presented in the Compare panel come from this package's tuned adapter, not from mediabunny.
- **requestVideoFrameCallback** only as a last-resort, opt-in fallback when the parser cannot give a rate (an unsupported container or sample entry) and the browser can play the file. Label the result approximate: it matched ffprobe on CFR clips but missed on every VFR file, needs a visible tab and takes seconds.
- **In a host app**, load the own parsers lazily: a dynamic `import()` on the first pick, a prewarm when the upload dialog opens, one worker terminated when idle, and a per-file timeout that lets the upload go on without the check ([Embedding in an existing app](#embedding-in-an-existing-app)). Show the rate profile only where users need it; its panel is a separate lazy chunk.
- **Check real files before relying on it.** The corpus is mostly synthetic, and its real recordings come from one browser. Imitations of phone, screen and browser recordings already found issues it could not (Limitations), so run a sample of your users' real uploads through the demo ([Testing on your devices](../demo/README.md#testing-on-your-devices)) before trusting every field.

## How it works

### Worker and reader

The probe posts each `File` to a module Web Worker: one per worker kind by default, two in the demo. The `File` is passed by reference, so no bytes are copied. In the worker, `analyze()` reads a 64 KiB head window, or the whole file when it is below the single-read size (465,536 bytes by default), and sniffs the container from its magic bytes, never from the file name. It then loads the matching parser chunk with a dynamic `import()` on first use and returns a `FileResult` with per-track values, warnings and IO counters. `src/core` has no DOM dependency, so the same code runs in the worker and in Node for the tests, the comparison script and the benchmark cross-check.

All IO goes through one primitive, `BlobReader.read(offset, length)` over `Blob.slice().arrayBuffer()`, with up to four cached windows and an abort check before and after each read. The `reads` and `bytesRead` (unique bytes) of every result come from this reader.

### Why the read count matters

In Chrome every `Blob.slice().arrayBuffer()` call has a fixed cost that is several times the Node cost ([research 4.1](research.md#41-reader-worker-io)), so for small files the number of reads, not the number of bytes, decides the time. The parsers are built around that:

- a file below the single-read size is read whole in its first read, whatever its layout: the 64 KiB head window plus the bytes that one read costs by the cost model (`perReadMs x bytesPerMs`, 400,000 bytes by default), so one read never costs more than two;
- above it, one head window covers a faststart MP4 or a Matroska header, and a moov at the end of the file costs one more read;
- fragmented files read many fragments per window;
- when fragments carry large mdat boxes, offsets known from a sidx or mfra index are fetched in parallel batches.

Below the single-read size the layout no longer changes the read count (faststart puts the moov first); the 604 MB pair in [Speed](#speed) shows the extra read of a moov at the end:

<!-- tables:reads:start -->

| File | Size | Reads | Bytes read | Node ms | Chrome ms |
|---|---:|---:|---:|---:|---:|
| `mov_nobf_faststart.mov` | 86.4 KiB | 1 | 86.4 KiB | 0.34 | 0.70 |
| `mov_nobf_default.mov` | 86.4 KiB | 1 | 86.4 KiB | 0.38 | 0.80 |
| `av_h264_aac_faststart.mp4` | 101.4 KiB | 1 | 101.4 KiB | 0.35 | 0.80 |
| `av_h264_aac.mp4` | 101.4 KiB | 1 | 101.4 KiB | 0.36 | 0.80 |

| Committed fixtures read in | Files | Median bytes read | Node ms (median) | Chrome ms (median) |
|---|---:|---:|---:|---:|
| 0 reads | 1 | 0 B | 0.00 | 0.00 |
| 1 read | 125 | 86.4 KiB | 0.41 | 0.80 |

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
3. Take the median delta `m`. The track is **VFR** when any delta differs from `m` by more than `max(1 tick, round(0.5% x m), 1 ms)`. The 1-tick floor absorbs timescale rounding: 29.97 fps at timescale 1000 alternates 33 and 34 ms. The 1 ms term applies only when the timescale is finer than 1 ms and every delta is a whole number of milliseconds: an MKV or WebM remuxed to MP4 (timescale 16000, 120 fps as 128 and 144 ticks) keeps the 1 ms timestamps of its source and is CFR, 1 ms quantized, as the Matroska file is. The ffprobe references use the same rule.
4. Minimum FPS is timescale / largest delta and maximum FPS is timescale / smallest delta, both exact rationals.
5. Nominal FPS: one distinct delta gives the exact rate. A CFR track with jitter snaps the mean of the kept deltas, within 0.1%, to an NTSC rate (24, 30, 48, 60, 120 or 240 x 1000/1001) or to an integer rate up to 240. The kept deltas leave an odd last tick out, so 240 fps at timescale 600 snaps to 240/1, not 240000/1001. A VFR track gets a dominant rate when one delta covers at least half of the frames; its share counts frames.

The average is presented frames x timescale / (last PTS + stored duration of the last presented frame - first PTS). `avgFpsFfprobe` is frames x timescale / sum of stored durations, the way ffprobe computes `avg_frame_rate`. Both are reduced exactly by a BigInt port of FFmpeg's `av_reduce`. A last frame held for at least 0.5 s and 4 median intervals adds a warning, because it pulls the average below the frame rate.

### Rate profile

An average hides how the frames are spread: 4 s at 5 fps followed by 4 s at 200 fps averages 102.5 fps. When the longest frame interval of a track is more than 7.5% longer than the shortest, the worker loads one more small chunk (`src/core/segments.ts`) after the parser and walks the intervals once more, in order. CFR tracks never load it: when the VFR rule calls a track CFR and its intervals differ only by timestamp rounding (within the VFR tolerance and less than twice the shortest), there is no profile, so 120 and 240 fps Matroska files with 1 ms ticks get none either. Matroska tracks get a profile only from an exact scan.

- **Segments.** A two-sided CUSUM on the frame interval finds the points where the rate steps. Its drift is 7.5% of the running mean interval and its alarm level 2 mean intervals. A segment needs at least 5 frames and 0.5 s; shorter runs join the neighbour with the closest rate. A long run with irregular intervals is a `variable` segment, shown as `~rate`. Neighbouring steady segments whose rates differ by less than 15% merge.
- **Anomalies.** `rate-change` between segments whose rates differ by more than 15%; `freeze` for a hold of at least 0.5 s and at least 4 times the mean interval around it; `gap` and `burst` for a short run at least 15% slower or faster than the segment it sits in. Duplicate timestamps are counted.
- **Uneven.** The badge appears when the steady segments within one 15% band cover less than 80% of the time (freezes count against it) or of the frames, or when steady segments differ by more than 15%. A regular cadence such as 2:3 pulldown is VFR under the rule above but not uneven.
- **Sparkline.** Frames per second in up to 120 buckets over the timeline, on a log scale. At most 50 segments and 50 anomalies are listed; the summary line names the first three segments and starts with "Steady", "Mostly steady" (one steady rate with freezes, gaps or bursts) or "Uneven". The dominant share in the profile counts time, while the Nominal FPS share on the card counts frames.

The thresholds are constants in `src/core/segments.ts` and `src/core/stats.ts`. The profile is one pass over the intervals (run-length for MP4), computed only after the regular statistics, and its panel is a separate lazy chunk that loads only for a card that has a profile. The rows below are asserted in `tests/segments/fixtures.test.ts`, and the e2e suite checks the committed ones in the browser.

<!-- tables:profile:start -->

The profile code is 1.84 KB gzip in the worker and the panel 0.94 KB on the main thread, both lazy. The first VFR MP4 loads 101.91 KB gzip, 1.84 KB more than a CFR one (budget 105.00 KB). Times are the whole analysis, profile included.

| File | Rate profile | Frames | Min to max FPS | Node ms | Chrome headless shell 156 ms |
|---|---|---:|---|---:|---:|
| `vfr_two_phase_5_200.mp4` | 2 steady segments, 5 fps for 4 s then 200 fps for 4 s; 1 rate change; uneven | 820 | 5.000 to 200.0 | 0.85 | 1.20 |
| `vfr_two_phase_5_200.mkv` | the same stream in Matroska: the same 2 segments | 820 | 5.000 to 200.0 | 1.85 | 1.80 |
| `vfr_freeze_2s.mp4` | 1 steady segment at 30 fps; 1 freeze of 2 s at 1.967 s; uneven | 120 | 0.500 to 30.000 | 0.41 | 0.90 |
| `vfr_concat_10_30_60.mp4` | 3 steady segments at 10, 30 and 60 fps, 2 s each; 2 rate changes; uneven | 200 | 10.000 to 60.000 | 0.60 | 0.90 |
| `vfr_screenrec_ts1000.mp4` | 1 steady segment at 60 fps; 2 gaps of about 1 s; uneven | 246 | 2.959 to 100.0 | 0.82 | 1.10 |
| `vfr_pulldown_2_3.mp4` | 1 steady segment at 24 fps (a 2:3 cadence is not uneven) | 120 | 20.000 to 30.000 | 0.54 | 1.00 |
| `cfr_h264_30.mp4` | none: all intervals equal, the chunk is not loaded | 90 | 30.000 to 30.000 | 0.35 | 0.80 |
| `long_vfr_1h_screenrec.mp4` | 60 fps for 3598 s plus a 1.5 s variable tail; 1439 gaps (50 listed); uneven | 133920 | 2.941 to 100.0 | 59.0 | 62.4 |

<!-- tables:profile:end -->

### ffprobe equivalence

| Value | MP4 / MOV | Matroska / WebM |
|---|---|---|
| `avg_frame_rate` | `av_reduce(timescale x N, D)` with N = sum of stts counts (plus trun samples inside ffprobe's header extent) and D = sum of count x delta; edit lists are ignored | `av_reduce(1e9, DefaultDuration, 30000)`: declared, not measured; without a DefaultDuration ffprobe's estimate from the first packets, reproduced in probe and exact mode ([implementation notes](implementation-notes.md#ffprobe-frame-rates-without-defaultduration-020)) |
| `r_frame_rate` | stage 1 only: `timescale / d0` when every kept duration except the last equals the first; otherwise ffprobe uses probing heuristics and the app shows none | equals `avg_frame_rate` when it is between 5 and 1000; without a DefaultDuration ffprobe's estimate from the first packets, reproduced like `avg_frame_rate` |
| frames | `nb_frames` = sum of stts counts; fragmented files: `nb_read_packets` | `nb_read_packets`: blocks, with laces counted |
| presented frames | `nb_read_frames`: samples inside the first non-empty edit | same as frames |
| measured average | presented frames / (last PTS + stored duration of the last presented sample - first PTS), compared with the same value from ffprobe's packets; within one frame interval when ffprobe fills the last packet duration itself (VP9 in MP4) | frames / (last PTS + last duration - first PTS), compared with the same value computed from ffprobe's packets |

A track keeps two averages when they differ: `avgFps`, presented frames over the presentation span of the whole file, and `avgFpsFfprobe`, the string ffprobe 8.1.1 prints. The card shows both. The compare script checks `avgFpsFfprobe` against `avg_frame_rate` and `avgFps` against the packet-based average. The full rules, with FFmpeg source references, are in [docs/research.md](research.md#2-ffprobe-equivalence).

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

## Limitations

- Matroska has no frame index: an exact frame count, min, max and VFR flag need a block scan. `auto` mode runs it only when the predicted cost is within budget; otherwise the card shows a sampled probe until "Scan all frames" is pressed.
- Matroska timestamps are usually 1 ms ticks. CFR content shows a quantized min and max, and VFR between rates whose frame periods differ by less than about 1 ms is invisible.
- In MP4 and MOV, `r_frame_rate` is reproduced only for tracks with equal intervals (ffprobe's stage 1). For VFR ffprobe uses probing heuristics; the app shows a dominant rate or nothing. In Matroska and WebM without a DefaultDuration, the same heuristics, run on the first packets, are reproduced for both `avg_frame_rate` and `r_frame_rate` (VP8, VP9, AV1 and Baseline H.264 whose decoder delay its headers fix at 0, with Opus as the only other track kind); a Matroska DefaultDuration outside 5 to 1000 fps leaves `r_frame_rate` unreproduced.
- With a complete sidx, ffprobe 8.1.1 reads only part of a fragmented file. The app reports the full-file average as Average FPS and reproduces ffprobe's partial value in `avgFpsFfprobe`.
- ISMV (Smooth Streaming, `ffmpeg -f ismv`) with B-frames: fragments without `tfdt` and with negative composition offsets give a start of 0 instead of ffprobe's 0.04 s and a format duration about 20 ms off. Frames, rates and the VFR flag match.
- Compressed movie headers (`cmov`) and a moov above 256 MiB are unsupported. Only the first stsd entry is used.
- Multi-segment edit lists get a warning and presented frames follow the first non-empty edit; a rate other than 1 is warned only on that first edit.
- Speed was measured only in Chromium, on one Windows desktop: the current figures in Playwright's Chrome headless shell 156 with software video decoding; runs on earlier builds used installed Chrome and Edge 155 with GPU decoding. The e2e suite checks results, not speed, in Chromium, Firefox and WebKit (Firefox only in CI on Ubuntu, because the Playwright build does not start on the Windows development machine). Real Safari, iOS and Android devices, network shares and cloud placeholder files are untested ([Testing on your devices](../demo/README.md#testing-on-your-devices)), and the Matroska cost model and exact-scan budget were tuned in Node.
- Files above 4 GiB: offsets are 64-bit safe and a 4.5 GB sparse MP4 passes an opt-in Node test. The same file picked through the built page in Playwright gave the Node result (2 reads, 66,712 B, 90 frames, 30/1) in 1.8 to 5.6 ms in Chromium 156 and 7 to 10 ms in WebKit 27.2, three picks each; that was a manual run, not a committed test.
- A large Matroska file in `auto` mode usually ends as a probe. A 1 GB, 20 s H.264 MKV took 31 to 56 ms in Chrome (27 reads, 4.35 MB), and its card shows no frame count and no average until "Scan all frames" (601 reads, 2.5 MB, about 100 ms in Node). The same stream in MP4 takes 2 reads. The speed tables have no large Matroska row.
- requestVideoFrameCallback needs a visible foreground tab and a playable codec: HEVC did not play in headless Chrome and ProRes does not play in Chrome.
- Most of the corpus is synthetic (ffmpeg lavfi sources). Its real recorder output is the 12 MediaRecorder recordings of headless Chromium 156 above. Firefox and Safari recordings, phone, OBS, screen recorder and action camera files, mkvmerge files and interlaced content are not in it.
- A probe with 32 imitations of phone, screen and browser recordings (built with ffmpeg and Chrome's MediaRecorder, not committed) matched ffprobe on most fields. Since then the average follows the presented timeline (Chrome MediaRecorder fMP4 with overlapping `tfdt` gives frames / span, 45.57 instead of 42.87 fps), 240 and 48 fps at timescale 600 snap to 240/1 and 48/1, and a held last frame gets a warning. These issues stay open ([implementation notes, section 9](implementation-notes.md#9-known-differences-from-ffprobe-outside-the-fixture-set)):
  - The rate profile does not draw the stored duration of the last frame: a final frame held for 2.5 s (typical of QuickTime screen recordings) is a warning, not a freeze in the profile, and the profile ends that much before the reported duration; otherwise it can end a few ms after it. A segment's duration includes the freezes inside it while its rate does not.
  - The dominant rate share on the card counts frames, not time, so a 20 fps screen recording with short 60 fps bursts shows "dominant 60, 68% of frames" (an uneven track shows "varies" instead).
  - With the moov at the end, everything after the mdat is read in one go (up to 16 MiB), including large `free` or `uuid` boxes before the moov.
  - Chrome MediaRecorder WebM and MKV: the measured average differs slightly from ffprobe's (the last-frame rule of [the recordings](#browser-recordings-tier-r), scored within tolerance), and the warnings say "unfinished recording" for every such file.
  - Vendor data after the moov is reported as a truncated box, with raw bytes in the warning text.
  - Phone clips whose timestamps jitter by one tick (common at timescale 600) are VFR with a dominant 30 fps rather than a nominal 30 fps, while ffprobe prints `r_frame_rate` 30/1.
- The references are pinned to ffprobe 8.1.1; later FFmpeg versions changed some edge cases (trun bounds, edit lists).

## Browser support

What the build needs, from a syntax and API scan of the built chunks, with the first browser version that has each feature (MDN compatibility data; Edge follows Chrome):

| Needed for | Feature | Chrome, Edge | Firefox | Safari, iOS |
|---|---|---:|---:|---:|
| reading the file | `Blob.slice()` and `Blob.arrayBuffer()` | 76 | 69 | 14 |
| parsing off the main thread | module workers (`new Worker(url, { type: 'module' })`) with `import()` inside | 80 | 114 | 15 |
| 64-bit box sizes and offsets | `BigInt`, `DataView.getBigUint64` | 67 | 68 | 15 |
| the ES2022 build target | private class methods, logical assignment (`??=`) | 85 | 90 | 15 |
| the engine lookup of every worker (`worker-runtime`, the standalone file) | `Object.hasOwn` | 93 | 92 | 15.4 |
| keyboard focus ring (styling only) | `:focus-visible` | 86 | 85 | 15.4 |
| rVFC fallback (optional) | `requestVideoFrameCallback` | 83 | 132 | 15.4 |
| mp4box.js comparison (optional) | class static blocks in the mp4box chunk | 94 | 93 | 16.4 |

**Minimum: Chrome and Edge 94, Firefox 114, Safari and iOS Safari 15.4.** Everything runs there except the mp4box.js comparison on Safari before 16.4 and the rVFC fallback on Firefox before 132. On iOS, Chrome and Firefox normally run on WebKit, so they follow the Safari column. These floors are derived, not tested; no old browser version was run.

Tested:

- Chromium 156 and WebKit 27.2 (Playwright builds, Windows): the e2e suite, including the 360 px layout check with the Compare panel open. All committed fixtures, picked through the page, gave results equal to Node field by field.
- Firefox (Playwright build): passes the full suite in the CI job on Ubuntu (157 of 157 tests, first CI run 39679082486). On the Windows development machine the build does not start (`browserType.launch: spawn UNKNOWN`); the only confirmed cause is a Windows side-by-side (SxS) activation-context failure for its `mozglue` dependent assembly (SideBySide event 33 in the Application log) on that machine. Firefox e2e therefore runs in CI, and local runs cover Chromium and WebKit only.
- Playwright's Chrome headless shell 156 (`CHROME_PATH` to its `chrome-headless-shell.exe`, `BENCH_BROWSER_FLAGS=--no-sandbox`, over the DevTools Protocol): the timings on this page and the Node identity check. The current build has no Edge run.
- requestVideoFrameCallback: works in Chrome; the Windows WebKit build of Playwright has no `requestVideoFrameCallback`.
- Real Safari on macOS and iOS, Android Chrome and phone recordings: not yet, see the next section.

## Testing

**Fixture corpus.** Mostly synthetic files generated with ffmpeg 8.1.1 from lavfi test sources, plus 12 MediaRecorder recordings made by this repository (CC0); there is no third-party content. `fixtures/manifest.tsv` lists each file with its expected outcome:

<!-- tables:corpus:start -->

| Category | Fixtures | Committed | Expected outcome | Covers |
|---|---:|---:|---|---|
| cfr | 23 | 23 | ok | H.264 MP4 and VP9 WebM at film, PAL, NTSC and high frame rates |
| mov | 11 | 11 | ok | MOV and MP4 with and without B-frames, edit lists (empty edit, trimmed start), faststart |
| codec | 9 | 9 | ok | HEVC (hvc1, hev1), AV1, VP8, VP9 and ProRes in MP4, MOV, WebM and Matroska |
| fmp4 | 15 | 15 | ok | fragmented MP4: empty moov, default-base-is-moof, CMAF, DASH, sidx, hybrid |
| matroska | 2 | 2 | ok | H.264 in Matroska, WebM without DefaultDuration |
| live | 5 | 5 | ok | WebM from live, pipe and MediaRecorder-like muxing: unknown sizes, no Duration or Cues, a false Duration, an audio-only tail |
| vfr | 22 | 22 | ok | VFR from concatenation, non-linear setpts, frame dropping, mpdecimate, screen recording, pulldown, a 5/200 fps two-phase file, a 2 s freeze and changes after more than 5000 constant frames, also with B-frames, fragmented, in MOV, WebM and Matroska |
| box64 | 4 | 4 | ok | 64-bit mdat headers, co64 chunk offsets, an mdat with size 0 |
| multi | 4 | 4 | ok | video plus audio, two video tracks, a still image track before the video |
| cover | 3 | 3 | no-video, ok | cover art in M4A, MP4 and Matroska |
| audio | 3 | 3 | no-video | audio-only MP4, M4A and WebM |
| edge | 1 | 1 | still | a single-frame video |
| corrupt | 9 | 9 | error, ok | empty, random, text and PNG files, truncated moov, mdat or fragment, a lying stts count |
| sniff | 3 | 3 | ok | files with the wrong extension |
| recorder | 12 | 12 | ok | MediaRecorder output of headless Chromium 156: WebM VP8, VP9 and AV1, Matroska H.264, fragmented MP4 H.264 and VP9, each in one piece and with a 250 ms timeslice |
| long | 2 | 0 | ok | long CFR and VFR MP4 (generated, not committed) |
| big | 3 | 0 | ok |  |
| sparse | 1 | 0 | ok | sparse MP4 above 4 GiB with 64-bit offsets (generated, not committed) |
| **total** | 132 | 126 |  |  |

<!-- tables:corpus:end -->

**References.** `npm run fixtures:refs` stores, per fixture, ffprobe's stream and format JSON with `-count_frames -count_packets` and the packet timestamps of each video stream. From those it derives the presented timestamps, the deltas with and without the reorder tail, duplicates, the VFR flag under the same rule as the app, and the average from timestamps.

**Tolerances** ([research 6.4](research.md#64-tolerances)):

| Field | MP4 / MOV | Matroska / WebM |
|---|---|---|
| average | exact reduced rational vs `avg_frame_rate` | declared string exact; measured average vs the packet average within 1e-9 relative |
| nominal | exact vs `r_frame_rate` when CFR (stage 1), else not checked | declared string exact when DefaultDuration exists; without one, the ffprobe estimate exact (not checked in header mode) |
| frames, presented frames | exact vs `nb_frames` (fragmented: `nb_read_packets`) and `nb_read_frames` | exact vs `nb_read_packets` |
| min, max, VFR, duplicates | exact rationals and flags vs the reference timestamps | same, on 1 ms ticks |
| durations | `duration_ts`, `start_pts` exact; format duration within 1e-6 s | `format.duration` exact when Info Duration exists |
| codec, width, height | exact | exact |

**Known deviations** live in `fixtures/known-deviations/<engine>*.json`, one reason per fixture and field. An entry that no longer matches is reported as stale ([format](../fixtures/known-deviations/README.md)).

**Tests.** `npm test` runs unit tests (EBML VINTs, `av_reduce`, box headers, entry bounding, statistics, rate profile, cost model, lazy parser loading, device info and export, the demo's deploy check), fixture tests over every manifest row, rate profile tests on the VFR fixtures, regression tests from hostile-input reviews, and engine contract tests. `FPS_PROBE_LARGE=1` adds the long files and a generated 4.5 GB sparse MP4.

**End-to-end tests.** `npm run test:e2e` builds the app into `.playwright/dist`, serves it with `vite preview` on `127.0.0.1:4317` and runs `tests/e2e` in Chromium, Firefox and WebKit (`npx playwright install chromium firefox webkit` once):

- `parse.spec.ts` picks every committed fixture through the page's file input and requires the result to equal `analyze()` in Node on the same file, field by field except the timing: all fixtures in Matroska `exact` mode, the Matroska-named ones also in `header` mode.
- `ui.spec.ts`: no console errors, the sample files, "Scan all frames", the uneven badge and rate profile on the two-phase file, the compare panel with mp4box.js and mediabunny against the same engines in Node, the JSON export against the cards, no horizontal overflow at 360 px, and keyboard focus on the file input.
- `deploy.spec.ts` keeps a tab open across a simulated redeploy, where the probe client chunk, the worker script, the Matroska parser of a worker that already ran, or the rate profile and compare panels answer 404 with or without a new entry script in the page, and requires one reload banner when the page changed, `Worker could not be loaded:` on every file when it did not, and results after a reload.
- `rvfc.spec.ts` records the requestVideoFrameCallback estimate per browser as an attachment and fails only on a hang or an exception.

`npm run test:e2e -- --project=webkit` runs one browser, `npx playwright show-report .playwright/report` opens the report, and `E2E_BASE_URL=https://vbondarets.github.io/video-fps-probe/ npx playwright test` runs the same suite against the deployed demo instead of a local build.

**CI.** [ci.yml](../.github/workflows/ci.yml) has four jobs on Ubuntu: Verify (type check, lint, the source aliases, tests, the comparison against the committed references, the demo build, its size budgets and the generated tables), Package (check-dist self-test, `build:lib`, publint and check-dist, attw, dist parity and API types), End-to-end (the demo suite in Chromium, Firefox and WebKit) and Consumers (the packed tarball in the Vite 8 consumer fixtures: the size matrix, the generated tables against that measurement, and the smoke test under `vite build` and `vite dev` in all three browsers). [pages.yml](../.github/workflows/pages.yml) deploys `demo/dist/` to GitHub Pages.

## Reproducing the numbers

Node 22.12 or newer (CI uses the version in `.nvmrc`).

```
npm ci
npm run dev                      # Vite dev server
npm test                         # vitest: unit and fixture tests in Node
npm run test:e2e                 # Playwright: the built app in Chromium, Firefox and WebKit
npm run test:package             # after build:lib: analyze() from dist/ equals src/ on every committed fixture, and every name docs/api.md gives an entry resolves from the packed tarball
npm run typecheck                # tsc -b
npm run lint                     # oxlint
npm run compare                  # own and the five library arms vs the ffprobe references, writes report/accuracy.*
npm run build:lib                # build the library to dist/ (tsc, worker URL and d.ts rewrites, standalone worker)
npm run build                    # build the library, then type-check and build the demo to demo/dist/
npm run check:package            # publint and check-dist on dist/: file whitelist, pack listing, worker literals, peer isolation
npm run size                     # bundle size per chunk and budgets for demo/dist/, writes report/size.*
npm run consumers:setup          # npm pack, then install the tarball, vite, the peers and React (18 too) into a temp directory (--dir)
npm run consumers:build          # build the consumer fixtures of tests/consumers/fixtures/ there
npm run size:matrix              # package size per configuration from those builds, fails on a budget or a stale report/size-matrix.*
npm run size:matrix:write        # the same measurement, writes report/size-matrix.*
npm run test:consumers           # Playwright: each consumer fixture under vite build and vite dev equals Node analyze from the tarball
npm run bench                    # headless Chrome benchmark of demo/dist/, writes report/browser-bench.*
node scripts/readme-tables.ts    # refresh the generated blocks of README.md and docs/ from report/
```

- `npm run compare -- --with-large` also runs every local file in `fixtures/large` that is present (made by `npm run fixtures:generate -- --with-long`, `--with-big` or `--with-sparse`).
- `npm run size -- --check` exits 1 when a budget is exceeded; CI runs it.
- `npm run bench` needs a built `demo/dist/` and Chrome (or `CHROME_PATH`); Edge is added when installed. `BENCH_BROWSER_FLAGS` adds flags to every browser it starts, for example `--no-sandbox` for Playwright's `chrome-headless-shell`.
- `npm run test:e2e` needs the Playwright browsers once: `npx playwright install chromium firefox webkit`. See [Testing](#testing).

Fixtures need ffmpeg and ffprobe **8.1.1** on PATH (Git Bash on Windows, bash on Linux and macOS):

```
npm run fixtures:generate                    # core fixtures into fixtures/files, rewrites manifest.tsv
npm run fixtures:generate -- --with-long     # adds the two long files to fixtures/large
npm run fixtures:generate -- --with-sparse   # adds the 4.5 GB sparse file to fixtures/large
npm run fixtures:refs                        # ffprobe references into fixtures/ref
```

The committed files and references come from the ffmpeg 8.1.1 gyan.dev full build. Another build can encode different bytes, so `fixtures:refs` refuses any other ffprobe version unless `ALLOW_FFPROBE_MISMATCH=1` is set. See [fixtures/README.md](../fixtures/README.md).

The order and flags that regenerate every report are in [report/README.md](../report/README.md#regenerate-everything).
