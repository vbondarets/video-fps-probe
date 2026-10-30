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

function wholeBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer;
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

  constructor(inner: BlobLike, limits: Required<Pick<HeaderLimits, 'maxBytes' | 'maxReads' | 'maxMs'>>, caller: AbortSignal | null) {
    this.size = inner.size;
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
    if (limits.maxMs <= MAX_TIMER_MS && !internal.aborted) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#timedOut = true;
        this.#controller.abort(new LimitError('time-limit', `limit reached: maxMs ${this.#maxMs}`));
      }, limits.maxMs);
      (this.#timer as { unref?: () => void }).unref?.();
    }
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
      pending = typeof inner.read === 'function' ? Promise.resolve(inner.read(start, end, this.#controller.signal)).then(wholeBuffer) : Promise.resolve(inner.slice(start, end).arrayBuffer());
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.catch(noop);
    return Promise.race([pending, this.#stopped]).catch((e: unknown) => {
      if (e instanceof LimitError) this.#tripped = e;
      throw e;
    });
  }
}
