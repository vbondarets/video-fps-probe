import { fourcc } from '../reader.ts';

export class IsoBmffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsoBmffError';
  }
}

export interface BoxHeader {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  end: number;
  truncated: boolean;
}

export const MAX_BOX_HEADER = 32;

export function readBoxHeader(dv: DataView, p: number, parentEnd: number, base = 0): BoxHeader | null {
  const avail = Math.min(dv.byteLength, parentEnd);
  if (p + 8 > avail) return null;
  const size32 = dv.getUint32(p);
  const type = fourcc(dv, p + 4);
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (p + 16 > avail) return null;
    const big = dv.getBigUint64(p + 8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new IsoBmffError(`corrupt file: box '${type}' at ${base + p} has a size above 2^53-1`);
    size = Number(big);
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - p;
  }
  if (type === 'uuid') headerSize += 16;
  if (size < headerSize) throw new IsoBmffError(`corrupt file: box '${type}' at ${base + p} is smaller than its header`);
  const end = p + size;
  return { type, start: p, size, headerSize, end: Math.min(end, parentEnd), truncated: end > parentEnd };
}

export function* childBoxes(dv: DataView, start: number, end: number, warnings?: string[]): Generator<BoxHeader> {
  let p = start;
  while (p + 8 <= end) {
    let h: BoxHeader | null;
    try {
      h = readBoxHeader(dv, p, end);
    } catch (e) {
      warnings?.push((e as Error).message.replace(/^corrupt file: /, 'ignored invalid child: '));
      return;
    }
    if (!h) return;
    yield h;
    p = h.start + h.size;
  }
}

export function boxU64(dv: DataView, p: number, box: string, at: number): number {
  const v = dv.getBigUint64(p);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new IsoBmffError(`unsupported: box '${box}' at ${at} holds a value above 2^53-1`);
  return Number(v);
}

export function boxI64(dv: DataView, p: number, box: string, at: number): number {
  const v = dv.getBigInt64(p);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IsoBmffError(`unsupported: box '${box}' at ${at} holds a value beyond 2^53-1`);
  }
  return Number(v);
}

export function boundEntries(count: number, available: number, entrySize: number, what: string, warnings: string[]): number {
  const fit = Math.max(0, Math.floor(available / entrySize));
  if (count > fit) {
    warnings.push(`${what} declares ${count} entries but its box holds only ${fit}`);
    return fit;
  }
  return count;
}
