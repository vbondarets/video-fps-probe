export type Ratio = [num: bigint, den: bigint];

export const INT_MAX = 2147483647n;

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

export function avReduce(num: bigint, den: bigint, max: bigint): Ratio {
  let a0: Ratio = [0n, 1n];
  let a1: Ratio = [1n, 0n];
  const negative = num < 0n !== den < 0n;
  const g = gcd(abs(num), abs(den));
  if (g) {
    num = abs(num) / g;
    den = abs(den) / g;
  }
  if (num <= max && den <= max) {
    a1 = [num, den];
    den = 0n;
  }
  while (den) {
    let x = num / den;
    const nextDen = num - den * x;
    const a2n = x * a1[0] + a0[0];
    const a2d = x * a1[1] + a0[1];
    if (a2n > max || a2d > max) {
      if (a1[0]) x = (max - a0[0]) / a1[0];
      if (a1[1]) x = x < (max - a0[1]) / a1[1] ? x : (max - a0[1]) / a1[1];
      if (den * (2n * x * a1[1] + a0[1]) > num * a1[1]) a1 = [x * a1[0] + a0[0], x * a1[1] + a0[1]];
      break;
    }
    a0 = a1;
    a1 = [a2n, a2d];
    num = den;
    den = nextDen;
  }
  return [negative ? -a1[0] : a1[0], a1[1]];
}

function binaryExponent(v: number): number {
  if (v === 0) return 0;
  let e = Math.floor(Math.log2(v));
  while (2 ** e > v) e--;
  while (2 ** (e + 1) <= v) e++;
  return e;
}

export function avD2q(d: number, max: bigint): Ratio {
  if (Number.isNaN(d)) return [0n, 0n];
  if (Math.abs(d) > Number(INT_MAX) + 3) return [d < 0 ? -1n : 1n, 0n];
  const exponent = Math.max(binaryExponent(Math.abs(d)), 0);
  const den = 1n << BigInt(61 - exponent);
  const num = BigInt(Math.floor(d * Number(den) + 0.5));
  return avReduce(num, den, max);
}
