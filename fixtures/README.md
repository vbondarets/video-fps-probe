# Fixtures

Synthetic test corpus for the FPS probe, built with ffmpeg 8.1.1 and measured with ffprobe 8.1.1.
Every video is generated from lavfi test sources (`testsrc2`, `sine`), so there is no third-party
content. 111 core fixtures (about 12.3 MB) are committed; six optional heavy ones are generated on demand.

## Layout

| Path | Content | Committed |
| --- | --- | --- |
| `files/` | the 111 core fixtures | yes |
| `large/` | optional `--with-long`, `--with-sparse` and `--with-big` files | no (git-ignored) |
| `manifest.tsv` | one row per fixture, optional ones included | yes |
| `ref/<file name>.ref.json` | ffprobe ground truth per fixture | yes |
| `known-deviations/<engine>*.json` | accepted differences between an engine and ffprobe, one reason per fixture and field ([format](known-deviations/README.md)) | yes |
| `known-deviations.json` | empty placeholder from the research, no longer read | yes |

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
build: a second run into a separate folder gave identical bytes for all 104 core files and the same manifest
(checked on 2026-10-21). WebM and Matroska
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

`expect=ok` does not mean ffprobe agrees. `corrupt_stts_count_huge.mp4` is `ok` because the app bounds the
lying `entry_count` by the box size and warns, while ffprobe fails on it (`ok: false` in its reference).
`corrupt_png_named.mp4` is `error` although ffprobe opens it as `png_pipe`.

## Categories

| Category | Files | What it covers |
| --- | --- | --- |
| `cfr` | 23 | constant rates 23.976 to 240 fps, H.264 in MP4 and VP9 in WebM, exact rationals; two WebM files stream-copied to MP4 (timescale 16000, 1 ms grid) and 240 fps at timescale 600 |
| `vfr` | 19 | variable rate made by concat, `setpts`, `select`, `mpdecimate`, `setts` (2:3 pulldown) and stream copy, in MP4, MOV, WebM, fragmented MP4 and Matroska, plus the four rate profile fixtures below, a first frame held 2 s with B-frames and a `-ss -c copy` trim of a VFR file |
| `mov` | 11 | QuickTime and MP4 muxing variants, B-frames, edit lists (empty edit, trimmed start), faststart |
| `fmp4` | 15 | fragmented MP4: `empty_moov`, `default_base_moof`, `global_sidx`, `dash`, `cmaf`, hybrid, DASH segments, plus two fragmented VFR files where ffprobe under-reads the fragments, a file with one fragment removed (tfdt gap) and plain DASH output with B-frames (global sidx with a non-zero earliest presentation time) |
| `codec` | 9 | HEVC (`hvc1`, `hev1`, in Matroska), AV1, VP8, VP9, ProRes |
| `matroska` | 2 | plain Matroska H.264, WebM without `DefaultDuration` |
| `live` | 5 | WebM written without seeking: unknown sizes, no Cues or Duration, a false Duration, audio that outlasts the video |
| `box64` | 4 | 64-bit `mdat` headers, `co64`, `mdat` with size 0 |
| `multi` | 4 | video plus audio, two real video tracks, a one-frame still track placed before the video |
| `cover` | 3 | cover art that ffprobe lists as an extra `attached_pic` video stream: M4A, MP4 and Matroska |
| `audio` | 3 | audio only (`no-video`) |
| `edge` | 1 | a single video sample |
| `corrupt` | 9 | empty, garbage, text, a PNG, truncated at different places, a lying `stts` count |
| `sniff` | 3 | real containers under the wrong extension |
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
| `vfr` | `{ isVfr, medianDeltaTicks, toleranceTicks, vfrRatio }` over `deltasExcludingTail`: median is the lower median, `tolerance = max(1, round(0.005 * median))`, VFR when any delta is further than the tolerance from the median, `vfrRatio = max delta / min delta`; `null` when there are no deltas |
| `avgFromPts` | `{ frames, firstPts, lastPts, lastDurationTicks, spanTicks, fps }` with `fps = frames / (lastPts + lastDuration - firstPts)` as a reduced rational, using the duration of the packet that has the greatest PTS |
| `lastPacketEnd` | `{ ticks, seconds }` for `lastPts + lastDuration` |
| `arraysOmitted` | true when the stream has more than 20,000 presented packets; `ptsPresented`, `deltas` and `deltasExcludingTail` are then `null` and only the histograms remain |

## Known deviations

Accepted differences between an engine and ffprobe live in `known-deviations/`, one JSON file per engine part
(`own-isobmff.json`, `own-matroska.json`, optional files for the library engines). Each entry maps a fixture and a
field to a plain reason; an entry that no longer matches is reported as stale. The format and the rules are in
[known-deviations/README.md](known-deviations/README.md). The own engine has three entries today, all listed in the
main README. The top-level `known-deviations.json` is the empty placeholder of the research and is not read.
