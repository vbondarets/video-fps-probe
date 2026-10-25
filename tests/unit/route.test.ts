import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EBML, familyOf } from '../../src/client/route.ts';
import { EBML_MAGIC, sniff } from '../../src/core/sniff.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const sniffsMatroska = (head: Uint8Array) => sniff(head).kind === 'matroska';
const route = async (bytes: Uint8Array<ArrayBuffer>) => familyOf(new Blob([bytes]));

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

describe('familyOf', () => {
  it('reads the EBML magic of sniff()', () => {
    expect([...EBML]).toEqual([...EBML_MAGIC]);
  });

  it('agrees with sniff() on the head of every fixture file, fragmented MP4, WebM and unknown files included', async () => {
    const names = readdirSync(FILES_DIR).filter((n) => !n.startsWith('.'));
    expect(names.length).toBeGreaterThan(100);
    for (const name of names) {
      const blob = await openAsBlob(join(FILES_DIR, name));
      const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
      expect(await familyOf(blob), name).toBe(sniffsMatroska(head) ? 'matroska' : 'isobmff');
    }
  });

  it('agrees with sniff() on short, partial and foreign heads', async () => {
    const heads = [
      [],
      [0x1a],
      [0x1a, 0x45],
      [0x1a, 0x45, 0xdf],
      [0x1a, 0x45, 0xdf, 0xa3],
      [0x1a, 0x45, 0xdf, 0xa4, 0, 0, 0, 0],
      [0x1b, 0x45, 0xdf, 0xa3, 0, 0, 0, 0],
      [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      [...new Uint8Array(376).map((_, i) => (i % 188 === 0 ? 0x47 : 0))],
    ];
    for (const head of heads) expect(await route(new Uint8Array(head)), head.slice(0, 8).join(',')).toBe(sniffsMatroska(new Uint8Array(head)) ? 'matroska' : 'isobmff');
  });

  it('agrees with sniff() on 10,000 random heads, a quarter of them with an EBML prefix', async () => {
    const next = random(20261025);
    let matroska = 0;
    for (let n = 0; n < 10_000; n++) {
      const head = new Uint8Array(next() % 24).map(() => next() & 0xff);
      if (n % 4 === 0) head.set(EBML.slice(0, Math.min(head.length, 1 + (next() % 4))));
      const expected = sniffsMatroska(head);
      if (expected) matroska++;
      expect(await route(head)).toBe(expected ? 'matroska' : 'isobmff');
    }
    expect(matroska).toBeGreaterThan(500);
  });

  it('never rejects: a non-Blob, a read that fails and an aborted read go to the ISO BMFF worker', async () => {
    expect(await familyOf({} as Blob)).toBe('isobmff');
    const failing = { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) } as unknown as Blob;
    expect(await familyOf(failing)).toBe('isobmff');
    const pending = { slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }) } as unknown as Blob;
    const controller = new AbortController();
    const routed = familyOf(pending, controller.signal);
    controller.abort();
    expect(await routed).toBe('isobmff');
    expect(await familyOf(new Blob([new Uint8Array(EBML)]), AbortSignal.abort())).toBe('isobmff');
  });
});
