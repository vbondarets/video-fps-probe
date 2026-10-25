import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Lazy, Pools } from '../../src/client/probe.ts';
import type { WorkerPool } from '../../src/client/pool.ts';
import { EBML, familyOf, splitRoute } from '../../src/client/route.ts';
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

  it('settles ISO BMFF when classifying the head throws, without an unhandled rejection', async () => {
    for (const value of [-1, Symbol('head'), 2 ** 53]) {
      const odd = { slice: () => ({ arrayBuffer: () => Promise.resolve(value) }) } as unknown as Blob;
      expect(await familyOf(odd), String(value)).toBe('isobmff');
    }
  });

  it('settles ISO BMFF when the read rejects or throws', async () => {
    const rejecting = { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) } as unknown as Blob;
    expect(await familyOf(rejecting)).toBe('isobmff');
    const throwing = {
      slice: () => ({
        arrayBuffer: () => {
          throw new Error('NotReadableError');
        },
      }),
    } as unknown as Blob;
    expect(await familyOf(throwing)).toBe('isobmff');
  });

  it('settles ISO BMFF for an input that is not a Blob', async () => {
    for (const input of [{}, null, undefined, 'video.webm', 42, { slice: () => null }]) expect(await familyOf(input as unknown as Blob), String(input)).toBe('isobmff');
  });

  it('settles ISO BMFF without reading when the signal is aborted before the call', async () => {
    const slice = vi.fn(() => new Blob([new Uint8Array(EBML)]));
    expect(await familyOf({ slice } as unknown as Blob, AbortSignal.abort())).toBe('isobmff');
    expect(slice).not.toHaveBeenCalled();
  });

  it('settles ISO BMFF when the signal aborts during the read, and a late Matroska head does not change it', async () => {
    const pending = { slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }) } as unknown as Blob;
    const controller = new AbortController();
    const routed = familyOf(pending, controller.signal);
    controller.abort();
    expect(await routed).toBe('isobmff');
    let finish: (b: ArrayBuffer) => void = () => {};
    const late = { slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>((r) => (finish = r)) }) } as unknown as Blob;
    const second = new AbortController();
    const raced = familyOf(late, second.signal);
    second.abort();
    finish(new Uint8Array(EBML).buffer);
    expect(await raced).toBe('isobmff');
  });

  it('removes its abort listener once the head is read or classifying it fails', async () => {
    const heads: Blob[] = [new Blob([new Uint8Array(EBML)]), new Blob([]), { slice: () => ({ arrayBuffer: () => Promise.resolve(-1) }) } as unknown as Blob, {} as Blob];
    for (const [i, head] of heads.entries()) {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      expect(await familyOf(head, controller.signal), String(i)).toBe(i === 0 ? 'matroska' : 'isobmff');
      await Promise.resolve();
      expect(add, String(i)).toHaveBeenCalledTimes(1);
      expect(remove, String(i)).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    }
  });
});

describe('splitRoute', () => {
  const setup = () => {
    const calls: [string, unknown][] = [];
    const created = new Map<string, () => Worker>();
    const pools: Pools = (key, create) => {
      created.set(key, create);
      return { run: async (request: unknown) => (calls.push([key, request]), { key }) } as unknown as WorkerPool;
    };
    const lazy: Lazy = (chunk) => chunk;
    return { calls, created, pools, lazy };
  };
  const matroska = () => ({}) as Worker;
  const custom = () => ({}) as Worker;
  const analyzeOf = (file: Blob) => ({ type: 'analyze' as const, file, name: 'x', engine: 'own' as const, options: {} });

  it('runs a Matroska head on the worker of its family and every other head on the worker of the route', async () => {
    const { calls, created, pools, lazy } = setup();
    const runner = splitRoute('custom', { matroska }, pools, lazy, new AbortController().signal, custom);
    if (!('pool' in runner)) throw new Error('not a pool route');
    expect(runner.kind).toBe('custom');
    expect(await runner.pool().run(analyzeOf(new Blob([new Uint8Array(EBML)])), {})).toEqual({ key: 'custom-matroska' });
    expect(await runner.pool().run(analyzeOf(new Blob([new Uint8Array([0, 0, 0, 0x18])])), {})).toEqual({ key: 'custom' });
    expect(calls.map(([key]) => key)).toEqual(['custom-matroska', 'custom']);
    expect([...created]).toEqual([
      ['custom-matroska', matroska],
      ['custom', custom],
    ]);
  });

  it('gives prewarm the pool of each family without a file: the worker of the family, else the worker of the route', () => {
    const { calls, created, pools, lazy } = setup();
    const route = splitRoute('custom', { matroska }, pools, lazy, new AbortController().signal, custom);
    if (!('pool' in route) || !route.warmPools) throw new Error('not a split route');
    expect(route.warmPools(['matroska', 'isobmff', 'matroska']).map(([, families]) => families)).toEqual([['isobmff'], ['matroska']]);
    expect(route.warmPools([])).toEqual([]);
    expect([...created]).toEqual([
      ['custom', custom],
      ['custom-matroska', matroska],
    ]);
    expect(calls).toEqual([]);
  });

  it('rejects through lazy and reaches no pool when the probe is destroyed while the head is read', async () => {
    const { calls, pools } = setup();
    const life = new AbortController();
    const destroyed = new Error('probe destroyed');
    const lazy: Lazy = <T>(chunk: Promise<T>) => {
      if (!life.signal.aborted) {
        life.abort();
        return chunk;
      }
      chunk.catch(() => {});
      return Promise.reject(destroyed);
    };
    const route = splitRoute('own', { matroska }, pools, lazy, life.signal);
    if (!('pool' in route)) throw new Error('not a pool route');
    await expect(route.pool().run(analyzeOf(new Blob([new Uint8Array(EBML)])), {})).rejects.toBe(destroyed);
    expect(calls).toEqual([]);
  });
});
