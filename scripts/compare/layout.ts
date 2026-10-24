import { open, type FileHandle } from 'node:fs/promises';
import type { FileLayout, LayoutTrack, MatroskaLayoutTrack } from './types.ts';

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

function fragmentDuration(buf: Buffer, moov: Child, timescale: number): number | null {
  const mehd = find(buf, find(buf, moov, 'mvex'), 'mehd');
  if (!mehd || timescale <= 0 || mehd.end - mehd.start < 8) return null;
  const v1 = buf.readUInt8(mehd.start) === 1;
  if (v1 && mehd.end - mehd.start < 12) return null;
  return (v1 ? Number(buf.readBigUInt64BE(mehd.start + 4)) : buf.readUInt32BE(mehd.start + 4)) / timescale;
}

async function readMoov(handle: FileHandle, offset: number, size: number): Promise<Pick<FileLayout, 'movieDurationSec' | 'fragmentDurationSec' | 'tracks'>> {
  const buf = Buffer.alloc(size);
  await handle.read(buf, 0, size, offset);
  const top = children(buf, 0, size)[0];
  if (!top || top.type !== 'moov') return { movieDurationSec: null, fragmentDurationSec: null, tracks: [] };
  const movie = timing(buf, find(buf, top, 'mvhd'), 20, 12);
  const tracks = children(buf, top.start, top.end)
    .filter((c) => c.type === 'trak')
    .map((t) => trackOf(buf, t))
    .filter((t): t is LayoutTrack => t !== null);
  return {
    movieDurationSec: movie && movie.timescale > 0 ? movie.duration / movie.timescale : null,
    fragmentDurationSec: movie ? fragmentDuration(buf, top, movie.timescale) : null,
    tracks,
  };
}

export async function scanIsoBmffLayout(path: string, size: number): Promise<FileLayout | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const types: string[] = [];
    const seen = new Set<string>();
    let moov: Pick<FileLayout, 'movieDurationSec' | 'fragmentDurationSec' | 'tracks'> = { movieDurationSec: null, fragmentDurationSec: null, tracks: [] };
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

const MKV_EBML = 0x1a45dfa3;
const MKV_SEGMENT = 0x18538067;
const MKV_TRACKS = 0x1654ae6b;
const MKV_TRACK_ENTRY = 0xae;
const MKV_TRACK_NUMBER = 0xd7;
const MKV_TRACK_TYPE = 0x83;
const MKV_DEFAULT_DURATION = 0x23e383;
const MKV_CLUSTER = 0x1f43b675;
const MKV_BLOCK_GROUP = 0xa0;
const MKV_BLOCK = 0xa1;
const MKV_BLOCK_DURATION = 0x9b;
const MKV_CLUSTER_CHILDREN: ReadonlySet<number> = new Set([0xe7, 0x5854, 0xa7, 0xab, 0xa3, MKV_BLOCK_GROUP, 0xaf, 0xec, 0xbf]);
const MKV_TRACKS_READ_CAP = 1024 * 1024;
const MKV_MAX_ELEMENTS = 10_000_000;

interface EbmlElement {
  id: number;
  dataStart: number;
  end: number | null;
}

const vintBytes = (first: number): number => (first === 0 ? 0 : Math.clz32(first) - 23);

function ebmlAt(b: Buffer, p: number, limit: number, base: number): EbmlElement | null {
  const idLen = p < limit ? vintBytes(b[p]) : 0;
  if (idLen < 1 || idLen > 4 || p + idLen >= limit) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[p + i];
  const first = b[p + idLen];
  const sizeLen = vintBytes(first);
  if (sizeLen < 1 || p + idLen + sizeLen > limit) return null;
  const mask = 0xff >> sizeLen;
  let unknown = (first & mask) === mask;
  let size = first & mask;
  for (let i = 1; i < sizeLen; i++) {
    const x = b[p + idLen + i];
    if (x !== 0xff) unknown = false;
    size = size * 256 + x;
  }
  const dataStart = base + p + idLen + sizeLen;
  return { id, dataStart, end: unknown ? null : dataStart + size };
}

function ebmlChildren(b: Buffer, start: number, end: number): EbmlElement[] {
  const out: EbmlElement[] = [];
  let p = start;
  while (p < end) {
    const e = ebmlAt(b, p, end, 0);
    if (!e || e.end === null || e.end > end) break;
    out.push(e);
    p = e.end;
  }
  return out;
}

const ebmlUint = (b: Buffer, e: EbmlElement): number => {
  let v = 0;
  for (let i = e.dataStart; i < (e.end ?? e.dataStart); i++) v = v * 256 + b[i];
  return v;
};

function matroskaTracks(b: Buffer): MatroskaLayoutTrack[] {
  return ebmlChildren(b, 0, b.length)
    .filter((e) => e.id === MKV_TRACK_ENTRY && e.end !== null)
    .map((entry) => {
      const t: MatroskaLayoutTrack = { number: null, type: null, defaultDurationNs: null, blockDurations: 0 };
      for (const c of ebmlChildren(b, entry.dataStart, entry.end ?? entry.dataStart)) {
        if (c.id === MKV_TRACK_NUMBER) t.number = ebmlUint(b, c);
        else if (c.id === MKV_TRACK_TYPE) t.type = ebmlUint(b, c);
        else if (c.id === MKV_DEFAULT_DURATION) t.defaultDurationNs = ebmlUint(b, c);
      }
      return t;
    });
}

export async function scanMatroskaLayout(path: string, size: number): Promise<FileLayout | null> {
  const handle = await open(path, 'r');
  const head = Buffer.alloc(12);
  const at = async (offset: number): Promise<EbmlElement | null> => {
    const { bytesRead } = await handle.read(head, 0, 12, offset);
    return ebmlAt(head, 0, bytesRead, offset);
  };
  const blockTrack = async (offset: number): Promise<number | null> => {
    const { bytesRead } = await handle.read(head, 0, 8, offset);
    const len = bytesRead > 0 ? vintBytes(head[0]) : 0;
    if (len < 1 || len > bytesRead) return null;
    let v = head[0] & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + head[i];
    return v;
  };
  try {
    const ebml = await at(0);
    if (!ebml || ebml.id !== MKV_EBML || ebml.end === null) return null;
    let segment = await at(ebml.end);
    while (segment && segment.id !== MKV_SEGMENT && segment.end !== null) segment = await at(segment.end);
    if (!segment || segment.id !== MKV_SEGMENT) return null;
    const segEnd = Math.min(size, segment.end ?? size);
    let tracks: MatroskaLayoutTrack[] | null = null;
    const blockDurations = new Map<number, number>();
    let elements = 0;
    let p = segment.dataStart;
    while (p < segEnd && elements++ < MKV_MAX_ELEMENTS) {
      const e = await at(p);
      if (!e) break;
      if (e.id === MKV_TRACKS && tracks === null && e.end !== null && e.end - e.dataStart <= MKV_TRACKS_READ_CAP) {
        const b = Buffer.alloc(e.end - e.dataStart);
        await handle.read(b, 0, b.length, e.dataStart);
        tracks = matroskaTracks(b);
      }
      if (e.id !== MKV_CLUSTER) {
        if (e.end === null) break;
        p = e.end;
        continue;
      }
      const end = e.end === null ? segEnd : Math.min(segEnd, e.end);
      let q = e.dataStart;
      while (q < end && elements++ < MKV_MAX_ELEMENTS) {
        const c = await at(q);
        if (!c || c.end === null || (e.end === null && !MKV_CLUSTER_CHILDREN.has(c.id))) break;
        if (c.id === MKV_BLOCK_GROUP) {
          let track: number | null = null;
          let withDuration = false;
          for (let r = c.dataStart; r < c.end; ) {
            const g = await at(r);
            if (!g || g.end === null || g.end > c.end) break;
            if (g.id === MKV_BLOCK) track = await blockTrack(g.dataStart);
            else if (g.id === MKV_BLOCK_DURATION) withDuration = true;
            r = g.end;
          }
          if (track !== null && withDuration) blockDurations.set(track, (blockDurations.get(track) ?? 0) + 1);
        }
        q = c.end;
      }
      p = e.end ?? q;
    }
    if (tracks === null) return null;
    for (const t of tracks) t.blockDurations = t.number === null ? 0 : (blockDurations.get(t.number) ?? 0);
    return { fragmented: false, hasSidx: false, topLevel: [], matroskaTracks: tracks };
  } finally {
    await handle.close();
  }
}
