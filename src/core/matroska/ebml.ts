export const ID_EBML = 0x1a45dfa3;
export const ID_DOC_TYPE = 0x4282;
export const ID_SEGMENT = 0x18538067;
export const ID_SEEK_HEAD = 0x114d9b74;
export const ID_SEEK = 0x4dbb;
export const ID_SEEK_ID = 0x53ab;
export const ID_SEEK_POSITION = 0x53ac;
export const ID_INFO = 0x1549a966;
export const ID_TIMESTAMP_SCALE = 0x2ad7b1;
export const ID_DURATION = 0x4489;
export const ID_TRACKS = 0x1654ae6b;
export const ID_TRACK_ENTRY = 0xae;
export const ID_TRACK_NUMBER = 0xd7;
export const ID_TRACK_UID = 0x73c5;
export const ID_TRACK_TYPE = 0x83;
export const ID_DEFAULT_DURATION = 0x23e383;
export const ID_TRACK_TIMESTAMP_SCALE = 0x23314f;
export const ID_CODEC_ID = 0x86;
export const ID_CODEC_DELAY = 0x56aa;
export const ID_CODEC_PRIVATE = 0x63a2;
export const ID_CONTENT_ENCODINGS = 0x6d80;
export const ID_VIDEO = 0xe0;
export const ID_PIXEL_WIDTH = 0xb0;
export const ID_PIXEL_HEIGHT = 0xba;
export const ID_FRAME_RATE = 0x2383e3;
export const ID_CLUSTER = 0x1f43b675;
export const ID_TIMESTAMP = 0xe7;
export const ID_SIMPLE_BLOCK = 0xa3;
export const ID_BLOCK_GROUP = 0xa0;
export const ID_BLOCK = 0xa1;
export const ID_BLOCK_DURATION = 0x9b;
export const ID_CUES = 0x1c53bb6b;
export const ID_CUE_POINT = 0xbb;
export const ID_CUE_TRACK_POSITIONS = 0xb7;
export const ID_CUE_CLUSTER_POSITION = 0xf1;
export const ID_TAGS = 0x1254c367;
export const ID_TAG = 0x7373;
export const ID_TARGETS = 0x63c0;
export const ID_TAG_TRACK_UID = 0x63c5;
export const ID_SIMPLE_TAG = 0x67c8;
export const ID_TAG_NAME = 0x45a3;
export const ID_TAG_STRING = 0x4487;
export const ID_ATTACHMENTS = 0x1941a469;
export const ID_ATTACHED_FILE = 0x61a7;
export const ID_FILE_MEDIA_TYPE = 0x4660;
export const ID_CHAPTERS = 0x1043a770;
export const ID_EDITION_ENTRY = 0x45b9;
export const ID_POSITION = 0xa7;
export const ID_PREV_SIZE = 0xab;
export const ID_REFERENCE_BLOCK = 0xfb;
export const ID_BLOCK_ADDITIONS = 0x75a1;
export const ID_DISCARD_PADDING = 0x75a2;
export const ID_CODEC_STATE = 0xa4;
export const ID_CRC32 = 0xbf;
export const ID_VOID = 0xec;

export const LEVEL1_IDS: ReadonlySet<number> = new Set([ID_SEEK_HEAD, ID_INFO, ID_TRACKS, ID_CUES, ID_TAGS, ID_CLUSTER, ID_CHAPTERS, ID_ATTACHMENTS]);

export const UNKNOWN_SIZE = -1;
export const MAX_HEADER_BYTES = 12;

export interface ElementHeader {
  id: number;
  pos: number;
  size: number;
  dataStart: number;
}

export function vintLength(first: number): number {
  return first === 0 ? 0 : Math.clz32(first) - 23;
}

export function readId(b: Uint8Array, p: number): { id: number; length: number } | null {
  if (p >= b.length) return null;
  const len = vintLength(b[p]);
  if (len < 1 || len > 4 || p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
  return { id, length: len };
}

export function readSize(b: Uint8Array, p: number): { size: number; length: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  const len = vintLength(first);
  if (len < 1 || p + len > b.length) return null;
  const mask = 0xff >> len;
  let unknown = (first & mask) === mask;
  let v = first & mask;
  for (let i = 1; i < len; i++) {
    const x = b[p + i];
    if (x !== 0xff) unknown = false;
    v = v * 256 + x;
  }
  if (unknown) return { size: UNKNOWN_SIZE, length: len };
  if (v > Number.MAX_SAFE_INTEGER) return null;
  return { size: v, length: len };
}

export function readHeader(b: Uint8Array, p: number, base: number): ElementHeader | null {
  const id = readId(b, p);
  if (!id) return null;
  const sz = readSize(b, p + id.length);
  if (!sz) return null;
  return { id: id.id, pos: base + p, size: sz.size, dataStart: base + p + id.length + sz.length };
}

export function headerShort(b: Uint8Array, p: number): boolean {
  if (p >= b.length) return true;
  const idLen = vintLength(b[p]);
  if (idLen < 1 || idLen > 4) return false;
  const q = p + idLen;
  return q >= b.length || (b[q] !== 0 && q + vintLength(b[q]) > b.length);
}

export function readVint(b: Uint8Array, p: number, end: number): { value: number; length: number } | null {
  const len = p < end ? vintLength(b[p]) : 0;
  if (len < 1 || p + len > end) return null;
  let v = b[p] & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
  return { value: v, length: len };
}

export function readUint(b: Uint8Array, p: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[p + i];
  return v;
}

export function readUintBig(b: Uint8Array, p: number, n: number): bigint {
  let v = 0n;
  for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(b[p + i]);
  return v;
}

export function readFloat(b: Uint8Array, p: number, n: number): number {
  if (n === 0) return 0;
  const dv = new DataView(b.buffer, b.byteOffset + p, n);
  if (n === 4) return dv.getFloat32(0);
  if (n === 8) return dv.getFloat64(0);
  return NaN;
}

const utf8 = new TextDecoder();

export function readString(b: Uint8Array, p: number, n: number): string {
  let e = p;
  while (e < p + n && b[e] !== 0) e++;
  return utf8.decode(b.subarray(p, e));
}

export interface Child {
  id: number;
  start: number;
  size: number;
}

export function* children(b: Uint8Array, start: number, end: number): Generator<Child> {
  let p = start;
  const stop = Math.min(end, b.length);
  while (p < stop) {
    const h = readHeader(b, p, 0);
    if (!h || h.size === UNKNOWN_SIZE || h.dataStart + h.size > stop) return;
    yield { id: h.id, start: h.dataStart, size: h.size };
    p = h.dataStart + h.size;
  }
}

export function childUint(b: Uint8Array, c: Child): number {
  return c.size > 6 ? Number(readUintBig(b, c.start, c.size)) : readUint(b, c.start, c.size);
}
