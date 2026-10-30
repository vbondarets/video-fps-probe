import { getEventListeners } from 'node:events';
import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { analyzeHeader, HEADER_DEFAULT_LIMITS, isAbortError, isTimeoutError, type BlobLike, type HeaderResult } from '../../src/header/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeAll(() => {
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

afterEach(() => {
  vi.useRealTimers();
});

const HEAD = new Uint8Array(await (await openAsBlob(join(FILES_DIR, 'cfr_h264_30.mp4'))).arrayBuffer());

function hanging(size = 10 * 1024 * 1024): BlobLike & { calls: number } {
  const src = {
    size,
    calls: 0,
    slice: () => ({
      arrayBuffer: () => {
        src.calls++;
        return new Promise<ArrayBuffer>(() => {});
      },
    }),
  };
  return src;
}

function ignoringSignals(): BlobLike & { signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    size: 1024 * 1024,
    signals,
    slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }),
    read: (_start: number, _end: number, signal?: AbortSignal | null) => {
      if (signal) signals.push(signal);
      return new Promise<Uint8Array>(() => {});
    },
  } as BlobLike & { signals: AbortSignal[] };
}

function settles<T>(p: Promise<T>): { done: () => boolean } {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { done: () => done };
}

describe('the deadline', () => {
  test('a hanging source stops with time-limit exactly at maxMs and leaves no timer', async () => {
    vi.useFakeTimers();
    const p = analyzeHeader(hanging(), { limits: { maxMs: 500 } });
    const s = settles(p);
    await vi.advanceTimersByTimeAsync(499);
    expect(s.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done()).toBe(true);
    const r = await p;
    expect(r).toMatchObject({ error: 'limit reached: maxMs 500', errorCode: 'time-limit', videoTracks: [], scan: 'header' });
    expect(r.io).toMatchObject({ reads: 0, bytesRead: 0, bytesRequested: 64 * 1024 });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a source that ignores the signal it is given stops with time-limit at maxMs too', async () => {
    vi.useFakeTimers();
    const src = ignoringSignals();
    const p = analyzeHeader(src, { limits: { maxMs: 250 } });
    const s = settles(p);
    await vi.advanceTimersByTimeAsync(249);
    expect(s.done()).toBe(false);
    expect(src.signals).toHaveLength(1);
    expect(src.signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).errorCode).toBe('time-limit');
    expect(src.signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a read that fails after the deadline is never an unhandled rejection', async () => {
    vi.useFakeTimers();
    const src: BlobLike = {
      size: 1024 * 1024,
      slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>((_, reject) => setTimeout(() => reject(new Error('late failure')), 1000)) }),
    };
    const p = analyzeHeader(src, { limits: { maxMs: 100 } });
    await vi.advanceTimersByTimeAsync(100);
    expect((await p).errorCode).toBe('time-limit');
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a maxMs above the timer range does not fire at once', async () => {
    const r = await analyzeHeader(new Blob([HEAD]), { limits: { maxMs: 2 ** 40 } });
    expect(r.error).toBeNull();
    vi.useFakeTimers();
    const p = analyzeHeader(hanging(), { limits: { maxMs: 2 ** 31 } });
    const s = settles(p);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.done()).toBe(false);
    vi.useRealTimers();
  });

  test('maxMs 0 stops before the first read', async () => {
    const src = hanging();
    const r = await analyzeHeader(src, { limits: { maxMs: 0 } });
    expect(r).toMatchObject({ errorCode: 'time-limit', error: 'limit reached: maxMs 0' });
    expect(src.calls).toBe(0);
    expect(r.io.bytesRequested).toBe(0);
  });

  test('with real timers a hanging source settles well under one second', async () => {
    const t0 = performance.now();
    const r = await analyzeHeader(hanging(), { limits: { maxMs: 50 } });
    expect(r.errorCode).toBe('time-limit');
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('the caller signal', () => {
  test('a caller abort rejects with its reason and removes the listener', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped by the caller');
    const p = analyzeHeader(hanging(), { signal: controller.signal, limits: { maxMs: Number.POSITIVE_INFINITY } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('a reason that is not an error is the rejection value as it is', async () => {
    const controller = new AbortController();
    const p = analyzeHeader(hanging(), { signal: controller.signal });
    controller.abort('plain reason');
    await expect(p).rejects.toBe('plain reason');
  });

  test('an already aborted signal rejects before any read', async () => {
    const src = hanging();
    const controller = new AbortController();
    controller.abort();
    const e: unknown = await analyzeHeader(src, { signal: controller.signal }).catch((x: unknown) => x);
    expect(isAbortError(e)).toBe(true);
    expect(src.calls).toBe(0);
  });

  test('an AbortSignal.timeout signal rejects with a TimeoutError', async () => {
    const e: unknown = await analyzeHeader(hanging(), { signal: AbortSignal.timeout(20), limits: { maxMs: Number.POSITIVE_INFINITY } }).catch((x: unknown) => x);
    expect(isTimeoutError(e)).toBe(true);
    expect(isAbortError(e)).toBe(false);
  });

  test('a hanging source with maxMs Infinity settles on the caller abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = analyzeHeader(hanging(), { signal: controller.signal, limits: { maxMs: Number.POSITIVE_INFINITY } });
    const s = settles(p);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.done()).toBe(false);
    controller.abort();
    const e: unknown = await p.catch((x: unknown) => x);
    expect(isAbortError(e)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('an abort after the result leaves the result as it is', async () => {
    const controller = new AbortController();
    const r = await analyzeHeader(new Blob([HEAD]), { signal: controller.signal });
    controller.abort();
    expect(r.error).toBeNull();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('argument validation', () => {
  const blob = new Blob([HEAD]);

  test('the defaults are the documented generous limits', () => {
    expect(HEADER_DEFAULT_LIMITS).toEqual({ maxBytes: 16 * 1024 * 1024, maxReads: 8, maxMs: 10_000, maxTracks: 64, maxTopLevelBoxes: 1024 });
    expect(Object.isFrozen(HEADER_DEFAULT_LIMITS)).toBe(true);
  });

  test('a source size that is not a non-negative safe integer throws TypeError', async () => {
    for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '10', null]) {
      const src = { size, slice: () => new Blob([]) } as unknown as BlobLike;
      await expect(analyzeHeader(src), String(size)).rejects.toThrow(new TypeError(`source.size must be a non-negative safe integer, got ${typeof size === 'string' ? JSON.stringify(size) : String(size)}`));
    }
  });

  test('a source without slice throws TypeError', async () => {
    for (const src of [null, undefined, 5, {}, { size: 10 }]) {
      await expect(analyzeHeader(src as unknown as BlobLike)).rejects.toThrow(TypeError);
    }
  });

  test('every limit must be a non-negative safe integer or Infinity', async () => {
    for (const key of Object.keys(HEADER_DEFAULT_LIMITS)) {
      for (const bad of [-1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53, '8']) {
        await expect(analyzeHeader(blob, { limits: { [key]: bad } }), `${key} ${bad}`).rejects.toThrow(
          new TypeError(`limits.${key} must be a non-negative safe integer or Infinity, got ${typeof bad === 'string' ? JSON.stringify(bad) : String(bad)}`),
        );
      }
      const r = await analyzeHeader(blob, { limits: { [key]: Number.POSITIVE_INFINITY } });
      expect(r.error, key).toBeNull();
    }
  });

  test('every read-ahead size is checked, head from the sniff window and tail from 16 bytes', async () => {
    await expect(analyzeHeader(blob, { readAhead: { head: 1023 } })).rejects.toThrow(new TypeError('readAhead.head must be a non-negative safe integer of at least 1024, got 1023'));
    await expect(analyzeHeader(blob, { readAhead: { tail: 15 } })).rejects.toThrow(new TypeError('readAhead.tail must be a non-negative safe integer of at least 16, got 15'));
    await expect(analyzeHeader(blob, { readAhead: { fragment: -1 } })).rejects.toThrow(new TypeError('readAhead.fragment must be a non-negative safe integer, got -1'));
    await expect(analyzeHeader(blob, { readAhead: { matroskaScan: Number.NaN } })).rejects.toThrow(new TypeError('readAhead.matroskaScan must be a non-negative safe integer, got NaN'));
    const r = await analyzeHeader(blob, { readAhead: { head: 1024, tail: 16, fragment: 0, matroskaScan: 0 } });
    expect(r.error).toBeNull();
  });

  test('the other options are checked too', async () => {
    await expect(analyzeHeader(blob, { fragmentedDuration: 'all' as 'index' })).rejects.toThrow(new TypeError(`fragmentedDuration must be 'header' or 'index', got "all"`));
    await expect(analyzeHeader(blob, { name: 5 as unknown as string })).rejects.toThrow(new TypeError('name must be a string, got 5'));
    await expect(analyzeHeader(blob, { signal: {} as AbortSignal })).rejects.toThrow(new TypeError('signal must be an AbortSignal, got an object'));
    await expect(analyzeHeader(blob, { limits: 5 as unknown as object })).rejects.toThrow(new TypeError('limits must be an object, got 5'));
    await expect(analyzeHeader(blob, null as unknown as object)).rejects.toThrow(new TypeError('options must be an object, got null'));
  });

  test('a File keeps its name unless the options give one', async () => {
    const file = new File([HEAD], 'clip.mp4');
    expect((await analyzeHeader(file)).name).toBe('clip.mp4');
    expect((await analyzeHeader(file, { name: 'other.mp4' })).name).toBe('other.mp4');
    expect((await analyzeHeader(blob)).name).toBe('');
  });
});

describe('read and byte limits', () => {
  test('maxReads 0 and maxBytes 0 stop before the first read with their codes', async () => {
    const blob = new Blob([HEAD]);
    const reads: HeaderResult = await analyzeHeader(blob, { limits: { maxReads: 0 } });
    expect(reads).toMatchObject({ errorCode: 'read-limit', error: 'limit reached: maxReads 0' });
    expect(reads.io).toMatchObject({ reads: 0, bytesRequested: 0 });
    const bytes = await analyzeHeader(blob, { limits: { maxBytes: 0 } });
    expect(bytes).toMatchObject({ errorCode: 'byte-limit', error: 'limit reached: maxBytes 0 (1024 more bytes needed at offset 0)' });
  });

  test('read-ahead is clipped to the bytes left, so a small maxBytes still reads the sniff window', async () => {
    const r = await analyzeHeader(new Blob([HEAD]), { limits: { maxBytes: 4096 } });
    expect(r.io.bytesRequested).toBeLessThanOrEqual(4096);
    expect(r.errorCode).toBe('byte-limit');
  });

  test('a source that throws is read-failed', async () => {
    const src: BlobLike = { size: 100_000, slice: () => ({ arrayBuffer: () => Promise.reject(new Error('disk gone')) }) };
    expect(await analyzeHeader(src)).toMatchObject({ errorCode: 'read-failed', error: 'file read failed: Error: disk gone' });
  });

  test('a source with a read method gets the range and the internal signal', async () => {
    const calls: Array<[number, number, boolean]> = [];
    const src = {
      size: HEAD.length,
      slice: () => {
        throw new Error('not used');
      },
      read: async (start: number, end: number, signal?: AbortSignal | null) => {
        calls.push([start, end, signal instanceof AbortSignal]);
        return HEAD.subarray(start, end);
      },
    };
    const r = await analyzeHeader(src);
    expect(r.error).toBeNull();
    expect(calls.length).toBe(r.io.reads);
    expect(calls.every(([, , signal]) => signal)).toBe(true);
  });
});
