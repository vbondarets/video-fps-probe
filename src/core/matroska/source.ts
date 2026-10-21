import type { BlobReader } from '../reader.ts';
import {
  ID_ATTACHED_FILE,
  ID_ATTACHMENTS,
  ID_CHAPTERS,
  ID_CLUSTER,
  ID_CRC32,
  ID_CUE_POINT,
  ID_CUES,
  ID_DURATION,
  ID_EDITION_ENTRY,
  ID_INFO,
  ID_POSITION,
  ID_PREV_SIZE,
  ID_SEEK,
  ID_SEEK_HEAD,
  ID_TAG,
  ID_TAGS,
  ID_TIMESTAMP,
  ID_TIMESTAMP_SCALE,
  ID_TRACK_ENTRY,
  ID_TRACKS,
  ID_VOID,
  LEVEL1_IDS,
  MAX_HEADER_BYTES,
  UNKNOWN_SIZE,
  readHeader,
  readId,
  readSize,
  type ElementHeader,
} from './ebml.ts';

export interface Chunk {
  base: number;
  buf: Uint8Array;
}

const MAX_CHUNKS = 4;

export class ByteSource {
  readonly reader: BlobReader;
  readonly size: number;
  window: number;
  buf: Uint8Array = new Uint8Array(0);
  base = 0;
  #chunks: Chunk[] = [];

  constructor(reader: BlobReader, window: number) {
    this.reader = reader;
    this.size = reader.size;
    this.window = window;
    const head = reader.peek(0, Math.min(reader.size, reader.headWindow));
    if (head && head.byteLength > 0) this.#use({ base: 0, buf: new Uint8Array(head.buffer, head.byteOffset, head.byteLength) });
  }

  has(pos: number, len: number): boolean {
    return pos >= this.base && Math.min(this.size, pos + len) <= this.base + this.buf.length;
  }

  cached(pos: number, len: number): boolean {
    const end = Math.min(this.size, pos + len);
    return this.#chunks.some((c) => pos >= c.base && end <= c.base + c.buf.length) || this.reader.peek(pos, end - pos) !== null;
  }

  async load(pos: number, len: number, window: number = this.window): Promise<void> {
    if (this.has(pos, len)) return;
    const end = Math.min(this.size, pos + len);
    for (const c of this.#chunks) {
      if (pos >= c.base && end <= c.base + c.buf.length) {
        this.#use(c);
        return;
      }
    }
    const want = Math.max(len, window);
    const dv = await this.reader.view(pos, want, want);
    this.#use({ base: pos, buf: new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) });
  }

  chunkAt(pos: number): Chunk | null {
    return this.#chunks.find((c) => pos >= c.base && pos < c.base + c.buf.length) ?? null;
  }

  async header(pos: number): Promise<ElementHeader | null> {
    if (!this.has(pos, MAX_HEADER_BYTES)) await this.load(pos, MAX_HEADER_BYTES);
    return readHeader(this.buf, pos - this.base, this.base);
  }

  #use(c: Chunk): void {
    this.buf = c.buf;
    this.base = c.base;
    const i = this.#chunks.indexOf(c);
    if (i >= 0) this.#chunks.splice(i, 1);
    this.#chunks.unshift(c);
    if (this.#chunks.length > MAX_CHUNKS) this.#chunks.length = MAX_CHUNKS;
  }
}

const INFO_CHILDREN = [ID_TIMESTAMP_SCALE, ID_DURATION, 0x4d80, 0x5741, 0x73a4, 0x4461, 0x7ba9, 0x7384, 0x3cb923, 0x3c83ab, 0x3eb923, 0x3e83bb, 0x4444, 0x6924];
const FIRST_CHILD: ReadonlyMap<number, readonly number[]> = new Map([
  [ID_SEEK_HEAD, [ID_SEEK]],
  [ID_INFO, INFO_CHILDREN],
  [ID_TRACKS, [ID_TRACK_ENTRY]],
  [ID_CUES, [ID_CUE_POINT]],
  [ID_TAGS, [ID_TAG]],
  [ID_CHAPTERS, [ID_EDITION_ENTRY]],
  [ID_ATTACHMENTS, [ID_ATTACHED_FILE]],
]);
const LEVEL1_FIRST_BYTE = new Uint8Array(256);
for (const id of LEVEL1_IDS) LEVEL1_FIRST_BYTE[id >>> 24] = 1;
const CLUSTER_FIRST_BYTE = new Uint8Array(256);
CLUSTER_FIRST_BYTE[ID_CLUSTER >>> 24] = 1;

export function isClusterAt(b: Uint8Array, i: number, limit: number): boolean {
  if (b[i] !== 0x1f || b[i + 1] !== 0x43 || b[i + 2] !== 0xb6 || b[i + 3] !== 0x75) return false;
  const sz = readSize(b, i + 4);
  if (!sz) return false;
  let p = i + 4 + sz.length;
  const end = sz.size === UNKNOWN_SIZE ? b.length : Math.min(b.length, p + sz.size);
  if (sz.size !== UNKNOWN_SIZE && p + sz.size > limit) return false;
  for (let k = 0; k < 4 && p < end; k++) {
    const id = readId(b, p);
    if (!id) return false;
    const s = readSize(b, p + id.length);
    if (!s || s.size === UNKNOWN_SIZE) return false;
    if (id.id === ID_TIMESTAMP) return s.size <= 8;
    if (id.id !== ID_CRC32 && id.id !== ID_VOID && id.id !== ID_POSITION && id.id !== ID_PREV_SIZE) return false;
    p += id.length + s.length + s.size;
  }
  return false;
}

export function level1At(b: Uint8Array, i: number, clusterLimit: number, fileEnd: number): boolean {
  const id = readId(b, i);
  if (id?.length !== 4) return false;
  if (id.id === ID_CLUSTER) return isClusterAt(b, i, clusterLimit);
  const kids = FIRST_CHILD.get(id.id);
  const sz = readSize(b, i + 4);
  if (!kids || !sz || sz.size < 2) return false;
  const end = i + 4 + sz.length + sz.size;
  const c = end <= fileEnd ? readHeader(b, i + 4 + sz.length, 0) : null;
  return !!c && c.size !== UNKNOWN_SIZE && c.dataStart + c.size <= end && (kids.includes(c.id) || c.id === ID_VOID || c.id === ID_CRC32);
}

export type Accept = (b: Uint8Array, i: number, base: number) => boolean;

export interface FindOptions {
  clustersOnly?: boolean;
  canLoad?: () => boolean;
  step?: number;
}

export async function findForward(src: ByteSource, from: number, to: number, accept: Accept, o: FindOptions = {}): Promise<number> {
  const first = o.clustersOnly ? CLUSTER_FIRST_BYTE : LEVEL1_FIRST_BYTE;
  const step = o.step ?? Math.max(src.window, 64 * 1024);
  let p = Math.max(0, from);
  const stopAt = Math.min(to, src.size);
  while (p < stopAt) {
    let c = src.chunkAt(p);
    if (!c || (c.base + c.buf.length < src.size && c.base + c.buf.length - p < 128)) {
      if (o.canLoad && !o.canLoad()) return -1;
      const w = Math.min(step, stopAt - p + 64);
      await src.load(p, Math.min(w, src.size - p), w);
      c = { base: src.base, buf: src.buf };
    }
    const b = c.buf;
    const base = c.base;
    const stop = Math.min(base + b.length >= src.size ? b.length : b.length - 64, stopAt - base);
    if (stop <= p - base) break;
    for (let i = p - base; i < stop; i++) {
      if (first[b[i]] && accept(b, i, base)) return base + i;
    }
    p = base + stop;
  }
  return -1;
}

export function findClusterForward(src: ByteSource, from: number, to: number, limit: number, o: FindOptions = {}): Promise<number> {
  return findForward(src, from, to, (b, i, base) => isClusterAt(b, i, limit - base), { ...o, clustersOnly: true });
}

export function findLevel1Forward(src: ByteSource, from: number, to: number, clusterLimit: number, o: FindOptions = {}): Promise<number> {
  const fileEnd = src.size;
  return findForward(src, from, to, (b, i, base) => level1At(b, i, clusterLimit - base, fileEnd - base), o);
}
