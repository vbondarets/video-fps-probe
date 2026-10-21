import { open } from 'node:fs/promises';
import type { FileLayout } from './types.ts';

const MAX_BOXES = 1_000_000;
const TOP_LEVEL_LIST_LIMIT = 40;

export async function scanIsoBmffLayout(path: string, size: number): Promise<FileLayout | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const types: string[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let boxes = 0;
    while (offset + 8 <= size && boxes < MAX_BOXES) {
      const { bytesRead } = await handle.read(head, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        const big = head.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
        boxSize = Number(big);
      } else if (boxSize === 0) boxSize = size - offset;
      if (boxSize < 8) break;
      boxes++;
      if (!seen.has(type)) {
        seen.add(type);
        if (types.length < TOP_LEVEL_LIST_LIMIT) types.push(type);
      }
      offset += boxSize;
    }
    if (!seen.has('moov') && !seen.has('moof') && !seen.has('ftyp')) return null;
    return { fragmented: seen.has('moof'), hasSidx: seen.has('sidx'), topLevel: types };
  } finally {
    await handle.close();
  }
}
