import { describe, expect, it } from 'vitest';
import { containerFamily, sniff } from '../../src/core/sniff.ts';

function box(size: number, type: string, extra: number[] = []): Uint8Array {
  const out = new Uint8Array(8 + extra.length);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(extra, 8);
  return out;
}

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('sniff', () => {
  it.each(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'moof', 'styp', 'sidx'])(
    'detects ISO BMFF from a top-level %s box',
    (type) => {
      expect(sniff(box(24, type, new Array(16).fill(0))).kind).toBe('isobmff');
    },
  );

  it('accepts size 0 (to end of file) and size 1 (64-bit largesize)', () => {
    expect(sniff(box(0, 'mdat')).kind).toBe('isobmff');
    const large = box(1, 'mdat', [0, 0, 0, 1, 0x0c, 0x38, 0x8d, 0x30]);
    expect(sniff(large)).toMatchObject({ kind: 'isobmff', reason: expect.stringContaining('64-bit') });
  });

  it('rejects an impossible box size', () => {
    expect(sniff(box(3, 'ftyp')).kind).toBe('unknown');
    expect(sniff(box(1, 'mdat', [0, 0, 0, 0, 0, 0, 0, 8])).kind).toBe('unknown');
    expect(sniff(box(1, 'mdat')).kind).toBe('unknown');
  });

  it('rejects unknown box types', () => {
    expect(sniff(box(24, 'abcd', new Array(16).fill(0))).kind).toBe('unknown');
  });

  it('detects Matroska and WebM from the EBML magic', () => {
    expect(sniff(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]))).toMatchObject({ kind: 'matroska' });
    expect(sniff(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])).kind).toBe('matroska');
  });

  it('names common non-video signatures', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    expect(sniff(png)).toEqual({ kind: 'unknown', reason: 'PNG image' });
    expect(sniff(text('hello, this is not a video file\n'))).toEqual({ kind: 'unknown', reason: 'text file' });
    expect(sniff(new Uint8Array(0))).toEqual({ kind: 'unknown', reason: 'empty file' });
    expect(sniff(new Uint8Array([1, 2, 3])).reason).toMatch(/too small/);
    const garbage = new Uint8Array(256);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 73 + 41) & 0xff;
    expect(sniff(garbage)).toEqual({ kind: 'unknown', reason: 'no known signature' });
  });

  it('ignores the content beyond the magic, never an extension', () => {
    const renamed = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...text('ftyp')]);
    expect(sniff(renamed).kind).toBe('matroska');
  });
});

describe('containerFamily', () => {
  it('maps a blob head to the container family, or null', async () => {
    const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]);
    expect(await containerFamily(blob(box(16, 'ftyp', [0, 0, 0, 0, 0, 0, 0, 0])))).toBe('isobmff');
    expect(await containerFamily(blob(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])))).toBe('matroska');
    expect(await containerFamily(blob(text('hello world')))).toBeNull();
    expect(await containerFamily(blob(new Uint8Array(0)))).toBeNull();
  });

  it('reads only the first kilobyte', async () => {
    const reads: [number, number][] = [];
    const head = new Uint8Array(2048);
    head.set(box(0, 'mdat'));
    const big = { size: 1 << 30, slice: (s = 0, e = 0) => (reads.push([s, e]), { arrayBuffer: async () => head.slice(s, Math.min(e, head.length)).buffer }) };
    expect(await containerFamily(big)).toBe('isobmff');
    expect(reads).toEqual([[0, 1024]]);
  });
});
