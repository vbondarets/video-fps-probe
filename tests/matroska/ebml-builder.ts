export type Bytes = Uint8Array | readonly number[];

export const UNKNOWN = -1;

export function concat(...parts: Bytes[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function idBytes(id: number): number[] {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return out;
}

export function sizeBytes(size: number, len = 0): number[] {
  let n = len;
  if (n === 0) {
    n = 1;
    while (size >= 2 ** (7 * n) - 1) n++;
  }
  if (size === UNKNOWN) {
    const out = new Array<number>(n).fill(0xff);
    out[0] = 0xff >> (n - 1);
    return out;
  }
  const out = new Array<number>(n).fill(0);
  let v = size;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (n - 1);
  return out;
}

export function el(id: number, payload: Bytes = [], sizeLen = 0, size?: number): Uint8Array {
  return concat(idBytes(id), sizeBytes(size ?? payload.length, sizeLen), payload);
}

export function uintBytes(v: number | bigint, len = 0): number[] {
  let x = BigInt(v);
  const out: number[] = [];
  while (x > 0n || out.length === 0) {
    out.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  while (out.length < len) out.unshift(0);
  return out;
}

export function uint(id: number, v: number | bigint, len = 0): Uint8Array {
  return el(id, uintBytes(v, len));
}

export function float(id: number, v: number, len: 0 | 4 | 8 = 8): Uint8Array {
  const b = new Uint8Array(len);
  const dv = new DataView(b.buffer);
  if (len === 4) dv.setFloat32(0, v);
  else if (len === 8) dv.setFloat64(0, v);
  return el(id, b);
}

export function str(id: number, s: string): Uint8Array {
  return el(id, Array.from(new TextEncoder().encode(s)));
}

export const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagDefault: 0x88,
  DefaultDuration: 0x23e383,
  TrackTimestampScale: 0x23314f,
  CodecID: 0x86,
  CodecDelay: 0x56aa,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  FrameRate: 0x2383e3,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Tags: 0x1254c367,
  Tag: 0x7373,
  Targets: 0x63c0,
  TagTrackUID: 0x63c5,
  SimpleTag: 0x67c8,
  TagName: 0x45a3,
  TagString: 0x4487,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileName: 0x466e,
  FileMediaType: 0x4660,
  FileData: 0x465c,
  CRC32: 0xbf,
  Void: 0xec,
} as const;

export function ebmlHeader(docType = 'webm'): Uint8Array {
  return el(ID.EBML, concat(uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(ID.DocType, docType), uint(0x4287, 4), uint(0x4285, 2)));
}

export interface TrackSpec {
  number: number;
  type?: number;
  uid?: number | bigint;
  codecId?: string;
  defaultDuration?: number;
  frameRate?: number;
  width?: number;
  height?: number;
  flagDefault?: number;
  trackTimestampScale?: number;
  codecDelay?: number;
}

export function trackEntry(t: TrackSpec): Uint8Array {
  const parts: Bytes[] = [uint(ID.TrackNumber, t.number), uint(ID.TrackUID, t.uid ?? t.number), uint(ID.TrackType, t.type ?? 1), str(ID.CodecID, t.codecId ?? 'V_VP9')];
  if (t.flagDefault !== undefined) parts.push(uint(ID.FlagDefault, t.flagDefault));
  if (t.defaultDuration !== undefined) parts.push(uint(ID.DefaultDuration, t.defaultDuration));
  if (t.trackTimestampScale !== undefined) parts.push(float(ID.TrackTimestampScale, t.trackTimestampScale, 8));
  if (t.codecDelay !== undefined) parts.push(uint(ID.CodecDelay, t.codecDelay));
  if ((t.type ?? 1) === 1) {
    const v: Bytes[] = [uint(ID.PixelWidth, t.width ?? 160), uint(ID.PixelHeight, t.height ?? 90)];
    if (t.frameRate !== undefined) v.push(float(ID.FrameRate, t.frameRate, 4));
    parts.push(el(ID.Video, concat(...v)));
  }
  return el(ID.TrackEntry, concat(...parts));
}

export function tracks(...entries: TrackSpec[]): Uint8Array {
  return el(ID.Tracks, concat(...entries.map(trackEntry)));
}

export function info(opts: { timestampScale?: number; duration?: number; durationLen?: 0 | 4 | 8 } = {}): Uint8Array {
  const parts: Bytes[] = [uint(ID.TimestampScale, opts.timestampScale ?? 1_000_000)];
  if (opts.duration !== undefined) parts.push(float(ID.Duration, opts.duration, opts.durationLen ?? 8));
  return el(ID.Info, concat(...parts));
}

export function durationTag(uid: number | bigint, value: string, name = 'DURATION'): Uint8Array {
  return el(ID.Tag, concat(el(ID.Targets, uint(ID.TagTrackUID, uid)), el(ID.SimpleTag, concat(str(ID.TagName, name), str(ID.TagString, value)))));
}

export interface BlockSpec {
  track: number;
  rel: number;
  flags?: number;
  laces?: number;
  payload?: number;
}

export function blockBody(b: BlockSpec): Uint8Array {
  const laces = b.laces ?? 1;
  let flags = b.flags ?? 0x80;
  const payload = b.payload ?? 16;
  const head: number[] = [...sizeBytes(b.track), (b.rel >> 8) & 0xff, b.rel & 0xff];
  if (laces > 1) {
    flags |= 0x06;
    head.push(flags, laces - 1, ...sizeBytes(Math.floor(payload / laces)), ...new Array<number>(laces - 2).fill(0xbf));
  } else head.push(flags);
  return concat(head, new Uint8Array(payload));
}

export function simpleBlock(b: BlockSpec): Uint8Array {
  return el(ID.SimpleBlock, blockBody(b));
}

export function blockGroup(b: BlockSpec, duration?: number, trailing: Bytes = []): Uint8Array {
  const parts: Bytes[] = [el(ID.Block, blockBody({ ...b, flags: b.flags ?? 0 }))];
  if (duration !== undefined) parts.push(uint(ID.BlockDuration, duration));
  parts.push(trailing);
  return el(ID.BlockGroup, concat(...parts));
}

export function cluster(ts: number, children: Bytes[], unknownSize = false): Uint8Array {
  const body = concat(uint(ID.Timestamp, ts), ...children);
  return unknownSize ? el(ID.Cluster, body, 1, UNKNOWN) : el(ID.Cluster, body);
}

export function segment(children: Bytes[], unknownSize = false): Uint8Array {
  const body = concat(...children);
  return unknownSize ? el(ID.Segment, body, 8, UNKNOWN) : el(ID.Segment, body, 8);
}

export function seekHead(entries: Array<[id: number, pos: number]>): Uint8Array {
  return el(ID.SeekHead, concat(...entries.map(([id, pos]) => el(ID.Seek, concat(el(ID.SeekID, idBytes(id)), uint(ID.SeekPosition, pos, 4))))));
}

export function cfrClusters(opts: { track?: number; frames: number; periodMs: number; perCluster?: number; payload?: number; unknownSize?: boolean }): Uint8Array[] {
  const per = opts.perCluster ?? 30;
  const out: Uint8Array[] = [];
  for (let i = 0; i < opts.frames; i += per) {
    const ts = Math.floor(i * opts.periodMs);
    const blocks: Uint8Array[] = [];
    for (let k = i; k < Math.min(opts.frames, i + per); k++) {
      blocks.push(simpleBlock({ track: opts.track ?? 1, rel: Math.floor(k * opts.periodMs) - ts, payload: opts.payload }));
    }
    out.push(cluster(ts, blocks, opts.unknownSize));
  }
  return out;
}

export function file(...parts: Bytes[]): Blob {
  const b = concat(...parts);
  return new Blob([b.buffer as ArrayBuffer]);
}
