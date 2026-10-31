export class BitWriter {
  private readonly bits: number[] = [];

  u(n: number, value: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  flag(on: boolean | number): this {
    return this.u(1, on ? 1 : 0);
  }

  ue(value: number): this {
    const v = value + 1;
    const len = Math.floor(Math.log2(v));
    return this.u(len, 0).u(len + 1, v);
  }

  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }

  get length(): number {
    return this.bits.length;
  }

  rbsp(trailing = true): Uint8Array {
    const bits = [...this.bits];
    if (trailing) bits.push(1);
    while (bits.length % 8) bits.push(0);
    const out = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
    return out;
  }
}

export function escapeRbsp(payload: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of payload) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

export function nal(header: number[], w: BitWriter, trailing = true): Uint8Array {
  return Uint8Array.from([...header, ...escapeRbsp(w.rbsp(trailing))]);
}

export interface VuiSpec {
  sar?: [number, number] | number;
  fullRange?: boolean;
  colour?: [number, number, number];
}

export function writeVui(w: BitWriter, vui: VuiSpec): void {
  w.flag(vui.sar !== undefined);
  if (typeof vui.sar === 'number') w.u(8, vui.sar);
  else if (vui.sar) w.u(8, 255).u(16, vui.sar[0]).u(16, vui.sar[1]);
  w.flag(1).flag(0);
  w.flag(vui.fullRange !== undefined || vui.colour !== undefined);
  if (vui.fullRange !== undefined || vui.colour !== undefined) {
    w.u(3, 5).flag(vui.fullRange === true).flag(vui.colour !== undefined);
    if (vui.colour) w.u(8, vui.colour[0]).u(8, vui.colour[1]).u(8, vui.colour[2]);
  }
  w.flag(0).flag(1).u(32, 1001).u(32, 60000).flag(1).flag(0).flag(0).flag(0).flag(0);
}

export interface H264Spec {
  profile: number;
  constraints?: number;
  level?: number;
  bitDepth?: number;
  scaling?: boolean;
  pocType?: 0 | 1 | 2;
  vui?: VuiSpec | null;
}

export function h264Sps(spec: H264Spec): Uint8Array {
  const w = new BitWriter();
  w.u(8, spec.profile).u(8, spec.constraints ?? 0).u(8, spec.level ?? 40).ue(0);
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 144].includes(spec.profile)) {
    w.ue(1).ue((spec.bitDepth ?? 8) - 8).ue((spec.bitDepth ?? 8) - 8).flag(0).flag(spec.scaling === true);
    if (spec.scaling) {
      for (let i = 0; i < 8; i++) {
        w.flag(i % 2 === 0);
        if (i % 2 === 0) for (let j = 0; j < (i < 6 ? 16 : 64); j++) w.se(j === 0 ? 8 : j === 3 ? -8 : 1);
      }
    }
  }
  w.ue(0).ue(spec.pocType ?? 0);
  if ((spec.pocType ?? 0) === 0) w.ue(2);
  else if (spec.pocType === 1) w.flag(0).se(-2).se(1).ue(3).se(2).se(-1).se(4);
  w.ue(4).flag(0).ue(119).ue(67).flag(1).flag(1).flag(1).ue(0).ue(0).ue(0).ue(4);
  w.flag(spec.vui !== null && spec.vui !== undefined);
  if (spec.vui) writeVui(w, spec.vui);
  return nal([0x67], w);
}

export interface HevcSpec {
  profile?: number;
  bitDepth?: number;
  subLayers?: number;
  scaling?: boolean;
  shortTermSets?: boolean;
  longTerm?: boolean;
  pcm?: boolean;
  vui?: VuiSpec | null;
}

export function hevcSps(spec: HevcSpec): Uint8Array {
  const w = new BitWriter();
  const subLayersMinus1 = (spec.subLayers ?? 1) - 1;
  w.u(4, 0).u(3, subLayersMinus1).flag(1);
  w.u(2, 0).flag(0).u(5, spec.profile ?? 2).u(32, 0x20000000).u(4, 0b1001).u(44, 0).u(8, 93);
  for (let i = 0; i < subLayersMinus1; i++) w.flag(1).flag(1);
  if (subLayersMinus1 > 0) for (let i = subLayersMinus1; i < 8; i++) w.u(2, 0);
  for (let i = 0; i < subLayersMinus1; i++) w.u(2, 0).flag(0).u(5, 2).u(32, 0).u(4, 0).u(44, 0).u(8, 90);
  w.ue(0).ue(1).ue(1920).ue(1080).flag(1).ue(0).ue(0).ue(0).ue(4);
  w.ue((spec.bitDepth ?? 10) - 8).ue((spec.bitDepth ?? 10) - 8).ue(4).flag(1);
  for (let i = 0; i <= subLayersMinus1; i++) w.ue(4).ue(0).ue(0);
  w.ue(0).ue(3).ue(0).ue(3).ue(1).ue(1);
  w.flag(spec.scaling === true);
  if (spec.scaling) {
    w.flag(1);
    for (let size = 0; size < 4; size++) {
      for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
        const explicit = (size + matrix) % 2 === 0;
        w.flag(explicit);
        if (!explicit) w.ue(matrix > 0 ? 1 : 0);
        else {
          if (size > 1) w.se(8);
          for (let i = 0; i < Math.min(64, 1 << (4 + (size << 1))); i++) w.se(i % 3 === 0 ? 1 : -1);
        }
      }
    }
  }
  w.flag(1).flag(1).flag(spec.pcm === true);
  if (spec.pcm) w.u(4, 7).u(4, 7).ue(0).ue(1).flag(1);
  if (spec.shortTermSets) {
    w.ue(3);
    w.ue(2).ue(1).ue(0).flag(1).ue(1).flag(1).ue(0).flag(0);
    w.flag(1).flag(0).ue(0).flag(1).flag(0).flag(1).flag(1).flag(0).flag(0);
    w.flag(1).flag(1).ue(2).flag(1).flag(1).flag(0).flag(1).flag(1);
  } else w.ue(0);
  w.flag(spec.longTerm === true);
  if (spec.longTerm) w.ue(2).u(8, 3).flag(1).u(8, 9).flag(0);
  w.flag(1).flag(1);
  w.flag(spec.vui !== null && spec.vui !== undefined);
  if (spec.vui) writeVui(w, spec.vui);
  return nal([0x42, 0x01], w);
}

export function ebml(id: number, ...parts: Array<Uint8Array | number[]>): Uint8Array {
  const payload = Uint8Array.from(parts.flatMap((p) => [...p]));
  const idBytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v & 255);
  const size = payload.length;
  const sizeBytes = size < 127 ? [0x80 | size] : [0x40 | (size >> 8), size & 255];
  return Uint8Array.from([...idBytes, ...sizeBytes, ...payload]);
}

export function uint(id: number, v: number): Uint8Array {
  const out: number[] = [];
  for (let x = v; out.length === 0 || x > 0; x = Math.floor(x / 256)) out.unshift(x & 255);
  return ebml(id, out);
}
export const text = (id: number, s: string): Uint8Array => ebml(id, [...s].map((c) => c.charCodeAt(0)));
