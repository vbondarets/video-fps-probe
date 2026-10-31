import { isoConfigFacts, matroskaConfigFacts } from '../color/codec-string.ts';
import {
  boxPayload,
  elementUint,
  i32,
  ID_DISPLAY_HEIGHT,
  ID_DISPLAY_UNIT,
  ID_DISPLAY_WIDTH,
  ID_PIXEL_HEIGHT,
  ID_PIXEL_WIDTH,
  ID_STEREO_MODE,
  isoConfig,
  matroskaConfig,
  u32,
  type IsoConfig,
  type MatroskaConfig,
} from '../color/config.ts';
import type { CodecConfig, FileResult, Rational, VideoTrackResult } from '../core/types.ts';

export type { CodecConfig, Rational } from '../core/types.ts';

export interface AspectInfo {
  sampleAspectRatio: Rational | null;
  displayAspectRatio: Rational | null;
  displayWidth: number | null;
  displayHeight: number | null;
}

export type AspectTrack = Pick<VideoTrackResult, 'codecName' | 'width' | 'height' | 'rotation' | 'codecConfig'>;

type Ratio = [num: bigint, den: bigint];

const INT_MAX = 2147483647n;
const DAR_MAX = 1048576n;
const MATRIX_SCALE_LIMIT = 1 << 24;
const MATRIX_SCALE_TOLERANCE = 0.01;
const DISPLAY_UNIT_UNKNOWN = 4;
const WIDTH_TIMES_TWO = new Set([1, 8, 9, 11]);
const HEIGHT_TIMES_TWO = new Set([2, 3, 6, 7]);

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

function avD2q(d: number, max: bigint): Ratio {
  if (Number.isNaN(d)) return [0n, 0n];
  if (Math.abs(d) > Number(INT_MAX) + 3) return [d < 0 ? -1n : 1n, 0n];
  const exponent = Math.max(binaryExponent(Math.abs(d)), 0);
  const den = 1n << BigInt(61 - exponent);
  const num = BigInt(Math.floor(d * Number(den) + 0.5));
  return avReduce(num, den, max);
}

function rational([num, den]: Ratio): Rational {
  return { num: Number(num), den: Number(den), value: Number(num) / Number(den) };
}

const valid = (r: Ratio | null): r is Ratio => r !== null && r[0] > 0n && r[1] > 0n;

function matrixOf(box: Uint8Array | null, offset: (version: number) => number): bigint[] | null {
  const p = boxPayload(box);
  if (!box || !p) return null;
  const at = p.start + offset(box[p.start]);
  if (at + 36 > p.end) return null;
  return Array.from({ length: 9 }, (_, i) => BigInt(i32(box, at + i * 4)));
}

function matrixRatio(iso: IsoConfig): Ratio | null {
  const tkhd = boxPayload(iso.tkhd);
  if (!iso.tkhd || !tkhd) return null;
  const v1 = iso.tkhd[tkhd.start] === 1;
  const sizeAt = tkhd.start + (v1 ? 88 : 76);
  if (sizeAt + 8 > tkhd.end || !u32(iso.tkhd, sizeAt) || !u32(iso.tkhd, sizeAt + 4)) return null;
  const track = matrixOf(iso.tkhd, (v) => (v === 1 ? 52 : 40));
  if (!track) return null;
  const movie = matrixOf(iso.mvhd, (v) => (v === 1 ? 48 : 36)) ?? Array<bigint>(9).fill(0n);
  const shift = [16n, 16n, 30n];
  const m: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0n;
      for (let e = 0; e < 3; e++) sum += (track[i * 3 + e] * movie[e * 3 + j]) >> shift[e];
      m.push(Number(BigInt.asIntN(32, sum)));
    }
  }
  const identity = m[0] === 65536 && m[4] === 65536 && m[8] === 1 << 30 && !m[1] && !m[2] && !m[3] && !m[5] && !m[6] && !m[7];
  if (identity) return null;
  const x = Math.hypot(m[0], m[3]);
  const y = Math.hypot(m[1], m[4]);
  if (!(x > 1 && y > 1 && x < MATRIX_SCALE_LIMIT && y < MATRIX_SCALE_LIMIT && Math.abs(x / y - 1) > MATRIX_SCALE_TOLERANCE)) return null;
  return avD2q(x / y, INT_MAX);
}

function isoRatio(track: AspectTrack, iso: IsoConfig): Ratio | null {
  let sar = matrixRatio(iso);
  for (const entry of iso.entries) {
    for (const c of entry.children) {
      if (c.type !== 'pasp' || c.end - c.start < 8) continue;
      const den = i32(iso.bytes, c.start + 4);
      if (den !== 0) sar = avReduce(BigInt(i32(iso.bytes, c.start)), BigInt(den), INT_MAX);
    }
  }
  if (!sar || !sar[0]) {
    const tkhd = boxPayload(iso.tkhd);
    const sizeAt = iso.tkhd && tkhd ? tkhd.start + (iso.tkhd[tkhd.start] === 1 ? 88 : 76) : -1;
    if (iso.tkhd && tkhd && sizeAt + 8 <= tkhd.end) {
      const w = BigInt(u32(iso.tkhd, sizeAt) >>> 16);
      const h = BigInt(u32(iso.tkhd, sizeAt + 4) >>> 16);
      const sw = BigInt(track.width);
      const sh = BigInt(track.height);
      if (w && h && sw && sh && (sw !== w || sh !== h)) sar = avReduce(sh * w, sw * h, INT_MAX);
    }
  }
  if (valid(sar)) return sar;
  const vui = iso.entries[0] ? isoConfigFacts(track.codecName, iso.bytes, iso.entries[0])?.sps?.vui?.sar : null;
  return vui ? avReduce(BigInt(vui[0]), BigInt(vui[1]), INT_MAX) : null;
}

function matroskaRatio(track: AspectTrack, mkv: MatroskaConfig): Ratio | null {
  const b = mkv.bytes;
  const unit = elementUint(b, mkv.video.get(ID_DISPLAY_UNIT)) ?? 0;
  let sar: Ratio | null = null;
  if (unit < DISPLAY_UNIT_UNKNOWN) {
    const pixelWidth = elementUint(b, mkv.video.get(ID_PIXEL_WIDTH)) ?? 0;
    const pixelHeight = elementUint(b, mkv.video.get(ID_PIXEL_HEIGHT)) ?? 0;
    const dw = elementUint(b, mkv.video.get(ID_DISPLAY_WIDTH)) ?? (unit === 0 ? pixelWidth : null);
    const dh = elementUint(b, mkv.video.get(ID_DISPLAY_HEIGHT)) ?? (unit === 0 ? pixelHeight : null);
    const stereo = elementUint(b, mkv.video.get(ID_STEREO_MODE)) ?? 0;
    if (dw && dh) {
      const wmul = WIDTH_TIMES_TWO.has(stereo) ? 2n : 1n;
      const hmul = HEIGHT_TIMES_TWO.has(stereo) ? 2n : 1n;
      sar = avReduce(BigInt(track.height) * BigInt(dw) * wmul, BigInt(track.width) * BigInt(dh) * hmul, INT_MAX);
    }
  }
  if (valid(sar)) return sar;
  const vui = matroskaConfigFacts(mkv.codecId, b, mkv.codecPrivate)?.sps?.vui?.sar;
  return vui ? avReduce(BigInt(vui[0]), BigInt(vui[1]), INT_MAX) : null;
}

function sampleRatio(track: AspectTrack, config: CodecConfig): Ratio | null {
  const iso = isoConfig(config);
  if (iso) return isoRatio(track, iso);
  const mkv = matroskaConfig(config);
  return mkv ? matroskaRatio(track, mkv) : null;
}

export function aspectOf(track: AspectTrack): AspectInfo | undefined {
  const config = track.codecConfig;
  if (!config) return undefined;
  const sar = sampleRatio(track, config);
  const usable = valid(sar) ? sar : null;
  const { width, height } = track;
  if (width <= 0 || height <= 0) return { sampleAspectRatio: usable && rational(usable), displayAspectRatio: null, displayWidth: null, displayHeight: null };
  const [num, den] = usable ?? [1n, 1n];
  const storedWidth = Number((2n * BigInt(width) * num + den) / (2n * den));
  const swap = Math.abs(track.rotation) % 180 === 90;
  return {
    sampleAspectRatio: usable && rational(usable),
    displayAspectRatio: usable && rational(avReduce(BigInt(width) * num, BigInt(height) * den, DAR_MAX)),
    displayWidth: swap ? height : storedWidth,
    displayHeight: swap ? storedWidth : height,
  };
}

export function withAspect<R extends Pick<FileResult, 'videoTracks'>>(result: R, options: { keepCodecConfig?: boolean } = {}): R {
  return {
    ...result,
    videoTracks: result.videoTracks.map((t) => {
      const aspect = aspectOf(t);
      if (!aspect) return t;
      const out = { ...t, ...aspect };
      if (!options.keepCodecConfig) delete out.codecConfig;
      return out;
    }),
  };
}
