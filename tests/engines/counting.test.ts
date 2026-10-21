import { describe, expect, it } from 'vitest';
import { CountingBlob, elapsed, now, timed } from '../../src/engines/counting.ts';

function patterned(size: number): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
  return new Blob([bytes]);
}

describe('CountingBlob', () => {
  it('counts each arrayBuffer call as one read and tracks unique bytes', async () => {
    const counted = new CountingBlob(patterned(1000));
    expect(counted.size).toBe(1000);
    expect(counted.stats()).toEqual({ reads: 0, bytesRead: 0, bytesTransferred: 0 });
    await counted.slice(0, 100).arrayBuffer();
    await counted.slice(50, 200).arrayBuffer();
    await counted.slice(500, 600).arrayBuffer();
    await counted.slice(150, 550).arrayBuffer();
    expect(counted.stats()).toEqual({ reads: 4, bytesRead: 600, bytesTransferred: 100 + 150 + 100 + 400 });
  });

  it('does not count a slice that is created but never read', async () => {
    const counted = new CountingBlob(patterned(64));
    counted.slice(0, 10);
    expect(counted.stats().reads).toBe(0);
  });

  it('returns the underlying bytes and clamps ranges to the size', async () => {
    const counted = new CountingBlob(patterned(300));
    const ab = await counted.slice(250, 9999).arrayBuffer();
    expect(ab.byteLength).toBe(50);
    expect(new Uint8Array(ab)[0]).toBe(250);
    const empty = await counted.slice(400, 500).arrayBuffer();
    expect(empty.byteLength).toBe(0);
    expect(counted.stats().bytesRead).toBe(50);
  });

  it('rejects reads once the signal is aborted', async () => {
    const controller = new AbortController();
    const counted = new CountingBlob(patterned(64), controller.signal);
    await counted.slice(0, 8).arrayBuffer();
    controller.abort();
    await expect(counted.slice(8, 16).arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
    expect(counted.stats().reads).toBe(1);
  });

  it('reports io stats with elapsed time', async () => {
    const counted = new CountingBlob(patterned(64));
    const t0 = now();
    await counted.slice(0, 64).arrayBuffer();
    const io = counted.io(t0);
    expect(io.reads).toBe(1);
    expect(io.bytesRead).toBe(64);
    expect(io.ms).toBeGreaterThanOrEqual(0);
  });
});

describe('timing helpers', () => {
  it('measures a promise', async () => {
    const { value, ms } = await timed(async () => 7);
    expect(value).toBe(7);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(elapsed(now())).toBeGreaterThanOrEqual(0);
  });
});
