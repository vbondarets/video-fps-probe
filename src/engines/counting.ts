import { throwIfAborted } from '../core/abort.ts';
import type { BlobLike, BlobSlice } from '../core/reader.ts';
import type { IoStats } from '../core/types.ts';

export interface CountingStats {
  reads: number;
  bytesRead: number;
  bytesTransferred: number;
}

interface Interval {
  start: number;
  end: number;
}

export function now(): number {
  return performance.now();
}

export function elapsed(since: number): number {
  return performance.now() - since;
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = now();
  const value = await fn();
  return { value, ms: elapsed(t0) };
}

export class CountingBlob implements BlobLike {
  readonly size: number;
  readonly #source: BlobLike;
  readonly #signal: AbortSignal | null;
  #reads = 0;
  #transferred = 0;
  #unique = 0;
  #covered: Interval[] = [];

  constructor(source: BlobLike, signal: AbortSignal | null = null) {
    this.#source = source;
    this.#signal = signal;
    this.size = source.size;
  }

  slice(start = 0, end: number = this.size): BlobSlice {
    const s = Math.max(0, Math.min(start, this.size));
    const e = Math.max(s, Math.min(end, this.size));
    return {
      arrayBuffer: async () => {
        throwIfAborted(this.#signal);
        const ab = await this.#source.slice(s, e).arrayBuffer();
        throwIfAborted(this.#signal);
        this.#reads++;
        this.#transferred += ab.byteLength;
        this.#cover(s, s + ab.byteLength);
        return ab;
      },
    };
  }

  stats(): CountingStats {
    return { reads: this.#reads, bytesRead: this.#unique, bytesTransferred: this.#transferred };
  }

  io(since: number): IoStats {
    return { reads: this.#reads, bytesRead: this.#unique, ms: elapsed(since) };
  }

  #cover(start: number, end: number): void {
    if (end <= start) return;
    const list = this.#covered;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].end < start) lo = mid + 1;
      else hi = mid;
    }
    let i = lo;
    let mergedStart = start;
    let mergedEnd = end;
    let overlap = 0;
    while (i < list.length && list[i].start <= end) {
      const iv = list[i];
      const o = Math.min(end, iv.end) - Math.max(start, iv.start);
      if (o > 0) overlap += o;
      if (iv.start < mergedStart) mergedStart = iv.start;
      if (iv.end > mergedEnd) mergedEnd = iv.end;
      i++;
    }
    list.splice(lo, i - lo, { start: mergedStart, end: mergedEnd });
    this.#unique += end - start - overlap;
  }
}
