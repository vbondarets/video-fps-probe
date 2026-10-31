import { openAsBlob, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { analyze } from '../../src/analyze.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { RangeSourceError, rangeSource, readCapped, type RangeFetcher, type RangeReply, type RangeRequest } from '../../src/url/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const names = readdirSync(FILES_DIR).sort();
const withoutMs = (r: { io: object }): unknown => ({ ...r, io: { ...r.io, ms: 0 } });

function served(bytes: Uint8Array, reply: (req: RangeRequest) => Partial<RangeReply> = () => ({})) {
  const calls: RangeRequest[] = [];
  const fetcher: RangeFetcher = async (req) => {
    calls.push(req);
    return { status: 206, contentRange: `bytes ${req.start}-${req.end - 1}/${bytes.byteLength}`, contentLength: req.end - req.start, bytes: bytes.subarray(req.start, req.end), ...reply(req) };
  };
  return { fetcher, calls };
}

const OBJECT = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);
const fileCode = async (pending: Promise<unknown>): Promise<string> => {
  try {
    await pending;
    return 'resolved';
  } catch (e) {
    return e instanceof RangeSourceError ? e.code : `${(e as Error).name}: ${(e as Error).message}`;
  }
};

describe('every committed fixture served with 206 by a fetcher', () => {
  test.each(names)('%s gives the Blob results in header and full mode, one fetcher call per read', async (name) => {
    const path = join(FILES_DIR, name);
    const bytes = new Uint8Array(readFileSync(path));
    const blob = await openAsBlob(path);

    const header = served(bytes);
    const headerRange = await analyzeHeader(rangeSource(header.fetcher, { size: bytes.byteLength }), { name });
    expect(withoutMs(headerRange)).toEqual(withoutMs(await analyzeHeader(blob, { name })));
    expect(header.calls.length).toBe(headerRange.io.reads);

    const full = served(bytes);
    const fullRange = await analyze(rangeSource(full.fetcher, { size: bytes.byteLength }), { name });
    expect(withoutMs(fullRange)).toEqual(withoutMs(await analyze(blob, { name })));
    expect(full.calls.length).toBe(fullRange.io.reads);
    for (const call of [...header.calls, ...full.calls]) expect(call.range).toBe(`bytes=${call.start}-${call.end - 1}`);
  });
});

describe('reply validation before the body is read', () => {
  const size = OBJECT.byteLength;

  test('a 200 to a ranged request fails with the body never read and discard called once', async () => {
    const body = vi.fn(async () => OBJECT);
    const discard = vi.fn();
    const source = rangeSource(async () => ({ status: 200, contentLength: size, body, discard }), { size });
    const error = await source.read(0, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeSourceError);
    expect(error).toMatchObject({ name: 'RangeSourceError', code: 'unexpected-status', status: 200 });
    expect(body).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    const result = await analyzeHeader(rangeSource(async () => ({ status: 200, body, discard }), { size: 100_000 }));
    expect(result).toMatchObject({ errorCode: 'read-failed', error: 'file read failed: RangeSourceError: status 200 to bytes=0-65535 of an object of 100000 bytes, expected 206' });
    expect(body).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(2);
    const whole = await analyzeHeader(rangeSource(async () => ({ status: 200, body, discard }), { size }));
    expect(whole.errorCode).toBe('unrecognised');
    expect(body).toHaveBeenCalledTimes(1);
  });

  test('a 200 to the whole object is accepted', async () => {
    const source = rangeSource(async () => ({ status: 200, contentLength: size, bytes: OBJECT }), { size });
    expect(await source.read(0, size)).toEqual(OBJECT);
  });

  test.each([
    ['another start', { contentRange: 'bytes 1-100/4096' }, 'range-mismatch'],
    ['another end', { contentRange: 'bytes 0-99/4096' }, 'range-mismatch'],
    ['an unparsable Content-Range', { contentRange: 'bytes=0-100/4096' }, 'range-mismatch'],
    ['an unsatisfied range', { contentRange: 'bytes */4096' }, 'range-mismatch'],
    ['a wrong total', { contentRange: 'bytes 0-100/5000' }, 'size-changed'],
    ['a Content-Length that differs', { contentLength: 100 }, 'length-mismatch'],
    ['a Content-Length that is not a number', { contentLength: Number.NaN }, 'length-mismatch'],
    ['neither a status nor a Content-Range', { status: null, contentRange: null }, 'unverifiable-reply'],
    ['a 404', { status: 404 }, 'unexpected-status'],
    ['a 416', { status: 416, contentRange: 'bytes */4096' }, 'unexpected-status'],
    ['a short body', { bytes: OBJECT.subarray(0, 100) }, 'body-too-short'],
    ['a long body', { bytes: OBJECT.subarray(0, 102) }, 'body-too-long'],
    ['a body that is not bytes', { bytes: 'text' as unknown as Uint8Array }, 'invalid-reply'],
    ['no bytes and no body', { bytes: undefined }, 'invalid-reply'],
  ] as const)('a reply with %s fails, and analyzeHeader reports read-failed', async (_, patch, code) => {
    const discard = vi.fn();
    const { fetcher } = served(OBJECT, () => ({ ...patch, discard }));
    expect(await fileCode(rangeSource(fetcher, { size }).read(0, 101))).toBe(code);
    if (!code.startsWith('body') && code !== 'invalid-reply') expect(discard).toHaveBeenCalledTimes(1);
    const result = await analyzeHeader(rangeSource(served(OBJECT, () => patch).fetcher, { size }));
    expect(result.errorCode).toBe('read-failed');
    expect(result.error).toMatch(/^file read failed: RangeSourceError: /);
  });

  test('a reply that is not an object fails without a request for its body', async () => {
    expect(await fileCode(rangeSource(async () => null as unknown as RangeReply, { size }).read(0, 10))).toBe('invalid-reply');
    expect(await fileCode(rangeSource((() => 'x') as unknown as RangeFetcher, { size }).read(0, 10))).toBe('invalid-reply');
  });

  test('a 206 without a Content-Range, as a browser reads a cross-origin reply, keeps the status and length checks', async () => {
    const { fetcher } = served(OBJECT, () => ({ contentRange: null }));
    expect(await rangeSource(fetcher, { size }).read(10, 20)).toEqual(OBJECT.subarray(10, 20));
    expect(await fileCode(rangeSource(served(OBJECT, () => ({ contentRange: '', contentLength: 5 })).fetcher, { size }).read(10, 20))).toBe('length-mismatch');
  });

  test('a reply with a Content-Range and no status, a * total and a body function is accepted', async () => {
    const body = vi.fn(async (n: number) => OBJECT.slice(10, 10 + n).buffer);
    const source = rangeSource(async () => ({ contentRange: 'bytes 10-19/*', body }), { size });
    expect(await source.read(10, 20)).toEqual(OBJECT.subarray(10, 20));
    expect(body).toHaveBeenCalledWith(10);
  });

  test('the bytes of a view that does not cover its buffer are copied, a whole buffer is not', async () => {
    const whole = OBJECT.slice(0, 10);
    const view = await rangeSource(async () => ({ status: 206, bytes: whole }), { size }).read(0, 10);
    expect(view.buffer).toBe(whole.buffer);
    const part = await rangeSource(async () => ({ status: 206, bytes: OBJECT.subarray(5, 15) }), { size }).read(5, 15);
    expect(part.buffer).not.toBe(OBJECT.buffer);
    expect([part.byteOffset, part.byteLength, part.buffer.byteLength]).toEqual([0, 10, 10]);
  });

  test('a fetcher that throws or rejects fails the read, and its own AbortError is a read failure, not an abort', async () => {
    const thrown = rangeSource(() => {
      throw new Error('boom');
    }, { size });
    expect(await fileCode(thrown.read(0, 10))).toBe('Error: boom');
    const own = rangeSource(async () => Promise.reject(new DOMException('aborted by the server', 'AbortError')), { size });
    expect(await fileCode(own.read(0, 10))).toBe(': AbortError: aborted by the server');
    const full = await analyze(own, { name: 'x.mp4' });
    expect(full).toMatchObject({ error: 'file read failed: AbortError: aborted by the server', errorCode: 'read-failed' });
    const header = await analyzeHeader(own);
    expect(header).toMatchObject({ error: 'file read failed: AbortError: aborted by the server', errorCode: 'read-failed' });
  });
});

describe('signals', () => {
  const size = OBJECT.byteLength;

  test('a caller abort rejects with its reason, the request carries the signal and a late reply is discarded', async () => {
    let resolveReply: (r: RangeReply) => void = () => {};
    let seen: RangeRequest | null = null;
    const source = rangeSource(
      (req) => {
        seen = req;
        return new Promise<RangeReply>((done) => (resolveReply = done));
      },
      { size },
    );
    const controller = new AbortController();
    const pending = source.read(0, 10, controller.signal);
    await Promise.resolve();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(seen!.signal?.aborted).toBe(true);
    const discard = vi.fn();
    resolveReply({ status: 206, bytes: OBJECT.subarray(0, 10), discard });
    await new Promise((done) => setTimeout(done, 0));
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test('the init signal and the call signal both abort the request, and the listeners are removed after the read', async () => {
    const init = new AbortController();
    const call = new AbortController();
    const add = vi.spyOn(call.signal, 'addEventListener');
    const remove = vi.spyOn(call.signal, 'removeEventListener');
    const signals: (AbortSignal | null)[] = [];
    const { fetcher } = served(OBJECT);
    const source = rangeSource((req) => (signals.push(req.signal), fetcher(req)), { size, signal: init.signal });
    await source.read(0, 10, call.signal);
    expect(add.mock.calls.length).toBeGreaterThan(0);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
    await source.slice(0, 10).arrayBuffer();
    expect(signals[1]).toBe(init.signal);
    init.abort(new Error('closed'));
    await expect(source.read(0, 10, call.signal)).rejects.toThrow('closed');
    await expect(source.slice(0, 10).arrayBuffer()).rejects.toThrow('closed');
  });

  test('an AbortSignal.timeout reason reaches the caller', async () => {
    const source = rangeSource(() => new Promise<RangeReply>(() => {}), { size });
    const error = await source.read(0, 10, AbortSignal.timeout(20)).catch((e: unknown) => e);
    expect((error as Error).name).toBe('TimeoutError');
  });
});

describe('the source as a BlobLike', () => {
  const size = OBJECT.byteLength;

  test('slice clamps to the object as Blob.slice does', async () => {
    const { fetcher, calls } = served(OBJECT);
    const source = rangeSource(fetcher, { size });
    const blob = new Blob([OBJECT]);
    for (const [s, e] of [[undefined, undefined], [10, 20], [-100, undefined], [-100, -50], [4000, 99999], [50, 10], [-99999, 3], [4096, 5000], [1.7, 9.9]] as const) {
      const got = new Uint8Array(await source.slice(s, e).arrayBuffer());
      expect(got, `${s}, ${e}`).toEqual(new Uint8Array(await blob.slice(s, e).arrayBuffer()));
    }
    expect(calls.every((c) => c.end > c.start)).toBe(true);
  });

  test('read checks its arguments, and an empty read makes no request', async () => {
    const { fetcher, calls } = served(OBJECT);
    const source = rangeSource(fetcher, { size });
    expect(source.size).toBe(size);
    expect(await source.read(5, 5)).toEqual(new Uint8Array(0));
    expect(calls).toEqual([]);
    await expect(source.read(-1, 5)).rejects.toThrow(TypeError);
    await expect(source.read(0, 1.5)).rejects.toThrow(TypeError);
    await expect(source.read(10, 5)).rejects.toThrow(RangeError);
    await expect(source.read(0, size + 1)).rejects.toThrow(RangeError);
    await expect(source.read(0, 5, 'x' as unknown as AbortSignal)).rejects.toThrow(TypeError);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '10', undefined, null])('rangeSource throws a TypeError for the size %s', (size) => {
    expect(() => rangeSource(served(OBJECT).fetcher, { size } as unknown as { size: number })).toThrow(TypeError);
  });

  test('rangeSource throws a TypeError for a missing fetcher, init or signal', () => {
    expect(() => rangeSource(null as unknown as RangeFetcher, { size: 1 })).toThrow('fetcher must be a function, got null');
    expect(() => rangeSource(served(OBJECT).fetcher, undefined as unknown as { size: number })).toThrow('init.size must be a non-negative safe integer, got undefined');
    expect(() => rangeSource(served(OBJECT).fetcher, 5 as unknown as { size: number })).toThrow('init must be an object, got 5');
    expect(() => rangeSource(served(OBJECT).fetcher, { size: 1, signal: {} as AbortSignal })).toThrow('init.signal must be an AbortSignal, got an object');
  });
});

function stream(chunks: unknown[], onCancel = vi.fn()): { body: ReadableStream<Uint8Array>; onCancel: typeof onCancel; pulled: () => number } {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array);
      else controller.close();
    },
    cancel: onCancel,
  });
  return { body, onCancel, pulled: () => i };
}

describe('readCapped', () => {
  test('reads a stream of exactly the expected length into one buffer', async () => {
    const { body } = stream([OBJECT.subarray(0, 10), OBJECT.subarray(10, 30).buffer.slice(10, 30), OBJECT.subarray(30, 64)]);
    const got = await readCapped(body, 64);
    expect(got).toEqual(OBJECT.subarray(0, 64));
    expect(got.buffer.byteLength).toBe(64);
  });

  test('cancels the stream once the total passes the expected length', async () => {
    const { body, onCancel, pulled } = stream(Array.from({ length: 100 }, () => OBJECT.subarray(0, 1000)));
    expect(await fileCode(readCapped(body, 2500))).toBe('body-too-long');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(pulled()).toBeLessThanOrEqual(5);
  });

  test('fails on a short end and on a chunk that is not bytes', async () => {
    expect(await fileCode(readCapped(stream([OBJECT.subarray(0, 10)]).body, 11))).toBe('body-too-short');
    const text = stream(['abc', 'def']);
    expect(await fileCode(readCapped(text.body, 3))).toBe('invalid-reply');
    expect(text.onCancel).toHaveBeenCalledTimes(1);
  });

  test('reads an async iterable and calls its return when it stops early', async () => {
    const finished = vi.fn();
    async function* chunks() {
      try {
        for (let i = 0; i < 10; i++) yield OBJECT.subarray(i * 10, i * 10 + 10);
      } finally {
        finished();
      }
    }
    expect(await readCapped(chunks(), 100)).toEqual(OBJECT.subarray(0, 100));
    expect(await fileCode(readCapped(chunks(), 50))).toBe('body-too-long');
    expect(finished).toHaveBeenCalledTimes(2);
  });

  test('an abort cancels the stream and rejects with the reason', async () => {
    const onCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: onCancel });
    const controller = new AbortController();
    const pending = readCapped(body, 10, controller.signal);
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await expect(readCapped(stream([]).body, 0, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  test('checks its arguments', async () => {
    await expect(readCapped(stream([]).body, -1)).rejects.toThrow('expectedLength must be a non-negative safe integer, got -1');
    await expect(readCapped({} as AsyncIterable<Uint8Array>, 1)).rejects.toThrow('body must be a ReadableStream or an async iterable, got an object');
    expect(await readCapped(stream([]).body, 0)).toEqual(new Uint8Array(0));
  });
});
