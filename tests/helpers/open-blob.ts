import { openAsBlob } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import type { BlobLike, BlobSlice } from '../../src/core/reader.ts';

export const OPEN_AS_BLOB_LIMIT = 2 ** 32;

export class FileSlice implements BlobLike {
  readonly #handle: FileHandle;
  readonly #start: number;
  readonly size: number;

  constructor(handle: FileHandle, start: number, size: number) {
    this.#handle = handle;
    this.#start = start;
    this.size = size;
  }

  slice(start = 0, end: number = this.size): FileSlice {
    const s = start < 0 ? Math.max(0, this.size + start) : Math.min(start, this.size);
    const e = end < 0 ? Math.max(0, this.size + end) : Math.min(end, this.size);
    return new FileSlice(this.#handle, this.#start + s, Math.max(0, e - s));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buf = new Uint8Array(this.size);
    let off = 0;
    while (off < this.size) {
      const { bytesRead } = await this.#handle.read(buf, off, Math.min(this.size - off, 1 << 24), this.#start + off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return off === this.size ? buf.buffer : buf.buffer.slice(0, off);
  }
}

export interface OpenedFixture {
  blob: BlobLike & BlobSlice;
  size: number;
  kind: 'openAsBlob' | 'fileSlice';
  close(): Promise<void>;
}

export async function openFixture(path: string, options: { forceFileSlice?: boolean } = {}): Promise<OpenedFixture> {
  const { size } = await stat(path);
  if (!options.forceFileSlice && size < OPEN_AS_BLOB_LIMIT) {
    const blob = await openAsBlob(path);
    if (blob.size === size) return { blob, size, kind: 'openAsBlob', close: async () => {} };
  }
  const handle = await open(path, 'r');
  return { blob: new FileSlice(handle, 0, size), size, kind: 'fileSlice', close: () => handle.close() };
}

export async function withFixture<T>(path: string, fn: (blob: BlobLike, size: number) => Promise<T>): Promise<T> {
  const opened = await openFixture(path);
  try {
    return await fn(opened.blob, opened.size);
  } finally {
    await opened.close();
  }
}
