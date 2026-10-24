import { describe, expect, it } from 'vitest';
import {
  BlobReader,
  EndOfFileError,
  ascii,
  fourcc,
  i64,
  u16,
  u24,
  u32,
  u64,
  u8,
  type BlobLike,
} from '../../src/core/reader.ts';

const KiB = 1024;

function patternBytes(size: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 7 + (i >>> 8)) & 0xff;
  return b;
}

function memoryBlob(size: number): { blob: Blob; bytes: Uint8Array<ArrayBuffer> } {
  const bytes = patternBytes(size);
  return { blob: new Blob([bytes]), bytes };
}

function same(view: DataView, bytes: Uint8Array, offset: number): boolean {
  for (let i = 0; i < view.byteLength; i++) if (view.getUint8(i) !== bytes[offset + i]) return false;
  return true;
}

describe('BlobReader windows', () => {
  it('serves later views from the 64 KiB head window', async () => {
    const { blob, bytes } = memoryBlob(256 * KiB);
    const r = new BlobReader(blob);
    const a = await r.view(0, 16);
    expect(a.byteLength).toBe(16);
    expect(r.reads).toBe(1);
    expect(r.bytesFetched).toBe(64 * KiB);
    const b = await r.view(1000, 5000);
    expect(r.reads).toBe(1);
    expect(same(b, bytes, 1000)).toBe(true);
  });

  it('fetches only the missing tail when a view starts inside a cached window', async () => {
    const { blob, bytes } = memoryBlob(256 * KiB);
    const r = new BlobReader(blob);
    await r.view(0, 16);
    const v = await r.view(60 * KiB, 10 * KiB, 0);
    expect(same(v, bytes, 60 * KiB)).toBe(true);
    expect(r.reads).toBe(2);
    expect(r.bytesFetched).toBe(70 * KiB);
    expect(r.bytesTransferred).toBe(70 * KiB);
  });

  it('counts unique bytes when windows overlap', async () => {
    const { blob } = memoryBlob(256 * KiB);
    const r = new BlobReader(blob, { maxWindows: 1 });
    await r.view(0, 16, 32 * KiB);
    await r.view(100 * KiB, 16, 32 * KiB);
    await r.view(16 * KiB - 8, 64, 0);
    expect(r.reads).toBe(3);
    expect(r.bytesTransferred).toBe(64 * KiB + 64);
    expect(r.bytesFetched).toBe(64 * KiB);
  });

  it('keeps at most maxWindows windows and evicts the least recently used', async () => {
    const { blob } = memoryBlob(1024 * KiB);
    const r = new BlobReader(blob, { headWindow: 4 * KiB });
    for (const off of [0, 100, 200, 300]) await r.view(off * KiB, 8);
    expect(r.reads).toBe(4);
    await r.view(0, 8);
    expect(r.reads).toBe(4);
    await r.view(400 * KiB, 8);
    expect(r.reads).toBe(5);
    await r.view(0, 8);
    expect(r.reads).toBe(5);
    await r.view(100 * KiB, 8);
    expect(r.reads).toBe(6);
  });

  it('clamps views at the end of the file', async () => {
    const { blob, bytes } = memoryBlob(1000);
    const r = new BlobReader(blob);
    const v = await r.view(996, 32);
    expect(v.byteLength).toBe(4);
    expect(same(v, bytes, 996)).toBe(true);
    expect((await r.view(1000, 8)).byteLength).toBe(0);
    await expect(r.viewExact(996, 32)).rejects.toBeInstanceOf(EndOfFileError);
    await expect(r.view(1001, 8)).rejects.toBeInstanceOf(RangeError);
  });

  it('bytes() returns a copy-free slice of the window', async () => {
    const { blob, bytes } = memoryBlob(4096);
    const r = new BlobReader(blob);
    const b = await r.bytes(10, 20);
    expect(Array.from(b)).toEqual(Array.from(bytes.subarray(10, 30)));
  });
});

describe('BlobReader primitive read', () => {
  it('reads exact ranges and counts every call', async () => {
    const { blob, bytes } = memoryBlob(10 * KiB);
    const r = new BlobReader(blob);
    const a = await r.read(100, 50);
    expect(Array.from(a)).toEqual(Array.from(bytes.subarray(100, 150)));
    await r.read(100, 50);
    expect(r.reads).toBe(2);
    expect(r.bytesTransferred).toBe(100);
    expect(r.bytesFetched).toBe(50);
    expect((await r.read(10 * KiB, 4)).length).toBe(0);
    expect(r.reads).toBe(2);
  });

  it('rejects unsafe offsets and lengths', async () => {
    const { blob } = memoryBlob(16);
    const r = new BlobReader(blob);
    await expect(r.read(2 ** 53, 1)).rejects.toBeInstanceOf(RangeError);
    await expect(r.read(-1, 1)).rejects.toBeInstanceOf(RangeError);
    await expect(r.view(0.5, 1)).rejects.toBeInstanceOf(RangeError);
    await expect(r.read(0, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
  });

  it('readMany keeps order with bounded concurrency', async () => {
    const { blob, bytes } = memoryBlob(64 * KiB);
    const r = new BlobReader(blob);
    const ranges: Array<[number, number]> = Array.from({ length: 10 }, (_, i) => [i * 1000, 100]);
    const out = await r.readMany(ranges, 3);
    out.forEach((b, i) => expect(Array.from(b)).toEqual(Array.from(bytes.subarray(i * 1000, i * 1000 + 100))));
    expect(r.reads).toBe(10);
    expect(r.bytesFetched).toBe(1000);
  });

  it('readMany serves ranges inside a cached window without reading', async () => {
    const { blob, bytes } = memoryBlob(128 * KiB);
    const r = new BlobReader(blob);
    await r.view(0, 16, 128 * KiB);
    const out = await r.readMany([
      [1000, 100],
      [100 * KiB, 4 * KiB],
    ]);
    expect(Array.from(out[1])).toEqual(Array.from(bytes.subarray(100 * KiB, 104 * KiB)));
    expect(out[0]).toHaveLength(100);
    expect(r.reads).toBe(1);
  });

  it('works with a Blob-like object over a size above 4 GiB', async () => {
    const size = 5 * 2 ** 30;
    const calls: Array<[number, number]> = [];
    const blobLike: BlobLike = {
      size,
      slice(start = 0, end = size) {
        calls.push([start, end]);
        return {
          async arrayBuffer() {
            const b = new Uint8Array(end - start);
            for (let i = 0; i < b.length; i++) b[i] = (start + i) % 251;
            return b.buffer;
          },
        };
      },
    };
    const r = new BlobReader(blobLike, { headWindow: 64 });
    const off = 4_500_000_048;
    const v = await r.view(off, 8);
    expect(calls).toEqual([[off, off + 64]]);
    expect(v.getUint8(0)).toBe(off % 251);
    expect(r.size).toBe(size);
  });

  it('throws on a short read', async () => {
    const blobLike: BlobLike = {
      size: 100,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(10) }),
    };
    const r = new BlobReader(blobLike);
    await expect(r.read(0, 50)).rejects.toBeInstanceOf(EndOfFileError);
  });
});

describe('BlobReader abort', () => {
  it('rejects with AbortError before reading once aborted', async () => {
    const { blob } = memoryBlob(1024);
    const ctl = new AbortController();
    const r = new BlobReader(blob, { signal: ctl.signal });
    await r.view(0, 8);
    ctl.abort();
    await expect(r.read(0, 8)).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.reads).toBe(1);
  });

  it('rejects a read that completes after the abort', async () => {
    const ctl = new AbortController();
    const blobLike: BlobLike = {
      size: 100,
      slice: (s = 0, e = 100) => ({
        arrayBuffer: async () => {
          ctl.abort();
          return new ArrayBuffer(e - s);
        },
      }),
    };
    const r = new BlobReader(blobLike, { signal: ctl.signal });
    await expect(r.read(0, 10)).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.reads).toBe(0);
  });
});

describe('DataView helpers', () => {
  const buf = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x01, 0x0c, 0x38, 0x8d, 0x30, 0x00, 0x20, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
  ]);
  const dv = new DataView(buf.buffer);

  it('reads big-endian integers and fourcc', () => {
    expect(u32(dv, 0)).toBe(24);
    expect(fourcc(dv, 4)).toBe('ftyp');
    expect(ascii(dv, 4, 2)).toBe('ft');
    expect(u8(dv, 3)).toBe(0x18);
    expect(u16(dv, 2)).toBe(0x18);
    expect(u24(dv, 1)).toBe(0x18);
    expect(u64(dv, 8)).toBe(4_500_000_048);
    expect(i64(dv, 24)).toBe(-2);
  });

  it('rejects 64-bit values above 2^53-1', () => {
    expect(() => u64(dv, 16)).toThrow(RangeError);
    expect(u64(new DataView(new Uint8Array([0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).buffer), 0)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
