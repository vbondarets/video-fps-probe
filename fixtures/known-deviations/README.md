# Known deviations

Accepted differences between an engine and ffprobe 8.1.1. `npm run compare` (`scripts/compare-ffprobe.ts`) reads these files to tell an accepted difference from a regression. This format replaces the placeholder `fixtures/known-deviations.json`.

## Files

One JSON file per engine part. A file belongs to engine `E` when it is named `E.json` or starts with `E-`:

| Engine | Files read |
| --- | --- |
| `own` | `own-isobmff.json`, `own-matroska.json` (any `own*.json`), merged |
| `mp4box` | `mp4box.json` |
| `mediabunny` | `mediabunny.json` |

Only the `own` engine fails the run on an unexpected mismatch. The library engines are informational, so their files are optional.

## Format

```json
{
  "<fixture file name>": {
    "<field>": "<concrete reason>"
  }
}
```

- The fixture name is the key used in `manifest.tsv` and `ref/`.
- The reason says why the app differs from ffprobe, in one or two plain sentences. At least 15 characters; the script rejects shorter ones. Do not write "TODO", "known issue" or "n/a".
- English only, no long dashes.

Field names:

`avgFps`, `nominalFps`, `frames`, `presentedFrames`, `durationSec`, `startSec`, `formatDurationSec`, `minFps`, `maxFps`, `isVfr`, `duplicateTimestamps`, `width`, `height`, `codecName`, `error`, `trackSelection`.

`avgFps` also accepts two finer keys for Matroska, where it is checked twice: `avgFps.declared` (the DefaultDuration string against `avg_frame_rate`) and `avgFps.measured` (the exact-scan average against `avgFromPts`). A finer key wins over `avgFps`.

A deviation covers the field on every video track of the fixture.

## How an entry is used

- It applies only when the check would otherwise be a `mismatch`; the verdict becomes `known-deviation` and the reason is printed in `report/accuracy.md`.
- An entry whose check is `exact`, `within-tol` or `n/a` is reported as stale. Remove it when the app starts to match.
- Unknown field names, non-object values and fixtures that are not in `manifest.tsv` are reported as file problems, and the entry is ignored.
- A deviation is never a way to hide a bug. Use it for differences that come from ffprobe itself (it under-reads, it estimates, it counts decoded frames) or from a documented choice of the app (research.md section 2).

## Built-in deviation

One deviation needs no entry because research 2.1 and 6.4 define it: ffprobe computes `avg_frame_rate` from the fragments it reads while opening the file. With a global sidx it reads the first fragment, with a per-fragment sidx all but the last. When the file is fragmented and has a sidx (found by a top-level box scan), the app value differs from ffprobe, and it equals the full-file average `avgFromPts` of the reference within 1e-9 relative, the `avgFps` check is reported as `known-deviation` with source `[built-in]`. An entry in the file for the same fixture and field replaces the built-in reason.

## Rules the script applies

These are the research 6.4 tolerances as implemented in `scripts/compare/rules.ts`. A real ffprobe video stream is one with `disposition.attached_pic == 0`; `v:0` is never used.

| Field | MP4 / MOV | Matroska / WebM |
| --- | --- | --- |
| `error` | outcome equals the manifest `expect`: `ok` needs a primary track and no error, `no-video` needs no video track and no error other than "no video", `still` needs only single-sample tracks, `error` needs an error and no track. ffprobe values are shown for information | same |
| `trackSelection` | same number of real video tracks as ffprobe, and the primary track is the one with the most samples among the enabled tracks with more than 1 sample (first on a tie). The tkhd enabled flag is read from ffprobe `disposition.default`, which the mov demuxer sets from it | first real video track |
| `codecName`, `width`, `height` | exact | exact |
| `avgFps` | exact reduced rational vs `avg_frame_rate` (`0/0` on both sides counts as equal; a still image with no app value is `n/a`) | `declared`: `avgFpsFfprobe` vs `avg_frame_rate`, exact; no declared value is `exact` when ffprobe prints `0/0`, `n/a` when the manifest notes say DefaultDuration is absent, else `mismatch`. `measured`: only after an exact scan (`scan == 'exact'` or provenance `exact`), `avgFps` vs `avgFromPts`, exact rational or within 1e-9 relative |
| `nominalFps` | an `exact` nominal rate must equal `r_frame_rate`; when the reference has one distinct PTS delta (CFR) the app must report an exact nominal rate; otherwise `n/a` | `rFpsFfprobe` vs `r_frame_rate`, exact; omitted although 5 < avg < 1000 is a `mismatch`; otherwise `n/a` (a numeric 1% check is informational only) |
| `frames` | `nb_frames` when it equals the packet count; `nb_read_packets` when `nb_frames` is N/A (fragmented) or smaller (hybrid, total count); `nb_frames` when it is larger (truncated mdat) | `nb_read_packets`, only after an exact scan; estimated counts are `n/a` |
| `presentedFrames` | `nb_read_frames` | `nb_read_frames`, only after an exact scan |
| `durationSec` | `duration_ts` x `time_base` within 1 ns; fragmented with sidx: within max(1 frame, abs(start_time)) is `within-tol` | `n/a` (ffprobe prints no video duration); the DURATION tag is shown |
| `startSec` | `start_pts` x `time_base` within 1 ns | same, only after an exact scan |
| `formatDurationSec` | `format.duration` to 6 decimals is `exact`, within 1e-6 s is `within-tol`; `n/a` when subtitle or data streams exist, or for a no-video file where the app reports none | same; ffprobe N/A with no app value is `exact`, with an app value `n/a` |
| `minFps`, `maxFps` | exact rationals vs the tail-excluded reference (`instFpsExcludingTail`); both absent is `exact` | same, on 1 ms ticks |
| `isVfr`, `duplicateTimestamps` | equal to the reference | equal |

## Example

```json
{
  "corrupt_trunc_mdat_faststart.mp4": {
    "presentedFrames": "The header lists 90 samples; ffprobe decodes only the 53 that survive the truncated mdat, which the app does not read."
  }
}
```
