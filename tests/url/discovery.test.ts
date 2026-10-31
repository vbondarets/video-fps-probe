import { openAsBlob, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { analyzeHeader } from '../../src/header/index.ts';
import { RangeSourceError, httpRange, openRangeSource, rangeSource, type RangeFetcher, type RangeReply } from '../../src/url/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { objectRoute, startServer, type TestServer } from './server.ts';

const HEAD = 65536;
const bytesOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
const withoutMs = (r: { io: object }): unknown => ({ ...r, io: { ...r.io, ms: 0 } });
const fixtures = readdirSync(FILES_DIR).sort().filter((n) => statSync(join(FILES_DIR, n)).size > 0);

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.close();
});

const codeOf = async (pending: Promise<unknown>): Promise<string> => {
  try {
    await pending;
    return 'resolved';
  } catch (e) {
    return e instanceof RangeSourceError ? e.code : `${(e as Error).name}: ${(e as Error).message}`;
  }
};

describe('discovery over HTTP', () => {
  test.each([
    ['1000 bytes', 1000, 'bytes=0-65535'],
    ['exactly headBytes', HEAD, 'bytes=0-65535'],
    ['1 MiB', 1 << 20, 'bytes=0-65535'],
  ])('an object of %s takes one discovery request', async (label, size, range) => {
    const object = bytesOf(size);
    const route = `/discover/${size}`;
    server.route(route, objectRoute(object));
    const source = await openRangeSource(httpRange(server.url(route)));
    expect(source.size, label).toBe(size);
    expect(server.requests(route)).toEqual([range]);
    const cached = Math.min(size, HEAD);
    expect(await source.read(0, cached)).toEqual(object.subarray(0, cached));
    expect(await source.read(cached >> 1, cached)).toEqual(object.subarray(cached >> 1, cached));
    expect(new Uint8Array(await source.slice(0, cached).arrayBuffer())).toEqual(object.subarray(0, cached));
    expect(server.requests(route)).toHaveLength(1);
    if (size > HEAD) {
      expect(await source.read(HEAD - 10, HEAD + 10)).toEqual(object.subarray(HEAD - 10, HEAD + 10));
      expect(server.requests(route)).toEqual([range, `bytes=${HEAD - 10}-${HEAD + 9}`]);
    }
  });

  test('the clamped 206 of a 1000-byte object is accepted and cached as bytes 0-999', async () => {
    const object = bytesOf(1000);
    server.route('/clamped', objectRoute(object));
    const http = httpRange(server.url('/clamped'));
    const replies: (string | null | undefined)[] = [];
    const source = await openRangeSource(async (req) => {
      const reply = await http(req);
      replies.push(reply.contentRange);
      return reply;
    });
    expect(replies).toEqual(['bytes 0-999/1000']);
    expect(source.size).toBe(1000);
    expect(await source.read(0, 1000)).toEqual(object);
    expect(await source.read(999, 1000)).toEqual(object.subarray(999));
    expect(server.requests('/clamped')).toHaveLength(1);
    const result = await analyzeHeader(source, { name: 'clamped.bin' });
    expect(result).toMatchObject({ errorCode: 'unrecognised', io: { reads: 1, bytesRead: 1000 } });
    expect(server.requests('/clamped')).toHaveLength(1);
  });

  test.each(fixtures)('%s: network requests equal io.reads for analyzeHeader with the default head', async (name) => {
    const path = join(FILES_DIR, name);
    const route = `/fixture/${encodeURIComponent(name)}`;
    server.route(route, objectRoute(new Uint8Array(readFileSync(path))));
    const source = await openRangeSource(httpRange(server.url(route)));
    const result = await analyzeHeader(source, { name });
    expect(server.requests(route).length).toBe(result.io.reads);
    expect(withoutMs(result)).toEqual(withoutMs(await analyzeHeader(await openAsBlob(path), { name })));
  });

  test('an empty object answers 416 with bytes */0 and gives an empty source', async () => {
    server.route('/empty', objectRoute(new Uint8Array(0)));
    const source = await openRangeSource(httpRange(server.url('/empty')));
    expect(source.size).toBe(0);
    expect(server.requests('/empty')).toEqual(['bytes=0-65535']);
    expect(await analyzeHeader(source)).toMatchObject({ errorCode: 'empty-file', io: { reads: 0 } });
    expect(server.requests('/empty')).toHaveLength(1);
  });

  test('a known size issues no request and a later read uses the strict rule', async () => {
    const object = bytesOf(1000);
    server.route('/known', objectRoute(object));
    const source = await openRangeSource(httpRange(server.url('/known')), { size: 1000 });
    expect(server.requests('/known')).toEqual([]);
    expect(await source.read(0, 1000)).toEqual(object);
    expect(await codeOf((await openRangeSource(httpRange(server.url('/known')), { size: 2000 })).read(0, 2000))).toBe('size-changed');
    expect(await codeOf((await openRangeSource(httpRange(server.url('/known')), { size: 2000 })).read(0, 100))).toBe('size-changed');
  });

  test('a smaller headBytes asks for that window', async () => {
    const object = bytesOf(5000);
    server.route('/head-1024', objectRoute(object));
    const source = await openRangeSource(httpRange(server.url('/head-1024')), { headBytes: 1024 });
    expect(source.size).toBe(5000);
    expect(server.requests('/head-1024')).toEqual(['bytes=0-1023']);
  });
});

describe('discovery replies', () => {
  const object = bytesOf(3000);
  const reply = (patch: Partial<RangeReply>): RangeFetcher => async () => ({ status: 206, contentRange: 'bytes 0-2999/3000', contentLength: 3000, bytes: object, ...patch });

  test('a 200 with a known Content-Length of at most headBytes is the whole object, read with that cap', async () => {
    const body = vi.fn(async (n: number) => object.slice(0, n));
    const source = await openRangeSource(reply({ status: 200, contentRange: null, contentLength: 3000, bytes: undefined, body }));
    expect(source.size).toBe(3000);
    expect(body).toHaveBeenCalledWith(3000);
    const empty = await openRangeSource(reply({ status: 200, contentRange: null, contentLength: 0, bytes: new Uint8Array(0) }));
    expect(empty.size).toBe(0);
  });

  test.each([
    ['a 200 without a Content-Length', { status: 200, contentRange: null, contentLength: null }, 'unexpected-status'],
    ['a 200 larger than headBytes', { status: 200, contentRange: null, contentLength: 70000 }, 'unexpected-status'],
    ['a 200 with a Content-Range of another size', { status: 200, contentRange: 'bytes 0-2999/4000', contentLength: 3000 }, 'range-mismatch'],
    ['a 206 without a Content-Range', { contentRange: null }, 'unverifiable-reply'],
    ['a 206 with a * total', { contentRange: 'bytes 0-2999/*' }, 'range-mismatch'],
    ['a 206 that does not start at 0', { contentRange: 'bytes 1-2999/3000' }, 'range-mismatch'],
    ['a 206 that is not clamped to the object', { contentRange: 'bytes 0-65535/3000' }, 'range-mismatch'],
    ['a 206 shorter than the object and headBytes', { contentRange: 'bytes 0-999/3000', contentLength: 1000 }, 'range-mismatch'],
    ['a 206 with a total that is not a safe integer', { contentRange: 'bytes 0-2999/99999999999999999999' }, 'range-mismatch'],
    ['a Content-Length that differs', { contentLength: 2999 }, 'length-mismatch'],
    ['a 416 for a non-empty object', { status: 416, contentRange: 'bytes */3000' }, 'unexpected-status'],
    ['a 404', { status: 404, contentRange: null }, 'unexpected-status'],
    ['neither a status nor a Content-Range', { status: null, contentRange: null }, 'unverifiable-reply'],
    ['a short body', { bytes: object.subarray(0, 2999) }, 'body-too-short'],
  ] as const)('%s is refused with RangeSourceError', async (_, patch, code) => {
    const discard = vi.fn();
    expect(await codeOf(openRangeSource(reply({ ...patch, discard })))).toBe(code);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test('a Content-Range without a status is enough, and 416 with bytes */0 needs no body', async () => {
    expect((await openRangeSource(reply({ status: null }))).size).toBe(3000);
    const discard = vi.fn();
    expect((await openRangeSource(async () => ({ status: 416, contentRange: 'bytes */0', discard }))).size).toBe(0);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test('a caller abort rejects with its reason', async () => {
    const reason = new Error('stop');
    await expect(openRangeSource(reply({}), { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const controller = new AbortController();
    const pending = openRangeSource(() => new Promise<RangeReply>(() => {}), { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test('checks its arguments', async () => {
    await expect(openRangeSource('x' as unknown as RangeFetcher)).rejects.toThrow('fetcher must be a function, got "x"');
    await expect(openRangeSource(reply({}), { headBytes: 0 })).rejects.toThrow('init.headBytes must be a non-negative safe integer of at least 1, got 0');
    await expect(openRangeSource(reply({}), { size: -1 })).rejects.toThrow(TypeError);
    await expect(openRangeSource(reply({}), null as unknown as object)).rejects.toThrow('init must be an object, got null');
  });
});

describe('rangeSource sizes', () => {
  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1000', null])('a size of %s throws a TypeError', (size) => {
    expect(() => rangeSource(async () => ({ status: 206 }), { size: size as number })).toThrow(TypeError);
  });

  test('a known size issues no request', () => {
    const fetcher = vi.fn<RangeFetcher>();
    expect(rangeSource(fetcher, { size: 0 }).size).toBe(0);
    expect(rangeSource(fetcher, { size: Number.MAX_SAFE_INTEGER }).size).toBe(Number.MAX_SAFE_INTEGER);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
