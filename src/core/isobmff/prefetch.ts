import { fourcc, type BlobReader } from '../reader.ts';
import { childBoxes, readBoxHeader } from './boxes.ts';

export const PREFETCH_BATCH = 8;
export const PREFETCH_CONCURRENCY = 4;
const MFRA_TAIL = 64 * 1024;
const MFRA_CAP = 16 * 1024 * 1024;
const FRAGMENT_START_TYPES = new Set(['moof', 'styp', 'sidx', 'ssix', 'emsg', 'prft', 'free', 'skip', 'uuid']);

export interface Prefetch {
  windows: Array<[offset: number, view: DataView]>;
  hints: number[];
  next: number;
  mfraTried: boolean;
}

export function newPrefetch(): Prefetch {
  return { windows: [], hints: [], next: 0, mfraTried: false };
}

export function prefetched(p: Prefetch, pos: number, need: number): DataView | null {
  for (const [off, dv] of p.windows) {
    if (pos >= off && pos + need <= off + dv.byteLength) return new DataView(dv.buffer, dv.byteOffset + pos - off, need);
  }
  return null;
}

export async function prefetchNext(reader: BlobReader, p: Prefetch, pos: number, length: number): Promise<void> {
  while (p.next < p.hints.length && p.hints[p.next] <= pos) p.next++;
  const ranges: Array<[number, number]> = [];
  for (let i = p.next; i < p.hints.length && ranges.length < PREFETCH_BATCH; i++) {
    if (p.hints[i] < reader.size) ranges.push([p.hints[i], Math.min(length, reader.size - p.hints[i])]);
  }
  p.next += ranges.length;
  if (!ranges.length) return;
  const bufs = await reader.readMany(ranges, PREFETCH_CONCURRENCY);
  p.windows = ranges.map(([o], i) => [o, new DataView(bufs[i].buffer, bufs[i].byteOffset, bufs[i].byteLength)]);
  if (!p.windows.every(([, dv]) => startsWithFragmentBox(dv))) {
    p.hints = [];
    p.next = 0;
  }
}

function startsWithFragmentBox(dv: DataView): boolean {
  return dv.byteLength >= 8 && dv.getUint32(0) >= 8 && FRAGMENT_START_TYPES.has(fourcc(dv, 4));
}

export function parseTfraOffsets(dv: DataView, start: number, end: number, out: Set<number>, fileSize = Number.MAX_SAFE_INTEGER): void {
  for (const t of childBoxes(dv, start, end)) {
    const p = t.start + t.headerSize;
    if (t.type !== 'tfra' || p + 16 > t.end) continue;
    const v1 = dv.getUint8(p) === 1;
    const lengths = dv.getUint32(p + 8);
    const entry = (v1 ? 16 : 8) + ((lengths >> 4) & 3) + ((lengths >> 2) & 3) + (lengths & 3) + 3;
    const n = Math.min(dv.getUint32(p + 12), Math.floor((t.end - p - 16) / entry));
    for (let i = 0; i < n; i++) {
      const o = p + 16 + i * entry;
      const offset = v1 ? dv.getBigUint64(o + 8) : BigInt(dv.getUint32(o + 4));
      if (offset > 0n && offset < BigInt(fileSize)) out.add(Number(offset));
    }
  }
}

export async function mfraMoofOffsets(reader: BlobReader): Promise<number[]> {
  try {
    return await readMfraOffsets(reader);
  } catch (e) {
    if (reader.signal?.aborted || (e as { name?: unknown } | null)?.name === 'AbortError') throw e;
    return [];
  }
}

async function readMfraOffsets(reader: BlobReader): Promise<number[]> {
  const size = reader.size;
  const tailLen = Math.min(size, MFRA_TAIL);
  if (tailLen < 16) return [];
  const tail = await reader.view(size - tailLen, tailLen, 0);
  if (fourcc(tail, tailLen - 12) !== 'mfro') return [];
  const mfraSize = tail.getUint32(tailLen - 4);
  if (mfraSize < 24 || mfraSize > Math.min(size, MFRA_CAP)) return [];
  const dv = mfraSize <= tailLen ? new DataView(tail.buffer, tail.byteOffset + tailLen - mfraSize, mfraSize) : await reader.view(size - mfraSize, mfraSize, 0);
  let h;
  try {
    h = readBoxHeader(dv, 0, mfraSize);
  } catch {
    return [];
  }
  if (!h || h.type !== 'mfra') return [];
  const out = new Set<number>();
  parseTfraOffsets(dv, h.headerSize, h.end, out, size);
  return [...out].sort((a, b) => a - b);
}
