import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import type { ArmSpec } from './engines.ts';
import { parseRatio, ticksToSec, type RefFile, type RefStream } from './ref.ts';
import { expectedPrimary, pairTracks, type Evaluation } from './rules.ts';
import type { CheckResult, ContainerFamily, FileLayout, FixtureInfo, OutcomeClass } from './types.ts';

export const DEFINITION_RELATIVE_TOLERANCE = 1e-6;
export const DEFINITION_SECONDS_TOLERANCE = 1e-6;
const PROBED = /(\d+) packets probed/;
const FAMILY_NAMES: Readonly<Record<ContainerFamily, string>> = { isobmff: 'MP4 and MOV', matroska: 'WebM and Matroska' };

export interface OutcomeContext {
  arm: ArmSpec;
  info: FixtureInfo;
  ref: RefFile | null;
  result: FileResult;
  layout: FileLayout | null;
  family: ContainerFamily | null;
}

export interface Outcome {
  outcome: OutcomeClass;
  why: string;
}

function rateOf(s: string | null | undefined): number | null {
  const r = parseRatio(s?.replace(/ \(.*\)$/, ''));
  return r && r.den !== 0 && r.num !== 0 ? r.num / r.den : null;
}

const near = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= DEFINITION_RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
const nearSec = (a: number | null, b: number | null | undefined): boolean => a !== null && b !== null && b !== undefined && Math.abs(a - b) <= DEFINITION_SECONDS_TOLERANCE;
const secondsOf = (c: CheckResult): number | null => (c.app === null || c.app === '' ? null : Number(c.app));

function meanIntervalFps(s: RefStream): number | null {
  const p = s.packets;
  const frames = p?.avgFromPtsFrames ?? null;
  if (!p || frames === null || frames < 2 || p.firstPts == null || p.lastPts == null || p.lastPts <= p.firstPts) return null;
  return (frames - 1) / ticksToSec(p.lastPts - p.firstPts, s.timeBase);
}

interface WindowRates {
  packets: number;
  avgFps: number;
  minFps: number;
  maxFps: number;
}

function probedPackets(track: VideoTrackResult | null): number {
  return Number(track?.warnings.map((w) => PROBED.exec(w)?.[1]).find(Boolean) ?? Number.NaN);
}

function probeWindow(track: VideoTrackResult | null, s: RefStream): WindowRates | null {
  const probed = probedPackets(track);
  const pts = s.packets?.ptsPresented;
  if (!pts || !(probed >= 2) || probed >= pts.length) return null;
  const window = [...pts].sort((a, b) => a - b).slice(0, probed);
  const deltas = window.slice(1).map((v, i) => v - window[i]).filter((d) => d > 0);
  if (deltas.length === 0) return null;
  const rate = (ticks: number): number => 1 / ticksToSec(ticks, s.timeBase);
  return { packets: probed, avgFps: (probed - 1) / ticksToSec(window[probed - 1] - window[0], s.timeBase), minFps: rate(Math.max(...deltas)), maxFps: rate(Math.min(...deltas)) };
}

function sortedPts(s: RefStream): number[] | null {
  const pts = s.packets?.ptsPresented;
  return pts && pts.length > 1 ? [...pts].sort((a, b) => a - b) : null;
}

function roundedInterval(app: number, s: RefStream): boolean {
  const pts = sortedPts(s);
  if (!pts) return false;
  const ticks = 1 / app / ticksToSec(1, s.timeBase);
  if (Number.isInteger(ticks)) return false;
  const deltas = new Set(pts.slice(1).map((v, i) => v - pts[i]));
  return deltas.has(Math.floor(ticks)) && deltas.has(Math.ceil(ticks));
}

const withinTick = (a: number, b: number, s: RefStream): boolean => Math.abs(a - b) <= ticksToSec(1, s.timeBase);

function averageBeforeRounding(app: number, s: RefStream): string | null {
  const p = s.packets;
  const frames = p?.avgFromPtsFrames ?? null;
  if (!p || frames === null || frames < 2) return null;
  const tick = `${s.timeBase.num}/${s.timeBase.den} s`;
  if (p.firstPts != null && p.lastPts != null && withinTick((frames - 1) / app, ticksToSec(p.lastPts - p.firstPts, s.timeBase), s)) {
    return `the mean frame interval ((frames - 1) over the timestamp span); the span it implies is within one ${tick} tick of the file's`;
  }
  if (p.avgFromPtsSpanTicks != null && withinTick(frames / app, ticksToSec(p.avgFromPtsSpanTicks, s.timeBase), s)) {
    return `frames over the presentation span; the span it implies is within one ${tick} tick of the file's`;
  }
  return null;
}

function rateDefinition(ctx: OutcomeContext, c: CheckResult, s: RefStream): string | null {
  const app = rateOf(c.app);
  if (app === null) return null;
  if (near(app, rateOf(c.ffprobe))) return `a floating-point rate equal to ffprobe's ${c.ffprobe} within ${DEFINITION_RELATIVE_TOLERANCE} relative, not the exact rational`;
  const p = s.packets;
  if (c.field === 'avgFps' && near(app, meanIntervalFps(s))) return 'the mean frame interval ((frames - 1) over the timestamp span), not ffprobe avg_frame_rate (frames over the duration)';
  if (c.field === 'avgFps') {
    const rounded = averageBeforeRounding(app, s);
    if (rounded) return rounded;
  }
  if (c.field === 'minFps' || c.field === 'maxFps') {
    const all = c.field === 'minFps' ? p?.instFpsAll?.minFps : p?.instFpsAll?.maxFps;
    if (near(app, all?.value)) return 'taken over every frame interval, the last one included, which the reference excludes';
    if (roundedInterval(app, s)) return `the frame interval before the timestamps were rounded to the ${s.timeBase.num}/${s.timeBase.den} s tick (both roundings occur in the file); the reference takes the rounded intervals`;
    const ref = rateOf(c.ffprobe);
    if (ref !== null && Math.abs(1 / app - 1 / ref) < ticksToSec(1, s.timeBase) && Math.abs(app - ref) <= 1e-4 * ref) return 'within one timestamp tick of the reference interval: computed from floating-point seconds, not integer ticks';
  }
  if (c.field === 'avgFps' || c.field === 'minFps' || c.field === 'maxFps') {
    const track = ctx.result.videoTracks.find((t) => t.trackId === c.trackId) ?? null;
    const w = probeWindow(track, s);
    if (w && (near(app, w[c.field]) || (c.field === 'avgFps' && withinTick((w.packets - 1) / app, (w.packets - 1) / w.avgFps, s)))) return `computed over the first ${w.packets} of ${s.packets?.ptsPresented?.length ?? '?'} frames, which the recipe probes by default, not over the whole stream`;
    const probed = probedPackets(track);
    const frames = p?.packets ?? 0;
    if (!p?.ptsPresented && probed >= 2 && probed < frames) return `computed over the first ${probed} of ${frames} frames, which the recipe probes by default; the reference keeps no per-frame timestamps for this file, so the window is not checked`;
  }
  return null;
}

function trackDefinition(ctx: OutcomeContext, c: CheckResult, s: RefStream): string | null {
  const t = ctx.layout?.tracks?.find((x) => x.id === c.trackId) ?? null;
  if (c.field === 'durationSec') {
    const app = secondsOf(c);
    if (ctx.family === 'isobmff' && nearSec(app, t?.mediaDurationSec)) return 'the media header (mdhd) duration, before the edit list and the fragments';
    if (s.startPts !== null && s.durationTs !== null && nearSec(app, ticksToSec(s.startPts + s.durationTs, s.timeBase))) return 'the end timestamp of the last frame, not the span from the first';
  }
  if (c.field === 'startSec' && t?.hasEditList && (secondsOf(c) ?? 0) < 0) return "the first packet's timestamp, which the edit list moves below zero; ffprobe starts at the first presented frame";
  if (c.field === 'frames' && ctx.layout?.fragmented && t?.samples != null && c.app === String(t.samples)) return 'the samples of the moov only; the fragments are not counted';
  if (c.field === 'isVfr') {
    if (s.packets?.isVfr == null && (s.packets?.packets ?? 0) <= 1) return 'one frame has no interval: the arm reports a constant rate, the reference no flag';
    const intent = ctx.info.category === 'vfr' ? 'true' : ctx.info.category === 'cfr' ? 'false' : null;
    if (intent !== null && c.app === intent) return `its own constant-rate rule, which agrees with how the fixture was made (category ${ctx.info.category}); the reference flag shares this package's rule`;
  }
  return null;
}

function fileDefinition(ctx: OutcomeContext, c: CheckResult): string | null {
  if (c.field === 'error') return ctx.result.error !== null && ctx.ref && !ctx.ref.ok ? 'fails to open the file, as ffprobe does; this package reads what the file holds' : null;
  if (c.field !== 'formatDurationSec') return null;
  const app = secondsOf(c);
  if (ctx.family === 'isobmff' && nearSec(app, ctx.layout?.movieDurationSec)) return 'the movie header (mvhd) duration; ffprobe derives the format duration from the streams';
  const ends = (ctx.ref?.videoStreams ?? []).flatMap((s) => [
    s.packets?.lastPacketEndSec ?? null,
    s.startPts !== null && s.durationTs !== null ? ticksToSec(s.startPts + s.durationTs, s.timeBase) : null,
  ]);
  if (ends.some((e) => nearSec(app, e))) return 'the end timestamp of the last frame, not the duration from the start';
  const lastStarts = (ctx.ref?.videoStreams ?? []).map((s) => (s.packets?.lastPts != null ? ticksToSec(s.packets.lastPts, s.timeBase) : null));
  if (lastStarts.some((e) => nearSec(app, e))) return "the timestamp of the last frame, without that frame's duration; ffprobe reports the container duration";
  return null;
}

function selectionOutcome(ctx: OutcomeContext): Outcome | null {
  const { arm, result, ref, family } = ctx;
  if (!ref || !family) return null;
  const pairs = pairTracks(result.videoTracks, ref.videoStreams);
  const expected = expectedPrimary(family, ref.videoStreams);
  const primary = result.videoTracks.find((t) => t.trackId === result.primaryTrackId) ?? null;
  const primaryRight = !!expected && !!primary && pairs.find((p) => p.app === primary)?.ref === expected;
  if (arm.primaryOnly && primaryRight) return { outcome: 'not-provided', why: 'the recipe returns the primary video track only' };
  if (!arm.picksPrimary && result.videoTracks.length === ref.videoStreams.length && !primaryRight) {
    return { outcome: 'not-provided', why: 'the library picks no primary track; the recipe takes the first video track' };
  }
  return null;
}

export function classify(ctx: OutcomeContext, c: CheckResult, stream: RefStream | null): Outcome {
  const { arm, family } = ctx;
  if (family && !arm.families.includes(family)) return { outcome: 'unsupported-container', why: `the library reads ${arm.families.map((f) => FAMILY_NAMES[f]).join(', ')} only` };
  if (arm.provides && !arm.provides.has(c.field)) return { outcome: 'not-provided', why: "not part of the arm's recipe" };
  if (c.field === 'trackSelection') return selectionOutcome(ctx) ?? { outcome: 'wrong', why: c.detail ?? 'a different track selection' };
  if ((c.app === null || c.app === '') && c.field !== 'error') return { outcome: 'not-provided', why: 'the arm returned no value' };
  const definition = stream ? (rateDefinition(ctx, c, stream) ?? trackDefinition(ctx, c, stream)) : fileDefinition(ctx, c);
  if (definition) return { outcome: 'definition-differs', why: definition };
  return { outcome: 'wrong', why: 'differs from ffprobe, and none of the checked definitions explains it' };
}

export function classifyEvaluation(ctx: OutcomeContext, evaluation: Evaluation): void {
  const set = (c: CheckResult, stream: RefStream | null) => {
    if (c.verdict !== 'mismatch') return;
    const o = classify(ctx, c, stream);
    c.outcome = o.outcome;
    c.outcomeWhy = o.why;
  };
  for (const c of evaluation.fileChecks) set(c, null);
  for (const t of evaluation.tracks) {
    const stream = ctx.ref?.videoStreams.find((s) => s.index === t.refIndex) ?? null;
    for (const c of t.checks) set(c, stream);
  }
}

export function countOutcomes(checks: readonly CheckResult[]): Record<OutcomeClass, number> {
  const counts: Record<OutcomeClass, number> = { wrong: 0, 'definition-differs': 0, 'not-provided': 0, 'unsupported-container': 0 };
  for (const c of checks) if (c.outcome) counts[c.outcome]++;
  return counts;
}
