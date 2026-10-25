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

export interface FrameSizeRule {
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
  frameSize?: FrameSizeRule;
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
  value: number | null;
  reason: string;
}

export interface CheckReport {
  verdict: CheckVerdict;
  violations: CheckViolation[];
  suggestedFps?: SuggestedFps;
}

type Q = readonly [bigint, bigint];
type Bound = 'min' | 'max' | 'exact' | 'oneOf';
type Text = string | ((against: readonly Q[]) => string);

const UNEVEN_SPREAD = 1.075;
const DECIMATE_FROM: Q = [3n, 2n];
const SPAN_SLACK_MS = 3n;
const NOMINAL_SLACK_PER_S = 10_000_000n;
const NTSC = [24n, 30n, 48n, 60n, 120n];
const STANDARD: Q[] = [...[24n, 25n, 30n, 48n, 50n, 60n, 100n, 120n].map((m): Q => [m, 1n]), ...NTSC.map((m): Q => [m * 1000n, 1001n])];
const RELATION: Record<Bound, string> = { min: 'below the minimum', max: 'above the maximum', exact: 'not', oneOf: 'not one of' };
const BOUNDS = Object.keys(RELATION) as Bound[];
const GROUPS = ['fps', 'duration', 'frameSize', 'aspectRatio', 'pixels', 'fileSize'] as const;
const POLICIES: readonly RatePolicy[] = ['allow', 'warn', 'reject'];
const SOURCES: readonly FpsSource[] = ['avg', 'ffprobe', 'nominal', 'dominant'];
const AUDIO_ENGINES: readonly string[] = ['own', 'mp4box', 'mediabunny'];
const RANGE = ['min', 'max'];
const GROUP_KEYS: Record<(typeof GROUPS)[number], readonly string[]> = {
  fps: [...RANGE, 'exact', 'oneOf', 'source'],
  duration: RANGE,
  frameSize: ['Width', 'Height', 'ShortSide', 'LongSide'].flatMap((side) => RANGE.map((b) => b + side)),
  aspectRatio: [...RANGE, 'oneOf'],
  pixels: RANGE,
  fileSize: RANGE,
};
const RULE_KEYS: readonly string[] = [...GROUPS, 'containers', 'codecs', 'audio', 'vfr', 'uneven', 'severity'];

const invalid = (rule: string, v: unknown, what: string): never => {
  throw new TypeError(`${rule}: ${typeof v === 'number' ? v : JSON.stringify(v)} is not ${what}`);
};

function decimal(s: string): Q | null {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s.trim());
  if (!m) return null;
  const e = Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  const n = BigInt(m[1]! + (m[2] ?? ''));
  return e >= 0 ? [n * 10n ** BigInt(e), 1n] : [n, 10n ** BigInt(-e)];
}

function ratio(v: unknown, rule: string, amount = false): Q {
  const parts = typeof v === 'number' || typeof v === 'string' ? String(v).split(/[/:]/) : [];
  const [a, b] = parts.map(decimal);
  const q: Q | null = a && parts.length === 1 ? a : a && b && parts.length === 2 && !amount ? [a[0] * b[1], a[1] * b[0]] : null;
  const ratios = parts.length > 1 ? "; 'num/den' and 'num:den' ratios are for fps and aspectRatio" : '';
  return q && q[1] !== 0n ? q : invalid(rule, v, amount ? `a non-negative number${ratios}` : "a non-negative number or 'num/den'");
}

const cmp = (a: Q, b: Q): bigint => a[0] * b[1] - b[0] * a[1];

const ntsc = (v: unknown, q: Q): Q[] => (/[/:]/.test(String(v)) ? [] : NTSC.filter((m) => q[0] * 1000n === q[1] * m * 999n).map((m): Q => [m * 1000n, 1001n]));

const readings = (v: unknown, rule: string): Q[] => {
  const q = ratio(v, rule);
  return [q, ...ntsc(v, q)];
};

function close(n: bigint, a: Q, b: Q, slack: bigint, perSecond: bigint): boolean {
  const gap = n * (a[1] * b[0] - b[1] * a[0]);
  return (gap < 0n ? -gap : gap) * perSecond <= slack * a[0] * b[0];
}

const whole = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function primaryTrack(result: FileResult): VideoTrackResult | string {
  const list: unknown = result.videoTracks;
  const id: unknown = result.primaryTrackId;
  if (!Array.isArray(list)) return 'the result has no videoTracks list';
  if (list.length === 0) return 'no video track';
  const track: unknown = list.find((x) => record(x) && typeof id === 'number' && x.trackId === id);
  return (track as VideoTrackResult) || `no primary track: primaryTrackId ${id === undefined ? 'is missing' : `${JSON.stringify(id)} matches no video track`}`;
}

const fromRational = (r: Pick<Rational, 'num' | 'den'> | null | undefined): Q | null => (r && whole(r.num) && whole(r.den) ? [BigInt(r.num), BigInt(r.den)] : null);

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

const value = (q: Q): number => Number(q[0]) / Number(q[1]);

const round = (x: number): number => +x.toFixed(3);

function digits(q: Q, against: readonly Q[]): number {
  let d = 3;
  while (d < 12 && against.some((b) => value(b).toFixed(d) === value(q).toFixed(d))) d++;
  return +value(q).toFixed(d);
}

function fraction(q: Q): string {
  const g = gcd(q[0], q[1]) || 1n;
  return `${q[0] / g}/${q[1] / g}`;
}

const fpsText = (q: Q, against: readonly Q[] = []): string => (q[0] % q[1] === 0n ? `${q[0] / q[1]}` : `${digits(q, against)} (${fraction(q)})`);

function steady(t: VideoTrackResult): readonly [Q, Q] | null {
  const avg = fromRational(t.avgFps);
  const nominal = fromRational(t.nominalFps);
  const frames = t.presentedFrames ?? t.frames;
  if (!avg || !nominal || !t.timestampsQuantized || t.isVfr !== false || !whole(frames)) return null;
  const n = BigInt(frames);
  return close(n, avg, nominal, SPAN_SLACK_MS, 1000n) ? [nominal, [n * nominal[1], nominal[0]]] : null;
}

function resolution(t: VideoTrackResult, cfr: readonly [Q, Q] | null): ((x: Q) => boolean) | undefined {
  const avg = fromRational(t.avgFps);
  const frames = t.presentedFrames ?? t.frames;
  if (!avg || !t.timestampsQuantized || t.isVfr !== false || !whole(frames)) return undefined;
  return cfr ? (x) => close(1n, cfr[0], x, 1n, NOMINAL_SLACK_PER_S) : (x) => close(BigInt(frames), avg, x, SPAN_SLACK_MS, 1000n);
}

function judgedFps(t: VideoTrackResult, source: FpsSource | undefined, cfr: readonly [Q, Q] | null): Q | null {
  const m = /^(\d+)\/(\d+)$/.exec(t.avgFpsFfprobe ?? '');
  if (source === 'ffprobe') return m && fromRational({ num: +m[1]!, den: +m[2]! });
  if (source === 'nominal') return fromRational(t.nominalFps);
  if (source === 'dominant') return fromRational(t.dominantFps?.rate ?? (t.isVfr === false ? t.nominalFps : null));
  return cfr?.[0] ?? fromRational(t.avgFps);
}

function unevenOf(t: VideoTrackResult): unknown {
  const p: unknown = t.rateProfile;
  if (p != null) return record(p) ? p.uneven : null;
  return t.isVfr === false || (t.minFps && t.maxFps && t.maxFps.value <= t.minFps.value * UNEVEN_SPREAD) ? false : null;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

function fit(target: Q, rule: FpsRule = {}): readonly [Q, number] | null {
  const list = (v: unknown): Q[] => (v == null ? [] : [v].flat().flatMap((x) => readings(x, 'fps')));
  const [lo] = list(rule.min);
  const hi = list(rule.max).reduce<Q | undefined>((a, q) => (a && cmp(a, q) > 0 ? a : q), undefined);
  const inside = (q: Q): boolean => (!lo || cmp(q, lo) >= 0) && (!hi || cmp(q, hi) <= 0);
  const nearer = (a: Q, b: Q): bigint => abs(cmp(a, target)) * b[1] - abs(cmp(b, target)) * a[1] || cmp(a, b);
  const nearest = (qs: Q[]): Q | null => qs.filter(inside).reduce<Q | null>((b, q) => (b && nearer(b, q) <= 0n ? b : q), null);
  const divided = (keep: (q: Q) => boolean): readonly [Q, number] | undefined => {
    for (let k = 2n; k <= 8n; k++) {
      const q: Q = [target[0], target[1] * k];
      if (keep(q)) return [q, Number(k)];
    }
  };
  const oneOf = rule.oneOf == null ? null : list(rule.oneOf);
  const named = rule.exact == null ? oneOf : list(rule.exact).filter((q) => !oneOf || oneOf.some((o) => cmp(o, q) === 0n));
  if (named) {
    const best = nearest(named);
    return best && [best, 0];
  }
  if (lo && hi && cmp(lo, hi) > 0) return null;
  if (inside(target)) return [target, 0];
  const standard = nearest(STANDARD);
  if (standard) return divided((q) => STANDARD.some((s) => inside(s) && cmp(s, q) === 0n)) ?? [standard, 0];
  if (lo && cmp(target, lo) < 0) return [lo, 0];
  const top = hi!;
  const under = cmp(target, [DECIMATE_FROM[0] * top[0], DECIMATE_FROM[1] * top[1]]) >= 0 ? divided((q) => cmp(q, top) <= 0) : undefined;
  return under && !(lo && cmp(under[0], lo) < 0) ? under : [top, 0];
}

export function check(result: FileResult | null | undefined, rules: CheckRules): CheckReport {
  const known = (path: string, v: unknown, keys: readonly string[]): void => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(path, v, 'an object');
    const prefix = path === 'rules' ? '' : `${path}.`;
    for (const k of Object.keys(v as object)) if (!keys.includes(k)) throw new TypeError(`${prefix}${k}: not a rule; expected one of ${keys.join(', ')}`);
  };
  known('rules', rules, RULE_KEYS);
  for (const g of GROUPS) if (rules[g] != null) known(g, rules[g], GROUP_KEYS[g]);
  const choices: Array<[string, unknown, readonly string[]]> = [
    ['fps.source', rules.fps?.source, SOURCES],
    ['audio', rules.audio, ['required', 'forbidden']],
    ['vfr', rules.vfr, POLICIES],
    ['uneven', rules.uneven, POLICIES],
    ['severity', rules.severity, ['fail', 'warn']],
  ];
  for (const [rule, v, list] of choices) if (v != null && !list.includes(v as string)) invalid(rule, v, `one of ${list.join(', ')}`);
  const violations: CheckViolation[] = [];
  const severity = rules.severity === 'warn' ? 'warn' : 'fail';
  const failure = result == null ? 'the analysis failed: no result' : result.error ? `the analysis failed: ${result.error}` : null;
  const found = failure ?? primaryTrack(result!);
  const t = typeof found === 'string' ? null : found;
  const add = (rule: string, s: CheckSeverity, expected: CheckExpected, actual: number | string | boolean | null, message: string): number =>
    violations.push({ rule, severity: s, expected, actual, message: `${rule}: ${message}` });
  const unknown = (rule: string, missing: string): unknown =>
    violations.some((v) => v.rule === rule) ||
    add(rule, 'unknown', null, null, `unknown, ${t || rule === 'fileSize' || rule === 'containers' ? `no ${missing}${failure ? `; ${failure}` : ''}` : found}`);

  const limits = (
    group: string,
    rule: Partial<Record<Bound, RatioValue | readonly RatioValue[]>> | undefined,
    actual: Q | null,
    shown: number | string,
    text: Text,
    unit: string,
    missing: string,
    side = '',
    near?: (q: Q) => boolean,
  ): void => {
    const bounds = BOUNDS.filter((b) => rule?.[b] != null).map((b) => {
      const path = `${group}.${b}${side}`;
      return [b, rule![b]!, (b === 'oneOf' ? [rule![b]!].flat() : [rule![b]!]).map((v) => (group === 'fps' ? readings(v, path) : [ratio(v, path, group !== 'aspectRatio')]))] as const;
    });
    if (bounds.length === 0) return;
    if (!actual) return void unknown(group, missing);
    for (const [b, expected, values] of bounds) {
      const meets = (q: Q): boolean | undefined => near?.(q) || (b === 'min' ? cmp(actual, q) >= 0n : b === 'max' ? cmp(actual, q) <= 0n : cmp(actual, q) === 0n);
      const listed = [expected].flat();
      const named = listed.length ? `${listed.join(', ')}${unit}` : 'an empty list';
      const actualText = typeof text === 'string' ? text : text(values.flat());
      if (!values.flat().some(meets)) add(`${group}.${b}${side}`, severity, expected, shown, `${actualText}${unit} is ${RELATION[b]} ${named}`);
    }
  };
  const quantity = (x: number | null | undefined): Q | null => (typeof x === 'number' ? decimal(String(x)) : null);
  const allow = (rule: 'containers' | 'codecs', list: readonly string[] | undefined, actual: unknown, missing: string): void => {
    if (list == null) return;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) invalid(rule, list, 'a list of strings');
    if (typeof actual !== 'string' || !actual || actual === 'unknown') unknown(rule, missing);
    else if (!list.some((x) => x.toLowerCase() === actual.toLowerCase())) add(rule, severity, list, actual, `${actual} is not one of ${list.length ? list.join(', ') : 'an empty list'}`);
  };
  const policy = (rule: 'vfr' | 'uneven', state: unknown, missing: string, message: string): boolean => {
    const p = rules[rule];
    if (!p || p === 'allow') return false;
    if (typeof state !== 'boolean') unknown(rule, missing);
    else if (state) add(rule, p === 'warn' ? 'warn' : severity, p, true, message);
    return state === true;
  };

  const cfr = t && steady(t);
  const fps = t && judgedFps(t, rules.fps?.source, cfr);
  const near = t && (rules.fps?.source ?? 'avg') === 'avg' ? resolution(t, cfr) : undefined;
  limits('fps', rules.fps, fps, fps ? fraction(fps) : '', (against) => fpsText(fps!, against), ' fps', `${rules.fps?.source ?? 'avg'} frame rate`, '', near);
  const exact = cfr?.[1] ?? quantity(t && (t.durationSec ?? result!.formatDurationSec));
  const span: Q | null = exact && [(exact[0] * 2_000_000n + exact[1]) / (2n * exact[1]), 1_000_000n];
  const seconds = span ? value(span) : 0;
  limits('duration', rules.duration, span, seconds, (against) => `${digits(span!, against)}`, ' s', 'duration');

  const size = t ? (Math.abs(t.rotation) % 180 === 90 ? [t.height, t.width] : [t.width, t.height]) : [0, 0];
  const sized = size.every(whole);
  const [w, h] = sized ? size : [0, 0];
  const sides = { Width: w, Height: h, ShortSide: Math.min(w, h), LongSide: Math.max(w, h) };
  const d = rules.frameSize as Record<string, RatioValue | undefined> | undefined;
  for (const [side, x] of Object.entries(sides)) {
    limits('frameSize', { min: d?.[`min${side}`], max: d?.[`max${side}`] }, sized ? [BigInt(x), 1n] : null, x, `${x}`, ' px', 'frame size', side);
  }
  const area: Q = [BigInt(w), BigInt(h)];
  limits('aspectRatio', rules.aspectRatio, sized ? area : null, fraction(area), `${w}x${h} (${round(w / h)})`, '', 'frame size');
  limits('pixels', rules.pixels, sized ? [BigInt(w) * BigInt(h), 1n] : null, w * h, `${w * h}`, ' px', 'frame size');
  limits('fileSize', rules.fileSize, quantity(result?.size), result?.size ?? '', `${result?.size}`, ' bytes', 'file size');
  allow('containers', rules.containers, result?.container, 'container');
  allow('codecs', rules.codecs, t?.codecName, 'codec name');
  if (rules.audio) {
    const engine: unknown = result?.engine;
    const counts = AUDIO_ENGINES.includes(engine as string);
    const n = result?.audioTrackCount;
    const audio = t && counts && Number.isSafeInteger(n) && n! >= 0 ? n! > 0 : null;
    const required = rules.audio === 'required';
    if (audio === null) unknown('audio', `audio track count${!counts && typeof engine === 'string' ? ` (the ${engine} engine reports none)` : ''}`);
    else if (audio !== required) add('audio', severity, rules.audio, audio, `${rules.audio}, the file has ${required ? 'no' : 'an'} audio track`);
  }
  const vfr = policy('vfr', t?.isVfr, 'VFR flag', 'the frame rate is variable');
  const profile: unknown = t?.rateProfile;
  const summary = record(profile) && typeof profile.summary === 'string' ? `: ${profile.summary}` : '';
  const uneven = policy('uneven', t && unevenOf(t), `${profile == null ? '' : 'uneven flag in the '}rate profile`, `the frame rate is uneven${summary}`);

  const report: CheckReport = { verdict: 'pass', violations };
  const fpsOff = violations.some((v) => v.rule.startsWith('fps.'));
  if (t && (fpsOff || vfr || uneven)) {
    const constant = fpsOff ? fps : (fromRational(t.dominantFps?.rate) ?? fromRational(t.nominalFps));
    const avg = Math.round(t.avgFps?.value ?? 0);
    const fitted = fit(constant ?? [whole(avg) ? BigInt(avg) : 0n, 1n], rules.fps);
    const why = fpsOff ? `${fpsText(fps!, fitted ? [fitted[0]] : [])} fps is not allowed` : `the frame rate is ${vfr ? 'variable' : 'uneven'}`;
    if (!fitted) report.suggestedFps = { value: null, reason: `${why}, and no frame rate meets every bound of the fps rule` };
    else if (fitted[0][0] > 0n) {
      const [q, k] = fitted;
      const how = k > 1 ? `, which keeps 1 of every ${k} frames` : '';
      report.suggestedFps = { value: value(q), reason: `${why}: ${fpsOff ? 'convert to' : 're-encode at a constant'} ${fpsText(q)} fps${how}` };
    }
  }
  report.verdict = (['fail', 'unknown', 'warn'] as const).find((s) => violations.some((v) => v.severity === s)) ?? 'pass';
  return report;
}
