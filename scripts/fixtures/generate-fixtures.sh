#!/usr/bin/env bash
# Builds the FPS test corpus with ffmpeg 8.1.1 (libx264, libx265, libvpx, libaom, libopus).
# Usage: generate-fixtures.sh [rootDir] [--with-long] [--with-sparse] [--with-big]
#   rootDir        fixtures root, default <repo>/fixtures. Output: <rootDir>/files, <rootDir>/manifest.tsv,
#                  and <rootDir>/large (git-ignored) when an optional set is requested.
#   --with-long    adds a 3 h / 60 fps CFR file (~13 MB) and a 1 h VFR screen-recording-like file (~4 MB)
#   --with-sparse  adds a 4.5 GB sparse MP4 (co64 + 64-bit mdat, ~87 KB of real disk on NTFS/ext4/APFS)
#   --with-big     adds three 1080p files of 604 MB each (MP4 moov at the end, MP4 faststart, Matroska), ~1.8 GB of disk
# The manifest always lists every fixture, including the optional ones (committed=no).
# Generated data is synthetic (lavfi testsrc2/sine); the browser recordings (category recorder) are copied from
# fixtures/files, not generated. Run from Git Bash on Windows, or bash on Linux/macOS.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${TOOLS:-$HERE/tools}"
EXPECTED_FFMPEG="8.1.1"

ROOT=""; WITH_LONG=0; WITH_SPARSE=0; WITH_BIG=0
for a in "$@"; do
  case "$a" in
    --with-long) WITH_LONG=1 ;;
    --with-sparse) WITH_SPARSE=1 ;;
    --with-big) WITH_BIG=1 ;;
    --*) echo "unknown option: $a" >&2; exit 2 ;;
    *) ROOT="$a" ;;
  esac
done
ROOT="${ROOT:-$HERE/../../fixtures}"
mkdir -p "$ROOT/files"
ROOT="$(cd "$ROOT" && pwd)"
FILES="$ROOT/files"; LARGE="$ROOT/large"; MANIFEST="$ROOT/manifest.tsv"

FFVER="$(ffmpeg -version | head -n 1)"
case "$FFVER" in
  "ffmpeg version $EXPECTED_FFMPEG"*) ;;
  *) echo "WARN: expected ffmpeg $EXPECTED_FFMPEG, found: $FFVER (output bytes may differ from the committed corpus)" >&2 ;;
esac

W="$(mktemp -d 2>/dev/null || mktemp -d -t fixtures)"
trap 'rm -rf "$W"' EXIT
cd "$FILES"
[[ $WITH_LONG == 1 || $WITH_SPARSE == 1 || $WITH_BIG == 1 ]] && mkdir -p "$LARGE"

printf 'name\tcontainer\tcategory\texpect\tcommitted\tnotes\tpath\n' > "$MANIFEST"

FF=(ffmpeg -hide_banner -loglevel error -y)
note()       { printf '%s\t%s\t%s\t%s\tyes\t%s\tfiles/%s\n' "$1" "$2" "$3" "$4" "$5" "$1" >> "$MANIFEST"; }
note_large() { printf '%s\t%s\t%s\t%s\tno\t%s\tlarge/%s\n' "$1" "$2" "$3" "$4" "$5" "$1" >> "$MANIFEST"; }
src()  { echo "testsrc2=size=${3:-160x90}:rate=$1:duration=$2"; }

H264V=(-c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -g 30)
H264=("${H264V[@]}" -an)
H264B=(-c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -g 30 -bf 3 -an)
VP9V=(-c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 40 -b:v 0 -g 30)
VP9=("${VP9V[@]}" -an)
BX=(-fflags +bitexact)   # output option: makes Matroska/WebM byte-reproducible (no random SegmentUID/TrackUID)
VFR=(-fps_mode passthrough)

# ---------- A. CFR H.264 MP4 (moov at end, ffmpeg default) and CFR VP9 WebM, exact rationals ----------
for pair in 23.976:24000/1001 24:24 25:25 29.97:30000/1001 30:30 50:50 59.94:60000/1001 60:60 120:120 240:240; do
  name=${pair%%:*}; rate=${pair#*:}
  "${FF[@]}" -f lavfi -i "$(src "$rate" 3)" "${H264[@]}" "cfr_h264_$name.mp4"
  note "cfr_h264_$name.mp4" mp4 cfr ok "CFR $rate fps, H.264 no B-frames, ftyp free mdat moov, 1 stts entry"
  "${FF[@]}" -f lavfi -i "$(src "$rate" 3)" "${VP9[@]}" "${BX[@]}" "cfr_vp9_$name.webm"
  note "cfr_vp9_$name.webm" webm cfr ok "CFR $rate fps VP9 WebM: ms block timestamps quantize inst. FPS, DefaultDuration is exact"
done

# ---------- B. MOV (QuickTime) and MP4 muxing variants ----------
S30="$(src 30000/1001 3)"
"${FF[@]}" -f lavfi -i "$S30" "${H264[@]}" -f mov mov_nobf_default.mov
note mov_nobf_default.mov mov mov ok "MOV, no B-frames, 'wide' before mdat, moov at end, elst present"
"${FF[@]}" -f lavfi -i "$S30" "${H264[@]}" -f mov -movflags +faststart mov_nobf_faststart.mov
note mov_nobf_faststart.mov mov mov ok "MOV faststart: ftyp moov wide mdat"
"${FF[@]}" -f lavfi -i "$S30" "${H264B[@]}" -f mov mov_bf_elst.mov
note mov_bf_elst.mov mov mov ok "MOV + B-frames: ctts + elst media_time=2002 (2 frames of reorder delay)"
"${FF[@]}" -f lavfi -i "$S30" "${H264B[@]}" -f mov -use_editlist 0 mov_bf_noelst.mov
note mov_bf_noelst.mov mov mov ok "MOV + B-frames without edit list: ffprobe start_time=0.067, no elst"
"${FF[@]}" -f lavfi -i "$S30" "${H264B[@]}" -f mov -movflags +faststart mov_bf_faststart.mov
note mov_bf_faststart.mov mov mov ok "MOV + B-frames + faststart"
"${FF[@]}" -f lavfi -i "$S30" -c:v prores_ks -profile:v 0 -pix_fmt yuv422p10le -an -f mov mov_prores.mov
note mov_prores.mov mov codec ok "MOV ProRes 422 Proxy (non-H.26x codec, apch)"
"${FF[@]}" -f lavfi -i "$S30" "${H264B[@]}" -f mp4 mp4_bf_elst.mp4
note mp4_bf_elst.mp4 mp4 mov ok "MP4 + B-frames: ctts + elst media_time=2002, 'free' before mdat"
"${FF[@]}" -f lavfi -i "$S30" "${H264B[@]}" -f mp4 -use_editlist 0 mp4_bf_noelst.mp4
note mp4_bf_noelst.mp4 mp4 mov ok "MP4 + B-frames, no elst"
"${FF[@]}" -f lavfi -i "$S30" "${H264B[@]}" -f mp4 -movflags +faststart mp4_bf_faststart.mp4
note mp4_bf_faststart.mp4 mp4 mov ok "MP4 faststart: ftyp moov free mdat"

# ---------- C. Edit-list traps ----------
"${FF[@]}" -f lavfi -i "$(src 30 3)" "${H264B[@]}" -g 30 -output_ts_offset 1 -use_editlist 1 -f mp4 mp4_elst_empty_offset.mp4
note mp4_elst_empty_offset.mp4 mp4 mov ok "elst = [empty edit 1000 ms (media_time=-1), media_time=1024]; ffprobe start_time=1.0; 90 frames"
"${FF[@]}" -ss 0.7 -i mp4_bf_elst.mp4 -c copy -f mp4 mp4_elst_trim_start.mp4
note mp4_elst_trim_start.mp4 mp4 mov ok "-ss 0.7 stream copy: stts=90 samples but elst trims start so only 69 frames are shown (nb_frames=90, nb_read_frames=69)"
"${FF[@]}" -i mp4_bf_elst.mp4 -ss 0.7 -c copy -f mp4 mp4_elst_trim_output_seek.mp4
note mp4_elst_trim_output_seek.mp4 mp4 mov ok "output -ss 0.7 stream copy: 60 frames, elst = [empty 301, media_time 2002], start_time 0.301"

# ---------- D. Fragmented MP4 ----------
S4="$(src 30000/1001 4)"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -f mp4 -movflags frag_keyframe+empty_moov fmp4_keyframe_empty_moov.mp4
note fmp4_keyframe_empty_moov.mp4 mp4 fmp4 ok "ftyp moov(empty) (moof mdat)x4 mfra; explicit base_data_offset in tfhd; nb_frames N/A"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof fmp4_default_base_moof.mp4
note fmp4_default_base_moof.mp4 mp4 fmp4 ok "as above with default_base_is_moof (tfhd flags 0x20038)"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -f mp4 -movflags empty_moov+default_base_moof -frag_duration 500000 fmp4_frag_duration.mp4
note fmp4_frag_duration.mp4 mp4 fmp4 ok "fragments cut by duration (0.5 s): 8 moof for 120 samples"
"${FF[@]}" -f lavfi -i "$S4" "${H264B[@]}" -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof fmp4_bframes.mp4
note fmp4_bframes.mp4 mp4 fmp4 ok "fragmented with B-frames: trun composition offsets, no elst, start_time 0.067"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -f mp4 -movflags frag_keyframe fmp4_hybrid_no_empty_moov.mp4
note fmp4_hybrid_no_empty_moov.mp4 mp4 fmp4 ok "moov already holds 30 samples (stts) + 3 moofs with 90 more: ffprobe nb_frames=30 but 120 real"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -f mp4 -movflags cmaf fmp4_cmaf.mp4
note fmp4_cmaf.mp4 mp4 fmp4 ok "movflags cmaf"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx fmp4_global_sidx.mp4
note fmp4_global_sidx.mp4 mp4 fmp4 ok "global sidx right after moov"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -f mp4 -movflags dash fmp4_dash_flag.mp4
note fmp4_dash_flag.mp4 mp4 fmp4 ok "movflags dash: sidx before every moof"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -keyint_min 30 -sc_threshold 0 -f mp4 -movflags +hybrid_fragmented mp4_hybrid_fragmented_finalized.mp4
note mp4_hybrid_fragmented_finalized.mp4 mp4 fmp4 ok "hybrid_fragmented: written fragmented, finalized to a plain ftyp free mdat moov file (4 chunks)"
DT="$W/dash"; mkdir -p "$DT"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -keyint_min 30 -sc_threshold 0 -f dash -seg_duration 1 -single_file 1 -single_file_name v.mp4 -init_seg_name init.m4s "$DT/out.mpd"
cp "$DT/v.mp4" fmp4_dash_single_file.mp4
note fmp4_dash_single_file.mp4 mp4 fmp4 ok "-f dash single_file: ftyp moov (sidx moof mdat)x4; moov has elst with segment_duration=0"
"${FF[@]}" -f lavfi -i "$S4" "${H264[@]}" -keyint_min 30 -sc_threshold 0 -f dash -seg_duration 1 -use_template 0 -use_timeline 0 "$DT/seg.mpd"
cat "$DT"/init-stream0.m4s "$DT"/chunk-stream0-0000{1,2,3,4}.m4s > fmp4_dash_concat_segments.mp4
note fmp4_dash_concat_segments.mp4 mp4 fmp4 ok "CMAF-style: init segment + 4 media segments concatenated: moov (styp sidx moof mdat)x4"
rm -rf "$DT"

# ---------- E. Other codecs / containers ----------
"${FF[@]}" -f lavfi -i "$S30" -c:v libx265 -preset ultrafast -crf 32 -pix_fmt yuv420p -x265-params log-level=error:keyint=30 -tag:v hvc1 -an -f mp4 hevc_hvc1.mp4
note hevc_hvc1.mp4 mp4 codec ok "HEVC sample entry hvc1 (coded size 160x96, display 160x90)"
"${FF[@]}" -f lavfi -i "$S30" -c:v libx265 -preset ultrafast -crf 32 -pix_fmt yuv420p -x265-params log-level=error:keyint=30 -tag:v hev1 -an -f mp4 hevc_hev1.mp4
note hevc_hev1.mp4 mp4 codec ok "HEVC sample entry hev1"
"${FF[@]}" -f lavfi -i "$S30" -c:v libaom-av1 -cpu-used 8 -crf 45 -b:v 0 -g 30 -pix_fmt yuv420p -an -f mp4 av1.mp4
note av1.mp4 mp4 codec ok "AV1 in MP4 (av01) via libaom"
"${FF[@]}" -f lavfi -i "$S30" "${VP9[@]}" -f mp4 vp9.mp4
note vp9.mp4 mp4 codec ok "VP9 in MP4 (vp09)"
"${FF[@]}" -f lavfi -i "$S30" "${VP9[@]}" "${BX[@]}" -f webm vp9.webm
note vp9.webm webm codec ok "VP9 WebM, known sizes, Cues, Duration, DefaultDuration=33366666 ns"
"${FF[@]}" -f lavfi -i "$S30" -c:v libvpx -deadline realtime -cpu-used 8 -crf 20 -b:v 1M -g 30 -an "${BX[@]}" -f webm vp8.webm
note vp8.webm webm codec ok "VP8 WebM"
"${FF[@]}" -f lavfi -i "$S30" -c:v libaom-av1 -cpu-used 8 -crf 45 -b:v 0 -g 30 -pix_fmt yuv420p -an "${BX[@]}" -f webm av1.webm
note av1.webm webm codec ok "AV1 WebM"
"${FF[@]}" -f lavfi -i "$S30" "${H264[@]}" "${BX[@]}" -f matroska h264.mkv
note h264.mkv matroska matroska ok "Matroska with H.264"
"${FF[@]}" -f lavfi -i "$S30" -c:v libx265 -preset ultrafast -crf 32 -pix_fmt yuv420p -x265-params log-level=error:keyint=30 -an "${BX[@]}" -f matroska hevc.mkv
note hevc.mkv matroska codec ok "HEVC (H.265) in Matroska"
"${FF[@]}" -f lavfi -i "$S30" "${VP9[@]}" "${BX[@]}" -f webm -live 1 vp9_live.webm
note vp9_live.webm webm live ok "-live 1: Segment size unknown, no Duration, no Cues, clusters keep known size. crashed.mkv (ffmpeg killed mid-write) is not in the corpus: not byte-reproducible"
"${FF[@]}" -f lavfi -i "$S30" "${VP9[@]}" "${BX[@]}" -f webm pipe:1 > vp9_pipe.webm
note vp9_pipe.webm webm live ok "written to a pipe: identical structure to -live 1 (non-seekable output)"
node "$TOOLS/patch-webm.mjs" unknown-clusters vp9_live.webm vp9_unknown_clusters.webm > /dev/null
note vp9_unknown_clusters.webm webm live ok "MediaRecorder-like: Segment AND every Cluster have unknown size (01FFFF.. / 3FFFFF), no Cues/Duration"
node "$TOOLS/patch-webm.mjs" void-defaultduration vp9.webm vp9_no_defaultduration.webm > /dev/null
note vp9_no_defaultduration.webm webm matroska ok "DefaultDuration element overwritten by an EBML Void: only block timestamps (ms) remain"

# ---------- F. VFR (variable frame rate): every method proven by packet PTS deltas in the reference ----------
SEGS=(-f lavfi -i "testsrc2=size=160x90:rate=10:duration=2" -f lavfi -i "testsrc2=size=160x90:rate=30:duration=2" -f lavfi -i "testsrc2=size=160x90:rate=60:duration=2")
CONCAT='[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]'
"${FF[@]}" "${SEGS[@]}" -filter_complex "$CONCAT" -map '[v]' "${H264[@]}" "${VFR[@]}" -video_track_timescale 90000 vfr_concat_10_30_60.mp4
note vfr_concat_10_30_60.mp4 mp4 vfr ok "VFR method 1: concat of 2 s segments at 10/30/60 fps, passthrough; avg 100/3, nominal r=60; timescale 90000"
"${FF[@]}" "${SEGS[@]}" -filter_complex "$CONCAT" -map '[v]' "${H264B[@]}" "${VFR[@]}" -video_track_timescale 90000 vfr_concat_bframes.mp4
note vfr_concat_bframes.mp4 mp4 vfr ok "VFR + B-frames: stts (DTS deltas) and display-order PTS deltas differ, so FPS min/max from stts is not the same as from PTS"
"${FF[@]}" "${SEGS[@]}" -filter_complex "$CONCAT" -map '[v]' "${H264[@]}" "${VFR[@]}" vfr_concat_10_30_60_ts1M.mp4
note vfr_concat_10_30_60_ts1M.mp4 mp4 vfr ok "same, ffmpeg default timescale 1000000: rounding gives 33333/33334 tick durations (5 distinct deltas)"
"${FF[@]}" "${SEGS[@]}" -filter_complex "$CONCAT" -map '[v]' "${H264[@]}" "${VFR[@]}" -video_track_timescale 90000 -f mov vfr_concat_10_30_60.mov
note vfr_concat_10_30_60.mov mov vfr ok "same in MOV"
"${FF[@]}" "${SEGS[@]}" -filter_complex "$CONCAT" -map '[v]' "${VP9[@]}" "${VFR[@]}" "${BX[@]}" vfr_concat_10_30_60.webm
note vfr_concat_10_30_60.webm webm vfr ok "same in WebM: ffprobe avg_frame_rate=0/0, r_frame_rate=30/1; DefaultDuration describes only one rate"
"${FF[@]}" "${SEGS[@]}" -filter_complex "$CONCAT" -map '[v]' "${H264[@]}" "${VFR[@]}" -video_track_timescale 90000 -movflags frag_keyframe+empty_moov+default_base_moof vfr_concat_10_30_60_fmp4.mp4
note vfr_concat_10_30_60_fmp4.mp4 mp4 vfr ok "same, fragmented: durations live in trun"
"${FF[@]}" -f lavfi -i "$(src 30 5)" -vf "settb=1/90000,setpts='(N+6*sin(N/8))*3000'" "${H264[@]}" "${VFR[@]}" -enc_time_base:v 1/90000 -video_track_timescale 90000 vfr_setpts_sine.mp4
note vfr_setpts_sine.mp4 mp4 vfr ok "VFR method 2: non-linear setpts, delta = 3000*(1+0.75cos(N/8)) ticks -> inst. FPS 17..120"
"${FF[@]}" -f lavfi -i "$(src 60 5)" -vf "select='lt(mod(n*7,10),6)',settb=1/90000" "${H264[@]}" "${VFR[@]}" -video_track_timescale 90000 vfr_select_drop.mp4
note vfr_select_drop.mp4 mp4 vfr ok "VFR method 3: select drops 4 of every 10 frames of a 60 fps source (gaps of 1,2,3 frames)"
"${FF[@]}" -f lavfi -i "$(src 30 1.5)" -f lavfi -i "color=c=gray:size=160x90:rate=30:duration=1.5" -f lavfi -i "$(src 30 1.5)" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,mpdecimate,settb=1/90000[v]" -map '[v]' "${H264[@]}" "${VFR[@]}" -video_track_timescale 90000 vfr_mpdecimate.mp4
note vfr_mpdecimate.mp4 mp4 vfr ok "VFR method 4: mpdecimate removes the static middle: one ~1.5 s gap (min inst FPS 0.67)"
SC="select='not(between(mod(n,150),60,119))+not(mod(n,20))',settb=1/1000,setpts=PTS+random(0)*7"
"${FF[@]}" -f lavfi -i "$(src 60 6)" -vf "$SC" "${H264[@]}" "${VFR[@]}" -enc_time_base:v 1/1000 -video_track_timescale 1000 vfr_screenrec_ts1000.mp4
note vfr_screenrec_ts1000.mp4 mp4 vfr ok "VFR method 5: screen-recording-like, timescale 1000, 0-7 ms jitter, long gaps; 246 frames, avg ~41 (61500/1501)"
"${FF[@]}" -f lavfi -i "$(src 60 6)" -vf "$SC" "${VP9[@]}" "${VFR[@]}" "${BX[@]}" vfr_screenrec_ts1000.webm
note vfr_screenrec_ts1000.webm webm vfr ok "same in WebM: DefaultDuration claims 60 fps while real average is ~41"
"${FF[@]}" -f lavfi -i "$(src 24 5)" "${H264[@]}" -bf 0 -g 24 -video_track_timescale 90000 -f mp4 "$W/src24.mp4"
"${FF[@]}" -i "$W/src24.mp4" -c copy -bsf:v "setts=pts='(5*floor(N/2)+2*mod(N,2))*1500':dts='(5*floor(N/2)+2*mod(N,2))*1500':duration='(2+mod(N,2))*1500'" -video_track_timescale 90000 vfr_pulldown_2_3.mp4
note vfr_pulldown_2_3.mp4 mp4 vfr ok "VFR method 6: setts bsf rewrites a 24 fps stream to a 2:3 cadence (3000/4500 ticks); avg exactly 24, r=60"
TWO=(-f lavfi -i "testsrc2=size=160x90:rate=5:duration=4" -f lavfi -i "testsrc2=size=160x90:rate=200:duration=4")
TWOCAT='[0:v][1:v]concat=n=2:v=1:a=0[v]'
"${FF[@]}" "${TWO[@]}" -filter_complex "$TWOCAT" -map '[v]' "${H264[@]}" "${VFR[@]}" -video_track_timescale 90000 vfr_two_phase_5_200.mp4
note vfr_two_phase_5_200.mp4 mp4 vfr ok "rate profile: 4 s at 5 fps then 4 s at 200 fps (20 + 800 frames), passthrough, timescale 90000; avg 205/2"
"${FF[@]}" "${TWO[@]}" -filter_complex "$TWOCAT" -map '[v]' "${VP9[@]}" "${VFR[@]}" "${BX[@]}" vfr_two_phase_5_200.webm
note vfr_two_phase_5_200.webm webm vfr ok "same two phases in WebM (VP9): 200 ms and 5 ms block timestamps"
"${FF[@]}" -i vfr_two_phase_5_200.mp4 -c copy "${BX[@]}" -f matroska vfr_two_phase_5_200.mkv
note vfr_two_phase_5_200.mkv matroska vfr ok "same two phases, the H.264 MP4 stream-copied to Matroska"
"${FF[@]}" -f lavfi -i "$(src 30 4)" -vf "settb=1/90000,setpts='(N+gt(N,59)*59)*3000'" "${H264[@]}" "${VFR[@]}" -enc_time_base:v 1/90000 -video_track_timescale 90000 vfr_freeze_2s.mp4
note vfr_freeze_2s.mp4 mp4 vfr ok "rate profile: 30 fps with one frame held for 2 s at 1.967 s (frame 59), 120 frames over 5.967 s"

# ---------- G. 64-bit box sizes (in-place header rewrite, as ffmpeg itself does when mdat > 4 GiB) ----------
node "$TOOLS/patch-mp4.mjs" mdat64 mov_nobf_default.mov box64_mdat64_wide.mov > /dev/null
note box64_mdat64_wide.mov mov box64 ok "'wide'+mdat(32) rewritten to size=1 'mdat' largesize (16-byte header); same file size, same stco offsets"
node "$TOOLS/patch-mp4.mjs" mdat64 cfr_h264_30.mp4 box64_mdat64_free.mp4 > /dev/null
note box64_mdat64_free.mp4 mp4 box64 ok "'free'+mdat(32) rewritten the same way"
node "$TOOLS/patch-mp4.mjs" co64 mp4_bf_elst.mp4 box64_co64_mdat64.mp4 > /dev/null
note box64_co64_mdat64.mp4 mp4 box64 ok "64-bit mdat header + every stco rewritten to co64 (moov grows by 4 bytes/chunk)"

# ---------- H. Track layout traps ----------
AUD=(-f lavfi -i "sine=frequency=440:sample_rate=44100:duration=3")
"${FF[@]}" -f lavfi -i "$(src 30 3)" "${AUD[@]}" "${H264V[@]}" -c:a aac -b:a 32k -f mp4 av_h264_aac.mp4
note av_h264_aac.mp4 mp4 multi ok "video + AAC audio, moov at end (the typical real-world file)"
"${FF[@]}" -f lavfi -i "$(src 30 3)" "${AUD[@]}" "${H264V[@]}" -c:a aac -b:a 32k -movflags +faststart -f mp4 av_h264_aac_faststart.mp4
note av_h264_aac_faststart.mp4 mp4 multi ok "video + AAC audio, faststart"
"${FF[@]}" -f lavfi -i "$(src 30 3)" -f lavfi -i "$(src 24 4 320x180)" "${AUD[@]}" -map 0:v -map 1:v -map 2:a "${H264V[@]}" -c:a aac -b:a 32k -f mp4 multi_video_2tracks.mp4
note multi_video_2tracks.mp4 mp4 multi ok "two real video tracks: 160x90 @30 (3 s) first, 320x180 @24 (4 s) second, + audio"
"${FF[@]}" -f lavfi -i "testsrc2=size=64x64" -frames:v 1 "$W/cover.png"
"${FF[@]}" -i "$W/cover.png" -frames:v 1 -c:v mjpeg -f mp4 "$W/still.mp4"
"${FF[@]}" -i "$W/still.mp4" -i av_h264_aac.mp4 -map 0:v -map 1:v -map 1:a -c copy -f mp4 still_image_track_first.mp4
note still_image_track_first.mp4 mp4 multi ok "first video trak is a 1-sample MJPEG still (64x64, 0.04 s), real H.264 video is track 2"
"${FF[@]}" "${AUD[@]}" -i "$W/cover.png" -map 0:a -map 1:v -c:a aac -b:a 32k -c:v mjpeg -disposition:v:0 attached_pic -f ipod cover_art_audio.m4a
note cover_art_audio.m4a mp4 cover no-video "audio-only M4A with cover art stored in udta/meta/ilst/covr (no video trak, but ffprobe lists an attached_pic video stream)"
"${FF[@]}" -i "$W/cover.png" -f lavfi -i "$(src 30 3)" "${AUD[@]}" -map 0:v -map 1:v -map 2:a -c:v:0 mjpeg -disposition:v:0 attached_pic -c:v:1 libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -g 30 -c:a aac -b:a 32k -f mp4 cover_art_plus_video.mp4
note cover_art_plus_video.mp4 mp4 cover ok "real video + covr cover art; ffprobe shows 3 streams (attached_pic first), trak list has only video+audio"
"${FF[@]}" "${AUD[@]}" -c:a aac -b:a 32k -f ipod audio_only.m4a
note audio_only.m4a mp4 audio no-video "audio-only M4A (ipod brand), no video trak"
"${FF[@]}" "${AUD[@]}" -c:a aac -b:a 32k -f mp4 audio_only_aac.mp4
note audio_only_aac.mp4 mp4 audio no-video "audio-only MP4"
"${FF[@]}" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" -c:a libopus -b:a 24k "${BX[@]}" -f webm audio_only_opus.webm
note audio_only_opus.webm webm audio no-video "audio-only WebM/Opus (no video TrackEntry)"
"${FF[@]}" -f lavfi -i "$(src 30 0.1)" -frames:v 1 "${H264[@]}" -f mp4 edge_single_frame.mp4
note edge_single_frame.mp4 mp4 edge still "one video sample: avg FPS undefined, treated as a still image"

# ---------- I. Negative / corrupt / lying files ----------
: > corrupt_empty_0byte.mp4
note corrupt_empty_0byte.mp4 unknown corrupt error "zero-byte file"
node "$TOOLS/make-corrupt.mjs" garbage corrupt_garbage_random.mp4 65536 12345
note corrupt_garbage_random.mp4 unknown corrupt error "64 KiB xorshift noise, .mp4 extension"
printf 'This is a plain text file with an .mp4 extension.\nNot a video.\n' > corrupt_text_named.mp4
note corrupt_text_named.mp4 unknown corrupt error "ASCII text with .mp4 extension"
cp "$W/cover.png" corrupt_png_named.mp4
note corrupt_png_named.mp4 unknown corrupt error "a PNG image saved with .mp4 extension (ffprobe sniffs png_pipe and reports a png video stream; the app must not treat it as a container)"
node "$TOOLS/make-corrupt.mjs" truncate cfr_h264_30.mp4 corrupt_trunc_moov_partial.mp4 moov-half > /dev/null
note corrupt_trunc_moov_partial.mp4 mp4 corrupt error "non-faststart file cut in the middle of moov"
node "$TOOLS/make-corrupt.mjs" truncate cfr_h264_30.mp4 corrupt_trunc_no_moov.mp4 mdat-end > /dev/null
note corrupt_trunc_no_moov.mp4 mp4 corrupt error "non-faststart file cut exactly where moov would start (interrupted recording)"
node "$TOOLS/make-corrupt.mjs" truncate av_h264_aac_faststart.mp4 corrupt_trunc_mdat_faststart.mp4 ratio:0.6 > /dev/null
note corrupt_trunc_mdat_faststart.mp4 mp4 corrupt ok "moov intact (faststart) but mdat cut at 60%: header says 90 frames, only 53 decodable"
node "$TOOLS/make-corrupt.mjs" truncate fmp4_keyframe_empty_moov.mp4 corrupt_fmp4_truncated_mid_fragment.mp4 ratio:0.6 > /dev/null
note corrupt_fmp4_truncated_mid_fragment.mp4 mp4 corrupt ok "fragmented MP4 cut at 60% (interrupted live recording): last moof/mdat incomplete"
node "$TOOLS/make-corrupt.mjs" mdat-size0 av_h264_aac_faststart.mp4 box_mdat_size0.mp4
note box_mdat_size0.mp4 mp4 box64 ok "last mdat has size field 0 ('extends to end of file')"
node "$TOOLS/make-corrupt.mjs" stts-count cfr_h264_30.mp4 corrupt_stts_count_huge.mp4 2147483647
note corrupt_stts_count_huge.mp4 mp4 corrupt ok "stts entry_count lies (2^31-1): the app bounds reads by box size and warns; ffprobe fails (error reading header)"
cp vp9.webm sniff_webm_named_mp4.mp4
note sniff_webm_named_mp4.mp4 webm sniff ok "real WebM named .mp4: sniff magic, not extension"
cp cfr_h264_30.mp4 sniff_mp4_named_webm.webm
note sniff_mp4_named_webm.webm mp4 sniff ok "real MP4 named .webm"
cp cfr_h264_30.mp4 sniff_mp4_named_mkv.mkv
note sniff_mp4_named_mkv.mkv mp4 sniff ok "real MP4 named .mkv"

# ---------- K. Fragmented VFR and Matroska additions ----------
SEL60="select='lt(n\,60)+not(mod(n\,3))'"
FRAGVFR=(-fps_mode vfr -bf 0 -video_track_timescale 90000)
"${FF[@]}" -f lavfi -i "$(src 60 5)" -vf "$SEL60" "${H264[@]}" "${FRAGVFR[@]}" -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx frag_vfr_global_sidx.mp4
note frag_vfr_global_sidx.mp4 mp4 fmp4 ok "fragmented VFR (60 fps for 1 s, then every 3rd frame) with a global sidx: ffprobe reads only the first fragment (avg 60/1), true average 4200/149"
"${FF[@]}" -f lavfi -i "$(src 60 5)" -vf "$SEL60" "${H264[@]}" "${FRAGVFR[@]}" -movflags +dash frag_vfr_dash.mp4
note frag_vfr_dash.mp4 mp4 fmp4 ok "same content with movflags dash (sidx per fragment): ffprobe reads all but the last fragment (avg 30/1), true average 4200/149"
"${FF[@]}" -f lavfi -i "$(src 60 6)" -vf "select='not(between(mod(n,18),1,5))'" "${H264[@]}" "${VFR[@]}" -video_track_timescale 90000 "$W/vfr260.mp4"
"${FF[@]}" -i "$W/vfr260.mp4" -c copy "${BX[@]}" -f matroska h264_vfr_remux.mkv
note h264_vfr_remux.mkv matroska vfr ok "VFR MP4 stream-copied to Matroska: DefaultDuration 23076923 = the true average 130/3, 260 BlockGroups each with a BlockDuration"
"${FF[@]}" -f lavfi -i "$(src 30 3)" "${VP9[@]}" "${BX[@]}" -t 10 -f webm pipe:1 > vp9_pipe_t10.webm
note vp9_pipe_t10.webm webm live ok "3 s source piped with -t 10: Info Duration says 10.000 but 90 frames end at 3.0 s"
"${FF[@]}" -f lavfi -i "$(src 30 3)" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" -map 0:v -map 1:a "${VP9V[@]}" -c:a libopus -b:a 24k "${BX[@]}" -live 1 -f webm vp9_opus_live_audiotail.webm
note vp9_opus_live_audiotail.webm webm live ok "3 s video + 6 s Opus, -live 1: last cluster holds no video, the tail scan must reach the last video PTS (2.967 s)"
"${FF[@]}" -f lavfi -i "$(src 25 3)" "${H264[@]}" -attach "$W/cover.png" -metadata:s:t mimetype=image/png "${BX[@]}" -f matroska h264_25_cover.mkv
note h264_25_cover.mkv matroska cover ok "Matroska with an attached cover.png: ffprobe lists an attached_pic stream (r 90000/1) that the app ignores"

# ---------- M. Real-world timing patterns (remuxes, held first frame, lost fragment, trimmed copy, slow motion) ----------
for pair in 120:120 29.97:30000/1001; do
  name=${pair%%:*}; rate=${pair#*:}
  "${FF[@]}" -i "cfr_vp9_$name.webm" -c copy -f mp4 "remux_cfr_${name}_ts16000.mp4"
  note "remux_cfr_${name}_ts16000.mp4" mp4 cfr ok "cfr_vp9_$name.webm stream-copied to MP4 (MKV-to-MP4 remux): timescale 16000, PTS on a 1 ms grid, so deltas differ by 16 ticks; CFR $rate, 1 ms quantized"
done
"${FF[@]}" -f lavfi -i "$(src 30 5)" -vf "setpts='if(eq(N\,0)\,0\,(2+(N-1)/30)/TB)'" "${VFR[@]}" -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -g 30 -bf 3 -an -video_track_timescale 30000 start_freeze_bf.mp4
note start_freeze_bf.mp4 mp4 vfr ok "first frame held 2 s, then 30 fps, B-frames + elst: stts starts 60000, 1000, 60000; avg_frame_rate 1125/67 differs from presented frames / span 4500/209"
"${FF[@]}" -f lavfi -i "$(src 30 6)" -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -g 30 -bf 0 -an -movflags +frag_keyframe+empty_moov+default_base_moof "$W/frag6.mp4"
node "$TOOLS/make-corrupt.mjs" drop-fragment "$W/frag6.mp4" fmp4_missing_fragment.mp4 3
note fmp4_missing_fragment.mp4 mp4 fmp4 ok "fragmented 30 fps with the 3rd moof+mdat removed: tfdt jumps 1 s, avg_frame_rate 30/1, presented frames / span 25/1"
"${FF[@]}" -ss 0.95 -i vfr_two_phase_5_200.mp4 -c copy elst_trim_vfr_copy.mp4
note elst_trim_vfr_copy.mp4 mp4 vfr ok "vfr_two_phase_5_200.mp4 trimmed with -ss 0.95 -c copy: elst skips 5 stored frames, avg_frame_rate counts them"
"${FF[@]}" -f lavfi -i "$(src 240 2 64x64)" -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -bf 0 -an -video_track_timescale 600 cfr_240_ts600.mp4
note cfr_240_ts600.mp4 mp4 cfr ok "240 fps at timescale 600 (QuickTime-like slow motion): deltas alternate 3 and 2 ticks, nominal 240/1"
"${FF[@]}" -f lavfi -i "$(src 25 4 160x96)" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=4" -map 0:v -map 1:a -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -bf 2 -c:a aac -b:a 32k -movflags +frag_keyframe+empty_moov+global_sidx+dash fmp4_global_sidx_bframes.mp4
note fmp4_global_sidx_bframes.mp4 mp4 fmp4 ok "plain ffmpeg DASH output with B-frames: global sidx with earliest_presentation_time 1024, ffprobe duration = ept + subsegment durations (4.08 s, format 4.16 s)"

# ---------- N. Late rate changes (Tier L): constant for more than 5000 frames, then a change; 64x36, at most 1 MB ----------
LATEV=(-c:v libx264 -preset ultrafast -crf 51 -pix_fmt yuv420p -g 300 -bf 0 -an -x264-params scenecut=0:keyint=300)
"${FF[@]}" -f lavfi -i "testsrc2=size=64x36:rate=30:duration=200" -f lavfi -i "testsrc2=size=64x36:rate=60:duration=20" -filter_complex '[0:v][1:v]concat=n=2:v=1:a=0[v]' -map '[v]' "${LATEV[@]}" "${VFR[@]}" -video_track_timescale 90000 late_30_to_60.mp4
note late_30_to_60.mp4 mp4 vfr ok "late change: 6000 frames at 30 fps (200 s), then 1200 at 60 fps (20 s); avg 360/11, the change is far past a 256-packet probe"
"${FF[@]}" -f lavfi -i "testsrc2=size=64x36:rate=25:duration=220" -f lavfi -i "testsrc2=size=64x36:rate=12.5:duration=40" -filter_complex '[0:v][1:v]concat=n=2:v=1:a=0[v]' -map '[v]' -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 63 -b:v 0 -g 250 -an "${VFR[@]}" "${BX[@]}" late_25_to_12.5.webm
note late_25_to_12.5.webm webm vfr ok "late change in WebM (VP9): 5500 frames at 25 fps (220 s), then 500 at 12.5 fps (40 s); 6000 frames over 260 s; no DefaultDuration, ffprobe estimates avg_frame_rate 25/1 from the first packets"
"${FF[@]}" -f lavfi -i "testsrc2=size=64x36:rate=25:duration=250" -vf "settb=1/90000,setpts='(N+gt(N,5999)*250)*3600'" "${LATEV[@]}" "${VFR[@]}" -enc_time_base:v 1/90000 "${BX[@]}" -f matroska late_freeze_10s.mkv
note late_freeze_10s.mkv matroska vfr ok "late freeze in Matroska (H.264): 25 fps, frame 5999 held 10.04 s at 239.96 s, then 250 more frames; 6250 frames over 260 s"

# ---------- O. Header values other parsers trip on: 64-bit all-ones durations, data after moov ----------
node "$TOOLS/patch-mp4.mjs" mehd fmp4_default_base_moof.mp4 fmp4_mehd_all_ones.mp4 ffffffffffffffff > /dev/null
note fmp4_mehd_all_ones.mp4 mp4 fmp4 ok "fmp4_default_base_moof.mp4 with a version 1 mehd of 0xFFFFFFFFFFFFFFFF (unknown fragment duration) in mvex: ffprobe never reads mehd, the app ignores it"
node "$TOOLS/patch-mp4.mjs" elst64 cfr_h264_30.mp4 corrupt_elst64_all_ones.mp4 ffffffffffffffff > /dev/null
note corrupt_elst64_all_ones.mp4 mp4 corrupt ok "cfr_h264_30.mp4 with its elst rewritten as version 1 and a segment duration of 0xFFFFFFFFFFFFFFFF: the app reads the edit as lasting to the end and warns; ffprobe fails (invalid edit list duration -1)"

# ---------- R. Browser recordings (Tier R): made by record-mediarecorder.mjs, not by this script; rows, and a copy into another root ----------
# Real MediaRecorder output of a canvas animation (rAF, a 0.6 s freeze, a 15 fps timer, rAF again), 320x180 at
# 250 kbps, recorded once on 2026-10-24 in headless Chromium 156.0.8078.4 and committed as recorded (CC0).
REC="Chromium 156 MediaRecorder"
note rec_chromium_vp8.webm webm recorder ok "$REC video/webm;codecs=vp8, one piece: sized Segment, Duration and Cues, no DefaultDuration"
note rec_chromium_vp8_sliced.webm webm recorder ok "$REC video/webm;codecs=vp8, 250 ms timeslice: unknown-size Segment and Clusters, no Duration, no Cues, no DefaultDuration"
note rec_chromium_vp9.webm webm recorder ok "$REC video/webm;codecs=vp9, one piece: sized Segment, Duration and Cues, no DefaultDuration"
note rec_chromium_vp9_sliced.webm webm recorder ok "$REC video/webm;codecs=vp9, 250 ms timeslice: unknown-size Segment and Clusters, no Duration, no Cues, no DefaultDuration"
note rec_chromium_av1.webm webm recorder ok "$REC video/webm;codecs=av1 (recorded as av01), one piece: sized Segment, Duration and Cues, no DefaultDuration"
note rec_chromium_av1_sliced.webm webm recorder ok "$REC video/webm;codecs=av1 (recorded as av01), 250 ms timeslice: unknown-size Segment and Clusters, no Duration, no Cues, no DefaultDuration"
note rec_chromium_h264.mkv matroska recorder ok "$REC video/webm;codecs=h264, recorded as video/x-matroska;codecs=avc1 (DocType matroska), one piece: Duration and Cues, no DefaultDuration"
note rec_chromium_h264_sliced.mkv matroska recorder ok "$REC video/webm;codecs=h264, recorded as video/x-matroska;codecs=avc1, 250 ms timeslice: unknown sizes, no Duration, no Cues, no DefaultDuration"
note rec_chromium_h264.mp4 mp4 recorder ok "$REC video/mp4;codecs=avc1, one piece: fragmented (empty moov, moof mdat, mfra), mvhd duration set"
note rec_chromium_h264_sliced.mp4 mp4 recorder ok "$REC video/mp4;codecs=avc1, 250 ms timeslice: fragmented, mvhd duration 0, no mfra"
note rec_chromium_vp9.mp4 mp4 recorder ok "$REC video/mp4 (recorded as video/mp4;codecs=vp9), one piece: fragmented (empty moov, moof mdat, mfra), mvhd duration set"
note rec_chromium_vp9_sliced.mp4 mp4 recorder ok "$REC video/mp4 (recorded as video/mp4;codecs=vp9), 250 ms timeslice: fragmented, mvhd duration 0, no mfra"
for f in $(awk -F'\t' '$3 == "recorder" { print $1 }' "$MANIFEST"); do
  [[ -f "$f" ]] || cp "$HERE/../../fixtures/files/$f" "$f"
done

# ---------- L. Optional heavy files (manifest rows are always written, files only on request) ----------
note_large long_cfr_3h_60fps.mp4 mp4 long ok "3 h x 60 fps = 648000 frames, 64x36, crf 51: 13 MB, moov 2.6 MB at the end (stsz 4 B/frame)"
note_large long_vfr_1h_screenrec.mp4 mp4 long ok "1 h VFR screen-recording-like: 133920 frames, stts has 124761 entries (~1 MB)"
note_large big_1080p_moov_end.mp4 mp4 big ok "60 s of 1080p30 H.264 with film-grain noise, CRF 21 (604 MB), moov at the end: a phone-sized upload, measured in the browser"
note_large big_1080p_faststart.mp4 mp4 big ok "the same file with -movflags +faststart (moov before mdat)"
note_large big_1080p.mkv matroska big ok "the same stream copied to Matroska: auto mode decides between probe and exact by the predicted scan cost"
note_large sparse_4_5gb_co64.mp4 mp4 sparse ok "SPARSE 4.5 GB logical: ftyp + mdat(64-bit, hole+payload) + moov(co64, offsets > 2^32) at 4.5 GB; ~87 KB real data. Do NOT copy with tools that expand sparse files"
if [[ $WITH_LONG == 1 ]]; then
  LONG=(-c:v libx264 -preset ultrafast -crf 51 -pix_fmt yuv420p -g 120 -bf 0 -an -x264-params scenecut=0:keyint=120)
  "${FF[@]}" -f lavfi -i "testsrc2=size=64x36:rate=60:duration=10800" "${LONG[@]}" -f mp4 "$LARGE/long_cfr_3h_60fps.mp4"
  "${FF[@]}" -f lavfi -i "testsrc2=size=64x36:rate=60:duration=3600" -vf "$SC" "${LONG[@]}" "${VFR[@]}" -enc_time_base:v 1/1000 -video_track_timescale 1000 -f mp4 "$LARGE/long_vfr_1h_screenrec.mp4"
fi
if [[ $WITH_BIG == 1 ]]; then
  "${FF[@]}" -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=60" -vf "noise=alls=8:allf=t:all_seed=1" -c:v libx264 -preset ultrafast -crf 21 -pix_fmt yuv420p -g 60 -an "$LARGE/big_1080p_moov_end.mp4"
  "${FF[@]}" -i "$LARGE/big_1080p_moov_end.mp4" -c copy -movflags +faststart "$LARGE/big_1080p_faststart.mp4"
  "${FF[@]}" -i "$LARGE/big_1080p_moov_end.mp4" -c copy "${BX[@]}" -f matroska "$LARGE/big_1080p.mkv"
fi
if [[ $WITH_SPARSE == 1 ]]; then
  node "$TOOLS/patch-mp4.mjs" sparse cfr_h264_30.mp4 "$LARGE/sparse_4_5gb_co64.mp4" 4500000000 > /dev/null
fi

# ---------- consistency: manifest rows <-> files ----------
fail=0
while IFS=$'\t' read -r name _ _ _ committed _ path; do
  [[ "$name" == name ]] && continue
  if [[ "$committed" == yes && ! -f "$ROOT/$path" ]]; then echo "ERROR: manifest row without file: $path" >&2; fail=1; fi
done < "$MANIFEST"
for f in "$FILES"/*; do
  n="$(basename "$f")"
  awk -F'\t' -v p="files/$n" '$7 == p { found = 1 } END { exit !found }' "$MANIFEST" || { echo "ERROR: file without manifest row: files/$n" >&2; fail=1; }
done
[[ $fail == 0 ]] || exit 1
echo "done: $(ls "$FILES" | wc -l | tr -d ' ') core fixtures in $FILES ($(( $(wc -l < "$MANIFEST") - 1 )) manifest rows)"
