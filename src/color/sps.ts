import { u16, type Span } from './config.ts';

export interface VuiInfo {
  sar: [num: number, den: number] | null;
  fullRange: boolean | null;
  colour: [primaries: number, transfer: number, matrix: number] | null;
}

export interface SpsInfo {
  bitDepth: number;
  vui: VuiInfo | null;
}

const H264_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 144]);

const PIXEL_ASPECT = [0, 1, 1, 1, 12, 11, 10, 11, 16, 11, 40, 33, 24, 11, 20, 11, 32, 11, 80, 33, 18, 11, 15, 11, 64, 33, 160, 99, 4, 3, 3, 2, 2, 1];

const EXTENDED_SAR = 255;

const GIVE_UP = new RangeError();
const HEVC_SPS_NAL = 33;

export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[n++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

export interface BitReader {
  bit(): number;
  bits(n: number): number;
  skip(n: number): void;
  ue(max?: number): number;
  se(): number;
}

export function bitReader(b: Uint8Array, start = 0): BitReader {
  let pos = start * 8;
  const end = b.length * 8;
  const bit = (): number => {
    check(pos < end);
    const v = (b[pos >> 3] >> (7 - (pos & 7))) & 1;
    pos++;
    return v;
  };
  const bits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + bit();
    return v;
  };
  const skip = (n: number): void => {
    check(pos + n <= end);
    pos += n;
  };
  const ue = (max = 0xfffffffe): number => {
    let zeros = 0;
    while (bit() === 0) check(++zeros < 32);
    const v = 2 ** zeros - 1 + bits(zeros);
    check(v <= max);
    return v;
  };
  const se = (): number => {
    const k = ue();
    return k & 1 ? (k + 1) / 2 : k ? -k / 2 : 0;
  };
  return { bit, bits, skip, ue, se };
}

function check(ok: boolean): void {
  if (!ok) throw GIVE_UP;
}

function readVui(r: BitReader): VuiInfo {
  const { bit, bits, skip } = r;
  const vui: VuiInfo = { sar: null, fullRange: null, colour: null };
  if (bit()) {
    const idc = bits(8);
    const sar = idc === EXTENDED_SAR ? [bits(16), bits(16)] : [PIXEL_ASPECT[idc * 2] ?? 0, PIXEL_ASPECT[idc * 2 + 1] ?? 0];
    vui.sar = sar[0] > 0 && sar[1] > 0 ? [sar[0], sar[1]] : null;
  }
  if (bit()) skip(1);
  if (bit()) {
    skip(3);
    vui.fullRange = bit() === 1;
    if (bit()) vui.colour = [bits(8), bits(8), bits(8)];
  }
  return vui;
}

function skipH264ScalingList(r: BitReader, size: number): void {
  const { se } = r;
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

export function parseH264Sps(nal: Uint8Array): SpsInfo | null {
  try {
    const r = bitReader(unescapeRbsp(nal), 1);
    const { bit, bits, skip, ue, se } = r;
    const profile = bits(8);
    skip(16);
    ue(31);
    let bitDepth = 8;
    if (H264_HIGH_PROFILES.has(profile)) {
      const chroma = ue(3);
      if (chroma === 3) skip(1);
      bitDepth = ue(6) + 8;
      check(ue(6) + 8 === bitDepth);
      skip(1);
      if (bit()) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (bit()) skipH264ScalingList(r, i < 6 ? 16 : 64);
    }
    ue(12);
    const poc = ue(2);
    if (poc === 0) ue(12);
    else if (poc === 1) {
      skip(1);
      se();
      se();
      const cycle = ue(255);
      for (let i = 0; i < cycle; i++) se();
    }
    ue(16);
    skip(1);
    ue();
    ue();
    if (!bit()) skip(1);
    skip(1);
    if (bit()) for (let i = 0; i < 4; i++) ue();
    return { bitDepth, vui: bit() ? readVui(r) : null };
  } catch (e) {
    if (e === GIVE_UP) return null;
    throw e;
  }
}

function skipProfileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  const { bit, skip } = r;
  skip(88);
  skip(8);
  const present: Array<[profile: number, level: number]> = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) present.push([bit(), bit()]);
  if (maxSubLayersMinus1 > 0) skip(2 * (8 - maxSubLayersMinus1));
  for (const [profile, level] of present) {
    if (profile) skip(88);
    if (level) skip(8);
  }
}

function skipHevcScalingListData(r: BitReader): void {
  const { bit, ue, se } = r;
  for (let size = 0; size < 4; size++) {
    for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
      if (!bit()) {
        const delta = ue();
        check(matrix - delta * (size === 3 ? 3 : 1) >= 0);
      } else {
        const coefs = Math.min(64, 1 << (4 + (size << 1)));
        if (size > 1) {
          const dc = se();
          check(dc >= -7 && dc <= 247);
        }
        for (let i = 0; i < coefs; i++) se();
      }
    }
  }
}

const HEVC_MAX_REFS = 16;
const HEVC_MAX_DELTA_POCS = 32;

function skipShortTermRefPicSets(r: BitReader, count: number): void {
  const { bit, skip, ue } = r;
  const deltaPocs: number[] = [];
  for (let idx = 0; idx < count; idx++) {
    if (idx > 0 && bit()) {
      skip(1);
      ue(32767);
      let k = 0;
      for (let j = 0; j <= deltaPocs[idx - 1]; j++) {
        const used = bit();
        if (used || bit()) k++;
      }
      check(k < HEVC_MAX_DELTA_POCS);
      deltaPocs.push(k);
    } else {
      const negative = ue(HEVC_MAX_REFS - 1);
      const positive = ue(HEVC_MAX_REFS - 1);
      for (let i = 0; i < negative + positive; i++) {
        ue(32767);
        skip(1);
      }
      deltaPocs.push(negative + positive);
    }
  }
}

export function parseHevcSps(nal: Uint8Array): SpsInfo | null {
  try {
    const r = bitReader(unescapeRbsp(nal), 2);
    const { bit, bits, skip, ue } = r;
    skip(4);
    const maxSubLayersMinus1 = bits(3);
    check(maxSubLayersMinus1 < 7);
    skip(1);
    skipProfileTierLevel(r, maxSubLayersMinus1);
    ue(15);
    const chroma = ue(3);
    if (chroma === 3) skip(1);
    ue();
    ue();
    if (bit()) for (let i = 0; i < 4; i++) ue();
    const bitDepth = ue(8) + 8;
    const chromaDepth = ue(8) + 8;
    check(chroma === 0 || chromaDepth === bitDepth);
    const pocLsbBits = ue(12) + 4;
    const ordering = bit();
    for (let i = ordering ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
      ue();
      ue();
      ue();
    }
    for (let i = 0; i < 6; i++) ue();
    if (bit() && bit()) skipHevcScalingListData(r);
    skip(2);
    if (bit()) {
      skip(8);
      ue();
      ue();
      skip(1);
    }
    skipShortTermRefPicSets(r, ue(64));
    if (bit()) {
      const longTerm = ue(32);
      for (let i = 0; i < longTerm; i++) skip(pocLsbBits + 1);
    }
    skip(2);
    return { bitDepth, vui: bit() ? readVui(r) : null };
  } catch (e) {
    if (e === GIVE_UP) return null;
    throw e;
  }
}

export function avcConfigSps(b: Uint8Array, s: Span): SpsInfo | null {
  const len = s.end - s.start >= 8 && b[s.start + 5] & 31 ? u16(b, s.start + 6) : -1;
  return len >= 0 && s.start + 8 + len <= s.end ? parseH264Sps(b.subarray(s.start + 8, s.start + 8 + len)) : null;
}

export function hevcConfigSps(b: Uint8Array, s: Span): SpsInfo | null {
  let q = s.start + 23;
  for (let a = 0, arrays = s.end - s.start >= 23 ? b[s.start + 22] : 0; a < arrays && q + 3 <= s.end; a++) {
    const type = b[q] & 63;
    const count = u16(b, q + 1);
    q += 3;
    for (let i = 0; i < count && q + 2 <= s.end; i++) {
      const len = u16(b, q);
      if (q + 2 + len > s.end) return null;
      if (type === HEVC_SPS_NAL) return parseHevcSps(b.subarray(q + 2, q + 2 + len));
      q += 2 + len;
    }
  }
  return null;
}
