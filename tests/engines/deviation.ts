import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import { refOptionalNumber, type FixtureRef, type RefVideoStream } from '../helpers/fixtures.ts';

export type Verdict = 'exact' | 'within-tol' | 'mismatch' | 'n/a';

export interface FieldDiff {
  track: number;
  field: string;
  actual: string | number | boolean | null;
  expected: string | number | boolean | null;
  verdict: Verdict;
}

interface ProbeStream {
  codec_type?: string;
  disposition?: { attached_pic?: number };
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  nb_read_frames?: string;
  duration?: string;
  start_time?: string;
}

interface InstFps {
  minFps?: { num: number; den: number; value: number } | null;
  maxFps?: { num: number; den: number; value: number } | null;
}

interface RefStream extends RefVideoStream {
  codecName?: string;
  instFpsExcludingTail?: InstFps;
  vfr?: { isVfr: boolean } | null;
  duplicateTimestamps?: number;
}

export const REL_TOLERANCE = 1e-3;
export const PRINTED_SECONDS_TOLERANCE = 5e-7;

function ratioOf(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /^(-?\d+)\/(\d+)$/.exec(text);
  if (!m || Number(m[2]) === 0) return null;
  return Number(m[1]) / Number(m[2]);
}

function judge(actual: number | null, expected: number | null, tolerance: number): Verdict {
  if (expected === null) return actual === null ? 'exact' : 'n/a';
  if (actual === null) return 'mismatch';
  if (actual === expected) return 'exact';
  const scale = Math.max(Math.abs(expected), 1e-12);
  return Math.abs(actual - expected) / scale <= tolerance ? 'within-tol' : 'mismatch';
}

function judgeSeconds(actual: number | null, expected: number | null): Verdict {
  if (expected === null) return actual === null ? 'exact' : 'n/a';
  if (actual === null) return 'mismatch';
  const diff = Math.abs(actual - expected);
  if (diff < 1e-12) return 'exact';
  return diff <= PRINTED_SECONDS_TOLERANCE ? 'within-tol' : 'mismatch';
}

function probeVideoStreams(ref: FixtureRef): ProbeStream[] {
  const probe = ref.probe as { streams?: ProbeStream[] } | undefined;
  return (probe?.streams ?? []).filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
}

export function compareToRef(result: FileResult, ref: FixtureRef): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (!ref.ok || result.error !== null) return diffs;
  const refStreams = ((ref.videoStreams ?? []) as RefStream[]).slice();
  const probeStreams = probeVideoStreams(ref);
  if (result.videoTracks.length !== refStreams.length) {
    diffs.push({
      track: -1,
      field: 'trackCount',
      actual: result.videoTracks.length,
      expected: refStreams.length,
      verdict: 'mismatch',
    });
    return diffs;
  }
  result.videoTracks.forEach((track, i) => compareTrack(diffs, i, track, refStreams[i], probeStreams[i]));
  return diffs;
}

function compareTrack(diffs: FieldDiff[], i: number, t: VideoTrackResult, r: RefStream, p: ProbeStream | undefined): void {
  const push = (field: string, actual: FieldDiff['actual'], expected: FieldDiff['expected'], verdict: Verdict): void => {
    diffs.push({ track: i, field, actual, expected, verdict });
  };
  const exact = (field: string, actual: FieldDiff['actual'], expected: FieldDiff['expected']): void => {
    push(field, actual, expected, String(actual) === String(expected) ? 'exact' : 'mismatch');
  };
  const numeric = (field: string, actual: number | null, expected: number | null, tolerance: number): void => {
    push(field, actual, expected, judge(actual, expected, tolerance));
  };

  const avgRef = p?.avg_frame_rate ?? null;
  if (avgRef !== null) {
    const verdict: Verdict =
      t.avgFpsFfprobe === avgRef
        ? 'exact'
        : (avgRef === '0/0' && t.avgFps === null) || judge(t.avgFps ? t.avgFps.value : null, ratioOf(avgRef), REL_TOLERANCE) === 'within-tol'
          ? 'within-tol'
          : 'mismatch';
    push('avgFps', t.avgFpsFfprobe, avgRef, verdict);
  }
  const framesRef = refOptionalNumber(p?.nb_frames) ?? refOptionalNumber(p?.nb_read_packets);
  exact('frames', t.frames, framesRef);
  exact('presentedFrames', t.presentedFrames, refOptionalNumber(p?.nb_read_frames));

  const inst = r.instFpsExcludingTail;
  const minRef = inst?.minFps ?? null;
  const maxRef = inst?.maxFps ?? null;
  numeric('minFps', t.minFps ? t.minFps.value : null, minRef ? minRef.value : null, REL_TOLERANCE);
  numeric('maxFps', t.maxFps ? t.maxFps.value : null, maxRef ? maxRef.value : null, REL_TOLERANCE);
  exact('isVfr', t.isVfr, r.vfr ? r.vfr.isVfr : null);
  exact('duplicates', t.duplicateTimestamps, r.duplicateTimestamps ?? 0);
  exact('width', t.width, r.width);
  exact('height', t.height, r.height);
  exact('codec', t.codecName, r.codecName ?? null);
  push('durationSec', t.durationSec, refOptionalNumber(p?.duration), judgeSeconds(t.durationSec, refOptionalNumber(p?.duration)));
  push('startSec', t.startSec, refOptionalNumber(p?.start_time), judgeSeconds(t.startSec, refOptionalNumber(p?.start_time)));
}

export interface FieldTally {
  exact: number;
  withinTol: number;
  mismatch: number;
  na: number;
}

export function tally(rows: ReadonlyArray<{ diffs: readonly FieldDiff[] }>): Map<string, FieldTally> {
  const out = new Map<string, FieldTally>();
  for (const row of rows) {
    for (const d of row.diffs) {
      const t = out.get(d.field) ?? { exact: 0, withinTol: 0, mismatch: 0, na: 0 };
      if (d.verdict === 'exact') t.exact++;
      else if (d.verdict === 'within-tol') t.withinTol++;
      else if (d.verdict === 'mismatch') t.mismatch++;
      else t.na++;
      out.set(d.field, t);
    }
  }
  return out;
}

export function formatTally(title: string, tallies: Map<string, FieldTally>): string {
  const lines = [`${title}: exact / within-tol / mismatch per field`];
  for (const [field, t] of [...tallies].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${field.padEnd(16)} ${String(t.exact).padStart(4)} ${String(t.withinTol).padStart(4)} ${String(t.mismatch).padStart(4)}`);
  }
  return lines.join('\n');
}
