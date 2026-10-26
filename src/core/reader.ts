import { throwIfAborted } from './abort.ts';

export interface BlobSlice {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): BlobSlice;
}

export interface BlobReaderOptions {
  headWindow?: number;
  maxWindows?: number;
  signal?: AbortSignal | null;
}

export interface ReaderStats {
  reads: number;
  bytesFetched: number;
  bytesTransferred: number;
}

export const DEFAULT_HEAD_WINDOW = 64 * 1024;
export const DEFAULT_MAX_WINDOWS = 4;
export const MAX_SAFE_OFFSET = Number.MAX_SAFE_INTEGER;

export class EndOfFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndOfFileError';
  }
}

export class FileReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`file read failed: ${message}`, { cause });
    this.name = 'FileReadError';
  }
}

interface CachedWindow {
  off: number;
  buf: Uint8Array;
}

interface Interval {
  start: number;
  end: number;
}

function assertSafeCount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative safe integer, got ${value}`);
}

export function toSafeNumber(value: bigint, what = 'value'): number {
  if (value > BigInt(MAX_SAFE_OFFSET) || value < -BigInt(MAX_SAFE_OFFSET)) throw new RangeError(`${what} ${value} exceeds 2^53-1`);
  return Number(value);
}

export class BlobReader {
  readonly size: number;
  readonly headWindow: number;
  readonly maxWindows: number;
  readonly signal: AbortSignal | null;
  readonly #source: BlobLike;
  #windows: CachedWindow[] = [];
  #covered: Interval[] = [];
  #reads = 0;
  #unique = 0;
  #transferred = 0;

  constructor(source: BlobLike, options: BlobReaderOptions = {}) {
    assertSafeCount(source.size, 'blob size');
    this.#source = source;
    this.size = source.size;
    this.headWindow = options.headWindow ?? DEFAULT_HEAD_WINDOW;
    this.maxWindows = Math.max(1, options.maxWindows ?? DEFAULT_MAX_WINDOWS);
    this.signal = options.signal ?? null;
    assertSafeCount(this.headWindow, 'headWindow');
  }

  get reads(): number {
    return this.#reads;
  }

  get bytesFetched(): number {
    return this.#unique;
  }

  get bytesTransferred(): number {
    return this.#transferred;
  }

  stats(): ReaderStats {
    return { reads: this.#reads, bytesFetched: this.#unique, bytesTransferred: this.#transferred };
  }

  checkAbort(): void {
    throwIfAborted(this.signal);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertSafeCount(offset, 'offset');
    assertSafeCount(length, 'length');
    if (offset > this.size) throw new RangeError(`offset ${offset} is beyond the end of the file (${this.size})`);
    const end = Math.min(this.size, offset + length);
    if (end === offset) return new Uint8Array(0);
    this.checkAbort();
    let ab: ArrayBuffer;
    try {
      ab = await this.#source.slice(offset, end).arrayBuffer();
    } catch (e) {
      this.checkAbort();
      throw (e as Error | null)?.name === 'AbortError' ? e : new FileReadError(String(e), e);
    }
    this.checkAbort();
    this.#reads++;
    this.#transferred += ab.byteLength;
    if (ab.byteLength !== end - offset) {
      throw new FileReadError(`short read at ${offset}: expected ${end - offset} bytes, got ${ab.byteLength}`);
    }
    this.#cover(offset, end);
    return new Uint8Array(ab);
  }

  async readMany(ranges: ReadonlyArray<readonly [offset: number, length: number]>, concurrency = 4): Promise<Uint8Array[]> {
    const out: Uint8Array[] = new Array(ranges.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ranges.length) {
        const i = next++;
        const [o, n] = ranges[i];
        const cached = this.peek(o, n);
        out[i] = cached ? new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength) : await this.read(o, n);
      }
    };
    const lanes: Promise<void>[] = [];
    for (let k = 0; k < Math.max(1, Math.min(concurrency, ranges.length)); k++) lanes.push(worker());
    await Promise.all(lanes);
    return out;
  }

  peek(offset: number, length: number): DataView | null {
    const end = Math.min(this.size, offset + length);
    for (let i = 0; i < this.#windows.length; i++) {
      const w = this.#windows[i];
      if (offset >= w.off && end <= w.off + w.buf.length) {
        if (i > 0) {
          this.#windows.splice(i, 1);
          this.#windows.unshift(w);
        }
        return new DataView(w.buf.buffer, w.buf.byteOffset + (offset - w.off), end - offset);
      }
    }
    return null;
  }

  async view(offset: number, length: number, readAhead: number = this.headWindow): Promise<DataView> {
    assertSafeCount(offset, 'offset');
    assertSafeCount(length, 'length');
    assertSafeCount(readAhead, 'readAhead');
    if (offset > this.size) throw new RangeError(`offset ${offset} is beyond the end of the file (${this.size})`);
    const end = Math.min(this.size, offset + length);
    if (end === offset) return new DataView(new ArrayBuffer(0));
    const hit = this.peek(offset, end - offset);
    if (hit) return hit;
    const fetchEnd = Math.min(this.size, Math.max(end, offset + readAhead));
    const partial = this.#windows.find((w) => offset >= w.off && offset < w.off + w.buf.length);
    let buf: Uint8Array;
    if (partial) {
      const keep = partial.buf.subarray(offset - partial.off);
      const fetched = await this.read(partial.off + partial.buf.length, fetchEnd - (partial.off + partial.buf.length));
      buf = new Uint8Array(keep.length + fetched.length);
      buf.set(keep, 0);
      buf.set(fetched, keep.length);
    } else {
      buf = await this.read(offset, fetchEnd - offset);
    }
    this.#windows.unshift({ off: offset, buf });
    if (this.#windows.length > this.maxWindows) this.#windows.length = this.maxWindows;
    return new DataView(buf.buffer, buf.byteOffset, end - offset);
  }

  async viewExact(offset: number, length: number, readAhead: number = this.headWindow): Promise<DataView> {
    const dv = await this.view(offset, length, readAhead);
    if (dv.byteLength < length) {
      throw new EndOfFileError(`unexpected end of file: wanted ${length} bytes at ${offset}, file size ${this.size}`);
    }
    return dv;
  }

  async bytes(offset: number, length: number, readAhead: number = this.headWindow): Promise<Uint8Array> {
    const dv = await this.view(offset, length, readAhead);
    return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  }

  clearCache(): void {
    this.#windows = [];
  }

  #cover(start: number, end: number): void {
    const list = this.#covered;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].end < start) lo = mid + 1;
      else hi = mid;
    }
    let i = lo;
    let mergedStart = start;
    let mergedEnd = end;
    let overlap = 0;
    while (i < list.length && list[i].start <= end) {
      const iv = list[i];
      const o = Math.min(end, iv.end) - Math.max(start, iv.start);
      if (o > 0) overlap += o;
      if (iv.start < mergedStart) mergedStart = iv.start;
      if (iv.end > mergedEnd) mergedEnd = iv.end;
      i++;
    }
    list.splice(lo, i - lo, { start: mergedStart, end: mergedEnd });
    this.#unique += end - start - overlap;
  }
}

export function u8(dv: DataView, p: number): number {
  return dv.getUint8(p);
}

export function u16(dv: DataView, p: number): number {
  return dv.getUint16(p);
}

export function i16(dv: DataView, p: number): number {
  return dv.getInt16(p);
}

export function u24(dv: DataView, p: number): number {
  return dv.getUint8(p) * 65536 + dv.getUint16(p + 1);
}

export function u32(dv: DataView, p: number): number {
  return dv.getUint32(p);
}

export function i32(dv: DataView, p: number): number {
  return dv.getInt32(p);
}

export function u64(dv: DataView, p: number): number {
  return toSafeNumber(dv.getBigUint64(p), 'u64');
}

export function i64(dv: DataView, p: number): number {
  return toSafeNumber(dv.getBigInt64(p), 'i64');
}

export function u64Big(dv: DataView, p: number): bigint {
  return dv.getBigUint64(p);
}

export function fixed16_16(dv: DataView, p: number): number {
  return dv.getInt32(p) / 65536;
}

export function ascii(dv: DataView, p: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(dv.getUint8(p + i));
  return s;
}

export function fourcc(dv: DataView, p: number): string {
  return ascii(dv, p, 4);
}
