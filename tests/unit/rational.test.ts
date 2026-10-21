import { describe, expect, it } from 'vitest';
import {
  INT_MAX,
  avReduce,
  avgFrameRate,
  exactRatio,
  parseRational,
  reduceRational,
  toDecimal,
  toFfprobeString,
} from '../../src/core/rational.ts';

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

describe('avReduce (port of FFmpeg av_reduce)', () => {
  it('reduces stts 999999x1001 + 4x997 at timescale 30000 to 807689923/26949920 (spec 2.1)', () => {
    const n = 999_999 + 4;
    const d = 999_999 * 1001 + 4 * 997;
    const r = avReduce(30000n * BigInt(n), d, INT_MAX);
    expect([r.num, r.den]).toEqual([807689923, 26949920]);
    expect(r.exact).toBe(false);
    expect(toFfprobeString(avgFrameRate(30000, n, d))).toBe('807689923/26949920');
  });

  it.each([
    [16683333, '19001/317'],
    [33366666, '30000/1001'],
    [41708333, '24000/1001'],
  ])('Matroska av_reduce(1e9, %i, 30000) = %s', (defaultDuration, expected) => {
    const r = avReduce(1_000_000_000, defaultDuration, 30000);
    expect(`${r.num}/${r.den}`).toBe(expected);
  });

  it('divides by the gcd when the result fits', () => {
    expect(avReduce(6, 4)).toEqual({ num: 3, den: 2, exact: true });
    expect(avReduce(30000 * 90, 90 * 1001)).toEqual({ num: 30000, den: 1001, exact: true });
  });

  it('keeps the sign like FFmpeg', () => {
    expect(avReduce(-6, 4)).toEqual({ num: -3, den: 2, exact: true });
    expect(avReduce(6, -4)).toEqual({ num: -3, den: 2, exact: true });
    expect(avReduce(-6, -4)).toEqual({ num: 3, den: 2, exact: true });
  });

  it('handles zero inputs', () => {
    expect(avReduce(0, 5)).toEqual({ num: 0, den: 1, exact: true });
    expect(avReduce(5, 0)).toEqual({ num: 1, den: 0, exact: true });
    expect(avReduce(0, 0)).toEqual({ num: 0, den: 0, exact: true });
  });

  it('always returns a reduced fraction within max', () => {
    const cases: Array<[bigint, bigint, number]> = [
      [10n ** 18n, 3n, INT_MAX],
      [3n, 10n ** 18n, INT_MAX],
      [123456789012345n, 987654321n, INT_MAX],
      [1_000_000_000n, 16683333n, 30000],
      [2n ** 62n - 1n, 2n ** 61n + 7n, 1000],
    ];
    for (const [n, d, max] of cases) {
      const r = avReduce(n, d, max);
      expect(Math.abs(r.num)).toBeLessThanOrEqual(max);
      expect(r.den).toBeLessThanOrEqual(max);
      expect(gcd(Math.abs(r.num), r.den)).toBeLessThanOrEqual(1);
      const exactValue = Number(n) / Number(d);
      if (exactValue > 10 / max && exactValue < max / 10) {
        expect(Math.abs(r.num / r.den - exactValue) / exactValue).toBeLessThan(1e-3);
      }
    }
  });

  it('accepts bigint inputs above 2^53 and rejects unsafe numbers', () => {
    const big = 2n ** 60n;
    expect(avReduce(big * 30000n, big * 1001n)).toEqual({ num: 30000, den: 1001, exact: true });
    expect(() => avReduce(2 ** 60, 3)).toThrow(RangeError);
  });
});

describe('rational helpers', () => {
  it('avgFrameRate returns null (0/0) when N or D is 0', () => {
    expect(avgFrameRate(30000, 0, 1001)).toBeNull();
    expect(avgFrameRate(30000, 90, 0)).toBeNull();
    expect(toFfprobeString(avgFrameRate(30000, 0, 0))).toBe('0/0');
  });

  it('avgFrameRate uses BigInt for ts * N above 2^53', () => {
    const r = avgFrameRate(90000, 2 ** 40, 3000 * 2 ** 40);
    expect(r).toMatchObject({ num: 30, den: 1, value: 30 });
  });

  it('formats and parses ffprobe strings', () => {
    expect(toFfprobeString({ num: 30000, den: 1001 })).toBe('30000/1001');
    expect(toFfprobeString(null)).toBe('0/0');
    expect(parseRational('24000/1001')).toEqual({ num: 24000, den: 1001 });
    expect(parseRational('0/0')).toEqual({ num: 0, den: 0 });
    expect(parseRational('N/A')).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });

  it('toDecimal returns 0 for a zero denominator', () => {
    expect(toDecimal({ num: 0, den: 0 })).toBe(0);
    expect(toDecimal({ num: 30000, den: 1001 })).toBeCloseTo(29.97003, 5);
  });

  it('exactRatio and reduceRational fill value', () => {
    expect(exactRatio(90000, 3000)).toEqual({ num: 30, den: 1, value: 30 });
    expect(exactRatio(1000, -34)).toEqual({ num: -500, den: 17, value: -500 / 17 });
    expect(reduceRational(60000, 1001)).toEqual({ num: 60000, den: 1001, value: 60000 / 1001 });
  });
});
