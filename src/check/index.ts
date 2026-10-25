import type { ContainerKind, FileResult, Rational, VideoTrackResult } from '../core/types.ts';

export type RatioValue = number | `${number}/${number}` | `${number}:${number}`;
export type RatePolicy = 'allow' | 'warn' | 'reject';
export type FpsSource = 'avg' | 'ffprobe' | 'nominal' | 'dominant';
export type CheckVerdict = 'pass' | 'warn' | 'fail' | 'unknown';
export type CheckSeverity = 'fail' | 'warn' | 'unknown';

export interface RangeRule<T = number> {
  min?: T;
  max?: T;
}

export interface FpsRule extends RangeRule<RatioValue> {
  exact?: RatioValue;
  oneOf?: readonly RatioValue[];
  source?: FpsSource;
}

export interface AspectRatioRule extends RangeRule<RatioValue> {
  oneOf?: readonly RatioValue[];
}

export interface DisplayRule {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  minShortSide?: number;
  maxShortSide?: number;
  minLongSide?: number;
  maxLongSide?: number;
}

export interface CheckRules {
  fps?: FpsRule;
  duration?: RangeRule;
  display?: DisplayRule;
  aspectRatio?: AspectRatioRule;
  pixels?: RangeRule;
  fileSize?: RangeRule;
  containers?: readonly ContainerKind[];
  codecs?: readonly string[];
  audio?: 'required' | 'forbidden';
  vfr?: RatePolicy;
  uneven?: RatePolicy;
  severity?: 'fail' | 'warn';
}

export type CheckExpected = number | string | readonly (number | string)[] | null;

export interface CheckViolation {
  rule: string;
  severity: CheckSeverity;
  expected: CheckExpected;
  actual: number | string | boolean | null;
  message: string;
}

export interface SuggestedFps {
  value: number;
  reason: string;
}

export interface CheckReport {
  verdict: CheckVerdict;
  violations: CheckViolation[];
  suggestedFps?: SuggestedFps;
}

type Q = readonly [bigint, bigint];
type Bound = 'min' | 'max' | 'exact' | 'oneOf';

const UNEVEN_SPREAD = 1.075;
const DECIMATE_FROM = 1.5;
const SPAN_SLACK_MS = 3n;
const RELATION: Record<Bound, string> = { min: 'below the minimum', max: 'above the maximum', exact: 'not', oneOf: 'not one of' };
const BOUNDS = Object.keys(RELATION) as Bound[];
const GROUPS = ['fps', 'duration', 'display', 'aspectRatio', 'pixels', 'fileSize'] as const;
const POLICIES: readonly RatePolicy[] = ['allow', 'warn', 'reject'];
const SOURCES: readonly FpsSource[] = ['avg', 'ffprobe', 'nominal', 'dominant'];

const invalid = (rule: string, v: unknown, what: string): never => {
  throw new TypeError(`${rule}: ${JSON.stringify(v)} is not ${what}`);
};

function decimal(s: string): Q | null {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s.trim());
  if (!m) return null;
  const e = Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  const n = BigInt(m[1]! + (m[2] ?? ''));
  return e >= 0 ? [n * 10n ** BigInt(e), 1n] : [n, 10n ** BigInt(-e)];
}

function ratio(v: unknown, rule: string): Q {
  const parts = typeof v === 'number' || typeof v === 'string' ? String(v).split(/[/:]/) : [];
  const [a, b] = parts.map(decimal);
  const q: Q | null = a && parts.length === 1 ? a : a && b && parts.length === 2 ? [a[0] * b[1], a[1] * b[0]] : null;
  return q && q[1] !== 0n ? q : invalid(rule, v, "a non-negative number or 'num/den'");
}

const cmp = (a: Q, b: Q): bigint => a[0] * b[1] - b[0] * a[1];

const whole = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;

const fromRational = (r: Pick<Rational, 'num' | 'den'> | null | undefined): Q | null => (r && whole(r.num) && whole(r.den) ? [BigInt(r.num), BigInt(r.den)] : null);

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

const value = (q: Q): number => Number(q[0]) / Number(q[1]);

const round = (x: number): number => +x.toFixed(3);

function fraction(q: Q): string {
  const g = gcd(q[0], q[1]) || 1n;
  return `${q[0] / g}/${q[1] / g}`;
}

const fpsText = (q: Q): string => (q[0] % q[1] === 0n ? `${q[0] / q[1]}` : `${round(value(q))} (${fraction(q)})`);

function steady(t: VideoTrackResult): readonly [Q, Q] | null {
  const avg = fromRational(t.avgFps);
  const nominal = fromRational(t.nominalFps);
  const frames = t.presentedFrames ?? t.frames;
  if (!avg || !nominal || !t.timestampsQuantized || t.isVfr !== false || !whole(frames)) return null;
  const n = BigInt(frames);
  const gap = n * (avg[1] * nominal[0] - nominal[1] * avg[0]);
  return (gap < 0n ? -gap : gap) * 1000n <= SPAN_SLACK_MS * avg[0] * nominal[0] ? [nominal, [n * nominal[1], nominal[0]]] : null;
}

function judgedFps(t: VideoTrackResult, source: FpsSource | undefined, cfr: readonly [Q, Q] | null): Q | null {
  const m = /^(\d+)\/(\d+)$/.exec(t.avgFpsFfprobe ?? '');
  if (source === 'ffprobe') return m && fromRational({ num: +m[1]!, den: +m[2]! });
  if (source === 'nominal') return fromRational(t.nominalFps);
  if (source === 'dominant') return fromRational(t.dominantFps?.rate ?? (t.isVfr === false ? t.nominalFps : null));
  return cfr?.[0] ?? fromRational(t.avgFps);
}

function unevenOf(t: VideoTrackResult): boolean | null {
  if (t.rateProfile) return t.rateProfile.uneven;
  return t.isVfr === false || (t.minFps && t.maxFps && t.maxFps.value <= t.minFps.value * UNEVEN_SPREAD) ? false : null;
}

function fit(target: number, rule: FpsRule = {}): [number, number] {
  const n = (v: RatioValue | null | undefined): number | null => (v == null ? null : value(ratio(v, 'fps')));
  const lo = n(rule.min) ?? 0;
  const hi = n(rule.max) ?? Infinity;
  const exact = n(rule.exact);
  if (exact !== null) return [exact, 0];
  const allowed = [rule.oneOf ?? []].flat().map((v) => n(v)!).filter((v) => v >= lo && v <= hi);
  const distance = (v: number): number => Math.abs(v - target) + v * 1e-9;
  if (allowed.length > 0) return [allowed.reduce((best, v) => (distance(v) < distance(best) ? v : best)), 0];
  if (target < lo) return [lo, 0];
  if (target <= hi) return [target, 0];
  if (target >= hi * DECIMATE_FROM) for (let k = 2; k <= 8; k++) if (target / k <= hi) return target / k >= lo ? [target / k, k] : [hi, 0];
  return [hi, 0];
}

export function check(result: FileResult | null | undefined, rules: CheckRules): CheckReport {
  if (!rules || typeof rules !== 'object') invalid('rules', rules, 'an object');
  for (const g of GROUPS) if (rules[g] != null && typeof rules[g] !== 'object') invalid(g, rules[g], 'an object');
  const choices: Array<[string, unknown, readonly string[]]> = [['fps.source', rules.fps?.source, SOURCES], ['audio', rules.audio, ['required', 'forbidden']], ['vfr', rules.vfr, POLICIES], ['uneven', rules.uneven, POLICIES], ['severity', rules.severity, ['fail', 'warn']]];
  for (const [rule, v, list] of choices) if (v != null && !list.includes(v as string)) invalid(rule, v, `one of ${list.join(', ')}`);
  const violations: CheckViolation[] = [];
  const severity = rules.severity === 'warn' ? 'warn' : 'fail';
  const error = result ? result.error : 'no result';
  const t = result && !error && Array.isArray(result.videoTracks) ? (result.videoTracks.find((x) => x.trackId === result.primaryTrackId) ?? null) : null;
  const add = (rule: string, s: CheckSeverity, expected: CheckExpected, actual: number | string | boolean | null, message: string): number => violations.push({ rule, severity: s, expected, actual, message: `${rule}: ${message}` });
  const unknown = (rule: string, missing: string): unknown => violations.some((v) => v.rule === rule) || add(rule, 'unknown', null, null, `unknown, ${error ? `the analysis failed: ${error}` : t ? `no ${missing}` : 'no video track'}`);

  const limits = (group: string, rule: Partial<Record<Bound, RatioValue | readonly RatioValue[]>> | undefined, actual: Q | null, shown: number | string, text: string, unit: string, missing: string, side = ''): void => {
    const bounds = BOUNDS.filter((b) => rule?.[b] != null).map((b) => [b, rule![b]!, [rule![b]!].flat().map((v) => ratio(v, `${group}.${b}${side}`))] as const);
    if (bounds.length === 0) return;
    if (!actual) return void unknown(group, missing);
    for (const [b, expected, qs] of bounds) {
      const c = qs.map((q) => cmp(actual, q));
      if (b === 'min' ? c[0]! < 0n : b === 'max' ? c[0]! > 0n : !c.includes(0n)) add(`${group}.${b}${side}`, severity, expected, shown, `${text}${unit} is ${RELATION[b]} ${[expected].flat().join(', ')}${unit}`);
    }
  };
  const quantity = (x: number | null | undefined): Q | null => (typeof x === 'number' ? decimal(String(x)) : null);
  const allow = (rule: 'containers' | 'codecs', list: readonly string[] | undefined, actual: string | null | undefined, missing: string): void => {
    if (list == null) return;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) invalid(rule, list, 'a list of strings');
    if (!actual || actual === 'unknown') unknown(rule, missing);
    else if (!list.some((x) => x.toLowerCase() === actual.toLowerCase())) add(rule, severity, list, actual, `${actual} is not one of ${list.join(', ')}`);
  };
  const policy = (rule: 'vfr' | 'uneven', state: boolean | null, missing: string, message: string): boolean => {
    const p = rules[rule];
    if (!p || p === 'allow') return false;
    if (state === null) unknown(rule, missing);
    else if (state) add(rule, p === 'warn' ? 'warn' : severity, p, true, message);
    return !!state;
  };

  const cfr = t && steady(t);
  const fps = t && judgedFps(t, rules.fps?.source, cfr);
  limits('fps', rules.fps, fps, fps ? fraction(fps) : '', fps ? fpsText(fps) : '', ' fps', `${rules.fps?.source ?? 'avg'} frame rate`);
  const span = cfr?.[1] ?? quantity(t && (t.durationSec ?? result!.formatDurationSec));
  const seconds = span ? value(span) : 0;
  limits('duration', rules.duration, span, seconds, `${round(seconds)}`, ' s', 'duration');

  const size = t ? (Math.abs(t.rotation) % 180 === 90 ? [t.height, t.width] : [t.width, t.height]) : [0, 0];
  const sized = size.every(whole);
  const [w, h] = sized ? size : [0, 0];
  const sides = { Width: w, Height: h, ShortSide: Math.min(w, h), LongSide: Math.max(w, h) };
  const d = rules.display as Record<string, RatioValue | undefined> | undefined;
  for (const [side, x] of Object.entries(sides)) {
    limits('display', { min: d?.[`min${side}`], max: d?.[`max${side}`] }, sized ? [BigInt(x), 1n] : null, x, `${x}`, ' px', 'display size', side);
  }
  const area: Q = [BigInt(w), BigInt(h)];
  limits('aspectRatio', rules.aspectRatio, sized ? area : null, fraction(area), `${w}x${h} (${round(w / h)})`, '', 'display size');
  limits('pixels', rules.pixels, sized ? [BigInt(w) * BigInt(h), 1n] : null, w * h, `${w * h}`, ' px', 'display size');
  limits('fileSize', rules.fileSize, quantity(result?.size), result?.size ?? '', `${result?.size}`, ' bytes', 'file size');
  allow('containers', rules.containers, result?.container, 'container');
  allow('codecs', rules.codecs, t?.codecName, 'codec name');
  if (rules.audio) {
    const audio = t ? result!.audioTrackCount > 0 : null;
    const required = rules.audio === 'required';
    if (audio === null) unknown('audio', '');
    else if (audio !== required) add('audio', severity, rules.audio, audio, `${rules.audio}, the file has ${required ? 'no' : 'an'} audio track`);
  }
  const vfr = policy('vfr', t && t.isVfr, 'VFR flag', 'the frame rate is variable');
  const uneven = policy('uneven', t && unevenOf(t), 'rate profile', `the frame rate is uneven${t?.rateProfile ? `: ${t.rateProfile.summary}` : ''}`);

  const report: CheckReport = { verdict: 'pass', violations };
  const fpsOff = violations.some((v) => v.rule.startsWith('fps.'));
  if (t && (fpsOff || vfr || uneven)) {
    const constant = fpsOff ? fps : (fromRational(t.dominantFps?.rate) ?? fromRational(t.nominalFps));
    const [v, k] = fit(constant ? value(constant) : Math.round(t.avgFps?.value ?? 0), rules.fps);
    const how = k > 1 ? `, which keeps 1 of every ${k} frames` : '';
    if (v > 0) report.suggestedFps = { value: v, reason: fpsOff ? `${fpsText(fps!)} fps is not allowed: convert to ${round(v)} fps${how}` : `the frame rate is ${vfr ? 'variable' : 'uneven'}: re-encode at a constant ${round(v)} fps${how}` };
  }
  report.verdict = (['fail', 'unknown', 'warn'] as const).find((s) => violations.some((v) => v.severity === s)) ?? 'pass';
  return report;
}
