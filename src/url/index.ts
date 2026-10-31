import type { BlobLike, BlobSlice } from '../core/reader.ts';

export type { BlobLike, BlobSlice } from '../core/reader.ts';

export interface RangeRequest {
  readonly start: number;
  readonly end: number;
  readonly range: string;
  readonly signal: AbortSignal | null;
}

export interface RangeReply {
  readonly status?: number | null;
  readonly contentRange?: string | null;
  readonly contentLength?: number | null;
  readonly bytes?: ArrayBuffer | ArrayBufferView | null;
  readonly body?: (expectedLength: number) => Promise<ArrayBuffer | ArrayBufferView>;
  readonly discard?: () => void;
}

export type RangeFetcher = (request: RangeRequest) => Promise<RangeReply>;

export interface RangeSource extends BlobLike {
  read(start: number, end: number, signal?: AbortSignal | null): Promise<Uint8Array>;
}

export interface RangeSourceInit {
  size: number;
  signal?: AbortSignal | null;
}

export interface OpenRangeSourceInit {
  size?: number;
  headBytes?: number;
  signal?: AbortSignal | null;
}

export interface HttpRangeInit {
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
}

export type RangeSourceErrorCode = 'unverifiable-reply' | 'unexpected-status' | 'range-mismatch' | 'size-changed' | 'length-mismatch' | 'body-too-long' | 'body-too-short' | 'invalid-reply';

export interface RangeSourceErrorOptions {
  status?: number | null;
  cause?: unknown;
}

export class RangeSourceError extends Error {
  readonly code: RangeSourceErrorCode;
  readonly status: number | null;

  constructor(code: RangeSourceErrorCode, message: string, options: RangeSourceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RangeSourceError';
    this.code = code;
    this.status = typeof options.status === 'number' ? options.status : null;
  }
}

const HEAD_BYTES = 65536;
const CONTENT_RANGE = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i;
const noop = (): void => {};
const tag = (v: unknown): string => Object.prototype.toString.call(v);

function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

function count(value: unknown, what: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new TypeError(`${what} must be a non-negative safe integer${min > 0 ? ` of at least ${min}` : ''}, got ${shown(value)}`);
  return value;
}

function signalOf(value: unknown, what: string): AbortSignal | null {
  if (value === undefined || value === null) return null;
  const s = value as Partial<AbortSignal>;
  if (typeof s !== 'object' || typeof s.aborted !== 'boolean' || typeof s.addEventListener !== 'function' || typeof s.removeEventListener !== 'function') throw new TypeError(`${what} must be an AbortSignal, got ${shown(value)}`);
  return value as AbortSignal;
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object, got ${shown(value)}`);
  return value as Record<string, unknown>;
}

function fetcherOf(value: unknown): RangeFetcher {
  if (typeof value !== 'function') throw new TypeError(`fetcher must be a function, got ${shown(value)}`);
  return value as RangeFetcher;
}

const reasonOf = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) throw reasonOf(signal);
}

function linked(a: AbortSignal | null, b: AbortSignal | null): [AbortSignal | null, () => void] {
  if (!a || !b || a === b || a.aborted || b.aborted) return [a?.aborted || !b ? a : b, noop];
  const c = new AbortController();
  const fromA = (): void => c.abort(reasonOf(a));
  const fromB = (): void => c.abort(reasonOf(b));
  a.addEventListener('abort', fromA, { once: true });
  b.addEventListener('abort', fromB, { once: true });
  return [c.signal, () => (a.removeEventListener('abort', fromA), b.removeEventListener('abort', fromB))];
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | null, late: (value: T) => void = noop): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(reasonOf(signal!));
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    pending.then(
      (value) => {
        signal?.removeEventListener('abort', stop);
        if (signal?.aborted) late(value);
        else resolve(value);
      },
      (e: unknown) => {
        signal?.removeEventListener('abort', stop);
        reject(!signal?.aborted && (e as Error | null)?.name === 'AbortError' ? Object.assign(new Error(String(e), { cause: e }), { name: '' }) : e);
      },
    );
  });
}

function attempt<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (e) {
    return Promise.reject(e);
  }
}

function discard(reply: RangeReply | null | undefined): void {
  attempt(() => reply?.discard?.()).catch(noop);
}

function parseRange(value: string): { first: number; last: number; total: number | null } | null {
  const m = CONTENT_RANGE.exec(value);
  if (!m) return null;
  const first = Number(m[1]);
  const last = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || (total !== null && !Number.isSafeInteger(total))) return null;
  return { first, last, total };
}

const present = <T>(value: T | null | undefined): value is T => value !== undefined && value !== null;
const contentRangeOf = ({ contentRange: v }: RangeReply): string | null => (typeof v === 'string' ? (v.trim() === '' ? null : v) : present(v) ? String(v) : null);

function replyOf(value: unknown, range: string): RangeReply {
  if (typeof value !== 'object' || value === null) throw new RangeSourceError('invalid-reply', `the reply to ${range} is ${shown(value)}, not an object`);
  return value as RangeReply;
}

function refusal(reply: RangeReply, start: number, end: number, size: number, range: string): RangeSourceError | null {
  const status = present(reply.status) ? reply.status : null;
  const contentRange = contentRangeOf(reply);
  if (status === null && contentRange === null) return new RangeSourceError('unverifiable-reply', `the reply to ${range} has neither a status nor a Content-Range, so it cannot be checked`);
  if (status !== null && status !== 206 && !(status === 200 && start === 0 && end === size)) {
    return new RangeSourceError('unexpected-status', `status ${status} to ${range} of an object of ${size} bytes, expected 206${start === 0 && end === size ? ' or 200' : ''}`, { status });
  }
  if (contentRange !== null) {
    const r = parseRange(contentRange);
    if (!r || r.first !== start || r.last !== end - 1) return new RangeSourceError('range-mismatch', `Content-Range ${shown(contentRange)} does not match ${range}`, { status });
    if (r.total !== null && r.total !== size) return new RangeSourceError('size-changed', `Content-Range ${shown(contentRange)} gives an object of ${r.total} bytes, the source was opened at ${size} bytes`, { status });
  }
  if (present(reply.contentLength) && reply.contentLength !== end - start) return new RangeSourceError('length-mismatch', `Content-Length ${reply.contentLength} does not match ${range} (${end - start} bytes)`, { status });
  return null;
}

function exactly(value: unknown, length: number, what: string): Uint8Array {
  let bytes: Uint8Array;
  if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (tag(value) === '[object ArrayBuffer]') bytes = new Uint8Array(value as ArrayBuffer);
  else throw new RangeSourceError('invalid-reply', `${what} is ${value === null ? 'null' : typeof value}, not bytes`);
  if (bytes.byteLength > length) throw new RangeSourceError('body-too-long', `${what} holds ${bytes.byteLength} bytes, more than the ${length} requested`);
  if (bytes.byteLength < length) throw new RangeSourceError('body-too-short', `${what} holds ${bytes.byteLength} of the ${length} bytes requested`);
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && tag(bytes.buffer) === '[object ArrayBuffer]' ? bytes : bytes.slice();
}

async function bodyOf(reply: RangeReply, length: number, range: string, signal: AbortSignal | null): Promise<Uint8Array> {
  const what = `the body of ${range}`;
  if (present(reply.bytes)) return exactly(reply.bytes, length, what);
  const read = reply.body;
  if (typeof read !== 'function') throw new RangeSourceError('invalid-reply', `the reply to ${range} has neither bytes nor a body function`);
  return exactly(await untilAborted(attempt(() => read.call(reply, length)), signal), length, what);
}

function request(fetcher: RangeFetcher, start: number, end: number, signal: AbortSignal | null): [string, Promise<RangeReply>] {
  const range = `bytes=${start}-${end - 1}`;
  return [range, untilAborted(attempt(() => fetcher({ start, end, range, signal })), signal, discard).then((value) => replyOf(value, range))];
}

function sourceOf(fetcher: RangeFetcher, size: number, own: AbortSignal | null, head: Uint8Array | null): RangeSource {
  const read = async (start: number, end: number, signal?: AbortSignal | null): Promise<Uint8Array> => {
    count(start, 'start');
    count(end, 'end');
    if (start > end || end > size) throw new RangeError(`read needs start <= end <= size (${size}), got ${start} and ${end}`);
    const [joined, release] = linked(own, signalOf(signal, 'signal'));
    try {
      throwIfAborted(joined);
      if (start === end) return new Uint8Array(0);
      if (head && end <= head.byteLength) return head.slice(start, end);
      const [range, pending] = request(fetcher, start, end, joined);
      const reply = await pending;
      const refused = refusal(reply, start, end, size, range);
      if (refused) {
        discard(reply);
        throw refused;
      }
      return await bodyOf(reply, end - start, range, joined);
    } finally {
      release();
    }
  };
  const clamp = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const n = Math.round(Number(value)) || 0;
    return n < 0 ? Math.max(size + n, 0) : Math.min(n, size);
  };
  return {
    size,
    read,
    slice(start?: number, end?: number): BlobSlice {
      const from = clamp(start, 0);
      const to = Math.max(from, clamp(end, size));
      return { arrayBuffer: () => read(from, to, own).then((bytes) => bytes.buffer as ArrayBuffer) };
    },
  };
}

export function rangeSource(fetcher: RangeFetcher, init: RangeSourceInit): RangeSource {
  const f = fetcherOf(fetcher);
  const o = objectOf(init, 'init');
  return sourceOf(f, count(o.size, 'init.size'), signalOf(o.signal, 'init.signal'), null);
}

export async function openRangeSource(fetcher: RangeFetcher, init: OpenRangeSourceInit = {}): Promise<RangeSource> {
  const f = fetcherOf(fetcher);
  const o = objectOf(init, 'init');
  const signal = signalOf(o.signal, 'init.signal');
  if (o.size !== undefined) return sourceOf(f, count(o.size, 'init.size'), signal, null);
  const headBytes = o.headBytes === undefined ? HEAD_BYTES : count(o.headBytes, 'init.headBytes', 1);
  throwIfAborted(signal);
  const [range, pending] = request(f, 0, headBytes, signal);
  const reply = await pending;
  const status = present(reply.status) ? reply.status : null;
  const contentRange = contentRangeOf(reply);
  const r = contentRange === null ? null : parseRange(contentRange);
  const length = present(reply.contentLength) ? reply.contentLength : null;
  const refuse = (code: RangeSourceErrorCode, message: string): never => {
    discard(reply);
    throw new RangeSourceError(code, message, { status });
  };
  if ((status === 416 || status === null) && contentRange !== null && /^\s*bytes\s+\*\/0\s*$/i.test(contentRange)) {
    discard(reply);
    return sourceOf(f, 0, signal, new Uint8Array(0));
  }
  let size: number;
  if (status === 200) {
    if (length === null || !Number.isSafeInteger(length) || length < 0 || length > headBytes) refuse('unexpected-status', `status 200 to ${range} with ${length === null ? 'no Content-Length' : `Content-Length ${length}`}: the server sent the whole object instead of the range, and only an object of at most ${headBytes} bytes is accepted that way`);
    if (contentRange !== null && (!r || r.first !== 0 || r.last !== length! - 1 || r.total !== length)) refuse('range-mismatch', `Content-Range ${shown(contentRange)} does not match the whole object of ${length} bytes`);
    size = length!;
  } else if (status === 206 || (status === null && contentRange !== null)) {
    if (contentRange === null) refuse('range-mismatch', `the 206 reply to ${range} has no Content-Range, so the object size is unknown: pass init.size`);
    if (!r || r.total === null || r.first !== 0 || r.last !== Math.min(headBytes, r.total) - 1) refuse('range-mismatch', `Content-Range ${shown(contentRange)} does not match ${range} of an object of known size`);
    if (length !== null && length !== r!.last + 1) refuse('length-mismatch', `Content-Length ${length} does not match Content-Range ${shown(contentRange)}`);
    size = r!.total!;
  } else if (status === null) {
    return refuse('unverifiable-reply', `the reply to ${range} has neither a status nor a Content-Range, so it cannot be checked`);
  } else {
    return refuse('unexpected-status', `status ${status} to ${range}, expected 206`);
  }
  return sourceOf(f, size, signal, await bodyOf(reply, Math.min(size, headBytes), range, signal));
}

export function httpRange(url: string | URL, init: HttpRangeInit = {}): RangeFetcher {
  const href = typeof url === 'string' ? url : typeof (url as Partial<URL> | null)?.href === 'string' ? (url as URL).href : null;
  if (!href) throw new TypeError(`url must be a non-empty string or a URL, got ${shown(url)}`);
  const o = objectOf(init, 'init');
  const headers = objectOf(o.headers, 'init.headers');
  const run = o.fetch ?? globalThis.fetch;
  if (typeof run !== 'function') throw new TypeError('httpRange needs a fetch function: pass init.fetch where globalThis.fetch does not exist');
  return async ({ range, signal }) => {
    const h = new Headers(headers as Record<string, string>);
    h.set('range', range);
    h.set('accept-encoding', 'identity');
    const res = await (run as typeof globalThis.fetch)(href, { headers: h, signal });
    const length = res.headers.get('content-length');
    return {
      status: res.status,
      contentRange: res.headers.get('content-range'),
      contentLength: length === null ? null : /^\s*\d+\s*$/.test(length) ? Number(length) : Number.NaN,
      body: (expectedLength) => (res.body ? readCapped(res.body, expectedLength, signal) : Promise.resolve(new Uint8Array(0))),
      discard: () => void res.body?.cancel().catch(noop),
    };
  };
}

export async function readCapped(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, expectedLength: number, signal: AbortSignal | null = null): Promise<Uint8Array> {
  count(expectedLength, 'expectedLength');
  const s = signalOf(signal, 'signal');
  let next: () => Promise<IteratorResult<unknown>>;
  let stop: () => void;
  const b = body as Partial<ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>> | null;
  if (typeof b?.getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    next = () => reader.read();
    stop = () => void reader.cancel().catch(noop);
  } else if (typeof b?.[Symbol.asyncIterator] === 'function') {
    const it = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    next = () => it.next();
    stop = () => void attempt(() => it.return?.()).catch(noop);
  } else {
    throw new TypeError(`body must be a ReadableStream or an async iterable, got ${shown(body)}`);
  }
  const out = new Uint8Array(expectedLength);
  let got = 0;
  try {
    for (;;) {
      throwIfAborted(s);
      const step = await untilAborted(attempt(next), s);
      if (step.done) break;
      const chunk = step.value;
      const view = ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : tag(chunk) === '[object ArrayBuffer]' ? new Uint8Array(chunk as ArrayBuffer) : null;
      if (!view) throw new RangeSourceError('invalid-reply', `the body gave a ${chunk === null ? 'null' : typeof chunk} chunk, not bytes`);
      if (got + view.byteLength > expectedLength) throw new RangeSourceError('body-too-long', `the body passed the ${expectedLength} bytes requested`);
      out.set(view, got);
      got += view.byteLength;
    }
  } catch (e) {
    stop();
    throw e;
  }
  if (got < expectedLength) throw new RangeSourceError('body-too-short', `the body ended after ${got} of the ${expectedLength} bytes requested`);
  return out;
}
