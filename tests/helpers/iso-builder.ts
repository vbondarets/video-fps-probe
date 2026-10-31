import type { BlobLike, BlobSlice } from '../../src/core/reader.ts';

export type Bytes = Uint8Array<ArrayBuffer>;
type Part = Uint8Array | number[];

export function bytes(...parts: Part[]): Bytes {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
export const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export const u64 = (n: number): number[] => [...u32(Math.floor(n / 2 ** 32)), ...u32(n % 2 ** 32)];
export const tag = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
export const zeros = (n: number): Bytes => new Uint8Array(n);

export function box(type: string, ...parts: Part[]): Bytes {
  const body = bytes(...parts);
  return bytes(u32(body.length + 8), tag(type), body);
}

export function fullBox(type: string, version: number, flags: number, ...parts: Part[]): Bytes {
  return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
}

const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30].flatMap((v) => u32(v >>> 0));

export const ftyp = (brand = 'isom'): Bytes => box('ftyp', tag(brand), u32(512), tag(brand), tag('mp41'));

export const mvhd = (timescale: number, duration: number): Bytes =>
  fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x10000), u16(0x100), zeros(10), IDENTITY, zeros(24), u32(9));

export interface TrackSpec {
  id: number;
  handler?: 'vide' | 'soun' | 'text';
  timescale?: number;
  samples?: Array<[count: number, delta: number]>;
  chunkOffset?: number;
  sampleSize?: number;
  width?: number;
  height?: number;
  flags?: number;
}

function sampleEntry(spec: TrackSpec): Bytes {
  if (spec.handler === 'soun') return box('mp4a', zeros(6), u16(1), zeros(8), u16(2), u16(16), zeros(4), u32(48000 << 16));
  if (spec.handler === 'text') return box('tx3g', zeros(6), u16(1), zeros(32));
  return box('avc1', zeros(6), u16(1), zeros(16), u16(spec.width ?? 160), u16(spec.height ?? 90), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(24), u16(0xffff));
}

export function trak(spec: TrackSpec): Bytes {
  const ts = spec.timescale ?? 15360;
  const samples = spec.samples ?? [];
  const count = samples.reduce((n, [c]) => n + c, 0);
  const duration = samples.reduce((n, [c, d]) => n + c * d, 0);
  const handler = spec.handler ?? 'vide';
  const stts = fullBox('stts', 0, 0, u32(samples.length), samples.flatMap(([c, d]) => [...u32(c), ...u32(d)]));
  const tables =
    count === 0
      ? [fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stco', 0, 0, u32(0))]
      : [fullBox('stsz', 0, 0, u32(spec.sampleSize ?? 10), u32(count)), fullBox('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1)), fullBox('stco', 0, 0, u32(1), u32(spec.chunkOffset ?? 0))];
  const tkhd = fullBox('tkhd', 0, spec.flags ?? 3, u32(0), u32(0), u32(spec.id), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0), IDENTITY, u32((spec.width ?? 160) << 16), u32((spec.height ?? 90) << 16));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(duration), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), tag(handler), zeros(12), [0]);
  const stsd = fullBox('stsd', 0, 0, u32(1), sampleEntry(spec));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stts, ...tables))));
}

export interface MvexSpec {
  trex: Array<{ id: number; duration: number }>;
  mehd?: number | bigint | null;
}

export function mvex(spec: MvexSpec): Bytes {
  const mehd = spec.mehd === undefined || spec.mehd === null ? [] : [typeof spec.mehd === 'bigint' ? fullBox('mehd', 1, 0, u32(Number(spec.mehd >> 32n)), u32(Number(spec.mehd & 0xffffffffn))) : fullBox('mehd', 0, 0, u32(spec.mehd))];
  return box('mvex', ...mehd, ...spec.trex.map((t) => fullBox('trex', 0, 0, u32(t.id), u32(1), u32(t.duration), u32(0), u32(0))));
}

export function moov(tracks: TrackSpec[], extra: Uint8Array[] = [], timescale = 1000): Bytes {
  return box('moov', mvhd(timescale, 0), ...tracks.map(trak), ...extra);
}

export function moovOfSize(target: number, spec: Omit<TrackSpec, 'samples'>): Bytes {
  const fixed = moov([{ ...spec, samples: [] }]).length;
  const entries = Math.max(0, Math.floor((target - fixed) / 8));
  const samples: Array<[number, number]> = Array.from({ length: entries }, (_, i) => [1, 512 + (i % 2)]);
  return moov([{ ...spec, samples }]);
}

export interface FragmentSpec {
  id: number;
  baseDts: number | null;
  count: number;
  duration: number;
  cts?: number;
}

export function moof(sequence: number, trafs: FragmentSpec[], dataSize = 0): Bytes {
  const parts = trafs.map((f) =>
    box(
      'traf',
      fullBox('tfhd', 0, 0x20000 | 0x8 | 0x10, u32(f.id), u32(f.duration), u32(dataSize > 0 && f.count > 0 ? Math.floor(dataSize / f.count) : 1)),
      ...(f.baseDts === null ? [] : [fullBox('tfdt', 1, 0, u64(f.baseDts))]),
      f.cts === undefined ? fullBox('trun', 0, 0, u32(f.count)) : fullBox('trun', 0, 0x800, u32(f.count), ...Array.from({ length: f.count }, () => u32(f.cts!))),
    ),
  );
  return box('moof', fullBox('mfhd', 0, 0, u32(sequence)), ...parts);
}

export function mfra(entries: Array<{ id: number; offsets: number[] }>): Bytes {
  const tfras = entries.map((e) => fullBox('tfra', 1, 0, u32(e.id), u32(0), u32(e.offsets.length), e.offsets.flatMap((o, i) => [...u64(i * 1000), ...u64(o), 1, 1, 1])));
  const body = bytes(...tfras);
  const total = 8 + body.length + 16;
  return bytes(u32(total), tag('mfra'), body, fullBox('mfro', 0, 0, u32(total)));
}

export function sidx(referenceId: number, timescale: number, earliest: number, references: Array<[size: number, duration: number]>, firstOffset = 0): Bytes {
  return fullBox(
    'sidx',
    1,
    0,
    u32(referenceId),
    u32(timescale),
    u64(earliest),
    u64(firstOffset),
    u16(0),
    u16(references.length),
    references.flatMap(([size, duration]) => [...u32(size & 0x7fffffff), ...u32(duration), ...u32(0x90000000)]),
  );
}

export const mdatHeader = (payload: number): Bytes => (payload + 8 <= 0xffffffff ? bytes(u32(payload + 8), tag('mdat')) : bytes(u32(1), tag('mdat'), u64(payload + 16)));

export type Segment = Uint8Array | { zeros: number };

export interface VirtualSource extends BlobLike {
  readonly calls: Array<[start: number, end: number]>;
  readonly offsets: number[];
}

export function virtualSource(segments: Segment[]): VirtualSource {
  const offsets: number[] = [];
  let size = 0;
  for (const s of segments) {
    offsets.push(size);
    size += s instanceof Uint8Array ? s.length : s.zeros;
  }
  const calls: Array<[number, number]> = [];
  const read = (start: number, end: number): ArrayBuffer => {
    const out = new Uint8Array(Math.max(0, end - start));
    segments.forEach((s, i) => {
      if (!(s instanceof Uint8Array)) return;
      const at = offsets[i];
      const from = Math.max(start, at);
      const to = Math.min(end, at + s.length);
      if (from < to) out.set(s.subarray(from - at, to - at), from - start);
    });
    return out.buffer;
  };
  return {
    size,
    calls,
    offsets,
    slice(start = 0, end = size): BlobSlice {
      return {
        arrayBuffer: async () => {
          calls.push([start, end]);
          return read(start, Math.min(end, size));
        },
      };
    },
  };
}

export interface Recording {
  source: VirtualSource;
  moofOffsets: number[];
  videoTicks: number;
  audioTicks: number | null;
}

export interface RecordingOptions {
  fragments: number;
  mdatBytes: number;
  audio?: boolean;
  audioLonger?: number;
  audioShorter?: number;
  index?: boolean;
  mehd?: number | bigint | null;
  sidx?: boolean | 'fragment';
  cts?: number;
  separate?: boolean;
  free?: Uint8Array[];
}

export function recording(options: RecordingOptions): Recording {
  const video: TrackSpec = { id: 1, timescale: 15360 };
  const audio: TrackSpec = { id: 2, handler: 'soun', timescale: 48000 };
  const tracks = options.audio ? [video, audio] : [video];
  const trex = tracks.map((t) => ({ id: t.id, duration: t.handler === 'soun' ? 1024 : 512 }));
  const head = bytes(ftyp('iso5'), moov(tracks, [mvex({ trex, mehd: options.mehd })]));
  const segments: Segment[] = [head, ...(options.free ?? [])];
  let offset = segments.reduce((n, s) => n + (s instanceof Uint8Array ? s.length : s.zeros), 0);
  const moofOffsets: number[] = [];
  const audioMoofOffsets: number[] = [];
  let videoDts = 0;
  let audioDts = 0;
  const framesPer = 30;
  const audioPer = 47;
  const cts = options.cts ?? 0;
  const sidxRefs: Array<[number, number]> = [];
  const pieces: Array<{ moof: Bytes; mdat: number; video: boolean; audio: boolean; sidx: Bytes | null }> = [];
  for (let i = 0; i < options.fragments; i++) {
    const last = i === options.fragments - 1;
    const v: FragmentSpec = { id: 1, baseDts: videoDts, count: framesPer, duration: 512, cts: options.cts };
    const groups: FragmentSpec[][] = [[v]];
    if (options.audio) {
      const extra = last ? (options.audioLonger ?? 0) - (options.audioShorter ?? 0) : 0;
      const a: FragmentSpec = { id: 2, baseDts: audioDts, count: audioPer + extra, duration: 1024 };
      audioDts += (audioPer + extra) * 1024;
      if (options.separate) groups.push([a]);
      else groups[0].push(a);
    }
    let size = 0;
    for (const g of groups) {
      const m = moof(pieces.length + 1, g, options.mdatBytes);
      const hasVideo = g.some((f) => f.id === 1);
      const s = options.sidx === 'fragment' && hasVideo ? sidx(1, 15360, videoDts + cts, [[m.length + 8 + options.mdatBytes, framesPer * 512]]) : null;
      pieces.push({ moof: m, mdat: options.mdatBytes, video: hasVideo, audio: g.some((f) => f.id === 2), sidx: s });
      size += (s?.length ?? 0) + m.length + 8 + options.mdatBytes;
    }
    videoDts += framesPer * 512;
    sidxRefs.push([size, framesPer * 512]);
  }
  if (options.sidx === true) {
    const s = sidx(1, 15360, cts, sidxRefs);
    segments.push(s);
    offset += s.length;
  }
  for (const p of pieces) {
    if (p.sidx) {
      segments.push(p.sidx);
      offset += p.sidx.length;
    }
    if (p.video) moofOffsets.push(offset);
    if (p.audio) audioMoofOffsets.push(offset);
    segments.push(p.moof, mdatHeader(p.mdat), { zeros: p.mdat });
    offset += p.moof.length + 8 + p.mdat;
  }
  if (options.index !== false) {
    const entries = [{ id: 1, offsets: moofOffsets }];
    if (options.audio) entries.push({ id: 2, offsets: audioMoofOffsets });
    segments.push(mfra(entries));
  }
  return { source: virtualSource(segments), moofOffsets, videoTicks: videoDts, audioTicks: options.audio ? audioDts : null };
}
