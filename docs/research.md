# FPS PoC: research synthesis and implementation spec

**Scope.** This is a client-side FPS analyzer for video files that the user picks or drops. It is built with React, Vite and TypeScript and has no server. Date: 2026-10-21.

**Status keys:**
- **V**: confirmed by an independent verification pass, or corrected by one. Where a pass corrected a claim, the corrected form is the one stated here.
- **U**: evidence from a single stream only.

**Measurement setup.** Unless a number is marked "Chrome 155", it was measured on this machine: Windows 10, Node 24.20, ffmpeg/ffprobe 8.1.1 (gyan full build).

**Pinned sources:**
- npm registry via `npm view`, 2026-10-21.
- FFmpeg tag `n8.1.1`: tag object 150ba6dd, commit 239f2c733de4. This is the same version as the local ffprobe.
- RFC 9559 (Matroska) and RFC 8794 (EBML).
- @mdn/browser-compat-data 8.1.6.
- WICG video-rvfc draft of 2024-08-02, commit f2fc3e608c.
- mp4box tag v2.4.1 (8ad48af8) and mediabunny tag v1.62.0 (03d524ff).
- Chromium main 970f0cb5fc / f28aa18be9 and mozilla-firefox main 0f76fed7aea1.

## 1. Research summary

1. **MP4/MOV `avg_frame_rate` in ffprobe comes from the header.** The formula is `av_reduce(timescale * sum(stts counts), sum(count * delta), INT_MAX)` (mov.c:3636-3647, 6048-6053, 11004-11006). A plain stts/trun parser reproduces it exactly (V: 31/31 tracks, plus 14 and 32 independent fixtures).
2. **Matroska `avg_frame_rate` and `r_frame_rate` are declared, not measured.** Both are `av_reduce(1e9, DefaultDuration, 30000)` (matroskadec.c:3014-3022) (V).
3. **Exact min/max instantaneous FPS and the VFR flag need per-sample timestamps.**
   - MP4 stores them in moov/moof, so a non-fragmented file needs 1-2 reads.
   - Matroska has no frame index, so exact values need a walk over every block header. That is O(frames) (V).
4. **Own parsers are small and exact.**
   - MP4 reader, parser and statistics: 5.5 KB gzip (U).
   - EBML analyzer: 4.9 KB gzip, minified (V).
   - For comparison, mp4box is about 41 KB and mediabunny with MKV about 51 KB. Both deviate from ffprobe in documented ways.
5. **React 19.3.1 dominates the bundle at about 67.5 KB gzip.** Preact would be 5.5-7.1 KB, but the project uses React. Preact stays an option, not a default (V).
6. **rVFC playback is only an approximate fallback.** It works in all current engines, but:
   - it needs a visible tab and a playable codec;
   - it costs 1.8-3.4 s per file;
   - it fails on low-refresh displays unless the slow-motion rate adapts (V).
7. **Each browser read has a fixed cost.**
   - In Chrome 155 a `Blob.slice().arrayBuffer()` call costs about 0.65-0.85 ms, about 5x the Node cost of 0.13-0.15 ms.
   - The number of reads, not the bytes, decides the speed of small reads.
   - The slow cases are fragment-per-frame MP4 and exact MKV scans (V).

### 1.1 Libraries

**How sizes were measured:**
- Minimal realistic entry, built with esbuild 0.28.2 (ESM, minify, platform browser, target es2022).
- Compressed with gzip -9 and brotli q11.
- Verification reproduced these sizes within about 1%. Vite 8.3.5 worker chunks are about 3% smaller.

| Library | Version (published) | min / gzip (B) | brotli | Partial reads | moov at end | Fragmented | 64-bit | WebM/MKV | Per-sample durations | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| Own MP4 parser (prototype) | - | 13,557 / 5,475 (reader + parser + stats); size probe 2,423 / 1,160 | ~4.9 KB; probe 1,092 | yes, windowed | 2 reads, 67 KB on a 189 MiB file | yes, one read per moof, coalesced | yes: largesize, co64, 4.5 GB sparse | no | stts/ctts/trun, exact | **primary** |
| Own EBML analyzer (prototype) | - | ~11.7 KB / 4.9 KB (all modes, incl. Node glue); header probe 981 / 647 | probe 575 | yes | - | - | VINT up to 8 B | header in 1-2 reads; exact block walk | block timestamps (1 ms ticks) | **primary** |
| mp4box | 2.4.1 (2026-06-19) | 181,857 / 41,490 | 35,504 | yes, caller-driven `appendBuffer` | yes | yes, but only if the caller feeds ftyp + moov (+sidx) and each moof plus the next 16 B (reads 0.02-0.34%). A naive `appendBuffer` cursor loop reads 100% (V) | yes | no | yes, but the last sample's duration is overridden to `mdhd.duration - last dts` | comparison arm |
| mp4box/simple | 2.4.1 | 129,352 / 30,297 | 26,614 | - | - | - | - | no | broken: no stts/stsz/stsc/stco/ctts registered. The last-imported flavor wins the shared registry (V) | skip |
| mediabunny | 1.62.0 (2026-10-20) | MP4+MOV 145,079 / 41,238; +WebM/MKV 192,209 / 52,599; ALL 323,448 / 87,260 | 36,190 / 44,766 / 72,887 | yes, `BlobSource` with 8 MiB cache | yes, 213-301 KB | yes, about 1% of file; fragment-per-frame about 100% | yes | yes, but loads whole clusters, so exact stats read about 100% | yes, but `averageFrameRate` = (N-1)/PTS span and it applies only the first edit | cross-check arm; exact-MKV reference |
| @remotion/media-parser | 4.0.537 (2026-10-19) | 256,393 / 71,395 | 58,174 | yes | yes | fps null | yes | fps null | no; fps = N / mdhd seconds | skip: deprecated (`dist/parse-media.d.ts`), non-OSI Remotion License |
| music-metadata | 12.2.3 (2026-10-18) | 277,480 / 80,873 | 69,305 | yes, 5-10 KB | yes | yes, but 14,451 reads for 1,200 one-frame fragments | yes | DefaultDuration only | no (single frameRate) | optional harness reference |

**Other libraries, all skipped:**
- isobmff-inspector 0.5.0 reads 100% of the file via `stream()`.
- ts-ebml 3.0.2 costs 70.9 KB gzip for a header read, and needs the alias `ebml -> ebml/lib/ebml.esm.js` to run in a browser.
- mux.js 6.3.0 (6.9 KB) and codem-isoboxer 0.3.10 (5.6 KB) do not read files.
- WASM options are excluded:
  - web-demuxer 4.0.0: 43.5 KB JS plus 422.7 KB gzip WASM.
  - mediainfo.js 0.3.8: 979 KB gzip WASM. It reads 43-44% of the file and its frame counts disagree with ffprobe on edit-listed files.
  - @ffmpeg/core 0.12.10: 10,257,774 B gzip.
- mediabunny with Matroska only (MATROSKA + WEBM) is 36.2 KB gzip.

### 1.2 Toolchain (npm, 2026-10-21)

| Package | Version | Published | Notes |
|---|---|---|---|
| vite | 8.3.5 | 2026-10-21 | Rolldown-based; Node ^20.19 or >=22.12 |
| @vitejs/plugin-react | 6.1.2 | 2026-10-05 | requires vite ^8 |
| react, react-dom | 19.3.1 | 2026-10-14 | @types/react and @types/react-dom are 19.3.0 |
| typescript | 7.0.2 | 2026-07-08 | `tsc -b` passes on the template. create-vite pins ~6.0.3, which is the fallback |
| vitest | 5.0.5 | 2026-10-15 | Node ^22.12, ^24 or >=26; the Blob.slice smoke test passes |
| create-vite | 9.3.1 | 2026-10-20 | `npx create-vite@9.3.1 app --template react-ts --no-interactive`; the template uses oxlint ^1.88.0 and @types/node ^24.19.2 |
| esbuild | 0.28.2 | 2026-08-08 | used for size measurement |
| preact (option only) | 11.0.1 | 2026-10-08 | @preact/preset-vite 2.10.6 |

**Baseline production builds (gzip -9):**

| Build | Raw | gzip | brotli |
|---|---|---|---|
| Unmodified create-vite react-ts template | 222,459 | 68,401 | 58,888 (+4.1 KB CSS) |
| Minimal React app | - | 67,471-67,749 | - |
| Preact, native | - | 5,499-5,820 | - |
| Preact via compat | - | 6,780-7,095 | - |

**Worker format.** Use a module worker: `new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })`. It builds cleanly on Vite 8.3.5.

## 2. ffprobe equivalence

### 2.1 MP4/MOV, per video trak

**Inputs to the formulas:**
- **ts** = mdhd.timescale. A value <= 0 becomes 1. A missing mdhd falls back to the mvhd timescale.
- **N** = sum of stts counts. **D** = sum of count x delta.
- N and D also include every trun sample read during ffprobe's header phase. A trun sample's duration comes from the trun (flag 0x100), else the tfhd default (0x08), else the trex default.
- Any delta > 4294487295 (`max_stts_delta`) is replaced by 1 (mov.c:3616-3634).
- Use BigInt for ts x N, because the product exceeds 2^53 on long files.

| Field | Exact rule | Status |
|---|---|---|
| avg_frame_rate | `av_reduce(ts*N, D, 2147483647)`. Gives 0/0 if N or D is 0. Ignores edit lists and mdhd. av_reduce divides by the gcd, then uses a continued-fraction best approximation if the result exceeds INT_MAX (rational.c:34-75; validated with stts `999999x1001, 4x997` giving 807689923/26949920) | V |
| r_frame_rate | **Stage 1 (reproduce this):** take the per-sample durations retained after edit-list indexing (`mov_fix_index`). If every duration except the last equals the first, r = `av_reduce(ts, d0)`. When an elst ends before the media, the index stops at the first keyframe at or after the edit end, or one keyframe later when ctts is present (mov.c:4504-4527; check the boundary in source). **Stages 2-4 are heuristics:** rfps on the first 99 DTS at header time; then find_stream_info on 21 packets (41 if ts < 2000), capped by probesize (5,000,000 B) and analyzeduration, with `duration_gcd` carried over from stage 2; then the codec rate (x2 for H.264) or 1/time_base. Do not port stages 2-4. If stage 1 fails, report "not reproduced" | V |
| nb_frames | Sum of moov stts counts, not the stsz count. Prints N/A for fragmented files with empty_moov (the JSON omits the key). For hybrid `frag_keyframe` files without empty_moov it is the first fragment's count (30 of 120, 30 of 140) | V |
| nb_read_packets (`-count_packets`) | All samples, including edit-discarded ones. Lower when an elst ends early (61 of 150) | V |
| nb_read_frames (`-count_frames`) | Frames left after the decoder drops samples outside the edit list. Model: samples with PTS in [media_time, media_time + rescaled segment_duration) of the first non-empty edit. Matched 167/122, 110/74 and 90/69 | U |
| duration_ts | min of: mdhd.duration (all ones becomes 0); D if D > 0; the sum of elst durations including empty edits, rescaled from mvhd to mdhd with `av_rescale` rounding half up | V |
| start_pts | Sum of leading empty edits, rescaled. Without elst it is ctts[0] (2002 at 30000 = 0.067 s for B-frames) | V |
| Fragmented duration | max(non-fragmented value, last trun end). trun start DTS = tfdt - time_offset, where time_offset = media_time - empty duration. A sidx *assigns* earliest_pts + sum(subsegment_duration) in sidx timescale. With B-frames this sidx end includes the composition delay (8.083333 vs 8.0) | V / U |
| Format duration | Max over audio and video streams of max(duration, max end - min start). Subtitle and data streams count when they extend it by less than 1 s. N/A when all are 0. mvhd and tkhd durations are never used | V |
| width/height | ffprobe uses the decoder SPS values after find_stream_info. The app uses the stsd VisualSampleEntry at entry+32 / +34. They differ only when stsd and SPS disagree. tkhd width/height (16.16) feeds only SAR; pasp gives SAR | V |
| rotation | tkhd matrix x mvhd matrix, exported only when not identity. ffprobe = -atan2(b/s1, a/s0) x 180/pi with s0 = hypot(a, c), s1 = hypot(b, d). ffprobe does not swap width and height | U |
| codec_name | fourcc table below. For encv, take the original fourcc from sinf/frma | U |

**Header extent (V).** ffprobe stops walking top-level boxes once it has found moov and mdat and either `frag_index.complete` is set or the box end equals the file size (mov.c:9740-9746). What it reads depends on the sidx layout:

| Layout | Fragments read | Example (60->20 fps VFR) |
|---|---|---|
| No sidx | all | correct average |
| Global sidx (`+global_sidx`) | the first fragment only | avg 60/1 vs true 4200/149 |
| Per-fragment sidx (`+dash`, `+cmaf`) | all but the last | 30/1 vs true 4200/149 |

- mfra is ignored by default. The exception is a `free` box starting with "Anevia\x1A\x1A".
- The last 4 bytes of the file are always read as the mfra size.
- **The app reports the full-file value and flags ffprobe's under-read.**

**Version drift (V).** n8.1.3 and n9.0.2 behave the same as 8.1.1 on valid files, with two exceptions:
- They reject a trun whose sample count exceeds its payload; 8.1.1 reads to EOF instead.
- Master since 2026-10-12 skips empty edits in the middle of a list and keeps the duration of negative media-time edits.

So pin ffprobe 8.1.1 for the reference data.

**fourcc to codec_name** (isom_tags.c:29-300):

| fourcc | codec_name |
|---|---|
| avc1, avc2, avc3, avc4 | h264 |
| hvc1, hev1 (dvh1 is handled in mov.c) | hevc |
| vp08 | vp8 |
| vp09 | vp9 |
| av01 | av1 |
| vvc1, vvi1 | vvc |
| mp4v (esds object type can remap it) | mpeg4 |
| apch, apcn, apcs, apco, ap4h, ap4x | prores |
| jpeg, mjpa | mjpeg |
| AVdn, AVdh | dnxhd |
| m2v1 | mpeg2video |
| h263, s263 | h263 |
| anything else | look it up in the same table |

### 2.2 Matroska/WebM

| Field | Exact rule | Status |
|---|---|---|
| avg_frame_rate | `av_reduce(1e9, DefaultDuration, 30000)`. Examples: 33366666 gives 30000/1001; 41708333 gives 24000/1001; 16683333 gives **19001/317** (ffmpeg truncates DefaultDuration). If DefaultDuration is missing but the reclaimed Video\FrameRate (0x2383E3) exists, DefaultDuration = 1e9/FrameRate. If both are missing, ffprobe estimates from about 40 packets and snaps to a standard rate (59.94 becomes 60000/1001); that value cannot be reproduced | V (14/14 and 15/15 fixtures) |
| r_frame_rate | Equal to avg only when 5 < avg < 1000. Otherwise find_stream_info derives it (a 2 fps file shows 2/1) | V |
| Meaning of DefaultDuration | For VFR that ffmpeg *encodes*, it is the nominal rate (60/1 while the true average is 43.34). For *stream-copied* VFR it is the source average (130/3, the true value), and every block is a BlockGroup with a BlockDuration | V |
| nb_frames, stream duration | Always N/A for video. The JSON omits them unless `-show_optional_fields always` is passed. Audio-only files without Duration can get a bitrate-estimated duration (4.016 s in one fixture) | V |
| nb_read_packets = nb_read_frames | Number of blocks, with laces counted individually | V (20/20, 18/18) |
| Packet PTS | ns = (Cluster\Timestamp + block relative ts x TrackTimestampScale) x TimestampScale - CodecDelay (RFC 9559 section 11). ffmpeg always writes TimestampScale = 1,000,000, so ticks are 1 ms | V |
| Packet duration | BlockDuration if present, else DefaultDuration x laces / TimestampScale with integer division (29.97 fps gives 33 ms; matroskadec.c:4201-4202) | V |
| format.duration | Info\Duration x TimestampScale / 1e9. A Duration of 0 counts as absent and prints N/A. It is the end over all tracks (5.023 from AAC vs a video DURATION tag of 5.000). It can be wrong: pipe output with `-t` writes an early Duration (10.000 for 3.0 s of content) | V |
| width/height | PixelWidth (0xB0) / PixelHeight (0xBA) | V |
| codec_name | CodecID map (matroska.c:80-113): V_VP8 vp8, V_VP9 vp9, V_AV1 av1, V_MPEG4/ISO/AVC h264, V_MPEGH/ISO/HEVC hevc | U |
| format_name | Always `matroska,webm`. Use DocType to tell WebM from Matroska | U |
| DURATION tag | Per-track SimpleTag `HH:MM:SS.nnnnnnnnn`, written only for seekable output. TagTrackUID is 64-bit, so use BigInt. Keys can carry a `-<lang>` suffix | V |

### 2.3 Which streams count as video

**MP4/MOV:**
- A trak is video when its handler_type is 'vide' in **mdia/hdlr only**. MOV has a second hdlr under minf, and ffmpeg MP4 has one under udta/meta.
- A non-audio trak whose sample-entry fourcc is a known video tag also counts as video.
- tmcd tracks are data. Text and chapter tracks are not video.

**What ffprobe adds or keeps beyond real video tracks:**
- Cover art (udta/meta/ilst/covr) appears as an extra `attached_pic` video stream that is not a trak: r 90000/1, avg 0/0, nb_frames N/A. It shifts stream indexes and can be `v:0`.
- Traks referenced as chapters (tref chap) become attached_pic + timed_thumbnails.
- 1-sample still traks are real video streams.
- Matroska image attachments also appear as attached_pic video streams.

**Primary track (app rule):**
- List all video tracks.
- MP4/MOV primary: the enabled track (tkhd flags & 1) with the most samples, ignoring tracks with 1 sample or fewer.
- Matroska primary: the first track with TrackType 1. Do not use FlagDefault: ffmpeg writes 0 for lavfi tracks.

**Harness rule:** filter ffprobe streams by `disposition.attached_pic == 0` and never trust `v:0`.

## 3. Approach comparison

| Approach | Accuracy vs ffprobe | Bytes read | Reads | Speed | gzip | Risk |
|---|---|---|---|---|---|---|
| **Own parsers** | **MP4:** avg, nb_frames and duration exact on every MP4 fixture; min/max exact from stts/ctts/trun. **MKV:** header strings exact when DefaultDuration exists; the exact walk equals ffprobe packet counts and PTS deltas | faststart: 64 KiB. moov at end: ~67-70 KB on 189 MiB. 216k-sample B-frame moov: 2.7 MB. MKV header: 65-75 KB | 1 (faststart); 2 (moov at end); 13-16 for 3,574 coalesced fragments; MKV 1-2 header reads, exact scan scales with blocks or bytes/window | **Node, warm:** 0.24-1.9 ms; 28-31 ms for 216k samples (stats dominate); 240-320 ms for 1,290 one-frame fragments; MKV exact 0.1-0.9 s for 3.6k-36k frames | 5.5 + 4.9 | own code for trex, multi-edit and cmov edge cases |
| mp4box 2.4.1 | avg is exact only if computed from the stts box. Sample-duration paths are wrong whenever mdhd != stts sum, which includes ordinary x264 B-frame files (summed avg 29.846 vs 29.970; last sample 2x) | 1.05 MB with 1 MiB chunks; 65-78 KB with 64 KiB chunks; fragmented 11-154 KB with custom feeding | caller-driven | 3-10 ms non-fragmented (Node) | 40.7-41.5 | last-sample override; #544 (uint64 above 2^53, open); #570 (only the first trun data_offset, open PR) |
| mediabunny 1.62.0 | avg = (N-1)/span: -0.15% on VFR, -1.19% on edit-listed files with a spurious min of 9.99; exact on plain CFR. MKV exact, but by a full read | 65 KB (faststart); 213-301 KB (moov at end); about 1 MB fragmented (45 MB file); MKV exact about 100% | 690 reads for a 45 MB MKV | MP4 10-31 ms; 586 ms for 216k samples; MKV exact 117-237 ms | 41.2 (MP4), 50.9-52.9 (with MKV) | edit lists partial (#494); no VFR flag in PacketStats (#320); a truncated file looks like "no video" (but `getTracks().length` is 0, while audio-only has 1 track) |
| @remotion/media-parser | fps = N / mdhd seconds: -0.41% on an 8 s B-frame CFR file, -1.77% edit-listed; null for fragmented MP4 and MKV | 131-200 KB | - | 5-16 ms | 71.4 | deprecated; non-OSI licence |
| rVFC fallback | within 0.19% on CFR in Chrome 155 at 60 Hz. With a fixed 0.25x slow pass on a 32 Hz display, 240 fps read as 125.6. Sees VFR only in a local window. No frame count, except Chrome-only `totalVideoFrames` after full playback | decoder-driven | n/a | 1.8 s, or 3.4 s with the slow pass; frame count about 0.9-2 ms per frame | 1.2 | visible tab and playable codec needed (ProRes, MPEG-4 Part 2 and MPEG-TS fail; HEVC depends on the machine); depends on refresh rate; Safari and Firefox unmeasured |

### Recommendation

- **Primary path:** own ISO BMFF and EBML parsers in one module Web Worker, sharing one BlobReader.
- **Comparison arms:**
  - Use mediabunny 1.62.0 for all four containers and mp4box 2.4.1 for MP4/MOV.
  - Load both with dynamic `import()`, only when the "compare engines" panel opens. Also run them in the harness.
  - With mp4box, build durations from the stts box, never from the last `getTrackSamplesInfo` sample. Feed fragmented files box by box.
  - music-metadata is an optional harness-only arm.
- **Fallback:** rVFC, opt-in per file, labelled "approximate". Offer it only when the parser cannot produce a rate: an unsupported container or sample entry, or an MKV without DefaultDuration where the user declines a block scan.
- **Excluded:** @remotion/media-parser and all WASM libraries.
- **UI:** React 19.3.1, as requested. Show the Preact numbers in the README only as context.

### Bundle budget

Measured on the Vite production build with gzip -9. Enforce it with `scripts/size-report.mjs`, which reports raw, gzip -9 and brotli q11 per chunk and fails the build when a budget is exceeded.

| Chunk | Budget | Basis |
|---|---|---|
| main (React + UI) | <= 75 KB | minimal React app 67.5-67.7 KB |
| parser worker | <= 12 KB | prototypes 5.5 + 4.9 KB |
| rVFC fallback (lazy) | <= 2 KB | 1.2 KB measured |
| initial total (main + worker) | <= 85 KB | sum of the above |
| comparison chunks (lazy) | reported, not budgeted | mp4box ~41 KB, mediabunny ~51 KB |

## 4. Parser design notes

### 4.1 Reader, worker, IO

**Worker setup:**
- The main thread posts each `File` to the worker. The File is cloned by reference, so postMessage takes 0.06-0.08 ms. Spawning the worker takes 3.8-10.4 ms, once.
- Use one or two to four workers, with per-file progress and cancel (check an abort flag between reads).

**Read primitive:**
- There is a single primitive: `read(offset, length) => blob.slice(o, o + n).arrayBuffer()`.
- Keep it async. FileReaderSync was 0-9% faster in Chrome but not consistently, and slower in Edge at some sizes. It uses the same mojo transport and cannot run reads in parallel.

**Cost model:**

| Environment | Per read | Throughput | Notes |
|---|---|---|---|
| Chrome 155 | 0.65-0.85 ms (up to 64 KB) | ~2 ms/MB up to 1 MB; 8.7-10.4 ms for 8 MB | 8 parallel 64 KB reads are 2.3-2.8x faster than serial |
| Node 24 | ~0.14 ms | ~600 MiB/s | 10,000 reads in flight threw NotReadableError, so cap concurrency |

So in the browser one extra read costs about as much as 0.4-0.7 MB of extra bytes. In Node the break-even is about 88 KB.

**BlobReader:**
- `view(off, len, readAhead)` keeps up to 4 cached windows.
- The default head window is 64 KiB, because 4 KB and 64 KB cost the same in Chrome.
- Stats: `reads`, `bytesFetched` (sum of fetched slice lengths, with no overlapping re-reads, so it equals unique bytes), and `ms` (`performance.now()` around the whole analysis, measured in the worker).

**Speculative tail read: off by default.**
- In Node it gave no gain, and on faststart files it cost one extra read and 256 KiB.
- In Chrome it would save one round trip (~0.8 ms), and only on moov-at-end files.
- Keep it as a reader option and benchmark it in the browser.

**Parallel reads:** bounded concurrency of 4-8, only where offsets are known up front: sidx or tfra moof offsets, and Matroska Cues cluster positions.

### 4.2 ISO BMFF walk

**Box header:**
- Always read 32 bytes: 8 + 8 largesize + 16 uuid. Reading only 16 bytes once ended the walk silently at a top-level uuid.
- `size == 1`: read a u64 largesize with `getBigUint64` and reject values above 2^53-1.
- `size == 0`: the box runs to the end of its parent or of the file.
- `size < header size`: corrupt. This check also guarantees forward progress.
- A child that ends beyond its parent is clamped and flagged as truncated.
- Offsets are Numbers. Never use 32-bit bit operations on them.

**Top-level loop:**
- `ftyp`: read the brand.
- `moov`: one exact read. Use the selective walk if moov is larger than 16 MiB.
- `moof`: read size + 16 bytes so the next header can be peeked.
- `mfra`: stop.
- Everything else (mdat, free, skip, wide, pnot, uuid, sidx, meta): skip by size.
- Stop when fewer than 8 bytes remain.
- Result: faststart files take 1 read and moov-at-end files take 2.

**Fragmented read-ahead (tuned in Node):**
- After a moof: if the next mdat is 64 KiB or smaller, set read-ahead to 1 MiB so many fragments come in one read. Otherwise set it to `clamp(2 x moofSize + 64, 1 KiB, 64 KiB)`.
- Measured: a 3,574-fragment file went from 3,574 reads / 544 ms to 13-16 reads / 67-95 ms.
- Retune the coalescing gap with the Chrome cost model. Its break-even is about 0.4-0.7 MB, not 88 KB.
- With sidx (referenced sizes) or mfra/tfra present, compute the moof offsets first and batch the reads. Check contiguity (moof end + mdat size = next offset) and fall back to the sequential walk on any gap.

**Fields read.** Offsets are from the payload start. A FullBox starts with [0] version and [1..3] flags.

| Box | Fields |
|---|---|
| mvhd | timescale/duration at [12]/[16] in v0; [20] and [24] (u64) in v1 |
| tkhd | enabled = flags & 1; track_ID at [12] (v0) or [20] (v1); matrix at [40] / [52]; width/height 16.16 at [76]/[80] (v0) or [88]/[92] (v1) |
| elst | count at [4]. v0 entries are 12 B: u32 segment_duration (movie ts), s32 media_time, then the rate as s16.s16. v1 entries are 20 B: u64, s64, rate. media_time -1 marks an empty edit |
| mdhd | timescale/duration at [12]/[16] in v0; [20] and [24] (u64) in v1. A duration of all ones means unknown |
| hdlr (parent mdia only) | handler_type at [8] |
| stsd | count at [4]; first entry at [8] (size, fourcc). VisualSampleEntry width/height at entry+32 / +34; child boxes from entry+86: avcC, hvcC, vpcC, av1C, pasp, sinf/frma |
| stts | (u32 count, u32 delta) entries |
| ctts | (u32 count, offset) entries; read the offset as s32 in both versions, because v0 files with negative offsets exist |
| stsz / stz2 | sample_count at [8]; never read the table |
| stss | 1-based sync-sample numbers; absent means every sample is sync |
| trex | default_sample_duration at [12] |
| tfhd | track_ID at [4], then optional base_data_offset u64 (0x1), sample_description_index (0x2), default duration (0x8), default size (0x10), default flags (0x20). 0x010000 = duration-is-empty |
| tfdt | u32 in v0, u64 in v1 |
| trun | count at [4]; optional data_offset (0x1) and first_sample_flags (0x4); per sample: duration (0x100), size (0x200), flags (0x400), cts (0x800; u32 used as int32 in v0, s32 in v1). Record size = 4 x popcount(flags & 0xF00) |
| sidx | timescale at [8]; earliest_pts and first_offset are u32 in v0, u64 in v1; then 12-byte refs (31-bit referenced_size, subsegment_duration) |
| mfro (last box) | the mfra size |

**Bound every entry_count by the box size:** `m = min(count, floor((end - p - 8) / 8))`, and warn when they differ. A huge stts count in a tiny box makes ffprobe fail.

**Selective moov walk (designed, not yet implemented).** Use it only above 16 MiB.
- Hop by headers through moov / trak / mdia / minf / stbl.
- Read: mvhd, tkhd, elst, mdhd, hdlr, stsd, stts, ctts (only if needed), the stss header, and the first 12 bytes of stsz.
- Never read: the stsz table, stco/co64, stsc.
- Why it helps: in a 216k-sample B-frame moov (2.58 MB), ctts is 66% and stsz 34%, while stts is 24 B. A header-only walk of a 300 MB file took 33 reads and 608 B.
- Why the threshold is high: in the browser 33 reads cost about 25 ms, which is roughly the cost of reading 12 MB.

### 4.3 Per-frame durations, VFR, nominal FPS

**Timeline per track:**
- `dur[]` is the expanded stts, then each trun in turn. Each trun duration resolves in the order trun, then tfhd, then trex; if none gives a duration, it is an error.
- DTS is cumulative. A fragment's tfdt resets it, and any mismatch counts as a gap or overlap.
- `pts = dts + cts`.

**Average FPS:**
- **avg** = `av_reduce(ts*N, D)`. Show both the rational and the decimal.
- For fragmented files, N and D include **all** moofs, not only ffprobe's header-phase set.

**Presented frames:**
- **presented** = PTS inside the first non-empty edit window: [media_time, media_time + round(segment_duration x ts / mvhdTs)). A duration of 0 means infinite.
- With several edits or a rate other than 1, apply the first edit and warn.

**Instantaneous FPS:**
1. Sort the presented PTS (skip the sort if already monotonic) and take the deltas.
2. Deltas of 0 or less are **duplicate timestamps**: count them, flag them as an anomaly and exclude them.
3. Drop the last `1 + reorderDepth` deltas, where `reorderDepth = min(16, ceil((max cts - min cts) / first delta))` and is 0 without ctts. Without this, a stream-copy cut leaves a missing B-frame hole at the end and reports false VFR.

**VFR rule:**
- Build a histogram `Map<delta, count>` and take its median m.
- `tol = max(1 tick, round(0.005 x m))`.
- The track is VFR if any remaining delta satisfies `|d - m| > tol`. Report `vfrRatio` alongside the flag.
- `minFps = ts / max(d)`, `maxFps = ts / min(d)`.
- The 1-tick tolerance absorbs timescale rounding:
  - ts 1000: 29.97 fps gives {33, 34}.
  - ts 600: {20, 21}.
  - 90 kHz: 23.976 gives {3753, 3754}.
  - Matroska 1 ms ticks: 29.97 shows 29.41..30.30 and 240 shows 200..250. Display these as "CFR, timestamps quantized to 1 ms", with the raw range as detail.
- Known blind spot: at 1 ms ticks, VFR between rates whose periods differ by under about 1 ms (200 vs 240 fps) is invisible.

**Nominal FPS:**
- One distinct delta: `ts/d`, exact. This equals ffprobe's stage-1 r_frame_rate.
- CFR within tolerance: snap avg to {24, 30, 48, 60, 120, 240} x 1000/1001 or to an integer 1..240, within 0.1%.
- VFR where one delta covers at least 50% of frames: report it as a separate "dominant rate" with its share, not as nominal.
- Otherwise: none.
- Matroska: show a "declared" rate (`1e9/DefaultDuration`), labelled as possibly nominal or average.

**Fast path and memory:**
- With no ctts, or a constant ctts, compute min/max/VFR from stts run-length entries in O(entries). A 1-entry stts is O(1).
- Refuse per-sample expansion when N > 50M.
- Lean storage: keep PTS only, 8-12 B per sample. The prototype's stats took 54-136 ms for 1M samples in Node.

### 4.4 Edge cases

| Case | Behaviour |
|---|---|
| moov at end | Jump over mdat by size, then one exact moov read |
| no moov (interrupted recording) | Error "incomplete file: no moov" (1 read) |
| moov cut in half | Error. A lenient parse produced a wrong duration (9.943 s vs 10.010 s) |
| moov size beyond EOF | Read at most 16 MiB, parse, warn. ffprobe also recovers this file |
| moov present, mdat truncated | FPS valid from the header; warn. The header says 90 frames, only 53 decode |
| moof before moov, or an unresolvable sample duration | Error |
| trun count exceeds payload | Use the available entries and warn. ffprobe 8.1.3+ rejects such a trun |
| missing trex | Accept if trun or tfhd gives durations; flag "ffprobe drops this traf" |
| hybrid fMP4 | Merge moov stts first, then each moof in order |
| 64-bit fields | largesize, co64, and v1 mdhd/tkhd/elst/tfdt; reject anything above 2^53 |
| tmcd, chapter, auxv, meta tracks; covr | Not video |
| track with 1 sample or fewer | "still image", no FPS |
| audio-only | "no video track" |
| cmov (compressed moov) | Unsupported in the PoC. Option: `DecompressionStream('deflate')` (untested) |
| QuickTime quirks | Second hdlr under minf; non-FullBox `meta` (never descend generically); `wide`, `pnot`; 4-byte zero terminators in udta |
| text, PNG, random bytes, 0-byte file | "not a recognised container". Sniff the magic bytes (ftyp or a known box, or EBML 1A45DFA3), never the file extension |

### 4.5 Matroska strategy

**EBML basics:**
- VINT length = `Math.clz32(firstByte) - 23`, giving 1..8. A first byte of 0x00 is invalid.
- Element IDs keep the marker bit (at most 4 bytes); data sizes strip it.
- Unknown size means all data bits are 1. Check the raw bits, not the decoded number.
- Only Segment and Cluster may have unknown size. An unknown-size element ends at a valid parent, sibling or root element, at the end of its parent, or at EOF.
- To resync, scan for level-1 IDs, and accept Cluster `1F43B675` only when a Timestamp (0xE7) child follows.
- A size above 2^53 means corrupt.

**Elements used:**

| Group | Elements (ID) |
|---|---|
| EBML header and Segment | DocType 0x4282; Segment 0x18538067 |
| SeekHead | SeekHead 0x114D9B74, Seek 0x4DBB, SeekID 0x53AB, SeekPosition 0x53AC (relative to the Segment data start) |
| Info | Info 0x1549A966; TimestampScale 0x2AD7B1 (default 1e6); Duration 0x4489 (float of 0, 4 or 8 bytes) |
| Tracks | Tracks 0x1654AE6B; TrackEntry 0xAE; TrackNumber 0xD7; TrackUID 0x73C5 (BigInt); TrackType 0x83; DefaultDuration 0x23E383; TrackTimestampScale 0x23314F; CodecID 0x86; CodecDelay 0x56AA; Video 0xE0 with PixelWidth 0xB0, PixelHeight 0xBA, FrameRate 0x2383E3 |
| Cluster | Cluster 0x1F43B675; Timestamp 0xE7; SimpleBlock 0xA3; BlockGroup 0xA0 with Block 0xA1 and BlockDuration 0x9B |
| Cues | Cues 0x1C53BB6B; CueTime 0xB3; CueClusterPosition 0xF1 |
| Tags | Tags 0x1254C367; TagTrackUID 0x63C5; TagName 0x45A3; TagString 0x4487 |
| Global | CRC-32 0xBF; Void 0xEC |

**Block header:**
- Track number as a VINT, then an int16 big-endian relative timestamp, then a flags byte: 0x80 keyframe (SimpleBlock only), 0x08 invisible, 0x06 lacing, 0x01 discardable.
- If lacing is set, the next byte is frames - 1. Lace sizes are not needed for counting.
- **BlockGroup and BlockDuration must be handled**, because stream-copied VFR uses them on every block.
- Count invisible blocks separately.

**Stage A, header (always):**
- Read [0, 64 KiB) and parse up to the first Cluster. Follow SeekHead for elements outside the window, with the Cues read capped.
- Budget: 5 reads and 1 MiB at most. Measured: 1-2 reads, 65-75 KB, 1-2.4 ms.
- Gives: DocType, CodecID, dimensions, Duration, DefaultDuration, the ffprobe avg/r strings, and DURATION tags.
- A frame estimate `round(duration x 1e9 / DD)` is labelled "estimated, assumes CFR". It is wrong for VFR (180 vs 120) and when Duration is false (300 vs 90).

**Stage B, probe (default on):**
- Sample 8 clusters x up to 32 blocks, located via Cues or a validated sync search. Compute deltas only inside contiguous runs.
- Never output an average from sampled data: the prototype printed 1.009 fps for a 30 fps file.
- Add a **tail scan** when Duration or Cues are missing, or to cross-check Duration:
  - Read the last 256 KiB, growing x4 up to 16 MiB.
  - Step back cluster by cluster until a block of the video track is found, because audio can outlast video.
  - End = last PTS + that frame's duration.
- Node cost: 11-34 ms for the probe; 2-4 reads for the tail scan.

**Stage C, exact:**
- Walk every Cluster, reading only the Timestamp and block headers and skipping payloads by size.
- Gives exact frames (= `nb_read_packets`), average, min/max, VFR, duplicates and truncation. Example: a truncated file has 89 frames ending at 2.93 s while its header says 5.0 s.
- Window: 4 KiB when the average frame is 32 KiB or more, else 1 MiB.
- Cost is O(blocks). In Node: 0.27-0.52 s for 3,600 1080p frames, and 0.1-0.9 s for 36,000 small frames.
- Run it automatically when `reads x 0.8 ms + bytes / 0.5 GB/s` predicts about 150 ms or less. Otherwise offer a "scan all frames" button with progress and cancel.

**Exact average:**
- `frames / (lastPts + lastDur - firstPts)`.
- lastDur is the BlockDuration if present, else `DD x laces / TimestampScale` with integer division (this matches ffprobe packet durations), else the median delta.

**Provenance:** every field carries one of `header`, `sampled`, `exact`, `estimated`, or `computed` (meaning ffprobe shows N/A here).

### 4.6 Result shape

```ts
type Provenance = 'header' | 'exact' | 'sampled' | 'estimated' | 'computed';
interface Rational { num: number; den: number; value: number }
interface VideoTrackResult {
  trackId: number; fourccOrCodecId: string; codecName: string; width: number; height: number;
  rotation: number; timescale: number; frames: number; presentedFrames: number;
  durationSec: number; startSec: number; avgFps: Rational;
  nominalFps: (Rational & { kind: 'exact' | 'snapped' | 'declared' }) | null;
  dominantFps: { value: number; share: number } | null;
  minFps: number | null; maxFps: number | null; isVfr: boolean | null; vfrRatio: number;
  duplicateTimestamps: number; provenance: Record<string, Provenance>; warnings: string[];
}
interface FileResult {
  name: string; size: number; container: 'mp4' | 'mov' | 'webm' | 'matroska' | 'unknown';
  videoTracks: VideoTrackResult[]; primaryTrackId: number | null; error: string | null;
  reads: number; bytesRead: number; ms: number; engine: 'own' | 'mediabunny' | 'mp4box' | 'rvfc';
}
```

## 5. Fixture matrix

**The generator** (validated) is `generate-fixtures.sh [out] [--with-long] [--with-sparse]`. Its tools are `patch-mp4.mjs`, `patch-webm.mjs`, `make-corrupt.mjs`, `boxes.mjs`, `ebml.mjs` and `ref-extract.mjs`, plus `extract-reference.sh`. They live in `scripts/fixtures/` (the tools in `scripts/fixtures/tools/`).

**What it produces:**
- 95 fixtures: about 8.5 MB without the optional files, 24.7 MB with the long ones.
- Two runs were byte-identical (93/93). This needs `-fflags +bitexact` as an *output* option for WebM/MKV.
- Runtime is about 2 minutes, mostly Windows process start.

**Common settings:**
- Prefix: `ffmpeg -hide_banner -loglevel error -y`.
- Source: `testsrc2=size=160x90:rate=R:duration=3`.
- H264: `-c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -g 30 -an`. H264B is the same with `-preset veryfast -bf 3`.
- VP9: `-c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 40 -b:v 0 -g 30 -an`.
- VFR: `-fps_mode passthrough`.

### 5.1 Expected ffprobe 8.1.1 values

| Fixtures | Command essence | Expected |
|---|---|---|
| `cfr_h264_{23.976,24,25,29.97,30,50,59.94,60,120,240}.mp4` | H264 at rates 24000/1001 .. 240 | avg = r = the exact rational; frames (nb_frames and nb_read_frames) 72, 72, 75, 90, 90, 150, 180, 180, 360, 720; duration 3.003 for x/1001 rates, else 3; timescale 24000, 12288, 12800, 30000, 15360, 12800, 60000, 15360, 15360, 15360 |
| `cfr_vp9_*.webm` | VP9 + bitexact | avg = r from DefaultDuration (59.94 gives 19001/317); nb_frames N/A, read counts as above; instantaneous range 29.41..30.30, 58.82..62.5, 111.11..125, 200..250 |
| `mov_nobf_{default,faststart}.mov`, `mov_bf_{elst,faststart}.mov`, `mp4_bf_{elst,faststart}.mp4` | `-f mov` or `-f mp4`, optionally `+faststart` | 30000/1001; 90/90; 3.003; B-frame files have elst media_time 2002 |
| `mov_bf_noelst.mov`, `mp4_bf_noelst.mp4` | `-use_editlist 0` | same, but start 0.067 |
| `mov_prores.mov` | `prores_ks -profile:v 0` | prores, 30000/1001, 90/90 |
| `mp4_elst_empty_offset.mp4` | `-output_ts_offset 1 -use_editlist 1` | 30/1; 90/90; start 1.0 |
| `mp4_elst_trim_start.mp4` | `-ss 0.7 -i mp4_bf_elst.mp4 -c copy` | **90 / 69**; 2.303; 21 packets flagged D |
| `mp4_elst_trim_output_seek.mp4` | output `-ss 0.7 -c copy` | 60/60; 2.002; start 0.301 |
| 9 x `fmp4_*` | `frag_keyframe+empty_moov[+default_base_moof][+global_sidx]`, `cmaf`, `dash`, `-frag_duration 500000`, `-f dash -single_file 1`, dash segments concatenated | 30000/1001; N/A / 120; 4.004; the B-frame variant starts at 0.067 |
| `fmp4_hybrid_no_empty_moov.mp4` | `-movflags frag_keyframe` | **nb_frames 30** / 120 |
| `hevc_hvc1.mp4`, `hevc_hev1.mp4`, `av1.mp4` (libaom), `vp9.mp4` | `-tag:v hvc1` or `hev1` | 30000/1001; 90/90 |
| `vp9.webm`, `vp8.webm`, `av1.webm`, `h264.mkv` | bitexact | 30000/1001; N/A / 90 |
| `vp9_live.webm`, `vp9_pipe.webm`, `vp9_unknown_clusters.webm` | `-live 1`; `pipe:1`; `patch-webm unknown-clusters` | N/A / 90; format duration N/A; unknown-size Segment; the last file also has unknown-size Clusters |
| `vp9_no_defaultduration.webm` | `patch-webm void-defaultduration` | avg estimated by ffprobe; duration from Info |
| `box64_mdat64_wide.mov`, `box64_mdat64_free.mp4`, `box64_co64_mdat64.mp4`, `box_mdat_size0.mp4` | `patch-mp4 mdat64` / `co64`; `make-corrupt mdat-size0` | same values as the source file |
| `multi_video_2tracks.mp4` | two lavfi inputs + audio | 160x90 30/1 90 frames; 320x180 24/1 96 frames |
| `still_image_track_first.mp4` | 1-frame MJPEG trak placed before H.264 | v:0 is mjpeg 64x64 with 1 frame; the real video is 30/1, 90 frames |
| `cover_art_plus_video.mp4`, `cover_art_audio.m4a` | `-disposition:v:0 attached_pic` | ffprobe lists the attached_pic stream first; the app ignores it |
| `audio_only.m4a`, `audio_only_aac.mp4`, `audio_only_opus.webm`; `edge_single_frame.mp4` | sine audio; `-frames:v 1` | no video; for the single frame: 30/1, 1/1, no min/max |
| `corrupt_*` | `make-corrupt` | ffprobe fails with "moov atom not found" on empty, garbage, text and trunc_no_moov, and with "error reading header" on trunc_moov_partial and stts_count_huge. trunc_mdat_faststart: 90 / 53. fmp4_truncated: N/A / 72 (73 packets). png_named opens as png_pipe |
| `sniff_*` | renamed copies | probed by content, not extension |
| `long_cfr_3h_60fps.mp4` (`--with-long`) | 64x36, crf 51, 10800 s | 60/1; 648,000 frames; moov 2.61 MB at the end (stsz 2.59 MB, stts 24 B) |
| `long_vfr_1h_screenrec.mp4` | screen-recording filter, timescale 1000 | avg 186/5, r 1000/1; 133,920 frames; stts has 124,761 entries |
| `sparse_4_5gb_co64.mp4` (`--with-sparse`, delete after use) | `patch-mp4 sparse` | 30/1; 90/90; moov at 4,500,086,081; co64 offset 4,500,000,048; a header walk reads 592 B in 32 reads |

### 5.2 VFR methods (each proven by packet PTS deltas)

| Fixture | Method | avg / r | Frames | Instantaneous FPS (distinct deltas) |
|---|---|---|---|---|
| `vfr_concat_10_30_60.mp4` and `.mov` | concat of 2 s segments at 10/30/60 fps, `-video_track_timescale 90000` | 100/3 / 60/1 | 200 | 10..60 (3) |
| `..._ts1M.mp4` | ffmpeg default timescale 1e6 | 100/3 / 60/1 | 200 | 10..60 (5) |
| `..._fmp4.mp4` | fragmented | 100/3 / 10/1 | N/A / 200 | 10..60 |
| `vfr_concat_10_30_60.webm` | VP9; no DefaultDuration written | 0/0 / 30/1 | N/A / 200 | 10..62.5 (5) |
| `vfr_concat_bframes.mp4` | + B-frames | 1200/37 / 60/1 | 200 | 10..60; stts splits 22/60/118 while display order is 20/60/120 |
| `vfr_setpts_sine.mp4` | `settb=1/90000,setpts='(N+6*sin(N/8))*3000'` + `-enc_time_base:v 1/90000` | 13500000/445991 / 90000/1 | 150 | 17.15..119.68 (147) |
| `vfr_select_drop.mp4` | `select='lt(mod(n*7,10),6)',settb=1/90000` on a 60 fps source | 36/1 / 60/1 | 180 | 20..60 (3) |
| `vfr_mpdecimate.mp4` | concat test + gray + test, then `mpdecimate` | 182/9 / 30/1 | 91 | 0.67..30 (2) |
| `vfr_screenrec_ts1000.mp4` | select gaps + `setpts=PTS+random(0)*7`, timescale 1000 | 61500/1501 / 1000/1 | 246 | 2.96..100 (20) |
| `vfr_screenrec_ts1000.webm` | same, VP9 | 60/1 / 60/1 (DefaultDuration claims 60) | 246 | 2.99..62.5 (6) |
| `vfr_pulldown_2_3.mp4` | `setts` bsf with a 3000/4500 tick cadence | 24/1 / 60/1 | 120 | 20..30 (2) |

**Generation traps:**
- With a known source rate, the encoder time base is 1/framerate and it rounds `setpts` results, which produces duplicate PTS. Use `settb` together with `-enc_time_base:v 1/90000` or `1/1000`. `-enc_time_base -1` does not help on 8.1.1.
- Negative jitter on frame 0 creates a hidden first frame.
- SVT-AV1 pads 160x90 to 160x96, so use libaom for AV1.
- `-display_rotation` is an input option in 8.x.
- One verifier saw "Unknown function" errors for `sin`/`mod`/`floor`. Three other streams ran the generator's exact quoting cleanly, so copy that quoting verbatim.

### 5.3 Additions to the generator

These were validated in the verification streams:

| File | How | Expected |
|---|---|---|
| `frag_vfr_global_sidx.mp4` | `testsrc2 rate=60 -t 5 -vf "select='lt(n\,60)+not(mod(n\,3))'" -fps_mode vfr -bf 0 -video_track_timescale 90000 -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx` | ffprobe avg 60/1, true 4200/149 |
| `frag_vfr_dash.mp4` | the same with `-movflags +dash` | ffprobe 30/1 (4 of 5 fragments) |
| `h264_vfr_remux.mkv` | `ffmpeg -i <VFR mp4> -c copy out.mkv` | DefaultDuration 23076923; 130/3 = the true average; 260 BlockGroups |
| `vp9_pipe_t10.webm` | 3 s source piped with `-t 10` | Info Duration says 10.000; 90 frames ending at 3.0 s |
| `vp9_opus_live_audiotail.webm` | 3 s video + 6 s Opus, `-live 1` | tail scan must reach the last video PTS, 2.967 s |
| `h264_25_cover.mkv` | `-attach cover.png` | attached_pic stream with r 90000/1 |
| `crashed.mkv` | `timeout -s KILL n ffmpeg -re ... -flush_packets 1` (not byte-reproducible) | DefaultDuration kept; no Duration or Cues |
| synthetic early-ending elst | ffprobe-mov-verify rewriters | r 300/11; nb_read_packets 61 of 150 |
| `hevc.mkv` | not produced or validated by any stream | - |

### 5.4 The 64-bit trick

**Non-faststart files.** ffmpeg writes an 8-byte `wide` (MOV) or `free` (MP4) box followed by a 32-bit mdat header. Rewrite those 16 bytes in place as one 16-byte mdat header:
- `size = 1`
- type `'mdat'`
- `u64 largesize = old size32 + 8`

The file size and every chunk offset stay the same. ffmpeg's own `mov_write_mdat_size` does exactly this above 4 GiB. ffprobe still decodes all frames.

**co64.** ffmpeg writes co64 only when the last chunk offset exceeds UINT32_MAX (movenc.c:176-180), so `patch-mp4 co64` rewrites stco into co64. moov grows by 4 bytes per chunk, which shifts nothing when moov is at the end.

**Real offsets above 2^32.** These come from the sparse fixture: `fsutil sparse setflag` on Windows, about 87 KB of real data.

### 5.5 Not covered

- Real recorder output: iPhone (timescale 600), Android, OBS, QuickTime screen recording, Chrome MediaRecorder (only emulated), GoPro, DJI.
- mkvmerge output.
- Interlaced content.
- Video with lacing or BlockGroups, other than the remux fixture.
- HEVC or AV1 in fragmented MP4.
- More than one stsd entry.
- cmov.
- Browser `File` slicing above 2^32.

## 6. Comparison harness

### 6.1 References

`extract-reference.sh` produces these per fixture. Skip `-count_frames` for the sparse file.

```
ffprobe -v error -show_streams -show_format -count_frames -count_packets -show_optional_fields always -of json F
ffprobe -v error -select_streams v -show_entries stream=index:stream_disposition=attached_pic -of csv=p=0 F
ffprobe -v error -select_streams N -show_entries packet=pts,dts,duration,flags -of csv=p=0 F
```

The packet CSV gives integer ticks in the order pts, dts, duration, flags. A flag `D` marks a packet discarded by the edit list.

`ref-extract.mjs` writes `ref/<name>.ref.json` containing:
- the probe JSON and the ffprobe version line;
- per video stream: sorted presented PTS (non-D packets), deltas with and without tail exclusion, the duplicate count;
- `avgFromPts = N / (lastPts + lastDur - firstPts)`;
- the VFR flag under the 4.3 tick rule;
- the last packet end.

Treat a missing JSON key as N/A.

### 6.2 vitest (5.0.5, Node 24)

- `src/core` has no DOM dependencies.
- Tests run with `environment: 'node'` and call `analyze(await fs.openAsBlob(path))`, so they exercise the same `Blob.slice().arrayBuffer()` code path as the worker.
- **Files above 4 GiB.** On Node 24.20 here, `openAsBlob().size` wraps modulo 2^32: 205,035,818 instead of 4,500,003,114. The sparse test must use a Blob-like `FileSlice` over `fs.promises.open` instead; prototypes exist in `research/libs/measure/blobfile.mjs` and `research/libs-verify/m/big64test.mjs`. Make that test opt-in by env var, generate the file in setup and delete it in teardown.
- **Unit tests:**
  - VINT
  - av_reduce: 807689923/26949920, and 16683333 with 30000 gives 19001/317
  - box header: size 0, size 1, uuid, smaller than its header
  - entry_count bounding
  - trun record size
  - rotation
- **Fixture tests:** `test.each` over `manifest.tsv`, asserting the 6.4 rules.

### 6.3 Diff script

`scripts/compare-ffprobe.ts` (Node 24 runs `.ts` directly):
- For each fixture, engine (own, mediabunny, mp4box) and field, it prints: app value, ffprobe value, rule, and a verdict of `exact`, `within-tol`, `known-deviation`, `mismatch` or `n/a`. It also prints reads, bytes and ms.
- It writes `report/accuracy.md` and `report/accuracy.json`, which feed the README tables.
- It exits 1 on an unexpected mismatch for the own engine. The library engines are informational.
- Known deviations live in `fixtures/known-deviations.json`, keyed by fixture + field, each with a reason.
- Never compare speed with ffprobe: Windows process start alone takes 1.3-1.9 s here.

### 6.4 Tolerances

| Field | MP4/MOV | Matroska |
|---|---|---|
| avg FPS | exact reduced rational vs `avg_frame_rate`. With a complete sidx (VFR): compare with `N x ts / sum(packet durations)` and record a known deviation | the declared string must equal `avg_frame_rate` exactly when DefaultDuration exists. The measured average must equal `avgFromPts` (integer-ms last duration) within 1e-9 relative |
| r / nominal | exact vs `r_frame_rate` only when the track is CFR (stage 1); otherwise skip | when DefaultDuration exists, compare the string exactly. Without it, skip (numeric within 1% is informational only) |
| frames | exact vs `nb_frames` when non-fragmented. Fragmented: vs `nb_read_packets`. Hybrid: moov count vs `nb_frames`, total vs packets | exact vs `nb_read_packets` |
| presented frames | exact vs `nb_read_frames` | = frames |
| duration | `duration_ts` and `start_pts` exact. Fragmented with sidx: tolerance max(1 frame, abs(start_time)). Format duration within 1e-6 s; skip when subtitle or data tracks exist | `format.duration` exact when Info Duration exists; N/A otherwise (the computed end is shown with provenance) |
| min/max instantaneous FPS | exact rationals vs the tail-excluded reference | exact on 1 ms ticks |
| VFR flag, duplicates | equal under the shared rule | equal |
| width/height, codec_name | exact. A stsd vs SPS mismatch is a known deviation | exact |

**rVFC** cannot run in Node. Use `bench.html` driven over CDP in headless Chrome with a throwaway profile, the same setup as the research. Record the display Hz and compare against the ffprobe refs.

## 7. Risks and open questions

**Decisions (resolved: React, and the core corpus is committed):**
1. **React vs Preact.** React adds about 67.5 KB gzip, against 5.5-7.1 KB for Preact.
2. **Fixture binaries.** Either commit the 8.5 MB core corpus or regenerate it. Bytes are reproducible only on the same ffmpeg build, so committing keeps tests hermetic. The long and sparse files stay generated.

**Performance unknowns:**

3. **Browser IO is unmeasured outside Chromium.** Firefox and Safari per-read cost, cold cache, HDD, network share, OneDrive placeholders and Android SAF were not measured. In Chrome, fragment-per-frame MP4 (1,290 reads, about 1 s without coalescing) and exact MKV scans break the "milliseconds" target, so the coalescing gap and the auto-exact budget must be tuned in the browser.
4. **Speculative tail read** and the selective moov walk threshold (16 MiB) need browser benchmarks.
5. **Above 4 GiB in a browser `File`** is untested. The Node `openAsBlob` size wrap is a known test-only issue.

**ffprobe parity limits:**

6. **ffprobe under-reads fragmented files with a complete sidx.** The app shows the true full-file average and documents the deviation.
7. **Version drift.** FFmpeg 9.0.x is out, and master changed edit-list handling on 2026-10-12. Store the ffprobe version in each ref and refuse mixed versions.
8. **r_frame_rate** is reproduced only for CFR (stage 1). VFR values depend on probesize and bitrate. Nominal FPS for VFR is shown as "dominant rate" or none (decided: dominant rate).
9. **Frame count display.** The proposal shows presented frames as primary, with stored samples (`nb_frames`) as secondary.
10. **Partially handled features.** Multi-segment edit lists, rate != 1, dwell edits, missing trex and cmov are only flagged. The exact stage-1 index cut at an early elst end needs a source check.

**Matroska limits:**

11. Info Duration can be wrong (pipe output with `-t`), and DefaultDuration can be either nominal or average.
12. The 1 ms tick resolution hides VFR between close rates.
13. The duplicate-timestamp policy must be shown explicitly in the UI.
14. Not tested: TrackTimestampScale != 1, non-zero video CodecDelay, interlaced content.

**rVFC limits:**

15. The slow-motion rate must adapt: halve it until measured fps x rate <= 0.5 x refresh, and the passes agree within 0.3%. Flag the result when the typical and average estimates disagree or when few consecutive dpf=1 pairs exist.
16. `droppedVideoFrames` is unusable. `totalVideoFrames` equals `nb_frames` only in Chrome.
17. The results are Chrome 155 only; Chrome 156 is the current stable.
18. Safari has open bugs 283448 and 260798. A hidden tab pauses playback.

**Library and dependency risks:**

19. mp4box: last-sample override, #544, #570. mediabunny: #494, #320; it is MPL-2.0, which is fine as an unmodified dependency. Pin exact versions.

**Coverage gaps:**

20. Real-world capture files are needed (iPhone timescale 600, Android, OBS, MediaRecorder, mkvmerge, HEVC in MKV) to validate track selection, rotation and VFR on real data.

## 8. Errata found during implementation

Factual corrections only, in the order of the sections they correct. Each row has one line of evidence. Design choices that differ from this spec on purpose are not listed here; they are in [implementation-notes.md](implementation-notes.md).

| Section | Research says | Correction | Evidence |
|---|---|---|---|
| 2.1 avg_frame_rate | "Gives 0/0 if N or D is 0" | Then ffprobe fills avg_frame_rate from find_stream_info packets, so it is not reproducible and the app reports none. The same holds when an stts or trun count runs past its box, because 8.1.1 reads into the next bytes | Patched stts with delta 0: ffprobe 179/12. Patched stts count past its box: nb_frames 118, avg 63749/1907615141 |
| 2.1 r_frame_rate, stage 1 | Durations "retained after edit-list indexing"; "check the boundary in source" | `mov_fix_index` in n8.1.1: without ctts the kept durations are the first retained-count entries of stts (`tts_index_old` is never repositioned) and continue across edits; with ctts they start at the found index. The rate is constant when all but the last equal the first. An edit list with no media edit does not run stage 1 | `vfr_concat_10_30_60.mp4` with elst [33 ms @ 210000]: ffprobe 10/1; with [300 ms @ 270000]: 60/1 from stages 2-4. Sweep of 81 edit windows, 0 mismatches |
| 2.1 (missing rule) | Not covered | The declared entry count is used only if it fills the box exactly, otherwise box size / entry size. A later non-empty elst replaces the earlier one (`Duplicated ELST atom`) | `cfr_h264_30.mp4` plus a second elst [1000 ms @ 30000]: ffprobe duration 1.000000, nb_read_frames 30 |
| 2.1 (missing rule) | Not covered | ffmpeg `mov_read_trak` rejects a trak that has chunks but no stts, stsc or sample sizes, or samples but no chunks (`missing mandatory atoms, broken header`). The stream is listed but gets no index and time base 1/90000, and only its mdhd duration reaches the format duration | Second video trak with empty stts and stsz but a kept stco: ffprobe format duration 3.000000, own timing would give 4 |
| 2.1 header extent | A global or per-fragment sidx decides how many fragments are read | A sidx completes the index only if it is non-hierarchical, has `first_offset` 0, references an existing track and ends at EOF or at EOF minus the mfra size | A sidx with `first_offset` != 0 leaves the index incomplete: ffprobe reads every fragment (empirical, patched file) |
| 2.2 Packet PTS | `(Cluster\Timestamp + block relative ts x TrackTimestampScale) x TimestampScale - CodecDelay` | Ticks are `cluster / TrackTimestampScale + relative - CodecDelay` in the track time base `trunc(TimestampScale x TrackTimestampScale) / 1e9`. TrackTimestampScale != 1 and a video CodecDelay are now tested | Synthetic files with TrackTimestampScale 0.5 and 2, CodecDelay -11 ms and TimestampScale 100000: packet PTS, time base and durations equal ffprobe 8.1.1 |
| 2.2 avg_frame_rate | Without DefaultDuration and FrameRate "that value cannot be reproduced" | It can, bit for bit, from block timestamps: the analysis loop of `avformat_find_stream_info` with ffprobe's defaults, then `ff_rfps_add_frame` and `ff_rfps_calculate`, give `avg_frame_rate` and `r_frame_rate` from the first packets (41 on the Chromium recordings, 48 for H.264). `src/core/rfps.ts` re-implements it ([implementation notes](implementation-notes.md#ffprobe-frame-rates-without-defaultduration-020)) | The 12 committed files without DefaultDuration and 503 more Matroska files equal to ffprobe 8.1.1 on both strings |
| 2.3 and 4.4 | `auxv` tracks are not video | ffprobe 8.1.1 lists a trak with handler `auxv` and a video sample entry as a video stream and counts it in format duration (`mov_codec_id` maps a DATA-typed trak with a movvideo fourcc to VIDEO) | `multi_video_2tracks.mp4` with track 2 handler set to `auxv`: 2 video streams, format duration 4.000000 |
| 4.4 missing trex | "Accept if trun or tfhd gives durations; flag 'ffprobe drops this traf'" | ffprobe 8.1.1 does not drop the traf, it fails to open the file. `found_tfhd` is reset per moof, not per traf, so a traf without trex after a valid one is read as another track | Trex renamed, mvex removed, wrong trex track_ID and unknown tfhd track: all exit with `error reading header` (`trun track id unknown, no tfhd was found`) |
| 4.2 box header | "Always read 32 bytes", because 16 once ended the walk at a top-level uuid | 16 bytes are enough: skipping a uuid box never needs its extended type, so the earlier failure was a prototype bug | Unit test for a top-level uuid with a 16-byte peek, and 69 ISO fixtures |
| 4.5 Stage C window | 4 KiB windows when the average frame is 32 KiB or more, else 1 MiB | Under the 4.1 cost model 4 KiB wins only above about 290 KB per frame. The average must count all blocks, not only video frames, or interleaved audio inflates it | 300 x 40 KB frames: 1 MiB plan 34 ms, 4 KiB plan 242 ms. `noise_bigframes.mkv` (124 KB frames): 51 ms vs 121 ms |
| 4.5 auto budget | IO-only formula `reads x 0.8 ms + bytes / 0.5 GB/s` | CPU per block matters at large block counts: about 0.0002 ms per block in Node | Stream-copied `long_cfr_3h_60fps` MKV (648,000 blocks): predicted 40.9 ms, measured 116-170 ms |
| 1 item 4, 1.1, 3 budget | Parsers 5.5 KB (MP4) and 4.9 KB (EBML) gzip; one parser worker budget of 12 KB | The complete parsers are about twice the prototypes, and one worker chunk holding both measured 23.93 KB gzip. They are loaded as separate chunks per container and budgeted per chunk | First `npm run size` on the full build: worker 23.93 KB gzip against 12 KB, initial total 99.24 KB against 85 KB |
| 3 budget, rVFC row | Lazy rVFC chunk "1.2 KB measured" for a 2 KB budget | The engine is 2,136 B gzip alone (4,169 B raw); 1,965 B when `core/result.ts` is shared with another chunk | rolldown 1.2.14, ESM, minified, browser build of `src/engines/rvfc.ts` |
| 1 item 6, 3 rVFC | 1.8-3.4 s per file | That holds up to 60 fps. At 60 Hz 120 fps takes 4.9 s; 240 fps needs 5 passes, about 9.3 s on the 33 Hz default headless display | Chrome 155 over CDP, throwaway profile, H.264 CFR clips at 24 to 240 fps |
| 1.1 mediabunny | No mention of a packet-walk limit | `sink.packets()` (also used inside `computePacketStats`) stalls about 90 s once a metadata-only walk passes roughly 500k packets. The walk must use `getFirstPacket`/`getNextPacket` | Profiled to `timestamps.shift()` on a huge array in `media-sink.js`; the 648,000-packet 3 h file walks in 0.75 s with `getNextPacket` |
| 6.3 | Known deviations live in `fixtures/known-deviations.json` | They live in `fixtures/known-deviations/<engine>*.json` (`own-isobmff.json`, `own-matroska.json`), format in `fixtures/known-deviations/README.md` | The directory and the compare script's loader |
