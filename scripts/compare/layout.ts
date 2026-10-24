import { open, type FileHandle } from 'node:fs/promises';
import type { FileLayout, LayoutTrack } from './types.ts';

const MAX_BOXES = 1_000_000;
const TOP_LEVEL_LIST_LIMIT = 40;
const MOOV_READ_CAP = 64 * 1024 * 1024;

interface Child {
  type: string;
  start: number;
  end: number;
}

function children(buf: Buffer, start: number, end: number): Child[] {
  const out: Child[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p + header, end: p + size });
    p += size;
  }
  return out;
}

const find = (buf: Buffer, box: Child | undefined, type: string): Child | undefined => (box ? children(buf, box.start, box.end).find((c) => c.type === type) : undefined);

function timing(buf: Buffer, box: Child | undefined, v1Offset: number, v0Offset: number): { timescale: number; duration: number } | null {
  if (!box || box.end - box.start < 4) return null;
  const v1 = buf.readUInt8(box.start) === 1;
  const p = box.start + (v1 ? v1Offset : v0Offset);
  if (p + (v1 ? 12 : 8) > box.end) return null;
  const timescale = buf.readUInt32BE(p);
  const duration = v1 ? Number(buf.readBigUInt64BE(p + 4)) : buf.readUInt32BE(p + 4);
  return { timescale, duration };
}

function sampleCount(buf: Buffer, stbl: Child | undefined): number | null {
  const stsz = find(buf, stbl, 'stsz') ?? find(buf, stbl, 'stz2');
  if (!stsz || stsz.start + 12 > stsz.end) return null;
  return buf.readUInt32BE(stsz.start + 8);
}

function trackOf(buf: Buffer, trak: Child): LayoutTrack | null {
  const tkhd = find(buf, trak, 'tkhd');
  const mdia = find(buf, trak, 'mdia');
  if (!tkhd || tkhd.start + 24 > tkhd.end || !mdia) return null;
  const id = buf.readUInt32BE(tkhd.start + (buf.readUInt8(tkhd.start) === 1 ? 20 : 12));
  const media = timing(buf, find(buf, mdia, 'mdhd'), 20, 12);
  const hdlr = find(buf, mdia, 'hdlr');
  const elst = find(buf, find(buf, trak, 'edts'), 'elst');
  return {
    id,
    handler: hdlr && hdlr.start + 12 <= hdlr.end ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : null,
    mediaDurationSec: media && media.timescale > 0 ? media.duration / media.timescale : null,
    samples: sampleCount(buf, find(buf, find(buf, mdia, 'minf'), 'stbl')),
    hasEditList: !!elst && elst.start + 8 <= elst.end && buf.readUInt32BE(elst.start + 4) > 0,
  };
}

async function readMoov(handle: FileHandle, offset: number, size: number): Promise<Pick<FileLayout, 'movieDurationSec' | 'tracks'>> {
  const buf = Buffer.alloc(size);
  await handle.read(buf, 0, size, offset);
  const top = children(buf, 0, size)[0];
  if (!top || top.type !== 'moov') return { movieDurationSec: null, tracks: [] };
  const movie = timing(buf, find(buf, top, 'mvhd'), 20, 12);
  const tracks = children(buf, top.start, top.end)
    .filter((c) => c.type === 'trak')
    .map((t) => trackOf(buf, t))
    .filter((t): t is LayoutTrack => t !== null);
  return { movieDurationSec: movie && movie.timescale > 0 ? movie.duration / movie.timescale : null, tracks };
}

export async function scanIsoBmffLayout(path: string, size: number): Promise<FileLayout | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const types: string[] = [];
    const seen = new Set<string>();
    let moov: Pick<FileLayout, 'movieDurationSec' | 'tracks'> = { movieDurationSec: null, tracks: [] };
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
      if (type === 'moov' && !seen.has('moov') && offset + boxSize <= size && boxSize <= MOOV_READ_CAP) moov = await readMoov(handle, offset, boxSize);
      if (!seen.has(type)) {
        seen.add(type);
        if (types.length < TOP_LEVEL_LIST_LIMIT) types.push(type);
      }
      offset += boxSize;
    }
    if (!seen.has('moov') && !seen.has('moof') && !seen.has('ftyp')) return null;
    return { fragmented: seen.has('moof'), hasSidx: seen.has('sidx'), topLevel: types, ...moov };
  } finally {
    await handle.close();
  }
}
