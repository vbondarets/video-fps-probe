import type { Rational } from './types.ts';

export const INT_MAX = 2147483647;

export interface ReducedRational {
  num: number;
  den: number;
  exact: boolean;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function gcdBig(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function toBig(v: bigint | number, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (!Number.isSafeInteger(v)) throw new RangeError(`${what} must be a safe integer, got ${v}`);
  return BigInt(v);
}

export function avReduce(num: bigint | number, den: bigint | number, max: bigint | number = INT_MAX): ReducedRational {
  let n = toBig(num, 'num');
  let d = toBig(den, 'den');
  const m = toBig(max, 'max');
  let a0n = 0n;
  let a0d = 1n;
  let a1n = 1n;
  let a1d = 0n;
  const negative = n < 0n !== d < 0n;
  const g = gcdBig(absBig(n), absBig(d));
  if (g !== 0n) {
    n = absBig(n) / g;
    d = absBig(d) / g;
  }
  if (n <= m && d <= m) {
    a1n = n;
    a1d = d;
    d = 0n;
  }
  while (d !== 0n) {
    let x = n / d;
    const nextDen = n - d * x;
    const a2n = x * a1n + a0n;
    const a2d = x * a1d + a0d;
    if (a2n > m || a2d > m) {
      if (a1n !== 0n) x = (m - a0n) / a1n;
      if (a1d !== 0n) {
        const xd = (m - a0d) / a1d;
        if (xd < x) x = xd;
      }
      if (d * (2n * x * a1d + a0d) > n * a1d) {
        a1n = x * a1n + a0n;
        a1d = x * a1d + a0d;
      }
      break;
    }
    a0n = a1n;
    a0d = a1d;
    a1n = a2n;
    a1d = a2d;
    n = d;
    d = nextDen;
  }
  const outNum = Number(a1n);
  return { num: negative ? -outNum : outNum, den: Number(a1d), exact: d === 0n };
}

export function toDecimal(r: { num: number; den: number }): number {
  return r.den === 0 ? 0 : r.num / r.den;
}

export function toFfprobeString(r: { num: number; den: number } | null): string {
  return r ? `${r.num}/${r.den}` : '0/0';
}

export function makeRational(num: number, den: number): Rational {
  return { num, den, value: toDecimal({ num, den }) };
}

export function reduceRational(num: bigint | number, den: bigint | number, max: bigint | number = INT_MAX): Rational {
  const r = avReduce(num, den, max);
  return makeRational(r.num, r.den);
}

export function exactRatio(num: number, den: number): Rational {
  if (Number.isSafeInteger(num) && Number.isSafeInteger(den) && den !== 0) {
    const g = Number(gcdBig(absBig(BigInt(num)), absBig(BigInt(den))));
    const sign = den < 0 ? -1 : 1;
    return makeRational((sign * num) / g, (sign * den) / g);
  }
  return makeRational(num, den);
}

export function avgFrameRate(timescale: number, sampleCount: number, durationSum: number): Rational | null {
  if (sampleCount <= 0 || durationSum <= 0 || timescale <= 0) return null;
  return reduceRational(BigInt(timescale) * BigInt(sampleCount), durationSum, INT_MAX);
}

export function parseRational(s: string | null | undefined): { num: number; den: number } | null {
  if (!s) return null;
  const m = /^(-?\d+)\/(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { num: Number(m[1]), den: Number(m[2]) };
}
