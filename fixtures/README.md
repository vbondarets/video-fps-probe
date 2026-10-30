# Fixtures

Test corpus for the FPS probe, measured with ffprobe 8.1.1. 118 videos are built with ffmpeg 8.1.1 from lavfi
test sources (`testsrc2`, `sine`), and 12 are real MediaRecorder recordings of a canvas animation made by this
repository in headless Chromium, so there is no third-party content. 130 core fixtures (about 14.0 MB) are
committed; six optional heavy ones are generated on demand.

## Layout

| Path | Content | Committed |
| --- | --- | --- |
| `files/` | the 130 core fixtures | yes |
| `large/` | optional `--with-long`, `--with-sparse` and `--with-big` files | no (git-ignored) |
| `manifest.tsv` | one row per fixture, optional ones included | yes |
| `ref/<file name>.ref.json` | ffprobe ground truth per fixture | yes |
| `known-deviations/<engine>*.json` | accepted differences between an engine and ffprobe, one reason per fixture and field ([format](known-deviations/README.md)) | yes |

## Regenerate

Run from the repository root in Git Bash on Windows (not the WSL `bash.exe`, which cannot see the Windows
ffmpeg) or in bash on Linux and macOS. Needs Node 22.12 or newer and ffmpeg/ffprobe 8.1.1 on PATH with
libx264, libx265, libvpx, libaom, libopus and prores_ks.

```
npm run fixtures:generate                       # core set into fixtures/files, rewrites manifest.tsv
npm run fixtures:generate -- --with-long        # adds the two long files to fixtures/large
npm run fixtures:generate -- --with-sparse      # adds the 4.5 GB sparse file to fixtures/large
npm run fixtures:generate -- --with-big         # adds three 604 MB 1080p files to fixtures/large
npm run fixtures:refs                           # ffprobe references for every fixture present
```

Both scripts also accept a fixtures root as the first argument (`bash scripts/fixtures/generate-fixtures.sh /tmp/fx`),
which writes `files/`, `large/` and `manifest.tsv` under it. Generating the core set takes 2 to 3 minutes on
Windows (process start dominates), the long files add about 30 seconds, and the references take under a minute.

The generator fails when `files/` and `manifest.tsv` disagree. Output is byte-reproducible on the same ffmpeg
build: a second run into a separate folder gave identical bytes for all 104 core files of that date and the same
manifest (checked on 2026-10-21). The check ran only on those 104 files; the 7 core fixtures added later were not
re-checked. A run on 2026-10-30 reproduced all 165 core files and the manifest, but `vp8.webm` is not reliably
reproducible: libvpx VP8 with `-deadline realtime` adapts its speed to the wall clock, and runs on a loaded machine gave
other sizes. Do not commit a regenerated `vp8.webm` without comparing its bytes. `mov_cmov.mov` is reproducible only
with the same zlib: its cmov holds the output of `zlib.deflateSync` at level 9 in Node (both runs used Node 24.20.0,
zlib 1.3.2.1-motley), and another zlib build can emit other deflate bytes, so compare its bytes before a regenerated copy
is committed. WebM and Matroska
outputs use `-fflags +bitexact`, which removes random UIDs. The committed bytes come from ffmpeg
`8.1.1-full_build-www.gyan.dev`; another build can differ in encoder output, so the generator warns when the
version is not 8.1.1 and `fixtures:refs` refuses to run unless `ALLOW_FFPROBE_MISMATCH=1` is set.

## Manifest

Tab separated, header on the first line, notes never contain tabs.

| Column | Meaning |
| --- | --- |
| `name` | file name, also the key of the reference |
| `container` | what the file really is: `mp4`, `mov`, `webm`, `matroska` or `unknown` (not a container the app recognises) |
| `category` | group, see below |
| `expect` | outcome for the primary video track: `ok` (an FPS result), `no-video`, `still` (a single sample, no FPS), `error` (not a usable file) |
| `committed` | `yes` for `files/`, `no` for `large/` |
| `notes` | how the file is built and what it exercises |
| `path` | path relative to `fixtures/`, `files/<name>` or `large/<name>` |
| `code` | the expected file error code of a row that expects `error` (`empty-file`, `unrecognised`, `truncated`, `no-header`, `unsupported`), empty on every other row |

`expect=ok` does not mean ffprobe agrees. `corrupt_stts_count_huge.mp4` is `ok` because the app bounds the
lying `entry_count` by the box size and warns, while ffprobe fails on it (`ok: false` in its reference).
`corrupt_png_named.mp4` is `error` although ffprobe opens it as `png_pipe`, and `mov_cmov.mov` is `error`
although ffprobe reads its compressed moov and all 30 frames.

## Categories

| Category | Files | What it covers |
| --- | --- | --- |
| `cfr` | 23 | constant rates 23.976 to 240 fps, H.264 in MP4 and VP9 in WebM, exact rationals; two WebM files stream-copied to MP4 (timescale 16000, 1 ms grid) and 240 fps at timescale 600 |
| `vfr` | 22 | variable rate made by concat, `setpts`, `select`, `mpdecimate`, `setts` (2:3 pulldown) and stream copy, in MP4, MOV, WebM, fragmented MP4 and Matroska, plus the four rate profile fixtures and the three late-change fixtures below, a first frame held 2 s with B-frames and a `-ss -c copy` trim of a VFR file |
| `mov` | 13 | QuickTime and MP4 muxing variants, B-frames, edit lists (empty edit, trimmed start), faststart, bytes after the moov that are not a box, two sample descriptions |
| `fmp4` | 16 | fragmented MP4: `empty_moov`, `default_base_moof`, `global_sidx`, `dash`, `cmaf`, hybrid, DASH segments, plus two fragmented VFR files where ffprobe under-reads the fragments, a file with one fragment removed (tfdt gap), plain DASH output with B-frames (global sidx with a non-zero earliest presentation time) and an all-ones `mehd` |
| `codec` | 9 | HEVC (`hvc1`, `hev1`, in Matroska), AV1, VP8, VP9, ProRes |
| `matroska` | 2 | plain Matroska H.264, WebM without `DefaultDuration` |
| `live` | 5 | WebM written without seeking: unknown sizes, no Cues or Duration, a false Duration, audio that outlasts the video |
| `box64` | 4 | 64-bit `mdat` headers, `co64`, `mdat` with size 0 |
| `multi` | 4 | video plus audio, two real video tracks, a one-frame still track placed before the video |
| `cover` | 3 | cover art that ffprobe lists as an extra `attached_pic` video stream: M4A, MP4 and Matroska |
| `audio` | 3 | audio only (`no-video`) |
| `edge` | 1 | a single video sample |
| `corrupt` | 10 | empty, garbage, text, a PNG, truncated at different places, a lying `stts` count, an all-ones 64-bit `elst` duration |
| `sniff` | 3 | real containers under the wrong extension |
| `recorder` | 12 | MediaRecorder output of headless Chromium 156: WebM VP8, VP9 and AV1, Matroska H.264, fragmented MP4 H.264 and VP9, each in one piece and with a 250 ms timeslice (below) |
| `long` | 2 | optional: 3 h CFR at 60 fps (648,000 frames, 13 MB) and 1 h VFR screen recording (133,920 frames, 3.9 MB) |
| `sparse` | 1 | optional: 4.5 GB logical MP4 with `co64` offsets above 2^32 |
| `big` | 3 | optional: 60 s of 1080p30 H.264 (604 MB) with the moov at the end, the same with faststart, and the same stream in Matroska, for browser timing of a realistic upload |

## Rate profile fixtures

Four `vfr` files exercise the rate profile (segments, anomalies, the uneven flag). `tests/segments/fixtures.test.ts`
asserts their profiles, and their ffprobe references are checked like every other fixture.

| File | Built as | Expected profile |
| --- | --- | --- |
| `vfr_two_phase_5_200.mp4` | `testsrc2` at 5 fps for 4 s concatenated with 200 fps for 4 s (20 + 800 frames), H.264, `-fps_mode passthrough`, timescale 90000; average 205/2 | 2 steady segments (5 fps, 200 fps), 1 rate change at 4 s, uneven |
| `vfr_two_phase_5_200.webm` | the same two phases encoded as VP9 in WebM: 200 ms and 5 ms block timestamps | the same |
| `vfr_two_phase_5_200.mkv` | the H.264 MP4 stream-copied to Matroska | the same |
| `vfr_freeze_2s.mp4` | 30 fps H.264 whose frame 59 is held for 2 s (`setpts` at time base 1/90000): 120 frames over 5.967 s | 1 steady 30 fps segment, 1 freeze of 2 s at 1.967 s, uneven |

The commands are in section F of `scripts/fixtures/generate-fixtures.sh`.

## Late-change fixtures (Tier L)

Three `vfr` files, 64x36 and at most 1 MB each (443 KB together), stay constant for more than 5000 frames before the rate changes, far past a sampling probe such as mediabunny's default of 256 packets. They prove that a whole-file read sees what a sample misses; the predictions were committed in [docs/benchmarks.md](../docs/benchmarks.md#late-rate-changes-tier-l) before the comparison first ran on them. `tests/segments/fixtures.test.ts` asserts their profiles.

| File | Built as | Expected profile |
| --- | --- | --- |
| `late_30_to_60.mp4` | `testsrc2` at 30 fps for 200 s concatenated with 60 fps for 20 s (6000 + 1200 frames), H.264 at CRF 51, `-fps_mode passthrough`, timescale 90000; average 360/11 | 2 steady segments (30 fps, 60 fps), 1 rate change at 200 s, uneven |
| `late_25_to_12.5.webm` | 25 fps for 220 s concatenated with 12.5 fps for 40 s (5500 + 500 frames), VP9 at CRF 63 in WebM without a DefaultDuration (ffprobe's `avg_frame_rate` 25/1 is its estimate from the first packets) | 2 steady segments (25 fps, 12.5 fps), 1 rate change at 220 s, uneven |
| `late_freeze_10s.mkv` | 25 fps H.264 in Matroska whose frame 5999 is held for 10.04 s (`setpts` at time base 1/90000): 6250 frames over 260 s | 1 steady 25 fps segment, 1 freeze of 10.04 s at 239.96 s |

The commands are in section N of `scripts/fixtures/generate-fixtures.sh`.

## Header values other parsers trip on (section O)

Byte patches of ffmpeg output by `scripts/fixtures/tools/patch-mp4.mjs`, for header patterns reported against other parsers. Each keeps every sample offset valid, so ffprobe decodes the same frames as from the source file.

| File | Built as | ffprobe 8.1.1 | The app |
| --- | --- | --- | --- |
| `fmp4_mehd_all_ones.mp4` | `fmp4_default_base_moof.mp4` with a version 1 `mehd` of 0xFFFFFFFFFFFFFFFF appended to `mvex` (mode `mehd`; the data offsets are relative to each moof and the tfra offsets are shifted) | never reads `mehd`: the same values as the source file | ignores `mehd`: the same values as the source file |
| `corrupt_elst64_all_ones.mp4` | `cfr_h264_30.mp4` with its `elst` rewritten as version 1 and the segment duration 0xFFFFFFFFFFFFFFFF (mode `elst64`; the moov follows the mdat, so the chunk offsets stay valid) | fails: `Invalid edit list duration=-1`, `error reading header` | reads the edit as lasting to the end and warns; the values of `cfr_h264_30.mp4`, with `avgFpsFfprobe` and `rFpsFfprobe` null |
| `mov_trailing_junk.mov` | `mov_nobf_default.mov`, whose moov is the last box, with 16 bytes appended: a size of 0x7FFFFFFF, past the end of the file, and a type of four NUL bytes (mode `trailer`) | skips them: the same values as the source file | ignores them with `ignored trailing data at 88446: not a box`, so the file is not truncated: the same values as the source file |
| `mp4_stsd_two_entries.mp4` | `cfr_h264_30.mp4` with a copy of its `avc1` sample entry that says 320x180 and its one chunk split in two, so samples 46 to 90 point to the second description (mode `stsd2`) | reads both entries; codec, 160x90 from decoding, frames and rates as the source file | warns `2 sample descriptions, first used`; codec and size from the first entry, frames and rates from stts: the same values as the source file |

The commands are in section O of `scripts/fixtures/generate-fixtures.sh`.

Three more patches of `cfr_h264_30.mp4` are written by `tests/isobmff/fixtures.test.ts` rather than committed: its `mvhd`, `tkhd` or `mdhd` rewritten as version 1 with the duration 0xFFFFFFFFFFFFFFFF (modes `mvhd64`, `tkhd64` and `mdhd64`). The test checks the SHA-256 of each file and compares the app with what ffprobe 8.1.1 printed for those bytes with `-count_frames -count_packets`: the `mvhd` and `tkhd` files give the values of the source file, and the `mdhd` one 90 frames at 30/1 with a stream duration of 0 and no format duration.

## Browser recordings (Tier R)

Twelve `recorder` files are real browser output, not ffmpeg output. `scripts/fixtures/record-mediarecorder.mjs` drew a canvas animation (a frame counter, a moving square and a changing background) and recorded it with `canvas.captureStream()` and MediaRecorder:

- Browser: Playwright's headless Chromium 156.0.8078.4 (`chromium.launch({ headless: true })`, the headless shell), on Windows 10, recorded on 2026-10-24.
- Pacing: drawn on `requestAnimationFrame` for 1.5 s, paused for 0.6 s, drawn by a 15 fps `setInterval` until 3.6 s and on `requestAnimationFrame` again until 4.5 s. The drawing is the same in every run; the timestamps are what the browser recorded.
- Settings: 320x180, `videoBitsPerSecond` 250000, each type once without a timeslice and once with `start(250)`.
- Licence: CC0. The animation and the files were made by this repository, with no third-party content.

| File | Requested type | Recorded type | Timeslice | Frames drawn | Size |
| --- | --- | --- | --- | ---: | ---: |
| `rec_chromium_vp8.webm` | `video/webm;codecs=vp8` | `video/webm;codecs=vp8` | none | 166 | 86.9 KiB |
| `rec_chromium_vp8_sliced.webm` | `video/webm;codecs=vp8` | `video/webm;codecs=vp8` | 250 ms (15 chunks) | 166 | 86.2 KiB |
| `rec_chromium_vp9.webm` | `video/webm;codecs=vp9` | `video/webm;codecs=vp9` | none | 166 | 55.0 KiB |
| `rec_chromium_vp9_sliced.webm` | `video/webm;codecs=vp9` | `video/webm;codecs=vp9` | 250 ms (15 chunks) | 165 | 54.1 KiB |
| `rec_chromium_av1.webm` | `video/webm;codecs=av1` | `video/webm;codecs=av01` | none | 166 | 73.8 KiB |
| `rec_chromium_av1_sliced.webm` | `video/webm;codecs=av1` | `video/webm;codecs=av01` | 250 ms (15 chunks) | 166 | 73.8 KiB |
| `rec_chromium_h264.mkv` | `video/webm;codecs=h264` | `video/x-matroska;codecs=avc1` | none | 166 | 84.5 KiB |
| `rec_chromium_h264_sliced.mkv` | `video/webm;codecs=h264` | `video/x-matroska;codecs=avc1` | 250 ms (15 chunks) | 166 | 84.3 KiB |
| `rec_chromium_h264.mp4` | `video/mp4;codecs=avc1` | `video/mp4;codecs=avc1` | none | 165 | 85.2 KiB |
| `rec_chromium_h264_sliced.mp4` | `video/mp4;codecs=avc1` | `video/mp4;codecs=avc1` | 250 ms (7 chunks) | 166 | 85.4 KiB |
| `rec_chromium_vp9.mp4` | `video/mp4` | `video/mp4;codecs=vp9` | none | 166 | 49.1 KiB |
| `rec_chromium_vp9_sliced.mp4` | `video/mp4` | `video/mp4;codecs=vp9` | 250 ms (2 chunks) | 166 | 50.7 KiB |

WebM and Matroska recorded in one piece have a sized Segment, a Duration at or 1 ms after the last frame's timestamp (so the last frame gets almost no duration) and Cues; with a timeslice the Segment and Clusters have unknown sizes and there is no Duration and no Cues. None has a DefaultDuration. The MP4 files are fragmented (an empty moov, then moof and mdat pairs); in one piece Chromium adds an `mfra` and sets the mvhd duration, with a timeslice the mvhd duration stays 0. `video/webm;codecs=h264` records as `video/x-matroska;codecs=avc1` (DocType `matroska`) and plain `video/mp4` as VP9 in MP4, so the files are named after the type recorded.

The recordings are not byte-reproducible, so they are committed as recorded and frozen: a new recording is a new file, not a replacement. The recorder enforces that: `node scripts/fixtures/record-mediarecorder.mjs <outDir> [--browsers chromium,webkit,firefox]` needs the output directory (there is no default), refuses to overwrite a recording that exists there and exits 1 for it, and replaces one only with `--force`; `--list` needs no directory. The generator writes their manifest rows (section R) and, when it generates into another root, copies the committed recordings there. Playwright's WebKit 27.2 on Windows has no MediaRecorder, and its Firefox does not start on the maintainer machine; the manual workflow `.github/workflows/record-firefox.yml` records Firefox on Ubuntu and uploads the files as an artifact, to be reviewed before they are committed.

## Optional files

`--with-long` writes `large/long_cfr_3h_60fps.mp4` and `large/long_vfr_1h_screenrec.mp4` (17 MB together).

`--with-sparse` writes `large/sparse_4_5gb_co64.mp4`: ftyp, a 64-bit `mdat` that is mostly a hole, then moov with
offsets above 4 GiB. It occupies about 87 KB on NTFS, ext4 and APFS. Do not copy it with a tool that expands
sparse files, and delete it after use. On Windows the generator sets the sparse flag with `fsutil`. Node 24 wraps
`openAsBlob().size` modulo 2^32 for this file, so tests must read it through a Blob-like wrapper over
`fs.promises.open`. Its reference is committed (`ref/sparse_4_5gb_co64.mp4.ref.json`, probed without
`-count_frames`), so the sparse file itself never needs to be kept.

`--with-big` writes `large/big_1080p_moov_end.mp4`, `large/big_1080p_faststart.mp4` and `large/big_1080p.mkv`
(604 MB each, about 10 s to encode). The encode uses CRF and a seeded noise filter, so the bytes are reproducible on
the same ffmpeg build (rate-controlled `-b:v` was not). Their references are committed; delete the files after use.

`crashed.mkv` (ffmpeg killed mid-write) from the research is not part of the corpus because it is not
byte-reproducible.

## References

`ref/<file name>.ref.json` is deterministic for a given ffprobe build: no timings, no absolute paths.
Schema version 1:

| Key | Content |
| --- | --- |
| `schema`, `file`, `bytes` | schema version, file name, size in bytes |
| `ffprobeVersion` | the first line of `ffprobe -version` |
| `countFrames` | whether `-count_frames` ran (false only above 4 GiB) |
| `ok`, `exitCode`, `stderr` | `ok` is false when ffprobe could not open the file; `stderr` holds its messages with the file name replaced by `<file>` and addresses removed |
| `probe` | raw output of `ffprobe -v error -show_streams -show_format -count_frames -count_packets -show_optional_fields always -of json`, with `format.filename` equal to the bare file name |
| `attachedPicStreams` | indexes of `attached_pic` video streams (never use `v:0` blindly) |
| `videoStreams[]` | one entry per real video stream, see below |
| `probeExit`, `probeErr`, `format`, `streams[]`, `videos[]` | compact summary in the shape of the earlier research references, see below |

A key that is missing from `probe` and the string `"N/A"` both mean not available.

The summary block (`format`, `streams[]`, `videos[]`) is value-for-value identical to the research reference
files for the 95 fixtures they covered (only `profile: "unknown"` now appears on the PNG, because of
`-show_optional_fields always`). `videos[]` holds one entry per real video stream with `avg_frame_rate`,
`r_frame_rate`, `nb_frames`, `nb_read_frames`, `duration`, `start_time`, `time_base` and a `packets` object
(`minInstFps`, `maxInstFps`, `avgFpsFromPts`, `vfrByDeltaRatio`, ...). Its numbers keep the research
definitions: they count every packet including the ones the edit list discards, and use the duration of the last
packet in file order. Use `videoStreams[]` for exact comparisons.

`videoStreams[]` is computed from `ffprobe -select_streams <index> -show_entries packet=pts,dts,duration,flags`
and follows `docs/research.md` section 4.3. All times are integer ticks of `timeBase`.

| Key | Content |
| --- | --- |
| `index`, `codecName`, `width`, `height`, `timeBase` | from the probe |
| `packets`, `presentedPackets`, `discardedPackets`, `keyframes` | packet counts; a packet whose flags contain `D` was discarded by the edit list and is not presented |
| `ptsPresented` | sorted PTS of the presented packets |
| `deltas` | consecutive differences of `ptsPresented` |
| `duplicateTimestamps` | number of deltas that are 0 or less |
| `reorderDepth` | `min(16, ceil((max(pts - dts) - min(pts - dts)) / first positive delta))`, 0 without composition offsets |
| `tailDropped` | `min(positive deltas, 1 + reorderDepth)` |
| `deltasExcludingTail` | the positive deltas minus the last `tailDropped` ones |
| `deltaHistogramAll`, `deltaHistogramExcludingTail` | delta in ticks mapped to its count |
| `instFpsAll`, `instFpsExcludingTail` | `{ count, minDeltaTicks, maxDeltaTicks, distinctDeltas, minFps, maxFps }` where an FPS is the reduced rational `{ num, den, value }` equal to `timeBase.den / (delta * timeBase.num)` (`minFps` uses the largest delta) |
| `vfr` | `{ isVfr, medianDeltaTicks, toleranceTicks, vfrRatio }` over `deltasExcludingTail`: median is the lower median, `tolerance = max(1, round(0.005 * median), 1 ms in ticks)`, where the 1 ms term counts only when a tick is at most 1 ms and every delta is a whole number of milliseconds, VFR when any delta is further than the tolerance from the median, `vfrRatio = max delta / min delta`; `null` when there are no deltas |
| `avgFromPts` | `{ frames, firstPts, lastPts, lastDurationTicks, spanTicks, fps }` with `fps = frames / (lastPts + lastDuration - firstPts)` as a reduced rational, using the duration of the packet that has the greatest PTS |
| `lastPacketEnd` | `{ ticks, seconds }` for `lastPts + lastDuration` |
| `arraysOmitted` | true when the stream has more than 20,000 presented packets; `ptsPresented`, `deltas` and `deltasExcludingTail` are then `null` and only the histograms remain |

## Known deviations

Accepted differences between an engine and ffprobe live in `known-deviations/`, one JSON file per engine part
(`own-isobmff.json`, `own-matroska.json`, optional files for the library engines). Each entry maps a fixture and a
field to a plain reason; an entry that no longer matches is reported as stale. The format and the rules are in
[known-deviations/README.md](known-deviations/README.md). The own engine has no entry today: both
files are empty, and the last-frame difference of Matroska files that store no last frame duration is a rule of the
comparison instead (within-tol, [benchmarks](../docs/benchmarks.md#browser-recordings-tier-r)).
