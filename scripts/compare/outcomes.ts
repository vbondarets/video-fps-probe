import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import type { ArmSpec } from './engines.ts';
import { parseRatio, ticksToSec, type RefFile, type RefStream } from './ref.ts';
import { expectedPrimary, matroskaTrackOf, pairTracks, type Evaluation } from './rules.ts';
import type { CheckResult, ContainerFamily, FileLayout, FixtureInfo, OutcomeClass } from './types.ts';

export const DEFINITION_RELATIVE_TOLERANCE = 1e-6;
export const DEFINITION_SECONDS_TOLERANCE = 1e-6;
const PROBED = /(\d+) packets probed/;
const UNDERLYING = /underlying ([^,]+),/;
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

type DefinitionId =
  | 'fails-like-ffprobe'
  | 'float'
  | 'frame-rate-metrics'
  | 'span-average'
  | 'mean-interval'
  | 'span-to-last'
  | 'all-intervals'
  | 'rounded-interval'
  | 'float-seconds'
  | 'mdhd'
  | 'last-packet-end'
  | 'negative-start'
  | 'moov-samples'
  | 'single-frame'
  | 'intent'
  | 'mvhd'
  | 'mehd'
  | 'file-end'
  | 'metadata-duration'
  | 'audio-end'
  | 'last-start';

type Match = string | { unverified: string } | null;

interface Definition {
  id: DefinitionId;
  test(ctx: OutcomeContext, c: CheckResult, s: RefStream | null): Match;
}

const MEDIABUNNY_RECIPE: readonly DefinitionId[] = ['fails-like-ffprobe', 'float', 'frame-rate-metrics', 'last-packet-end', 'negative-start', 'single-frame', 'intent', 'file-end'];

const ARM_DEFINITIONS: Readonly<Record<string, readonly DefinitionId[]>> = {
  'mp4box-idiomatic': ['fails-like-ffprobe', 'mdhd', 'moov-samples', 'mvhd', 'mehd'],
  'mp4box-tuned': ['fails-like-ffprobe', 'file-end', 'audio-end'],
  'mediabunny-idiomatic': MEDIABUNNY_RECIPE,
  'mediabunny-full': MEDIABUNNY_RECIPE,
  'mediabunny-tuned': ['fails-like-ffprobe', 'float', 'span-average', 'negative-start', 'metadata-duration'],
};

const MEDIABUNNY_API: Partial<Record<DefinitionId, string>> = {
  'frame-rate-metrics': 'computeFrameRateMetrics()',
  'last-packet-end': 'the track computeDuration()',
  'negative-start': 'getFirstTimestamp()',
  'single-frame': 'computeFrameRateMetrics()',
  intent: 'frameRateIsConstant',
  'file-end': 'input.computeDuration()',
};

const ARM_API: Readonly<Record<string, Partial<Record<DefinitionId, string>>>> = {
  'mp4box-idiomatic': {
    mdhd: 'getInfo() track duration over its timescale',
    'moov-samples': 'getInfo() nb_samples at onReady',
    mvhd: 'getInfo() movie duration over its timescale',
    mehd: 'getInfo() fragment_duration, which the recipe takes when the movie duration is 0',
  },
  'mp4box-tuned': { 'file-end': 'the adapter takes the largest track end', 'audio-end': 'the adapter takes the largest track end' },
  'mediabunny-idiomatic': MEDIABUNNY_API,
  'mediabunny-full': MEDIABUNNY_API,
  'mediabunny-tuned': {
    'span-average': 'computePacketStats().averagePacketRate',
    'negative-start': 'the smallest packet timestamp of the adapter',
    'metadata-duration': 'input.getDurationFromMetadata()',
  },
};

const armKey = (arm: ArmSpec): string => (arm.library === 'own' ? 'own' : `${arm.library}-${arm.style}`);

function rateOf(s: string | null | undefined): number | null {
  const r = parseRatio(s?.replace(/ \(.*\)$/, ''));
  return r && r.den !== 0 && r.num !== 0 ? r.num / r.den : null;
}

const near = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= DEFINITION_RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
const nearSec = (a: number | null, b: number | null | undefined): boolean => a !== null && b !== null && b !== undefined && Math.abs(a - b) <= DEFINITION_SECONDS_TOLERANCE;
const secondsOf = (c: CheckResult): number | null => (c.app === null || c.app === '' ? null : Number(c.app));
const isRateField = (c: CheckResult): boolean => c.field === 'avgFps' || c.field === 'minFps' || c.field === 'maxFps';
const withinTick = (a: number, b: number, s: RefStream): boolean => Math.abs(a - b) <= ticksToSec(1, s.timeBase);
const tickText = (s: RefStream): string => `${s.timeBase.num}/${s.timeBase.den} s`;
const fmtRate = (v: number): string => (v >= 100 ? v.toFixed(1) : v.toFixed(3));

function trackOf(ctx: OutcomeContext, c: CheckResult): VideoTrackResult | null {
  return ctx.result.videoTracks.find((t) => t.trackId === c.trackId) ?? null;
}

const UNSTORED_LAST = 'the file stores no duration for the last frame (no DefaultDuration, no BlockDuration), so mediabunny gives it none';

function storesNoLastDuration(ctx: OutcomeContext, s: RefStream): boolean {
  if (ctx.family !== 'matroska' || !ctx.ref) return false;
  const t = matroskaTrackOf(ctx.layout, ctx.ref.videoStreams, s);
  return t !== null && t.defaultDurationNs === null && t.blockDurations === 0;
}

function sortedPts(s: RefStream): number[] | null {
  const pts = s.packets?.ptsPresented;
  return pts && pts.length > 1 ? [...pts].sort((a, b) => a - b) : null;
}

function meanIntervalFps(s: RefStream): number | null {
  const p = s.packets;
  const frames = p?.avgFromPtsFrames ?? null;
  if (!p || frames === null || frames < 2 || p.firstPts == null || p.lastPts == null || p.lastPts <= p.firstPts) return null;
  return (frames - 1) / ticksToSec(p.lastPts - p.firstPts, s.timeBase);
}

interface MetricsModel {
  avgFps: number;
  minFps: number;
  maxFps: number;
  distinct: number;
}

function metricsModel(ticks: readonly number[], resolution: number, underlying: number | null): MetricsModel {
  const distinct = [...new Set(ticks)].sort((a, b) => a - b);
  if (distinct.length < 2) return { avgFps: resolution, minFps: resolution, maxFps: resolution, distinct: distinct.length };
  const unit = underlying ?? resolution;
  const perFrame = underlying === null ? null : resolution / underlying;
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (let i = 1; i < distinct.length; i++) {
    const d = distinct[i] - distinct[i - 1];
    const diff = perFrame === null ? d : Math.max(1, Math.round(d / perFrame));
    min = Math.min(min, diff);
    max = Math.max(max, diff);
    total += diff;
  }
  return { avgFps: (unit * (distinct.length - 1)) / total, minFps: unit / max, maxFps: unit / min, distinct: distinct.length };
}

function metricsWarning(track: VideoTrackResult | null): { probed: number; underlying: number | null | undefined } {
  const line = track?.warnings.find((w) => PROBED.test(w)) ?? '';
  const probed = Number(PROBED.exec(line)?.[1] ?? Number.NaN);
  const raw = UNDERLYING.exec(line)?.[1];
  const underlying = raw === undefined ? undefined : raw === 'null' ? null : Number(raw);
  return { probed, underlying: underlying !== undefined && underlying !== null && !Number.isFinite(underlying) ? undefined : underlying };
}

const METRIC_TEXT: Readonly<Record<string, string>> = {
  avgFps: 'averageFrameRate, the distinct timestamps less one over their span,',
  minFps: 'minFrameRate, from the longest interval,',
  maxFps: 'maxFrameRate, from the shortest interval,',
};

function frameRateMetrics(ctx: OutcomeContext, c: CheckResult, s: RefStream | null): Match {
  if (!s || !isRateField(c)) return null;
  const app = rateOf(c.app);
  if (app === null) return null;
  const { probed, underlying } = metricsWarning(trackOf(ctx, c));
  const p = s.packets;
  const total = p?.presentedPackets ?? p?.packets ?? 0;
  if (!p || !(probed >= 1) || underlying === undefined) return null;
  const resolution = s.timeBase.den / s.timeBase.num;
  const discarded = p.discardedPackets ?? 0;
  if (discarded > 0) return { unverified: `the edit list discards ${discarded} stored packets, which computeFrameRateMetrics() reads and the reference does not keep, so its definition is not checked` };
  const pts = p.ptsPresented ? [...p.ptsPresented].sort((a, b) => a - b) : null;
  let model: MetricsModel | null = null;
  if (pts && pts.length > 0) model = metricsModel(pts.slice(0, Math.min(probed, pts.length)), resolution, underlying);
  else if (c.field === 'avgFps' && underlying === null && probed >= total && p.duplicateTimestamps === 0 && p.firstPts != null && p.lastPts != null && p.lastPts > p.firstPts) {
    model = { avgFps: (resolution * (total - 1)) / (p.lastPts - p.firstPts), minFps: Number.NaN, maxFps: Number.NaN, distinct: total };
  }
  if (!model) return { unverified: `computed over the first ${probed} of ${total} frames; the reference keeps no per-frame timestamps for this file, so its definition is not checked` };
  if (!near(app, model[c.field as 'avgFps' | 'minFps' | 'maxFps'])) return null;
  if (model.distinct < 2) return `fewer than two distinct timestamps: it returns the time resolution, ${fmtRate(resolution)} per second, as every rate`;
  const window = probed < total ? `the first ${probed} of ${total} frames (its default probe)` : `all ${total} frames`;
  const unit = underlying === null ? 'in timestamp ticks (it found no underlying frame rate)' : `in whole frames of the ${fmtRate(underlying)} fps underlying rate it infers`;
  return `${METRIC_TEXT[c.field]} of ${window}, ${unit}`;
}

function roundedInterval(app: number, s: RefStream): boolean {
  const pts = sortedPts(s);
  if (!pts) return false;
  const ticks = 1 / app / ticksToSec(1, s.timeBase);
  if (Number.isInteger(ticks)) return false;
  const deltas = new Set(pts.slice(1).map((v, i) => v - pts[i]));
  return deltas.has(Math.floor(ticks)) && deltas.has(Math.ceil(ticks));
}

const DEFINITIONS: readonly Definition[] = [
  {
    id: 'fails-like-ffprobe',
    test: (ctx, c) => (c.field === 'error' && ctx.result.error !== null && ctx.ref && !ctx.ref.ok ? 'fails to open the file, as ffprobe does; this package reads what the file holds' : null),
  },
  {
    id: 'float',
    test: (_ctx, c, s) => {
      if (!s || (!isRateField(c) && c.field !== 'nominalFps')) return null;
      return near(rateOf(c.app), rateOf(c.ffprobe)) ? `a floating-point rate equal to ffprobe's ${c.ffprobe} within ${DEFINITION_RELATIVE_TOLERANCE} relative, not the exact rational` : null;
    },
  },
  { id: 'frame-rate-metrics', test: frameRateMetrics },
  {
    id: 'span-average',
    test: (ctx, c, s) => {
      const app = rateOf(c.app);
      const p = s?.packets;
      const frames = p?.avgFromPtsFrames ?? null;
      if (!s || c.field !== 'avgFps' || app === null || !p || frames === null || frames < 1 || p.avgFromPtsSpanTicks == null || p.avgFromPtsSpanTicks <= 0) return null;
      const span = ticksToSec(p.avgFromPtsSpanTicks, s.timeBase);
      if (near(app, frames / span)) return 'frames over the presentation span, from the first timestamp to the end of the last frame';
      if (withinTick(frames / app, span, s)) return `frames over the presentation span; the span it implies is within one ${tickText(s)} tick of the file's`;
      if (!storesNoLastDuration(ctx, s) || p.firstPts == null || p.lastPts == null || p.lastPts <= p.firstPts) return null;
      return near(app, frames / ticksToSec(p.lastPts - p.firstPts, s.timeBase)) ? `frames over the presentation span, which ends at the last timestamp: ${UNSTORED_LAST}` : null;
    },
  },
  {
    id: 'mean-interval',
    test: (_ctx, c, s) => {
      const app = rateOf(c.app);
      const p = s?.packets;
      if (!s || c.field !== 'avgFps' || app === null || !p) return null;
      if (near(app, meanIntervalFps(s))) return 'the mean frame interval ((frames - 1) over the timestamp span), not ffprobe avg_frame_rate (frames over the duration)';
      const frames = p.avgFromPtsFrames ?? null;
      if (frames === null || frames < 2 || p.firstPts == null || p.lastPts == null) return null;
      return withinTick((frames - 1) / app, ticksToSec(p.lastPts - p.firstPts, s.timeBase), s)
        ? `the mean frame interval ((frames - 1) over the timestamp span); the span it implies is within one ${tickText(s)} tick of the file's`
        : null;
    },
  },
  {
    id: 'span-to-last',
    test: (_ctx, c, s) => {
      const app = rateOf(c.app);
      const p = s?.packets;
      const frames = p?.avgFromPtsFrames ?? null;
      if (!s || c.field !== 'avgFps' || app === null || !p || frames === null || p.firstPts == null || p.lastPts == null || p.lastPts <= p.firstPts) return null;
      return near(app, frames / ticksToSec(p.lastPts - p.firstPts, s.timeBase)) ? "frames over the span from the first to the last timestamp, without the last frame's duration" : null;
    },
  },
  {
    id: 'all-intervals',
    test: (_ctx, c, s) => {
      if (!s || (c.field !== 'minFps' && c.field !== 'maxFps')) return null;
      const all = c.field === 'minFps' ? s.packets?.instFpsAll?.minFps : s.packets?.instFpsAll?.maxFps;
      return near(rateOf(c.app), all?.value) ? 'taken over every frame interval, the last one included, which the reference excludes' : null;
    },
  },
  {
    id: 'rounded-interval',
    test: (_ctx, c, s) => {
      const app = rateOf(c.app);
      if (!s || (c.field !== 'minFps' && c.field !== 'maxFps') || app === null || !roundedInterval(app, s)) return null;
      return `the frame interval before the timestamps were rounded to the ${tickText(s)} tick (both roundings occur in the file); the reference takes the rounded intervals`;
    },
  },
  {
    id: 'float-seconds',
    test: (_ctx, c, s) => {
      const app = rateOf(c.app);
      const ref = rateOf(c.ffprobe);
      if (!s || (c.field !== 'minFps' && c.field !== 'maxFps') || app === null || ref === null) return null;
      return Math.abs(1 / app - 1 / ref) < ticksToSec(1, s.timeBase) && Math.abs(app - ref) <= 1e-4 * ref ? 'within one timestamp tick of the reference interval: computed from floating-point seconds, not integer ticks' : null;
    },
  },
  {
    id: 'mdhd',
    test: (ctx, c) => {
      const t = ctx.layout?.tracks?.find((x) => x.id === c.trackId);
      return c.field === 'durationSec' && ctx.family === 'isobmff' && nearSec(secondsOf(c), t?.mediaDurationSec) ? 'the media header (mdhd) duration, before the edit list and the fragments' : null;
    },
  },
  {
    id: 'last-packet-end',
    test: (_ctx, c, s) => {
      if (!s || c.field !== 'durationSec') return null;
      const app = secondsOf(c);
      const ffEnd = s.startPts !== null && s.durationTs !== null ? ticksToSec(s.startPts + s.durationTs, s.timeBase) : null;
      return nearSec(app, s.packets?.lastPacketEndSec) || nearSec(app, ffEnd) ? 'the end timestamp of the last frame (its timestamp plus its duration), not the span from the first' : null;
    },
  },
  {
    id: 'negative-start',
    test: (ctx, c) => {
      const t = ctx.layout?.tracks?.find((x) => x.id === c.trackId);
      return c.field === 'startSec' && t?.hasEditList && (secondsOf(c) ?? 0) < 0 ? "the first packet's timestamp, which the edit list moves below zero; ffprobe starts at the first presented frame" : null;
    },
  },
  {
    id: 'moov-samples',
    test: (ctx, c) => {
      const t = ctx.layout?.tracks?.find((x) => x.id === c.trackId);
      return c.field === 'frames' && ctx.layout?.fragmented && t?.samples != null && c.app === String(t.samples) ? 'the samples of the moov only; the fragments are not counted' : null;
    },
  },
  {
    id: 'single-frame',
    test: (_ctx, c, s) => (s && c.field === 'isVfr' && s.packets?.isVfr == null && (s.packets?.packets ?? 0) <= 1 ? 'one frame has no interval: a constant rate is reported, the reference has no flag' : null),
  },
  {
    id: 'intent',
    test: (ctx, c, s) => {
      if (!s || c.field !== 'isVfr') return null;
      const intent = ctx.info.category === 'vfr' ? 'true' : ctx.info.category === 'cfr' ? 'false' : null;
      return intent !== null && c.app === intent ? `its own constant-rate rule, which agrees with how the fixture was made (category ${ctx.info.category}); the reference flag shares this package's rule` : null;
    },
  },
  {
    id: 'mvhd',
    test: (ctx, c) =>
      c.field === 'formatDurationSec' && ctx.family === 'isobmff' && nearSec(secondsOf(c), ctx.layout?.movieDurationSec) ? 'the movie header (mvhd) duration; ffprobe derives the format duration from the streams' : null,
  },
  {
    id: 'mehd',
    test: (ctx, c) => {
      if (c.field !== 'formatDurationSec' || ctx.family !== 'isobmff' || ctx.layout?.movieDurationSec !== 0) return null;
      if (ctx.layout.fragmentDurationSec == null) {
        return { unverified: 'with no movie duration and no mehd, getInfo() sums the sample durations of the longest track, which the reference does not give, so its definition is not checked' };
      }
      return nearSec(secondsOf(c), ctx.layout.fragmentDurationSec) ? 'the movie extends header (mehd) fragment duration; ffprobe derives the format duration from the streams' : null;
    },
  },
  {
    id: 'file-end',
    test: (ctx, c) => {
      if (c.field !== 'formatDurationSec') return null;
      const app = secondsOf(c);
      const ends = (ctx.ref?.videoStreams ?? []).flatMap((s) => [s.packets?.lastPacketEndSec ?? null, s.startPts !== null && s.durationTs !== null ? ticksToSec(s.startPts + s.durationTs, s.timeBase) : null]);
      if (ends.some((e) => nearSec(app, e))) return 'the end timestamp of the last frame, not the duration from the start';
      const recipe = ctx.arm.library === 'mediabunny' && ctx.arm.style !== 'tuned';
      const video = ctx.ref?.videoStreams ?? [];
      if (recipe && video.length > 0 && (ctx.ref?.audioCount ?? 0) === 0 && video.every((s) => storesNoLastDuration(ctx, s))) {
        const lastStarts = video.map((s) => (s.packets?.lastPts != null ? ticksToSec(s.packets.lastPts, s.timeBase) : null));
        if (lastStarts.some((e) => nearSec(app, e))) return `the end timestamp of the last frame, which is its timestamp: ${UNSTORED_LAST}`;
      }
      return recipe && (ctx.ref?.audioCount ?? 0) > 0
        ? { unverified: 'input.computeDuration() takes the largest end timestamp of every track, audio included, and the reference keeps no audio packets, so its definition is not checked' }
        : null;
    },
  },
  {
    id: 'metadata-duration',
    test: (ctx, c) => {
      if (c.field !== 'formatDurationSec' || ctx.family !== 'isobmff') return null;
      const starts = new Map(ctx.result.videoTracks.map((t) => [t.trackId, t.startSec ?? 0]));
      const ends = (ctx.layout?.tracks ?? []).filter((t) => (t.mediaDurationSec ?? 0) > 0).map((t) => (t.mediaDurationSec ?? 0) + (starts.get(t.id) ?? 0));
      return ends.length > 0 && nearSec(secondsOf(c), Math.max(...ends)) ? 'the largest first timestamp plus media header (mdhd) duration of any track' : null;
    },
  },
  {
    id: 'audio-end',
    test: (ctx, c) => {
      const audio = (ctx.layout?.tracks ?? []).filter((t) => t.handler === 'soun').map((t) => t.mediaDurationSec);
      return c.field === 'formatDurationSec' && ctx.family === 'isobmff' && audio.some((d) => nearSec(secondsOf(c), d)) ? "an audio track's media header (mdhd) duration, the longest track" : null;
    },
  },
  {
    id: 'last-start',
    test: (ctx, c) => {
      if (c.field !== 'formatDurationSec') return null;
      const app = secondsOf(c);
      const lastStarts = (ctx.ref?.videoStreams ?? []).map((s) => (s.packets?.lastPts != null ? ticksToSec(s.packets.lastPts, s.timeBase) : null));
      return lastStarts.some((e) => nearSec(app, e)) ? "the timestamp of the last frame, without that frame's duration; ffprobe reports the container duration" : null;
    },
  },
];

function definitionOutcome(ctx: OutcomeContext, c: CheckResult, stream: RefStream | null): Outcome | null {
  const key = armKey(ctx.arm);
  const owned = new Set(ARM_DEFINITIONS[key] ?? []);
  const api = ARM_API[key] ?? {};
  for (const d of DEFINITIONS) {
    if (!owned.has(d.id)) continue;
    const m = d.test(ctx, c, stream);
    if (m === null) continue;
    if (typeof m !== 'string') return { outcome: 'unverified', why: m.unverified };
    return { outcome: 'definition-differs', why: api[d.id] ? `${api[d.id]}: ${m}` : m };
  }
  for (const d of DEFINITIONS) {
    if (owned.has(d.id)) continue;
    const m = d.test(ctx, c, stream);
    if (typeof m === 'string') return { outcome: 'unverified', why: `equals ${m}; that is not how the arm defines the field, so the cause is not verified` };
  }
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

const WRONG: Outcome = { outcome: 'wrong', why: "differs from ffprobe, and neither the arm's own definition nor another checked one explains it" };

export function classify(ctx: OutcomeContext, c: CheckResult, stream: RefStream | null): Outcome {
  const { arm, family } = ctx;
  if (family && !arm.families.includes(family)) return { outcome: 'unsupported-container', why: `the library reads ${arm.families.map((f) => FAMILY_NAMES[f]).join(', ')} only` };
  if (arm.provides && !arm.provides.has(c.field)) return { outcome: 'not-provided', why: "not part of the arm's recipe" };
  if (c.field === 'trackSelection') return selectionOutcome(ctx) ?? { outcome: 'wrong', why: c.detail ?? 'a different track selection' };
  if ((c.app === null || c.app === '') && c.field !== 'error') return { outcome: 'not-provided', why: 'the arm returned no value' };
  if (arm.library === 'own') return WRONG;
  return definitionOutcome(ctx, c, stream) ?? WRONG;
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
  const counts: Record<OutcomeClass, number> = { wrong: 0, 'definition-differs': 0, unverified: 0, 'not-provided': 0, 'unsupported-container': 0 };
  for (const c of checks) if (c.outcome) counts[c.outcome]++;
  return counts;
}
