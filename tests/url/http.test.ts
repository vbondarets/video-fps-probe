import { openAsBlob, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { analyze } from '../../src/analyze.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import { RangeSourceError, httpRange, rangeSource, type RangeFetcher, type RangeRequest } from '../../src/url/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { objectRoute, startServer, type TestServer } from './server.ts';

const names = readdirSync(FILES_DIR).sort();
const withoutMs = (r: { io: object }): unknown => ({ ...r, io: { ...r.io, ms: 0 } });
const OBJECT = Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 13) & 0xff);
const SIZE = OBJECT.byteLength;

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.close();
});

const within = <T>(pending: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([pending, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms))]);

function spied(fetcher: RangeFetcher) {
  const requests: RangeRequest[] = [];
  let discarded = 0;
  let bodies = 0;
  const wrapped: RangeFetcher = async (req) => {
    requests.push(req);
    const reply = await fetcher(req);
    return {
      ...reply,
      body: (n: number) => (bodies++, reply.body!(n)),
      discard: () => (discarded++, reply.discard!()),
    };
  };
  return { fetcher: wrapped, requests, discarded: () => discarded, bodies: () => bodies };
}

const codeOf = (e: unknown): string => (e instanceof RangeSourceError ? e.code : `${(e as Error).name}: ${(e as Error).message}`);

describe('every committed fixture served with 206 over HTTP', () => {
  test.each(names)('%s gives the Blob results with one request per read', async (name) => {
    const path = join(FILES_DIR, name);
    const bytes = new Uint8Array(readFileSync(path));
    const route = `/fixture/${encodeURIComponent(name)}`;
    server.route(route, objectRoute(bytes));
    const blob = await openAsBlob(path);
    const header = await analyzeHeader(rangeSource(httpRange(server.url(route)), { size: bytes.byteLength }), { name });
    expect(withoutMs(header)).toEqual(withoutMs(await analyzeHeader(blob, { name })));
    expect(server.requests(route).length).toBe(header.io.reads);
    const full = await analyze(rangeSource(httpRange(server.url(route)), { size: bytes.byteLength }), { name });
    expect(withoutMs(full)).toEqual(withoutMs(await analyze(blob, { name })));
    expect(server.requests(route).length).toBe(header.io.reads + full.io.reads);
    expect(server.requests(route).every((r) => /^bytes=\d+-\d+$/.test(r))).toBe(true);
  });
});

describe('replies that fail closed', () => {
  test('a 200 to a ranged request gives read-failed, with the body never read, discard called and the socket closed', async () => {
    server.route('/whole', (_, res) => {
      res.writeHead(200, { 'content-length': String(SIZE) });
      res.write(Buffer.from(OBJECT.subarray(0, 65536)));
    });
    const closed = server.socketClosed('/whole');
    const spy = spied(httpRange(server.url('/whole')));
    const result = await analyzeHeader(rangeSource(spy.fetcher, { size: SIZE }), { name: 'whole.mp4' });
    expect(result).toMatchObject({ errorCode: 'read-failed', error: `file read failed: RangeSourceError: status 200 to bytes=0-65535 of an object of ${SIZE} bytes, expected 206` });
    expect(spy.bodies()).toBe(0);
    expect(spy.discarded()).toBe(1);
    await within(closed, 2000, 'the close of the socket');
  });

  test.each([
    ['another range', (first: number, last: number) => ({ 'content-range': `bytes ${first + 1}-${last}/${SIZE}` }), 'range-mismatch'],
    ['a wrong total', (first: number, last: number) => ({ 'content-range': `bytes ${first}-${last}/${SIZE + 1}` }), 'size-changed'],
    ['a Content-Length that differs', (first: number, last: number) => ({ 'content-range': `bytes ${first}-${last}/${SIZE}`, 'content-length': String(last - first) }), 'length-mismatch'],
  ] as const)('a 206 with %s gives read-failed', async (label, headers, code) => {
    const route = `/bad/${code}`;
    server.route(route, (req, res) => {
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
      const body = Buffer.from(OBJECT.subarray(Number(a), Number(b) + 1));
      const h: Record<string, string> = headers(Number(a), Number(b));
      const n = h['content-length'] === undefined ? body.byteLength : Number(h['content-length']);
      res.writeHead(206, { ...h, 'content-length': String(n) }).end(body.subarray(0, n));
    });
    const error = await rangeSource(httpRange(server.url(route)), { size: SIZE }).read(100, 200).catch((e: unknown) => e);
    expect(codeOf(error), label).toBe(code);
    const result = await analyzeHeader(rangeSource(httpRange(server.url(route)), { size: SIZE }));
    expect(result.errorCode).toBe('read-failed');
    expect(result.error).toMatch(/^file read failed: RangeSourceError: /);
  });

  test('a short body gives read-failed', async () => {
    server.route('/short', (req, res) => {
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${SIZE}` }).end(Buffer.from(OBJECT.subarray(Number(a), Number(b))));
    });
    expect(codeOf(await rangeSource(httpRange(server.url('/short')), { size: SIZE }).read(0, 100).catch((e: unknown) => e))).toBe('body-too-short');
    expect((await analyzeHeader(rangeSource(httpRange(server.url('/short')), { size: SIZE }))).errorCode).toBe('read-failed');
  });

  test('a body cut before its Content-Length gives read-failed', async () => {
    server.route('/cut', (req, res) => {
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${SIZE}`, 'content-length': String(Number(b) - Number(a) + 1) });
      res.write(Buffer.from(OBJECT.subarray(0, 10)), () => res.destroy());
    });
    const result = await analyzeHeader(rangeSource(httpRange(server.url('/cut')), { size: SIZE }));
    expect(result.errorCode).toBe('read-failed');
  });

  test('a 206 without Content-Length and an oversized chunked body is cancelled once it passes the range', async () => {
    let written = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    server.route('/endless', (req, res) => {
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${SIZE}` });
      timer = setInterval(() => {
        written += 1024;
        res.write(Buffer.alloc(1024));
      }, 2);
      res.once('close', () => clearInterval(timer));
    });
    const closed = server.socketClosed('/endless');
    const error = await rangeSource(httpRange(server.url('/endless')), { size: SIZE }).read(0, 4096).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('body-too-long');
    await within(closed, 2000, 'the close of the socket');
    clearInterval(timer);
    expect(written).toBeLessThan(512 * 1024);
  });
});

describe('aborts and deadlines close the socket', () => {
  test('a caller abort rejects with its reason and closes the socket', async () => {
    server.route('/stall-abort', () => {});
    const closed = server.socketClosed('/stall-abort');
    const spy = spied(httpRange(server.url('/stall-abort')));
    const controller = new AbortController();
    const pending = rangeSource(spy.fetcher, { size: SIZE }).read(0, 100, controller.signal);
    await within(new Promise<void>((done) => setTimeout(done, 50)), 1000, 'the wait');
    const reason = new Error('caller stopped');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(spy.requests[0]!.signal?.aborted).toBe(true);
    await within(closed, 2000, 'the close of the socket');
  });

  test('a caller abort of analyzeHeader rejects with its reason and closes the socket', async () => {
    server.route('/stall-header-abort', () => {});
    const closed = server.socketClosed('/stall-header-abort');
    const controller = new AbortController();
    const pending = analyzeHeader(rangeSource(httpRange(server.url('/stall-header-abort')), { size: SIZE }), { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller stopped')), 50);
    await expect(pending).rejects.toThrow('caller stopped');
    await within(closed, 2000, 'the close of the socket');
  });

  test.each([
    ['answers nothing', '/stall-nothing', () => {}],
    ['sends its headers and stalls the body', '/stall-body', (res: import('node:http').ServerResponse) => res.writeHead(206, { 'content-range': `bytes 0-65535/${SIZE}`, 'content-length': '65536' }).write(Buffer.alloc(100))],
  ] as const)('a server that %s gives time-limit under maxMs 300 and sees its socket close', async (_, route, stall) => {
    server.route(route, (_req, res) => stall(res));
    const closed = server.socketClosed(route);
    const spy = spied(httpRange(server.url(route)));
    const t0 = performance.now();
    const result = await analyzeHeader(rangeSource(spy.fetcher, { size: SIZE }), { limits: { maxMs: 300 } });
    const ms = performance.now() - t0;
    expect(result).toMatchObject({ errorCode: 'time-limit', error: 'limit reached: maxMs 300' });
    expect(ms).toBeGreaterThanOrEqual(290);
    expect(ms).toBeLessThan(1500);
    expect(spy.requests).toHaveLength(1);
    expect(spy.requests[0]!.signal?.aborted).toBe(true);
    await within(closed, 1000, 'the close of the socket');
  });
});

describe('httpRange', () => {
  test('sends Range, Accept-Encoding identity and the caller headers, with the caller Range overridden', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    server.route('/headers', (req, res) => {
      seen = req.headers;
      objectRoute(OBJECT)(req, res);
    });
    const fetcher = httpRange(new URL(server.url('/headers')), { headers: { 'if-match': '"etag-1"', Range: 'bytes=9-9' } });
    expect(await rangeSource(fetcher, { size: SIZE }).read(10, 20)).toEqual(OBJECT.subarray(10, 20));
    expect(seen).toMatchObject({ range: 'bytes=10-19', 'if-match': '"etag-1"' });
    expect(seen['accept-encoding']).toMatch(/^identity(?:, identity)?$/);
  });

  test('uses the fetch it is given', async () => {
    const calls: string[] = [];
    const fetcher = httpRange('https://example.invalid/object', {
      fetch: async (url, init) => {
        calls.push(`${String(url)} ${new Headers(init?.headers).get('range')}`);
        return new Response(OBJECT.slice(0, 10), { status: 206, headers: { 'content-range': `bytes 0-9/${SIZE}`, 'content-length': '10' } });
      },
    });
    expect(await rangeSource(fetcher, { size: SIZE }).read(0, 10)).toEqual(OBJECT.subarray(0, 10));
    expect(calls).toEqual(['https://example.invalid/object bytes=0-9']);
  });

  test('checks its arguments', () => {
    expect(() => httpRange('')).toThrow(TypeError);
    expect(() => httpRange(5 as unknown as string)).toThrow('url must be a non-empty string or a URL, got 5');
    expect(() => httpRange('https://example.invalid/', { fetch: 'x' as unknown as typeof fetch })).toThrow(TypeError);
    expect(() => httpRange('https://example.invalid/', { headers: 'x' as unknown as Record<string, string> })).toThrow('init.headers must be an object, got "x"');
  });
});
