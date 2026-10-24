import type { FileResult, Rational, VideoTrackResult } from '../../src/core/types.ts';
import { parseRatio, ticksToSec, type Ratio, type RefFile, type RefStream } from './ref.ts';
import {
  checkId,
  type CheckResult,
  type CheckScope,
  type ContainerFamily,
  type FieldName,
  type FileLayout,
  type MatroskaLayoutTrack,
  type FixtureDeviations,
  type FixtureInfo,
  type Verdict,
} from './types.ts';

export const EXACT_SECONDS_EPSILON = 1e-9;
export const FORMAT_DURATION_TOLERANCE_SECONDS = 1e-6;
export const MEASURED_AVG_RELATIVE_TOLERANCE = 1e-9;
export const NOMINAL_INFORMATIONAL_TOLERANCE = 0.01;

export const SIDX_UNDER_READ_REASON =
  'ffprobe computes avg_frame_rate from the fragments it reads while opening the file (global sidx: the first fragment, per-fragment sidx: all but the last); the app reports the full-file average N x ts / sum(durations) (research 2.1 header extent)';

const RULE = {
  error: 'Outcome equals the manifest expectation',
  trackSelection: 'Same real video tracks and primary track as ffprobe (attached_pic excluded; MP4/MOV: enabled tracks only)',
  codecName: 'Exact vs codec_name',
  width: 'Exact vs width',
  height: 'Exact vs height',
  avgIso: 'avgFpsFfprobe (the duration-sum rational) must equal avg_frame_rate exactly',
  avgIsoMeasured: 'Presented average (presented frames / presentation span) must equal avgFromPts within 1e-9 relative; within-tol when the frames match and the spans differ by less than one median frame delta (ffprobe filled the last packet duration)',
  avgDeclared: 'Declared rate string must equal avg_frame_rate exactly when DefaultDuration exists',
  avgMeasured: 'Measured average must equal avgFromPts (integer-ms last duration) within 1e-9 relative',
  nominalIso: 'Exact vs r_frame_rate, only when the track is CFR (stage 1); otherwise skipped',
  nominalMatroska: 'Declared rate string must equal r_frame_rate exactly when DefaultDuration exists; otherwise skipped',
  framesIso: 'Exact vs nb_frames (non-fragmented); fragmented: vs nb_read_packets; hybrid: total vs nb_read_packets',
  framesMatroska: 'Exact vs nb_read_packets (ffprobe prints nb_frames N/A)',
  presentedIso: 'Exact vs nb_read_frames',
  presentedMatroska: 'Exact vs nb_read_frames (equals the block count)',
  durationIso: 'Exact vs duration_ts x time_base; fragmented with sidx: within max(1 frame, abs(start_time))',
  durationMatroska: 'ffprobe prints no duration for Matroska video streams; the DURATION tag is shown for information only',
  startIso: 'Exact vs start_pts x time_base',
  startMatroska: 'Exact vs start_pts x time_base once every block timestamp has been read (exact scan); otherwise skipped',
  formatDuration: 'format.duration within 1e-6 s; skipped when subtitle or data tracks exist',
  formatDurationMatroska: 'Exact vs format.duration when Info Duration exists; ffprobe N/A is not compared',
  minFps: 'Exact rational vs the tail-excluded reference minimum',
  maxFps: 'Exact rational vs the tail-excluded reference maximum',
  isVfr: 'Equal to the reference VFR flag (shared rule, tolerance max(1 tick, 0.5% of the median delta))',
  duplicates: 'Equal to the reference count of deltas that are 0 or less',
} as const;

export interface Draft {
  field: FieldName;
  sub: string | null;
  scope: CheckScope;
  trackId: number | null;
  verdict: Verdict;
  app: string | null;
  ffprobe: string | null;
  rule: string;
  detail?: string | null;
  builtinDeviation?: string | null;
}

export interface TrackPair {
  app: VideoTrackResult | null;
  ref: RefStream | null;
}

export interface TrackEvaluation {
  trackId: number | null;
  refIndex: number | null;
  primary: boolean;
  checks: CheckResult[];
}

export interface EvaluateInput {
  info: FixtureInfo;
  ref: RefFile | null;
  result: FileResult;
  layout?: FileLayout | null;
  deviations?: FixtureDeviations | null;
  threw?: string | null;
}

export interface Evaluation {
  family: ContainerFamily | null;
  fileChecks: CheckResult[];
  tracks: TrackEvaluation[];
  unusedDeviationKeys: string[];
  notes: string[];
}

export function sameRatio(a: Ratio, b: Ratio): boolean {
  if (a.den === 0 || b.den === 0) return a.num === b.num && a.den === b.den;
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

function isZeroRatio(r: Ratio): boolean {
  return r.num === 0 && r.den === 0;
}

function ratioValue(r: Ratio): number {
  return r.den === 0 ? 0 : r.num / r.den;
}

function fmtRatio(r: Ratio | null | undefined): string | null {
  return r ? `${r.num}/${r.den}` : null;
}

function fmtSec(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : n.toFixed(6);
}

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

function toRatio(r: Rational | null): Ratio | null {
  return r ? { num: r.num, den: r.den } : null;
}

export function detectFamily(info: FixtureInfo, ref: RefFile | null, result: FileResult): ContainerFamily | null {
  const declared = info.container.toLowerCase();
  if (declared === 'mp4' || declared === 'mov') return 'isobmff';
  if (declared === 'webm' || declared === 'matroska') return 'matroska';
  const fmt = ref?.formatName ?? '';
  if (/matroska|webm/.test(fmt)) return 'matroska';
  if (/(^|,)(mov|mp4)(,|$)/.test(fmt)) return 'isobmff';
  if (result.container === 'mp4' || result.container === 'mov') return 'isobmff';
  if (result.container === 'webm' || result.container === 'matroska') return 'matroska';
  return null;
}

function refSamples(s: RefStream): number {
  return s.nbFrames ?? s.nbReadPackets ?? s.packets?.packets ?? 0;
}

function sameShape(a: VideoTrackResult, r: RefStream): boolean {
  return a.codecName === r.codecName && a.width === r.width && a.height === r.height;
}

export function pairTracks(app: readonly VideoTrackResult[], refs: readonly RefStream[]): TrackPair[] {
  if (app.length === refs.length && app.every((a, i) => sameShape(a, refs[i]))) {
    return app.map((a, i) => ({ app: a, ref: refs[i] }));
  }
  const usedRefs = new Set<number>();
  const matched: Array<RefStream | null> = app.map(() => null);
  app.forEach((a, i) => {
    const j = refs.findIndex((r, k) => !usedRefs.has(k) && sameShape(a, r));
    if (j >= 0) {
      usedRefs.add(j);
      matched[i] = refs[j];
    }
  });
  app.forEach((_, i) => {
    if (matched[i]) return;
    const j = refs.findIndex((_r, k) => !usedRefs.has(k));
    if (j >= 0) {
      usedRefs.add(j);
      matched[i] = refs[j];
    }
  });
  const pairs: TrackPair[] = app.map((a, i) => ({ app: a, ref: matched[i] }));
  refs.forEach((r, k) => {
    if (!usedRefs.has(k)) pairs.push({ app: null, ref: r });
  });
  return pairs;
}

export function expectedPrimary(family: ContainerFamily, refs: readonly RefStream[]): RefStream | null {
  if (refs.length === 0) return null;
  if (family === 'matroska') return refs[0];
  const enabled = refs.filter((r) => r.enabled);
  let best: RefStream | null = null;
  let bestSamples = 1;
  for (const r of enabled.length > 0 ? enabled : refs) {
    const n = refSamples(r);
    if (n > bestSamples) {
      best = r;
      bestSamples = n;
    }
  }
  return best;
}

function describeRef(s: RefStream, total: number): string {
  return `stream ${s.index} of ${total}: ${s.codecName} ${s.width}x${s.height}`;
}

function describeApp(t: VideoTrackResult, total: number): string {
  return `track ${t.trackId} of ${total}: ${t.codecName} ${t.width}x${t.height}`;
}

function outcomeMatches(expect: string, result: FileResult): boolean | null {
  const tracks = result.videoTracks.length;
  switch (expect) {
    case 'ok':
      return result.error === null && tracks > 0 && result.primaryTrackId !== null;
    case 'no-video':
      return tracks === 0 && (result.error === null || /no video/i.test(result.error));
    case 'still':
      return result.error === null && tracks > 0 && result.videoTracks.every((t) => t.isStill);
    case 'error':
      return result.error !== null && tracks === 0;
    default:
      return null;
  }
}

function errorDraft(info: FixtureInfo, ref: RefFile | null, result: FileResult, threw: string | null): Draft {
  const tracks = result.videoTracks.length;
  const appValue = result.error !== null ? `error: ${result.error}` : `ok, ${tracks} video track${tracks === 1 ? '' : 's'}`;
  let ffValue: string | null = null;
  if (ref) {
    ffValue = ref.ok ? `opens as ${ref.formatName ?? 'unknown'}, ${ref.videoStreams.length} video stream(s)` : `fails: ${ref.stderr[0] ?? 'unknown error'}`;
  }
  const ok = threw ? false : outcomeMatches(info.expect, result);
  return {
    field: 'error',
    sub: null,
    scope: 'file',
    trackId: null,
    verdict: ok === null ? 'n/a' : ok ? 'exact' : 'mismatch',
    app: threw ? `engine threw: ${threw}` : appValue,
    ffprobe: ffValue,
    rule: `${RULE.error} (manifest expect=${info.expect || 'unset'})`,
    detail: null,
  };
}

function trackSelectionDraft(
  family: ContainerFamily,
  result: FileResult,
  refs: readonly RefStream[],
  pairs: readonly TrackPair[],
): Draft {
  const appTotal = result.videoTracks.length;
  const primaryApp = result.primaryTrackId === null ? null : (result.videoTracks.find((t) => t.trackId === result.primaryTrackId) ?? null);
  const expected = expectedPrimary(family, refs);
  const problems: string[] = [];
  if (appTotal !== refs.length) problems.push(`app lists ${appTotal} video tracks, ffprobe ${refs.length}`);
  if (expected) {
    if (!primaryApp) problems.push('app has no primary track');
    else {
      const pair = pairs.find((p) => p.app === primaryApp);
      if (pair?.ref !== expected) problems.push('app primary track is not the expected stream');
    }
  } else if (refs.length === 0 && primaryApp) {
    problems.push('app picked a primary track but ffprobe has no real video stream');
  }
  return {
    field: 'trackSelection',
    sub: null,
    scope: 'file',
    trackId: null,
    verdict: problems.length === 0 ? 'exact' : 'mismatch',
    app: primaryApp ? describeApp(primaryApp, appTotal) : `no primary track, ${appTotal} track(s)`,
    ffprobe: expected ? describeRef(expected, refs.length) : `no primary stream, ${refs.length} stream(s)`,
    rule: RULE.trackSelection,
    detail: problems.length > 0 ? problems.join('; ') : null,
  };
}

function formatDurationDraft(family: ContainerFamily, info: FixtureInfo, ref: RefFile, result: FileResult): Draft | null {
  const app = result.formatDurationSec;
  const ff = ref.formatDurationSec;
  const rule = family === 'matroska' ? RULE.formatDurationMatroska : RULE.formatDuration;
  const base = { field: 'formatDurationSec' as const, sub: null, scope: 'file' as const, trackId: null, rule };
  const appStr = fmtSec(app);
  const ffStr = ref.formatDurationRaw;
  if (ref.otherStreamTypes.length > 0) {
    return { ...base, verdict: 'n/a', app: appStr, ffprobe: ffStr, detail: `skipped: ${ref.otherStreamTypes.join(', ')} stream(s) present` };
  }
  if (ff === null) {
    if (app === null) return { ...base, verdict: 'exact', app: null, ffprobe: null, detail: 'both report no duration' };
    return { ...base, verdict: 'n/a', app: appStr, ffprobe: null, detail: 'ffprobe prints N/A; the app value is computed from the file' };
  }
  if (app === null) {
    if (info.expect === 'no-video') return { ...base, verdict: 'n/a', app: null, ffprobe: ffStr, detail: 'no video track: the format duration is not part of the result' };
    return { ...base, verdict: 'mismatch', app: null, ffprobe: ffStr, detail: 'the app reported no format duration' };
  }
  if (app.toFixed(6) === ff.toFixed(6)) return { ...base, verdict: 'exact', app: appStr, ffprobe: ffStr };
  if (Math.abs(app - ff) <= FORMAT_DURATION_TOLERANCE_SECONDS) return { ...base, verdict: 'within-tol', app: appStr, ffprobe: ffStr };
  return { ...base, verdict: 'mismatch', app: appStr, ffprobe: ffStr };
}

function trackBase(field: FieldName, sub: string | null, t: VideoTrackResult, rule: string) {
  return { field, sub, scope: 'track' as const, trackId: t.trackId, rule };
}

function compareExact<T extends string | number | boolean | null>(
  field: FieldName,
  t: VideoTrackResult,
  rule: string,
  app: T,
  ff: T,
  format: (v: T) => string | null = (v) => (v === null ? null : String(v)),
): Draft {
  return { ...trackBase(field, null, t, rule), verdict: app === ff ? 'exact' : 'mismatch', app: format(app), ffprobe: format(ff) };
}

function compareRatios(field: FieldName, t: VideoTrackResult, rule: string, app: Ratio | null, ff: Ratio | null): Draft {
  const base = trackBase(field, null, t, rule);
  const a = fmtRatio(app);
  const f = fmtRatio(ff);
  if (!app && !ff) return { ...base, verdict: 'exact', app: null, ffprobe: null, detail: 'both report none' };
  if (!app || !ff) return { ...base, verdict: 'mismatch', app: a, ffprobe: f };
  return { ...base, verdict: sameRatio(app, ff) ? 'exact' : 'mismatch', app: a, ffprobe: f };
}

function sidxFragmented(layout: FileLayout | null | undefined, s: RefStream, info: FixtureInfo): boolean {
  if (layout) return layout.fragmented && layout.hasSidx;
  return s.nbFrames === null && /sidx|dash/i.test(info.notes);
}

function avgIsoDraft(t: VideoTrackResult, s: RefStream, info: FixtureInfo, layout: FileLayout | null | undefined): Draft {
  const base = trackBase('avgFps', null, t, RULE.avgIso);
  const ff = parseRatio(s.avgFrameRate);
  const app = parseRatio(t.avgFpsFfprobe) ?? toRatio(t.avgFps);
  if (!ff) return { ...base, verdict: 'n/a', app: fmtRatio(app), ffprobe: s.avgFrameRate, detail: 'unparseable ffprobe value' };
  if (!app) {
    if (isZeroRatio(ff)) return { ...base, verdict: 'exact', app: null, ffprobe: s.avgFrameRate, detail: 'both report no average' };
    if (t.isStill) return { ...base, verdict: 'n/a', app: null, ffprobe: s.avgFrameRate, detail: 'still image: the app reports no FPS' };
    return { ...base, verdict: 'mismatch', app: null, ffprobe: s.avgFrameRate, detail: 'the app reported no average' };
  }
  if (sameRatio(app, ff)) return { ...base, verdict: 'exact', app: fmtRatio(app), ffprobe: s.avgFrameRate };
  const full = s.packets?.avgFromPts ?? null;
  if (full && sidxFragmented(layout, s, info) && relDiff(ratioValue(app), full.value) <= MEASURED_AVG_RELATIVE_TOLERANCE) {
    return {
      ...base,
      verdict: 'mismatch',
      app: fmtRatio(app),
      ffprobe: s.avgFrameRate,
      detail: `matches the full-file average ${fmtRatio(full)} computed from every packet`,
      builtinDeviation: SIDX_UNDER_READ_REASON,
    };
  }
  return { ...base, verdict: 'mismatch', app: fmtRatio(app), ffprobe: s.avgFrameRate };
}

function avgIsoMeasuredDraft(t: VideoTrackResult, s: RefStream): Draft {
  const base = trackBase('avgFps', 'measured', t, RULE.avgIsoMeasured);
  const full = s.packets?.avgFromPts ?? null;
  const ffStr = fmtRatio(full);
  const app = toRatio(t.avgFps);
  if (t.provenance.avgFps !== 'exact') return { ...base, verdict: 'n/a', app: fmtRatio(app), ffprobe: ffStr, detail: 'no presented timeline: the average is the stored-duration value' };
  if (!full) return { ...base, verdict: 'n/a', app: fmtRatio(app), ffprobe: null, detail: 'no reference average' };
  if (!app) return { ...base, verdict: 'mismatch', app: null, ffprobe: ffStr, detail: 'presented timeline built but no average reported' };
  if (sameRatio(app, full)) return { ...base, verdict: 'exact', app: fmtRatio(app), ffprobe: ffStr };
  if (relDiff(ratioValue(app), full.value) <= MEASURED_AVG_RELATIVE_TOLERANCE) return { ...base, verdict: 'within-tol', app: fmtRatio(app), ffprobe: ffStr };
  const p = s.packets;
  const frames = t.presentedFrames;
  const refSpan = p?.avgFromPtsSpanTicks ?? null;
  const median = p?.medianDeltaTicks ?? null;
  if (frames !== null && frames === p?.avgFromPtsFrames && refSpan !== null && median !== null && t.timescale > 0) {
    const appSpan = (frames * t.timescale) / ratioValue(app);
    const diff = Math.abs(appSpan - refSpan);
    if (diff < median) {
      return { ...base, verdict: 'within-tol', app: fmtRatio(app), ffprobe: ffStr, detail: `spans differ by ${Math.round(diff)} ticks: ffprobe's last packet duration is ${p?.lastDurationTicks ?? '?'} ticks, the stored one gives the app's span` };
    }
  }
  return { ...base, verdict: 'mismatch', app: fmtRatio(app), ffprobe: ffStr };
}

export function matroskaTrackOf(layout: FileLayout | null | undefined, streams: readonly RefStream[], s: RefStream): MatroskaLayoutTrack | null {
  const video = layout?.matroskaTracks?.filter((t) => t.type === 1) ?? [];
  const i = streams.indexOf(s);
  return i >= 0 && video.length === streams.length ? (video[i] ?? null) : null;
}

export function noteContradictsLayout(info: FixtureInfo, layout: FileLayout | null | undefined): string | null {
  const video = layout?.matroskaTracks?.filter((t) => t.type === 1) ?? [];
  if (!declaresNoDefaultDuration(info) || video.length === 0 || video.some((t) => t.defaultDurationNs === null)) return null;
  return `the manifest note of ${info.name} says the file has no DefaultDuration, but every video track of the file has one`;
}

function avgMatroskaDeclaredDraft(t: VideoTrackResult, s: RefStream, info: FixtureInfo, mkv: MatroskaLayoutTrack | null): Draft {
  const base = trackBase('avgFps', 'declared', t, RULE.avgDeclared);
  const ff = parseRatio(s.avgFrameRate);
  const app = parseRatio(t.avgFpsFfprobe);
  if (!ff) return { ...base, verdict: 'n/a', app: t.avgFpsFfprobe, ffprobe: s.avgFrameRate, detail: 'unparseable ffprobe value' };
  if (!app) {
    if (isZeroRatio(ff)) return { ...base, verdict: 'exact', app: null, ffprobe: s.avgFrameRate, detail: 'no DefaultDuration: both report no declared rate' };
    if (mkv ? mkv.defaultDurationNs === null : declaresNoDefaultDuration(info)) {
      return { ...base, verdict: 'n/a', app: null, ffprobe: s.avgFrameRate, detail: 'no DefaultDuration in this file; ffprobe estimates the rate from packets (cannot be reproduced)' };
    }
    return { ...base, verdict: 'mismatch', app: null, ffprobe: s.avgFrameRate, detail: 'the app reported no declared rate' };
  }
  return { ...base, verdict: sameRatio(app, ff) ? 'exact' : 'mismatch', app: fmtRatio(app), ffprobe: s.avgFrameRate };
}

function exactScan(t: VideoTrackResult, result: FileResult, field: 'avgFps' | 'frames' | 'presentedFrames' | 'startSec'): boolean {
  if (result.scan === 'exact') return true;
  const p = t.provenance[field];
  return p === 'exact' || p === 'computed';
}

function avgMatroskaMeasuredDraft(t: VideoTrackResult, s: RefStream, result: FileResult): Draft {
  const base = trackBase('avgFps', 'measured', t, RULE.avgMeasured);
  const full = s.packets?.avgFromPts ?? null;
  const ffStr = fmtRatio(full);
  if (!exactScan(t, result, 'avgFps')) {
    return { ...base, verdict: 'n/a', app: fmtRatio(toRatio(t.avgFps)), ffprobe: ffStr, detail: `no exact scan (scan=${result.scan ?? 'none'}): a measured average is not produced` };
  }
  if (!full) return { ...base, verdict: 'n/a', app: fmtRatio(toRatio(t.avgFps)), ffprobe: null, detail: 'no reference average' };
  if (!t.avgFps) return { ...base, verdict: 'mismatch', app: null, ffprobe: ffStr, detail: 'exact scan done but no average reported' };
  const same = sameRatio(t.avgFps, full);
  if (same) return { ...base, verdict: 'exact', app: fmtRatio(t.avgFps), ffprobe: ffStr };
  const within = relDiff(t.avgFps.value, full.value) <= MEASURED_AVG_RELATIVE_TOLERANCE;
  return { ...base, verdict: within ? 'within-tol' : 'mismatch', app: fmtRatio(t.avgFps), ffprobe: ffStr };
}

export function declaresNoDefaultDuration(info: FixtureInfo): boolean {
  return /\bDefaultDuration\b[^.]*\b(overwritten|voided|void|not written|missing|absent)\b|\b(no|without|missing)\s+DefaultDuration\b/i.test(info.notes);
}

function nominalIsoDraft(t: VideoTrackResult, s: RefStream): Draft {
  const base = trackBase('nominalFps', null, t, RULE.nominalIso);
  const ff = parseRatio(s.rFrameRate);
  const n = t.nominalFps;
  const appStr = n ? `${n.num}/${n.den} (${n.kind})` : null;
  const refCfr = s.packets?.instFpsExcludingTail?.distinctDeltas === 1;
  if (n && n.kind === 'exact') {
    if (!ff) return { ...base, verdict: 'n/a', app: appStr, ffprobe: s.rFrameRate, detail: 'unparseable ffprobe value' };
    return { ...base, verdict: sameRatio(n, ff) ? 'exact' : 'mismatch', app: appStr, ffprobe: s.rFrameRate };
  }
  if (refCfr) {
    return { ...base, verdict: 'mismatch', app: appStr, ffprobe: s.rFrameRate, detail: 'the reference has a single PTS delta (CFR), so the app must report an exact nominal rate' };
  }
  return { ...base, verdict: 'n/a', app: appStr, ffprobe: s.rFrameRate, detail: 'not CFR: ffprobe derives r_frame_rate from heuristics (stages 2-4)' };
}

function nominalMatroskaDraft(t: VideoTrackResult, s: RefStream): Draft {
  const base = trackBase('nominalFps', null, t, RULE.nominalMatroska);
  const ff = parseRatio(s.rFrameRate);
  const app = parseRatio(t.rFpsFfprobe);
  const declaredAvg = parseRatio(t.avgFpsFfprobe);
  if (!ff) return { ...base, verdict: 'n/a', app: t.rFpsFfprobe, ffprobe: s.rFrameRate, detail: 'unparseable ffprobe value' };
  if (app) return { ...base, verdict: sameRatio(app, ff) ? 'exact' : 'mismatch', app: fmtRatio(app), ffprobe: s.rFrameRate };
  if (declaredAvg && ratioValue(declaredAvg) > 5 && ratioValue(declaredAvg) < 1000) {
    return { ...base, verdict: 'mismatch', app: null, ffprobe: s.rFrameRate, detail: 'the app omitted r_frame_rate although 5 < avg < 1000 makes it equal to avg_frame_rate' };
  }
  const nominal = t.nominalFps;
  let detail = 'no declared rate: ffprobe derives r_frame_rate from packets';
  if (nominal && ratioValue(ff) > 0) {
    const close = relDiff(nominal.value, ratioValue(ff)) <= NOMINAL_INFORMATIONAL_TOLERANCE;
    detail += `; app nominal ${nominal.num}/${nominal.den} is ${close ? 'within' : 'not within'} 1% (informational)`;
  }
  return { ...base, verdict: 'n/a', app: nominal ? `${nominal.num}/${nominal.den} (${nominal.kind})` : null, ffprobe: s.rFrameRate, detail };
}

function framesIsoDraft(t: VideoTrackResult, s: RefStream): Draft {
  const nbFrames = s.nbFrames;
  const packets = s.nbReadPackets ?? s.packets?.packets ?? null;
  let expected: number | null;
  let detail: string | null = null;
  if (nbFrames === null) {
    expected = packets;
    detail = 'fragmented: nb_frames is N/A, compared with nb_read_packets';
  } else if (packets !== null && nbFrames < packets) {
    expected = packets;
    detail = `hybrid fragmented: moov count ${nbFrames}, total ${packets}`;
  } else {
    expected = nbFrames;
  }
  const base = trackBase('frames', null, t, RULE.framesIso);
  if (expected === null) return { ...base, verdict: 'n/a', app: t.frames === null ? null : String(t.frames), ffprobe: null, detail: 'no reference frame count' };
  if (t.frames === null) return { ...base, verdict: 'mismatch', app: null, ffprobe: String(expected), detail: 'the app reported no frame count' };
  return { ...base, verdict: t.frames === expected ? 'exact' : 'mismatch', app: String(t.frames), ffprobe: String(expected), detail };
}

function framesMatroskaDraft(t: VideoTrackResult, s: RefStream, result: FileResult): Draft {
  const base = trackBase('frames', null, t, RULE.framesMatroska);
  const expected = s.nbReadPackets ?? s.packets?.packets ?? null;
  const appStr = t.frames === null ? null : String(t.frames);
  if (expected === null) return { ...base, verdict: 'n/a', app: appStr, ffprobe: null, detail: 'no reference frame count' };
  if (!exactScan(t, result, 'frames')) {
    return { ...base, verdict: 'n/a', app: appStr, ffprobe: String(expected), detail: `no exact scan (scan=${result.scan ?? 'none'}, provenance=${t.provenance.frames ?? 'none'}): the count is not a block count` };
  }
  if (t.frames === null) return { ...base, verdict: 'mismatch', app: null, ffprobe: String(expected), detail: 'exact scan done but no frame count reported' };
  return { ...base, verdict: t.frames === expected ? 'exact' : 'mismatch', app: appStr, ffprobe: String(expected) };
}

function presentedDraft(family: ContainerFamily, t: VideoTrackResult, s: RefStream, result: FileResult): Draft {
  const rule = family === 'isobmff' ? RULE.presentedIso : RULE.presentedMatroska;
  const base = trackBase('presentedFrames', null, t, rule);
  const expected = s.nbReadFrames;
  const appStr = t.presentedFrames === null ? null : String(t.presentedFrames);
  if (expected === null) return { ...base, verdict: 'n/a', app: appStr, ffprobe: null, detail: 'ffprobe did not count frames (nb_read_frames N/A)' };
  if (family === 'matroska' && !exactScan(t, result, 'presentedFrames')) {
    return { ...base, verdict: 'n/a', app: appStr, ffprobe: String(expected), detail: `no exact scan (scan=${result.scan ?? 'none'})` };
  }
  if (t.presentedFrames === null) return { ...base, verdict: 'mismatch', app: null, ffprobe: String(expected), detail: 'the app reported no presented frame count' };
  return { ...base, verdict: t.presentedFrames === expected ? 'exact' : 'mismatch', app: appStr, ffprobe: String(expected) };
}

function frameSeconds(s: RefStream): number {
  const avg = parseRatio(s.avgFrameRate);
  const r = parseRatio(s.rFrameRate);
  const fps = avg && ratioValue(avg) > 0 ? ratioValue(avg) : r ? ratioValue(r) : 0;
  return fps > 0 ? 1 / fps : 0;
}

function durationDraft(
  family: ContainerFamily,
  t: VideoTrackResult,
  s: RefStream,
  info: FixtureInfo,
  layout: FileLayout | null | undefined,
): Draft {
  if (family === 'matroska') {
    return {
      ...trackBase('durationSec', null, t, RULE.durationMatroska),
      verdict: 'n/a',
      app: fmtSec(t.durationSec),
      ffprobe: fmtSec(s.durationTagSec),
      detail: 'Matroska video streams carry no duration in ffprobe',
    };
  }
  const base = trackBase('durationSec', null, t, RULE.durationIso);
  if (s.durationTs === null) return { ...base, verdict: 'n/a', app: fmtSec(t.durationSec), ffprobe: null, detail: 'duration_ts is N/A' };
  const expected = ticksToSec(s.durationTs, s.timeBase);
  if (t.durationSec === null) return { ...base, verdict: 'mismatch', app: null, ffprobe: fmtSec(expected), detail: 'the app reported no duration' };
  const diff = Math.abs(t.durationSec - expected);
  const appStr = fmtSec(t.durationSec);
  const ffStr = fmtSec(expected);
  if (diff <= EXACT_SECONDS_EPSILON) return { ...base, verdict: 'exact', app: appStr, ffprobe: ffStr };
  if (sidxFragmented(layout, s, info)) {
    const start = s.startPts === null ? 0 : Math.abs(ticksToSec(s.startPts, s.timeBase));
    const tol = Math.max(frameSeconds(s), start);
    if (diff <= tol) return { ...base, verdict: 'within-tol', app: appStr, ffprobe: ffStr, detail: `difference ${diff.toFixed(6)} s within ${tol.toFixed(6)} s (fragmented with sidx)` };
  }
  return { ...base, verdict: 'mismatch', app: appStr, ffprobe: ffStr, detail: `difference ${diff.toFixed(6)} s` };
}

function startDraft(family: ContainerFamily, t: VideoTrackResult, s: RefStream, result: FileResult): Draft {
  const base = trackBase('startSec', null, t, family === 'isobmff' ? RULE.startIso : RULE.startMatroska);
  const appStr = fmtSec(t.startSec);
  if (s.startPts === null) return { ...base, verdict: 'n/a', app: appStr, ffprobe: null, detail: 'start_pts is N/A' };
  const expected = ticksToSec(s.startPts, s.timeBase);
  const ffStr = fmtSec(expected);
  if (family === 'matroska' && !exactScan(t, result, 'startSec')) {
    return { ...base, verdict: 'n/a', app: appStr, ffprobe: ffStr, detail: `no exact scan (scan=${result.scan ?? 'none'})` };
  }
  if (t.startSec === null) return { ...base, verdict: 'mismatch', app: null, ffprobe: ffStr, detail: 'the app reported no start time' };
  return { ...base, verdict: Math.abs(t.startSec - expected) <= EXACT_SECONDS_EPSILON ? 'exact' : 'mismatch', app: appStr, ffprobe: ffStr };
}

function noPacketsDraft(field: FieldName, t: VideoTrackResult, rule: string, app: string | null): Draft {
  return { ...trackBase(field, null, t, rule), verdict: 'n/a', app, ffprobe: null, detail: 'no packet reference' };
}

function trackDrafts(
  family: ContainerFamily,
  info: FixtureInfo,
  result: FileResult,
  layout: FileLayout | null | undefined,
  t: VideoTrackResult,
  s: RefStream,
  mkv: MatroskaLayoutTrack | null,
): Draft[] {
  const out: Draft[] = [];
  out.push(compareExact('codecName', t, RULE.codecName, t.codecName, s.codecName));
  out.push(compareExact('width', t, RULE.width, t.width, s.width));
  out.push(compareExact('height', t, RULE.height, t.height, s.height));
  if (family === 'isobmff') {
    out.push(avgIsoDraft(t, s, info, layout));
    out.push(avgIsoMeasuredDraft(t, s));
  } else {
    out.push(avgMatroskaDeclaredDraft(t, s, info, mkv));
    out.push(avgMatroskaMeasuredDraft(t, s, result));
  }
  out.push(family === 'isobmff' ? nominalIsoDraft(t, s) : nominalMatroskaDraft(t, s));
  out.push(family === 'isobmff' ? framesIsoDraft(t, s) : framesMatroskaDraft(t, s, result));
  out.push(presentedDraft(family, t, s, result));
  out.push(durationDraft(family, t, s, info, layout));
  out.push(startDraft(family, t, s, result));
  const p = s.packets;
  if (!p) {
    out.push(noPacketsDraft('minFps', t, RULE.minFps, fmtRatio(t.minFps)));
    out.push(noPacketsDraft('maxFps', t, RULE.maxFps, fmtRatio(t.maxFps)));
    out.push(noPacketsDraft('isVfr', t, RULE.isVfr, t.isVfr === null ? null : String(t.isVfr)));
    out.push(noPacketsDraft('duplicateTimestamps', t, RULE.duplicates, String(t.duplicateTimestamps)));
    return out;
  }
  const inst = p.instFpsExcludingTail;
  out.push(compareRatios('minFps', t, RULE.minFps, toRatio(t.minFps), inst?.minFps ?? null));
  out.push(compareRatios('maxFps', t, RULE.maxFps, toRatio(t.maxFps), inst?.maxFps ?? null));
  out.push(compareExact<boolean | null>('isVfr', t, RULE.isVfr, t.isVfr, p.isVfr));
  out.push(compareExact('duplicateTimestamps', t, RULE.duplicates, t.duplicateTimestamps, p.duplicateTimestamps));
  return out;
}

export function evaluate(input: EvaluateInput): Evaluation {
  const { info, ref, result, layout = null, threw = null } = input;
  const deviations = input.deviations ?? null;
  const consumed = new Set<string>();
  const notes: string[] = [];

  const finalize = (d: Draft): CheckResult => {
    const id = checkId(d.field, d.sub);
    let verdict = d.verdict;
    let deviation: string | null = null;
    let source: CheckResult['deviationSource'] = null;
    if (verdict === 'mismatch') {
      const key = deviations && id in deviations ? id : deviations && d.field in deviations ? d.field : null;
      if (deviations && key) {
        verdict = 'known-deviation';
        deviation = deviations[key];
        source = 'file';
        consumed.add(key);
      } else if (d.builtinDeviation) {
        verdict = 'known-deviation';
        deviation = d.builtinDeviation;
        source = 'built-in';
      }
    }
    return {
      field: d.field,
      sub: d.sub,
      id,
      scope: d.scope,
      trackId: d.trackId,
      verdict,
      app: d.app,
      ffprobe: d.ffprobe,
      rule: d.rule,
      detail: d.detail ?? null,
      deviation,
      deviationSource: source,
    };
  };

  const family = detectFamily(info, ref, result);
  const fileChecks: CheckResult[] = [finalize(errorDraft(info, ref, result, threw))];
  const tracks: TrackEvaluation[] = [];

  const finish = (): Evaluation => ({
    family,
    fileChecks,
    tracks,
    unusedDeviationKeys: deviations ? Object.keys(deviations).filter((k) => !consumed.has(k)) : [],
    notes,
  });

  if (!ref) {
    notes.push('no ffprobe reference: value checks skipped');
    return finish();
  }
  if (!ref.ok) {
    notes.push('ffprobe cannot open this file: value checks skipped');
    return finish();
  }
  if (info.expect === 'error') {
    notes.push('expect=error: value checks skipped');
    return finish();
  }
  if (!family) {
    notes.push('container family unknown: value checks skipped');
    return finish();
  }

  const pairs = pairTracks(result.videoTracks, ref.videoStreams);
  fileChecks.push(finalize(trackSelectionDraft(family, result, ref.videoStreams, pairs)));
  const fd = formatDurationDraft(family, info, ref, result);
  if (fd) fileChecks.push(finalize(fd));

  for (const pair of pairs) {
    if (!pair.app || !pair.ref) continue;
    const drafts = trackDrafts(family, info, result, layout, pair.app, pair.ref, family === 'matroska' ? matroskaTrackOf(layout, ref.videoStreams, pair.ref) : null);
    tracks.push({
      trackId: pair.app.trackId,
      refIndex: pair.ref.index,
      primary: pair.app.trackId === result.primaryTrackId,
      checks: drafts.map(finalize),
    });
  }
  return finish();
}

export function allChecks(e: Evaluation): CheckResult[] {
  return [...e.fileChecks, ...e.tracks.flatMap((t) => t.checks)];
}

export function countVerdicts(checks: readonly CheckResult[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { exact: 0, 'within-tol': 0, 'known-deviation': 0, mismatch: 0, 'n/a': 0 };
  for (const c of checks) counts[c.verdict]++;
  return counts;
}
