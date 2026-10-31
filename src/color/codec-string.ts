import { firstBox, u16, u32, type SampleEntry, type Span } from './config.ts';
import { parseH264Sps, parseHevcSps, type SpsInfo } from './sps.ts';

export interface ConfigFacts {
  profile: number | null;
  bitDepth: number | null;
  codecString: string | null;
  sps: SpsInfo | null;
}

const H264_WITHOUT_EXTENSION = new Set([66, 77, 88]);
const HEVC_SPS_NAL = 33;

const hex2 = (v: number): string => v.toString(16).padStart(2, '0');
const dec2 = (v: number): string => String(v).padStart(2, '0');

function reverseBits32(v: number): number {
  let out = 0;
  for (let i = 0; i < 32; i++) {
    out = out * 2 + (v & 1);
    v >>>= 1;
  }
  return out;
}

function avcFacts(b: Uint8Array, s: Span, fourcc: string): ConfigFacts | null {
  if (s.end - s.start < 6) return null;
  const profile = b[s.start + 1];
  const facts: ConfigFacts = { profile, bitDepth: null, codecString: `${fourcc}.${hex2(profile)}${hex2(b[s.start + 2])}${hex2(b[s.start + 3])}`, sps: null };
  let q = s.start + 6;
  const spsCount = b[s.start + 5] & 31;
  for (let i = 0; i < spsCount && q + 2 <= s.end; i++) {
    const len = u16(b, q);
    if (q + 2 + len > s.end) return facts;
    if (i === 0) facts.sps = parseH264Sps(b.subarray(q + 2, q + 2 + len));
    q += 2 + len;
  }
  if (q < s.end) {
    const ppsCount = b[q++];
    for (let i = 0; i < ppsCount && q + 2 <= s.end; i++) q += 2 + u16(b, q);
  }
  const extended = !H264_WITHOUT_EXTENSION.has(profile);
  facts.bitDepth = facts.sps?.bitDepth ?? (!extended ? 8 : q + 4 <= s.end ? (b[q + 1] & 7) + 8 : null);
  return facts;
}

function hevcFacts(b: Uint8Array, s: Span, fourcc: string): ConfigFacts | null {
  if (s.end - s.start < 23) return null;
  const p = s.start;
  const space = b[p + 1] >> 6;
  const profile = b[p + 1] & 31;
  let constraints = '';
  for (let i = 5, any = false; i >= 0; i--) {
    const c = b[p + 6 + i];
    if (c || any) {
      constraints = `.${c.toString(16)}${constraints}`;
      any = true;
    }
  }
  const codecString = `${fourcc}.${['', 'A', 'B', 'C'][space]}${profile}.${reverseBits32(u32(b, p + 2)).toString(16)}.${b[p + 1] & 0x20 ? 'H' : 'L'}${b[p + 12]}${constraints}`;
  const facts: ConfigFacts = { profile, bitDepth: (b[p + 17] & 7) + 8, codecString, sps: null };
  let q = p + 23;
  for (let a = 0, arrays = b[p + 22]; a < arrays && q + 3 <= s.end; a++) {
    const type = b[q] & 63;
    const count = u16(b, q + 1);
    q += 3;
    for (let i = 0; i < count && q + 2 <= s.end; i++) {
      const len = u16(b, q);
      if (q + 2 + len > s.end) return facts;
      if (type === HEVC_SPS_NAL && !facts.sps) facts.sps = parseHevcSps(b.subarray(q + 2, q + 2 + len));
      q += 2 + len;
    }
  }
  return facts;
}

function av1Facts(b: Uint8Array, s: Span): ConfigFacts | null {
  if (s.end - s.start < 4) return null;
  const profile = b[s.start + 1] >> 5;
  const flags = b[s.start + 2];
  const high = (flags >> 6) & 1;
  const bitDepth = profile > 2 ? null : high ? (profile === 2 && flags & 0x20 ? 12 : 10) : 8;
  const codecString = bitDepth === null ? null : `av01.${profile}.${dec2(b[s.start + 1] & 31)}${flags & 0x80 ? 'H' : 'M'}.${dec2(bitDepth)}`;
  return { profile, bitDepth, codecString, sps: null };
}

function vp9String(profile: number | null, level: number | null, bitDepth: number | null): string | null {
  return profile === null || level === null || bitDepth === null ? null : `vp09.${dec2(profile)}.${dec2(level)}.${dec2(bitDepth)}`;
}

function vpcFacts(b: Uint8Array, s: Span): ConfigFacts | null {
  if (s.end - s.start < 7) return null;
  const profile = b[s.start + 4];
  const bitDepth = b[s.start + 6] >> 4;
  return { profile, bitDepth, codecString: vp9String(profile, b[s.start + 5], bitDepth), sps: null };
}

function vp9PrivateFacts(b: Uint8Array, s: Span): ConfigFacts | null {
  const features = new Map<number, number>();
  for (let q = s.start; q + 2 <= s.end; ) {
    const id = b[q];
    const len = b[q + 1];
    if (q + 2 + len > s.end) break;
    if (len === 1 && !features.has(id)) features.set(id, b[q + 2]);
    q += 2 + len;
  }
  if (!features.size) return null;
  const profile = features.get(1) ?? null;
  const bitDepth = features.get(3) ?? null;
  return { profile, bitDepth, codecString: vp9String(profile, features.get(2) ?? null, bitDepth), sps: null };
}

export function isoConfigFacts(codecName: string, b: Uint8Array, entry: SampleEntry): ConfigFacts | null {
  const avcC = firstBox(entry, 'avcC');
  if (codecName === 'h264' && avcC) return avcFacts(b, avcC, entry.type);
  const hvcC = firstBox(entry, 'hvcC');
  if (codecName === 'hevc' && hvcC) return hevcFacts(b, hvcC, entry.type);
  const av1C = firstBox(entry, 'av1C');
  if (codecName === 'av1' && av1C) return av1Facts(b, av1C);
  const vpcC = firstBox(entry, 'vpcC');
  if (codecName === 'vp9' && vpcC) return vpcFacts(b, vpcC);
  return null;
}

export function matroskaConfigFacts(codecId: string, b: Uint8Array, codecPrivate: Span | null): ConfigFacts | null {
  if (!codecPrivate) return null;
  if (codecId === 'V_MPEG4/ISO/AVC') return avcFacts(b, codecPrivate, 'avc1');
  if (codecId === 'V_MPEGH/ISO/HEVC') return hevcFacts(b, codecPrivate, 'hvc1');
  if (codecId === 'V_AV1') return av1Facts(b, codecPrivate);
  return codecId === 'V_VP9' ? vp9PrivateFacts(b, codecPrivate) : null;
}

export function dolbyVisionString(fourcc: string, profile: number, level: number): string {
  return `${fourcc}.${dec2(profile)}.${dec2(level)}`;
}
