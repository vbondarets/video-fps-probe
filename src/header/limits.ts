import type { BlobLike, BlobSlice } from '../core/reader.ts';

export interface HeaderLimits {
  maxBytes?: number;
  maxReads?: number;
  maxMs?: number;
  maxTracks?: number;
  maxTopLevelBoxes?: number;
}

export const HEADER_DEFAULT_LIMITS: Readonly<Required<HeaderLimits>> = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxReads: 8,
  maxMs: 10_000,
  maxTracks: 64,
  maxTopLevelBoxes: 1024,
});

export type LimitCode = 'byte-limit' | 'read-limit' | 'time-limit' | 'structure-limit';

export class LimitError extends Error {
  declare readonly errorCode: LimitCode;

  constructor(code: LimitCode, message: string) {
    super(message);
    this.name = 'LimitError';
    this.errorCode = code;
  }
}

interface SignalRead {
  read(start: number, end: number, signal?: AbortSignal | null): Promise<Uint8Array>;
}

const noop = (): void => {};
const MAX_TIMER_MS = 0x7fffffff;

function sourceError(message: string): Error {
  return Object.assign(new Error(message), { name: '' });
}

function bufferOf(value: unknown): ArrayBuffer {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : bytes.slice().buffer;
  }
  if (typeof (value as { byteLength?: unknown } | null)?.byteLength !== 'number') throw sourceError(`the source returned ${value === null ? 'null' : typeof value} instead of bytes`);
  return value as ArrayBuffer;
}

export class LimitedSource implements BlobLike {
  readonly size: number;
  readonly #inner: BlobLike & Partial<SignalRead>;
  readonly #maxBytes: number;
  readonly #maxReads: number;
  readonly #maxMs: number;
  readonly #deadline: number;
  readonly #controller = new AbortController();
  readonly #stopped: Promise<never>;
  readonly #caller: AbortSignal | null;
  readonly #forward = (): void => this.#controller.abort(this.#caller?.reason);
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timedOut = false;
  #reads = 0;
  #bytes = 0;
  #tripped: LimitError | null = null;

  constructor(inner: BlobLike, size: number, limits: Required<Pick<HeaderLimits, 'maxBytes' | 'maxReads' | 'maxMs'>>, caller: AbortSignal | null) {
    this.size = size;
    this.#inner = inner;
    this.#maxBytes = limits.maxBytes;
    this.#maxReads = limits.maxReads;
    this.#maxMs = limits.maxMs;
    this.#deadline = performance.now() + limits.maxMs;
    this.#caller = caller;
    const internal = this.#controller.signal;
    this.#stopped = new Promise<never>((_, reject) => internal.addEventListener('abort', () => reject(internal.reason), { once: true }));
    this.#stopped.catch(noop);
    if (caller) {
      if (caller.aborted) this.#forward();
      else caller.addEventListener('abort', this.#forward, { once: true });
    }
    if (Number.isFinite(limits.maxMs) && !internal.aborted) this.#arm(limits.maxMs);
  }

  #arm(left: number): void {
    const step = Math.min(left, MAX_TIMER_MS);
    this.#timer = setTimeout(() => {
      if (left > step) return this.#arm(left - step);
      this.#timer = null;
      this.#timedOut = true;
      this.#controller.abort(new LimitError('time-limit', `limit reached: maxMs ${this.#maxMs}`));
    }, step);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  get bytesLeft(): number {
    return this.#maxBytes - this.#bytes;
  }

  get bytesRequested(): number {
    return this.#bytes;
  }

  checkTime(): void {
    if (this.#timedOut || performance.now() >= this.#deadline) throw this.#trip('time-limit', `limit reached: maxMs ${this.#maxMs}`);
  }

  reserve(reads: number, bytes: number, offset: number): void {
    const trip = this.#admission(reads, bytes, offset);
    if (trip) throw trip;
  }

  take(): LimitError | null {
    const t = this.#tripped;
    this.#tripped = null;
    return t;
  }

  slice(start = 0, end = this.size): BlobSlice {
    return { arrayBuffer: () => this.#fetch(start, end) };
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#caller?.removeEventListener('abort', this.#forward);
  }

  #trip(code: LimitError['errorCode'], message: string): LimitError {
    this.#tripped = new LimitError(code, message);
    return this.#tripped;
  }

  #admission(reads: number, bytes: number, offset: number): LimitError | null {
    if (this.#reads + reads > this.#maxReads) return this.#trip('read-limit', `limit reached: maxReads ${this.#maxReads}`);
    if (this.#bytes + bytes > this.#maxBytes) return this.#trip('byte-limit', `limit reached: maxBytes ${this.#maxBytes} (${this.#bytes + bytes - this.#maxBytes} more bytes needed at offset ${offset})`);
    try {
      this.checkTime();
    } catch (e) {
      return e as LimitError;
    }
    return null;
  }

  #fetch(start: number, end: number): Promise<ArrayBuffer> {
    const length = Math.max(0, end - start);
    const trip = this.#admission(1, length, start);
    if (trip) return Promise.reject(trip);
    this.#reads++;
    this.#bytes += length;
    let pending: Promise<ArrayBuffer>;
    try {
      const inner = this.#inner;
      pending = Promise.resolve(typeof inner.read === 'function' ? inner.read(start, end, this.#controller.signal) : inner.slice(start, end).arrayBuffer()).then(bufferOf);
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.catch(noop);
    return Promise.race([pending, this.#stopped]).catch((e: unknown) => {
      if (e instanceof LimitError) this.#tripped = e;
      else if (!this.#controller.signal.aborted && (e as Error | null)?.name === 'AbortError') throw sourceError(String(e));
      throw e;
    });
  }
}
