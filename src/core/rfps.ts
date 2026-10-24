import { avReduce, INT_MAX } from './rational.ts';
import type { MkvHeader, MkvTrack } from './matroska/header.ts';
import type { newScanState, scanSegment } from './matroska/scan.ts';
import type { ByteSource } from './matroska/source.ts';

export interface BlockWalker {
  newScanState: typeof newScanState;
  scanSegment: typeof scanSegment;
}

export interface FfprobeRates {
  avg: string;
  r: string;
  packets: number;
}

interface Tb {
  num: number;
  den: number;
}

interface Stream {
  tb: Tb;
  nb: number;
  cid: number;
  durs: number;
  seen: boolean;
  first: number | null;
  firstIdx: number;
  last: number | null;
  lastIdx: number;
}

const STD = 399;
const LIMIT = 5_000_000;
const MAX_TS_PROBE = 50;
const DECODED_BEFORE_DTS = 7;
const PACKET_HEAD_BYTES = 1024;
const AVC = 'V_MPEG4/ISO/AVC';
const AV1 = 'V_AV1';

const stdRate = (i: number): number =>
  i < 360 ? (i + 1) * 1001 : i < 390 ? (i - 329) * 12012 : i < 393 ? [80, 120, 240][i - 390] * 12012 : [24, 30, 60, 12, 15, 48][i - 393] * 12000;

function llrint(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

const toUs = (ticks: number, tb: Tb): number => Number((BigInt(ticks) * BigInt(tb.num) * 1_000_000n + BigInt(tb.den >> 1)) / BigInt(tb.den));

function opusSamples(toc: number, next: number): number {
  const c = toc >> 3;
  const frame = c < 12 ? [480, 960, 1920, 2880][c & 3] : c < 16 ? [480, 960][c & 1] : [120, 240, 480, 960][c & 3];
  const code = toc & 3;
  const count = code === 0 ? 1 : code < 3 ? 2 : next & 0x3f;
  return count > 0 && frame * count <= 5760 ? frame * count : 0;
}

function rbsp(nal: Uint8Array): { u: (n: number) => number; ue: () => number } {
  const b: number[] = [];
  for (let i = 1, zeros = 0; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) zeros = 0;
    else {
      b.push(nal[i]);
      zeros = nal[i] ? 0 : zeros + 1;
    }
  }
  let p = 0;
  const u = (n: number): number => {
    let v = 0;
    for (const end = p + n; p < end; p++) {
      if (p >> 3 >= b.length) throw new RangeError();
      v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1);
    }
    return v;
  };
  const ue = (): number => {
    let z = 0;
    while (!u(1)) if (++z > 31) throw new RangeError();
    return 2 ** z - 1 + u(z);
  };
  return { u, ue };
}

export interface H264Poc {
  frameNumBits: number;
  pocType: number;
  pocLsbBits: number;
}

export function h264Sps(nal: Uint8Array): H264Poc | string | null {
  const { u, ue } = rbsp(nal);
  try {
    const profile = u(8);
    if (profile !== 66) return `H.264 profile ${profile}`;
    u(16);
    ue();
    const s: H264Poc = { frameNumBits: ue() + 4, pocType: ue(), pocLsbBits: 0 };
    if (s.pocType === 0) s.pocLsbBits = ue() + 4;
    if (s.pocType === 1) {
      u(1);
      ue();
      ue();
      for (let n = ue(); n > 0; n--) ue();
    }
    if (s.frameNumBits > 16 || s.pocLsbBits > 16 || s.pocType > 2) return 'bad H.264 SPS';
    ue();
    u(1);
    ue();
    ue();
    const frameMbsOnly = u(1) || (u(1), 0);
    u(1);
    if (u(1)) for (let i = 0; i < 4; i++) ue();
    if (u(1)) {
      if (u(1) && u(8) === 255) u(32);
      if (u(1)) u(1);
      if (u(1) && (u(4), u(1))) u(24);
      if (u(1)) {
        ue();
        ue();
      }
      if (u(1)) return 'H.264 timing info';
      if (u(1) || u(1) || u(1)) return 'H.264 HRD or pic_struct';
      if (u(1)) {
        u(1);
        for (let i = 0; i < 4; i++) ue();
        return ue() ? 'H.264 reordering' : null;
      }
    }
    return s.pocType === 1 ? 'H.264 pic_order_cnt_type 1' : frameMbsOnly ? s : 'H.264 field coding';
  } catch {
    return 'bad H.264 SPS';
  }
}

function nalUnits(data: Uint8Array, lengthSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (lengthSize) {
    for (let p = 0; p + lengthSize <= data.length; ) {
      let n = 0;
      for (const end = p + lengthSize; p < end; p++) n = n * 256 + data[p];
      out.push(data.subarray(p, (p += n)));
    }
  } else {
    for (let i = 0, start = -1; i <= data.length; i++) {
      if (i < data.length && (data[i] || data[i + 1] || data[i + 2] !== 1)) continue;
      if (start >= 0) out.push(data.subarray(start, i));
      start = i + 3;
      i += 2;
    }
  }
  return out;
}

function h264Unsupported(cp: Uint8Array | null, packets: readonly Uint8Array[]): string | null {
  const lengthSize = cp ? (cp[4] & 3) + 1 : 0;
  const sets = cp ? [] : nalUnits(packets[0], 0);
  if (cp) {
    let p = 5;
    for (const mask of [31, 255]) {
      for (let left = cp[p++] & mask, n = 0; left-- > 0 && p + 2 <= cp.length; p += 2 + n) {
        n = (cp[p] << 8) | cp[p + 1];
        sets.push(cp.subarray(p + 2, p + 2 + n));
      }
    }
  }
  const type = (n: Uint8Array): number => n[0] & 31;
  const sps = sets.find((n) => type(n) === 7);
  const s = sps ? h264Sps(sps) : 'no H.264 SPS';
  if (s === null || typeof s === 'string') return s;
  const pps = sets.filter((n) => type(n) === 8);
  if (!pps.length) return 'no H.264 PPS';
  const frames = 2 ** s.frameNumBits;
  let msb = 0;
  let lsb = NaN;
  let num = -1;
  let offset = 0;
  let last: number | null = null;
  try {
    for (const n of pps) {
      const { u, ue } = rbsp(n);
      ue();
      ue();
      u(1);
      if (u(1) && !s.pocType) return 'H.264 bottom field POC';
    }
    for (const packet of packets) {
      const nal = nalUnits(packet, lengthSize).find((n) => type(n) === 1 || type(n) === 5);
      if (!nal) return 'no H.264 slice header';
      const { u, ue } = rbsp(nal);
      ue();
      ue();
      ue();
      const frameNum = u(s.frameNumBits);
      if (type(nal) === 5) {
        ue();
        msb = offset = 0;
        lsb = NaN;
        last = null;
      } else if (num >= 0 && frameNum !== num && frameNum !== (num + 1) % frames) return 'H.264 frame_num gap';
      else if (frameNum < num) offset += frames;
      num = frameNum;
      let poc = 2 * (offset + frameNum) - (nal[0] & 0x60 ? 0 : 1);
      if (!s.pocType) {
        const x = u(s.pocLsbBits);
        const max = 2 ** s.pocLsbBits;
        if (!(lsb >= 0)) lsb = x;
        const m = x < lsb && lsb - x >= max / 2 ? msb + max : x > lsb && x - lsb > max / 2 ? msb - max : msb;
        poc = m + x;
        if (nal[0] & 0x60) [msb, lsb] = [m, x];
      }
      if (last !== null && poc - last !== 1 && poc - last !== 2) return `H.264 POC step ${poc - last}`;
      last = poc;
    }
  } catch {
    return 'bad H.264 PPS or slice header';
  }
  return null;
}

export function av1TimingInfo(obus: Uint8Array): boolean | null {
  for (let p = 0; p < obus.length; ) {
    const h = obus[p];
    let q = p + 1 + ((h >> 2) & 1);
    let size = obus.length - q;
    if (h & 2) for (let i = 0, byte = 128; byte & 128; i += 7) size = (i ? size : 0) + ((byte = obus[q++] ?? 0) & 127) * 2 ** i;
    if (((h >> 3) & 15) === 1) return q < obus.length ? (obus[q] & 12) === 4 : null;
    p = q + size;
  }
  return null;
}

function codecUnsupported(t: MkvTrack, packets: readonly Uint8Array[]): string | null {
  const cp = t.codecPrivate;
  if (t.codecId === AV1) {
    const timing = av1TimingInfo(cp && cp.length > 4 ? cp.subarray(4) : packets[0]);
    return timing === null ? 'no AV1 sequence header' : timing ? 'AV1 timing info' : null;
  }
  return t.codecId === AVC ? h264Unsupported(cp, packets) : null;
}

function setupUnsupported(h: MkvHeader): string | null {
  const video = h.tracks.filter((t) => t.type === 1);
  if (video.length !== 1) return `${video.length} video tracks`;
  if (new Set(h.tracks.map((t) => t.number)).size < h.tracks.length) return 'duplicate track numbers';
  if (h.attachedImages) return 'attached pictures';
  if (!['V_VP8', 'V_VP9', AV1, AVC].includes(video[0].codecId)) return `codec ${video[0].codecId}`;
  for (const t of h.tracks) {
    if (t.trackTimestampScale !== 1 || t.encoded) return `track ${t.number} scale or encoding`;
    const cp = t.codecPrivate;
    if (t.type !== 1 && (t.codecId !== 'A_OPUS' || !cp || String.fromCharCode(...cp.subarray(0, 8)) !== 'OpusHead' || cp[18] !== 0)) return `track ${t.number} (${t.codecId || t.type})`;
  }
  return null;
}

export async function ffprobeRates(src: ByteSource, h: MkvHeader, start: number, walker: BlockWalker): Promise<FfprobeRates | string> {
  const setup = setupUnsupported(h);
  if (setup) return setup;
  const streams = new Map<number, Stream>();
  for (const t of h.tracks) {
    const tb = avReduce(Math.trunc(h.timestampScale * t.trackTimestampScale), 1_000_000_000, INT_MAX);
    streams.set(t.number, { tb, nb: 0, cid: 0, durs: 0, seen: false, first: null, firstIdx: 0, last: null, lastIdx: 0 });
  }
  const track = h.tracks.find((t) => t.type === 1) as MkvTrack;
  const v = streams.get(track.number) as Stream;
  const tb = v.tb;
  const tbd = tb.num / tb.den;
  const avc = track.codecId === AVC;
  const unreliable = avc || tb.den >= 101 * tb.num || tb.den < 5 * tb.num;
  const framecount = unreliable ? (tbd > 0.0005 ? 40 : 20) : 0;
  const err = new Float64Array(4 * STD);
  const variance = (k: number, i: number): number => {
    const a = err[2 * k * STD + i] / count;
    return err[(2 * k + 1) * STD + i] / count - a * a;
  };
  let lastDts: number | null = null;
  let count = 0;
  let sum = 0;
  let div = 0;
  let readSize = 0;
  let failed: string | null = null;
  const heads: Array<[at: number, size: number]> = [];
  const st = walker.newScanState(h, src.size, h.tracks);
  st.onBlock = (t, blk, block, blockDuration) => {
    st.stop = true;
    if (readSize >= LIMIT || (v.nb && count >= framecount && [...streams.values()].every((s) => s.seen || s.nb >= MAX_TS_PROBE))) return;
    const s = streams.get(t.track.number) as Stream;
    const at = block.dataStart + Math.clz32(src.buf[block.dataStart - src.base]) - 20;
    const size = block.dataStart + block.size - at;
    const video = s === v;
    let dur = blockDuration || Math.floor((t.track.defaultDuration * blk.laces) / h.timestampScale);
    if (blk.laces > 1 || t.noPtsFrames) failed = 'laced or untimed blocks';
    else if (!dur && !video) {
      dur = Math.floor((opusSamples(src.buf[at - src.base], size > 1 ? src.buf[at + 1 - src.base] : 0) * s.tb.den) / (48000 * s.tb.num));
      if (!dur || size < 1) failed = 'a bad Opus packet';
    } else if (!dur && tb.num * 1000 > tb.den) dur = 1;
    if (video && !v.nb && block.id === 0xa3 && !(blk.flags & 0x80)) failed = 'no keyframe first';
    if (failed) return;
    readSize += size;
    const dts = video && avc && v.nb < DECODED_BEFORE_DTS ? null : t.pts[t.n - 1];
    if (dts !== null && s.nb > 1) {
      if (s.last !== null && (s.last >= dts || (s.first !== null && s.lastIdx > s.firstIdx && Math.floor((dts - s.last) / 1000) > Math.floor((s.last - s.first) / (s.lastIdx - s.firstIdx))))) s.first = null;
      if (s.first === null) {
        s.first = dts;
        s.firstIdx = s.nb;
      }
      s.last = dts;
      s.lastIdx = s.nb;
    }
    if (s.nb > 1) {
      let us = toUs(s.cid, s.tb);
      if (!us && s.nb > 30 && s.first !== null && s.last !== null) us = toUs(s.last - s.first, s.tb);
      if (us >= LIMIT) return;
      if (dur > 0) {
        s.cid += dur;
        s.durs++;
      }
    }
    if (video && dts !== null && lastDts !== null && dts > lastDts) {
      const x = dts * tbd;
      for (let i = 0; i < STD; i++) {
        if (!(err[STD + i] < 1e10)) continue;
        const sdts = (x * stdRate(i)) / 12012;
        for (let k = 0; k < 2; k++) {
          const e = sdts - llrint(sdts + k * 0.5) + k * 0.5;
          err[2 * k * STD + i] += e;
          err[(2 * k + 1) * STD + i] += e * e;
        }
      }
      count++;
      sum += dts - lastDts;
      if (count % 10 === 0) for (let i = 0; i < STD; i++) if (err[STD + i] < 1e10 && variance(0, i) > 0.04 && variance(1, i) > 0.04) err[STD + i] = err[3 * STD + i] = 2e10;
      if (count > 3) div = gcd(div, dts - lastDts);
    }
    if (video && dts !== null) lastDts = dts;
    if (dts !== null) s.seen = true;
    if (video && v.nb < (avc ? DECODED_BEFORE_DTS : 1)) heads.push([at, Math.min(size, PACKET_HEAD_BYTES)]);
    s.nb++;
    st.stop = false;
  };
  await walker.scanSegment(src, st, start);
  if (failed) return failed;
  if (!v.nb || st.resyncs || st.truncated || st.missingClusterTs) return 'damaged first Clusters';
  const packets: Uint8Array[] = [];
  for (const [at, size] of heads) {
    await src.load(at, size, size);
    packets.push(src.buf.slice(at - src.base, at + size - src.base));
  }
  const codec = codecUnsupported(track, packets);
  if (codec) return codec;
  let r: Tb | null = null;
  let avg: Tb | null = null;
  if (unreliable && count > 15 && div > Math.max(1, Math.floor(tb.den / (500 * tb.num)))) r = avReduce(tb.den, BigInt(tb.num) * BigInt(div), INT_MAX);
  if (count > 1 && !r && unreliable) {
    let num = 0;
    let best = 0.01;
    for (let j = 0; j < STD; j++) {
      const f = stdRate(j);
      if ((v.cid ? v.cid * tbd < 11511.5 / f : f < 12012) || (tbd * sum) / count < (1001 * 12.0 * 0.8) / f) continue;
      for (let k = 0; k < 2; k++) {
        const e = variance(k, j);
        if (e < best && best > 0.000000001) {
          best = e;
          num = f;
        }
      }
    }
    if (num && num / 12012 < 1.01 * (tb.den / tb.num)) r = avReduce(num, 12012, INT_MAX);
  }
  if (r && sum && v.cid <= 0 && count > 2 && Math.abs(1.0 / ((r.num / r.den) * tbd) - sum / count) <= 1.0) avg = r;
  if (v.durs && !avg && v.cid) {
    avg = avReduce(BigInt(v.durs) * BigInt(tb.den), BigInt(v.cid) * BigInt(tb.num), 60000);
    let best = 0.01;
    let fps = 0;
    for (let j = 0; j < STD; j++) {
      const e = Math.abs(avg.num / avg.den / (stdRate(j) / 12012) - 1);
      if (e < best) {
        best = e;
        fps = stdRate(j);
      }
    }
    if (fps) avg = avReduce(fps, 12012, INT_MAX);
  }
  r ??= { num: tb.den, den: tb.num };
  return { avg: avg ? `${avg.num}/${avg.den}` : '0/0', r: `${r.num}/${r.den}`, packets: v.nb };
}
