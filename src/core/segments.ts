import { CUSUM_DRIFT, FREEZE_FACTOR, FREEZE_MIN_SEC, RATE_CHANGE_RELATIVE } from './stats.ts';
import type { RateAnomaly, RateAnomalyKind, RateProfile, RateSegmentKind } from './types.ts';

export type DeltaVisitor = (count: number, delta: number) => void;
export type DeltaSource = (visit: DeltaVisitor) => void;
export type RateProfileFn = (source: DeltaSource, timescale: number, frames: number, spanTicks: number) => RateProfile | null;

export const MIN_SEGMENT_SEC = 0.5;
export const MIN_SEGMENT_FRAMES = 5;
export const CUSUM_ALARM_PERIODS = 2;
export { FREEZE_FACTOR, FREEZE_MIN_SEC };
export const UNEVEN_DOMINANT_SHARE = 0.8;
export const MAX_SEGMENTS = 50;
export const MAX_ANOMALIES = 50;
export const MAX_BUCKETS = 120;

interface Span {
  t0: number;
  t1: number;
  n: number;
  sum: number;
  frames: number;
  ex: number;
  d: number;
  kind: RateSegmentKind | 'short' | 'hold';
}

const R = 1 + RATE_CHANGE_RELATIVE;

const num = (x: number): string => String(+x.toPrecision(4));

const span = (t0: number): Span => ({ t0, t1: t0, n: 0, sum: 0, frames: 0, ex: 0, d: 0, kind: 'steady' });

function join(a: Span, b: Span, rate: boolean): void {
  a.t0 = Math.min(a.t0, b.t0);
  a.t1 = Math.max(a.t1, b.t1);
  a.frames += b.frames;
  if (rate) {
    a.n += b.n;
    a.sum += b.sum;
    a.ex += b.ex;
  } else a.ex += b.t1 - b.t0;
}

export const rateProfile: RateProfileFn = (source, timescale, frames, spanTicks) => {
  const ts = timescale;
  const hold = FREEZE_MIN_SEC * ts;
  const rate = (s: Span): number => (ts * s.n) / s.sum;
  const isLong = (s: Span): boolean => s.n >= MIN_SEGMENT_FRAMES && s.t1 - s.t0 >= MIN_SEGMENT_SEC * ts;
  const out: Span[] = [];
  const emit = (s: Span): void => {
    const last = out[out.length - 1];
    if (isLong(s)) out.push(s);
    else if (last?.kind === 'short') join(last, s, true);
    else out.push({ ...s, kind: 'short' });
  };

  let cur = span(0);
  let mp = span(0);
  let mm = span(0);
  let t = 0;
  let seen = 0;
  let dup = 0;
  let gp = 0;
  let gm = 0;
  let held = false;
  const cut = (): void => {
    cur.t1 = t;
    if (held) out.push({ ...cur, kind: 'hold' });
    else emit(cur);
    cur = span(t);
    held = false;
    gp = gm = 0;
  };
  const nb = Math.min(MAX_BUCKETS, Math.floor(frames / 2));
  const bw = spanTicks / nb;
  const acc = new Float64Array(nb);
  const add = (k: number, d: number): void => {
    cur.n += k;
    cur.sum += k * d;
    cur.frames += k;
    t += k * d;
  };
  const visit = (count: number, d: number): void => {
    let c = count;
    if (d <= 0) {
      cur.frames += c;
      dup += c;
      return;
    }
    for (let p = t, e = p + c * d, b = Math.floor(p / bw); p < e && b < nb; b++) {
      const hi = Math.min(e, (b + 1) * bw);
      if (hi > p) acc[b] += (hi - p) / d;
      p = Math.max(p, hi);
    }
    while (c > 0) {
      const m = cur.sum / cur.n;
      if (cur.n && d >= Math.max(hold, FREEZE_FACTOR * m)) {
        cut();
        held = true;
        add(1, d);
        c--;
        continue;
      }
      if (held && Math.abs(d - m) > CUSUM_DRIFT * m) cut();
      held = false;
      if (!cur.n) {
        add(c, d);
        return;
      }
      const e = d - m;
      const k = CUSUM_DRIFT * m;
      const h = CUSUM_ALARM_PERIODS * m;
      const far = Math.abs(e) > k;
      const step = far ? 1 : c;
      if (far && (e > 0 ? !gp || e - k > h : !gm)) {
        const at = { ...cur, t1: t, d };
        if (e > 0) mp = at;
        else mm = at;
      }
      gp = Math.max(0, gp + step * (e - k));
      gm = Math.max(0, gm - step * (e + k));
      add(step, d);
      c -= step;
      if (gp > h || gm > h) {
        const a = gp > h ? mp : mm;
        const rest = cur.n - a.n - 1;
        if (rest > 0 && Math.abs(Math.log((a.d * a.n) / a.sum)) < Math.abs(Math.log((a.d * rest) / (cur.sum - a.sum - a.d)))) {
          a.t1 += a.d;
          a.n++;
          a.sum += a.d;
          a.frames++;
        }
        cur.t0 = a.t1;
        cur.n -= a.n;
        cur.sum -= a.sum;
        cur.frames -= a.frames;
        emit(a);
        gp = gm = 0;
      }
    }
  };
  let pc = 0;
  let pd = 0;
  source((c, d) => {
    if (!(c > 0)) return;
    seen += c;
    if (pc && d !== pd) {
      visit(pc, pd);
      pc = 0;
    }
    pc += c;
    pd = d;
  });
  if (pc) visit(pc, pd);
  if (!(t > 0)) return null;
  if (cur.n) cut();
  else out[out.length - 1].frames += cur.frames;

  const anomalies: RateAnomaly[] = [];
  const note = (kind: RateAnomalyKind, s: Span, from: number, to: number, dur = s.t1 - s.t0): void => {
    anomalies.push({ kind, atSec: s.t0 / ts, durationSec: dur / ts, fromFps: from, toFps: to });
  };
  const segs: Span[] = [];
  const dist = (x: Span | undefined, rs: number): number => (x ? Math.abs(Math.log(rate(x) / rs)) : Infinity);
  out.forEach((s, i) => {
    const p = segs[segs.length - 1];
    if (s.kind === 'short' || s.kind === 'hold') {
      const rs = rate(s);
      const r = out[i + 1]?.kind === 'steady' ? out[i + 1] : undefined;
      const target = dist(p, rs) <= dist(r, rs) ? p : r;
      s.kind = isLong(s) ? 'variable' : 'steady';
      if (s.kind === 'steady' && target) {
        const rt = rate(target);
        const kind: RateAnomalyKind | null =
          s.sum >= s.n * Math.max(hold, (FREEZE_FACTOR * target.sum) / target.n) ? 'freeze' : rs * R < rt ? 'gap' : rs > rt * R ? 'burst' : null;
        if (kind) note(kind, s, rt, rs);
        join(target, s, !kind);
        return;
      }
    }
    const q = p ? rate(s) / rate(p) : 0;
    if (p?.kind === 'steady' && s.kind === 'steady' && q < R && q * R > 1) join(p, s, true);
    else segs.push(s);
  });
  const last = segs[segs.length - 1];
  const end = t + last.sum / last.n;
  last.frames += frames - seen;
  last.t1 = end;
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1];
    const s = segs[i];
    const q = rate(s) / rate(p);
    if ((p.kind === 'steady' && s.kind === 'steady') || q >= R || q * R <= 1) note('rate-change', s, rate(p), rate(s), 0);
  }
  anomalies.sort((a, b) => a.atSec - b.atSec);

  const steady = segs
    .filter((s) => s.kind === 'steady')
    .map((s) => [rate(s), s.t1 - s.t0 - s.ex, s.n])
    .sort((a, b) => a[0] - b[0]);
  let bt = 0;
  let bn = 0;
  let wt = 0;
  let wn = 0;
  let lo = 0;
  for (const [r, x, n] of steady) {
    wt += x;
    wn += n;
    for (; r >= steady[lo][0] * R; lo++) {
      wt -= steady[lo][1];
      wn -= steady[lo][2];
    }
    bt = Math.max(bt, wt);
    bn = Math.max(bn, wn);
  }
  const share = bt / end;
  const uneven =
    share < UNEVEN_DOMINANT_SHARE || bn < UNEVEN_DOMINANT_SHARE * (seen - dup) || (steady.length > 1 && steady[steady.length - 1][0] >= steady[0][0] * R);
  const list = segs.slice(0, 3).map((s) => `${s.kind === 'variable' ? '~' : ''}${num(rate(s))} fps for ${num((s.t1 - s.t0) / ts)} s`);
  if (segs.length > 3) list.push(`+${segs.length - 3} more`);
  let tags = '';
  const tag = (c: number, k: string): void => {
    if (c) tags += `${tags ? ', ' : '; '}${c} ${k}${c > 1 ? 's' : ''}`;
  };
  for (const k of ['freeze', 'gap', 'burst']) tag(anomalies.filter((a) => a.kind === k).length, k);
  tag(dup, 'duplicate timestamp');

  return {
    segments: segs.slice(0, MAX_SEGMENTS).map((s) => ({ startSec: s.t0 / ts, endSec: s.t1 / ts, frames: s.frames, fps: rate(s), kind: s.kind as RateSegmentKind })),
    moreSegments: Math.max(0, segs.length - MAX_SEGMENTS),
    anomalies: anomalies.slice(0, MAX_ANOMALIES),
    moreAnomalies: Math.max(0, anomalies.length - MAX_ANOMALIES),
    buckets: { bucketSec: bw / ts, fps: Array.from(acc, (x) => (x * ts) / bw) },
    uneven,
    dominantShare: share,
    summary: `${uneven ? 'Uneven' : tags ? 'Mostly steady' : 'Steady'}: ${list.join(', ')}${tags}`,
  };
};
