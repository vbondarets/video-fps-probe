import { open, type FileHandle } from 'node:fs/promises';
import { sniff } from '../../src/core/sniff.ts';
import type { CodecConfigFacts, ContainerColor, ContainerLayoutLike, FileLayout, LayoutTrack, MatroskaLayoutTrack, SampleEntryFacts } from './types.ts';

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

function lastSttsDelta(buf: Buffer, stbl: Child | undefined): number | null {
  const stts = find(buf, stbl, 'stts');
  if (!stts || stts.start + 8 > stts.end) return null;
  const n = buf.readUInt32BE(stts.start + 4);
  const p = stts.start + 8 + (n - 1) * 8;
  return n > 0 && p + 8 <= stts.end ? buf.readUInt32BE(p + 4) : null;
}

const VISUAL_FIELDS = 78;
const H264_HIGH_PROFILES: ReadonlySet<number> = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export function avcConfig(b: Uint8Array): CodecConfigFacts | null {
  if (b.length < 7) return null;
  const profile = b[1];
  const sps = b[5] & 0x1f;
  let p = 6;
  for (let i = 0; i < sps && p + 2 <= b.length; i++) p += 2 + ((b[p] << 8) | b[p + 1]);
  const pps = p < b.length ? b[p] : 0;
  p += 1;
  for (let i = 0; i < pps && p + 2 <= b.length; i++) p += 2 + ((b[p] << 8) | b[p + 1]);
  let bitDepth: number | null = H264_HIGH_PROFILES.has(profile) ? null : 8;
  if (bitDepth === null && p + 2 <= b.length) bitDepth = (b[p + 1] & 7) + 8;
  return { kind: 'avcC', profile, constraints: b[2], bitDepth, hasSps: sps > 0 };
}

export function hevcConfig(b: Uint8Array): CodecConfigFacts | null {
  if (b.length < 23) return null;
  let hasSps = false;
  let p = 23;
  for (let a = 0; a < b[22] && p + 3 <= b.length; a++) {
    const type = b[p] & 0x3f;
    const count = (b[p + 1] << 8) | b[p + 2];
    p += 3;
    for (let i = 0; i < count && p + 2 <= b.length; i++) p += 2 + ((b[p] << 8) | b[p + 1]);
    if (type === 33 && count > 0) hasSps = true;
  }
  const constraints = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
  return { kind: 'hvcC', profile: b[1] & 0x1f, constraints, bitDepth: (b[17] & 7) + 8, hasSps };
}

export function av1Config(b: Uint8Array): CodecConfigFacts | null {
  if (b.length < 4) return null;
  const high = (b[2] >> 6) & 1;
  const twelve = (b[2] >> 5) & 1;
  return { kind: 'av1C', profile: b[1] >> 5, constraints: null, bitDepth: twelve ? 12 : high ? 10 : 8, hasSps: null };
}

function vpcColor(b: Uint8Array): ContainerColor | null {
  if (b.length < 12 || b[0] !== 1) return null;
  return { kind: 'vpcC', primaries: b[7], transfer: b[8], matrix: b[9], fullRange: (b[6] & 1) === 1 };
}

export function vpcConfig(b: Uint8Array): CodecConfigFacts | null {
  if (b.length < 8) return null;
  return { kind: 'vpcC', profile: b[4], constraints: null, bitDepth: b[0] === 1 ? b[6] >> 4 : null, hasSps: null };
}

export function vp9PrivateConfig(b: Uint8Array): CodecConfigFacts | null {
  let profile: number | null = null;
  let bitDepth: number | null = null;
  for (let p = 0; p + 2 <= b.length; p += 2 + b[p + 1]) {
    if (b[p + 1] !== 1 || p + 3 > b.length) continue;
    if (b[p] === 1) profile = b[p + 2];
    if (b[p] === 3) bitDepth = b[p + 2];
  }
  return profile === null && bitDepth === null ? null : { kind: 'vp9-private', profile, constraints: null, bitDepth, hasSps: null };
}

function colrOf(buf: Buffer, box: Child): ContainerColor | null {
  if (box.start + 10 > box.end) return null;
  const kind = buf.toString('latin1', box.start, box.start + 4);
  if (kind !== 'nclx' && kind !== 'nclc') return null;
  const u16 = (i: number) => buf.readUInt16BE(box.start + 4 + i * 2);
  const fullRange = kind === 'nclx' && box.start + 11 <= box.end ? (buf[box.start + 10] & 0x80) !== 0 : null;
  return { kind, primaries: u16(0), transfer: u16(1), matrix: u16(2), fullRange };
}

function sampleEntryOf(buf: Buffer, stbl: Child | undefined): SampleEntryFacts | null {
  const stsd = find(buf, stbl, 'stsd');
  const entry = stsd && stsd.start + 8 < stsd.end ? children(buf, stsd.start + 8, stsd.end)[0] : undefined;
  if (!entry || entry.start + VISUAL_FIELDS > entry.end) return null;
  const facts: SampleEntryFacts = {
    type: entry.type,
    width: buf.readUInt16BE(entry.start + 24),
    height: buf.readUInt16BE(entry.start + 26),
    pasp: null,
    colr: null,
    vpcC: null,
    config: null,
    dolbyVision: null,
  };
  for (const c of children(buf, entry.start + VISUAL_FIELDS, entry.end)) {
    const body = buf.subarray(c.start, c.end);
    if (c.type === 'pasp' && body.length >= 8) facts.pasp = { num: body.readUInt32BE(0), den: body.readUInt32BE(4) };
    else if (c.type === 'colr') facts.colr ??= colrOf(buf, c);
    else if (c.type === 'vpcC') {
      facts.vpcC = vpcColor(body);
      facts.config ??= vpcConfig(body);
    } else if (c.type === 'avcC') facts.config ??= avcConfig(body);
    else if (c.type === 'hvcC') facts.config ??= hevcConfig(body);
    else if (c.type === 'av1C') facts.config ??= av1Config(body);
    else if (c.type === 'dvcC' || c.type === 'dvvC' || c.type === 'dvwC') facts.dolbyVision ??= c.type;
  }
  return facts;
}

function trackOf(buf: Buffer, trak: Child): LayoutTrack | null {
  const tkhd = find(buf, trak, 'tkhd');
  const mdia = find(buf, trak, 'mdia');
  if (!tkhd || tkhd.start + 24 > tkhd.end || !mdia) return null;
  const v1 = buf.readUInt8(tkhd.start) === 1;
  const id = buf.readUInt32BE(tkhd.start + (v1 ? 20 : 12));
  const media = timing(buf, find(buf, mdia, 'mdhd'), 20, 12);
  const hdlr = find(buf, mdia, 'hdlr');
  const elst = find(buf, find(buf, trak, 'edts'), 'elst');
  const stbl = find(buf, find(buf, mdia, 'minf'), 'stbl');
  const handler = hdlr && hdlr.start + 12 <= hdlr.end ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : null;
  const matrixAt = tkhd.start + (v1 ? 52 : 40);
  const sized = matrixAt + 44 <= tkhd.end;
  return {
    id,
    handler,
    mediaDurationSec: media && media.timescale > 0 ? media.duration / media.timescale : null,
    samples: sampleCount(buf, stbl),
    hasEditList: !!elst && elst.start + 8 <= elst.end && buf.readUInt32BE(elst.start + 4) > 0,
    lastSampleTicks: lastSttsDelta(buf, stbl),
    enabled: (buf.readUIntBE(tkhd.start + 1, 3) & 1) === 1,
    tkhdWidth: sized ? buf.readUInt32BE(matrixAt + 36) >>> 16 : 0,
    tkhdHeight: sized ? buf.readUInt32BE(matrixAt + 40) >>> 16 : 0,
    matrix: sized ? Array.from({ length: 9 }, (_, i) => buf.readInt32BE(matrixAt + i * 4)) : null,
    entry: handler === 'vide' ? sampleEntryOf(buf, stbl) : null,
  };
}

export function expectedLayout(layout: FileLayout | null | undefined): ContainerLayoutLike | null {
  if (!layout || layout.matroskaTracks || (layout.moovOffset == null && layout.firstMdatOffset == null)) return null;
  const mdatFirst = layout.firstMdatOffset != null && (layout.moovOffset == null || layout.firstMdatOffset < layout.moovOffset);
  const kind = layout.hasMvex ? 'fragmented' : mdatFirst ? 'moov-at-end' : 'faststart';
  const video = (layout.tracks ?? []).filter((t) => t.handler === 'vide');
  return {
    kind,
    moovOffset: layout.moovOffset ?? null,
    moovSize: layout.moovSize ?? null,
    sidx: layout.sidxBeforeFirstMoof ?? false,
    emptyMoov: kind === 'fragmented' && video.every((t) => (t.samples ?? 0) === 0),
  };
}

export async function sniffsAsIsoBmff(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return sniff(head.subarray(0, bytesRead)).kind === 'isobmff';
  } finally {
    await handle.close();
  }
}

export async function isoBmffFixtureSet(names: readonly string[], pathOf: (name: string) => string | null): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    const path = pathOf(name);
    if (path && (await sniffsAsIsoBmff(path))) out.push(name);
  }
  return out;
}

function fragmentDuration(buf: Buffer, moov: Child, timescale: number): number | null {
  const mehd = find(buf, find(buf, moov, 'mvex'), 'mehd');
  if (!mehd || timescale <= 0 || mehd.end - mehd.start < 8) return null;
  const v1 = buf.readUInt8(mehd.start) === 1;
  if (v1 && mehd.end - mehd.start < 12) return null;
  return (v1 ? Number(buf.readBigUInt64BE(mehd.start + 4)) : buf.readUInt32BE(mehd.start + 4)) / timescale;
}

function trexDurations(buf: Buffer, moov: Child): Map<number, number> {
  const out = new Map<number, number>();
  for (const trex of children(buf, find(buf, moov, 'mvex')?.start ?? 0, find(buf, moov, 'mvex')?.end ?? 0)) {
    if (trex.type === 'trex' && trex.start + 16 <= trex.end) out.set(buf.readUInt32BE(trex.start + 4), buf.readUInt32BE(trex.start + 12));
  }
  return out;
}

function lastFragmentSample(buf: Buffer, traf: Child, trex: ReadonlyMap<number, number>): { id: number; ticks: number } | null {
  let id = -1;
  let fallback: number | null = null;
  let last: number | null = null;
  for (const c of children(buf, traf.start, traf.end)) {
    if (c.type === 'tfhd' && c.start + 8 <= c.end) {
      const flags = buf.readUInt32BE(c.start) & 0xffffff;
      id = buf.readUInt32BE(c.start + 4);
      const at = c.start + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
      fallback = flags & 8 && at + 4 <= c.end ? buf.readUInt32BE(at) : (trex.get(id) ?? null);
    } else if (c.type === 'trun' && c.start + 8 <= c.end) {
      const flags = buf.readUInt32BE(c.start) & 0xffffff;
      const n = buf.readUInt32BE(c.start + 4);
      if (n === 0) continue;
      if (!(flags & 0x100)) {
        last = fallback;
        continue;
      }
      const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length;
      const p = c.start + 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0) + (n - 1) * stride;
      last = p + 4 <= c.end ? buf.readUInt32BE(p) : null;
    }
  }
  return id >= 0 && last !== null ? { id, ticks: last } : null;
}

type MoovScan = Pick<FileLayout, 'movieDurationSec' | 'fragmentDurationSec' | 'tracks' | 'hasMvex'> & { trex: Map<number, number> };

async function readMoov(handle: FileHandle, offset: number, size: number): Promise<MoovScan> {
  const buf = Buffer.alloc(size);
  await handle.read(buf, 0, size, offset);
  const top = children(buf, 0, size)[0];
  if (!top || top.type !== 'moov') return { movieDurationSec: null, fragmentDurationSec: null, tracks: [], hasMvex: false, trex: new Map() };
  const movie = timing(buf, find(buf, top, 'mvhd'), 20, 12);
  const tracks = children(buf, top.start, top.end)
    .filter((c) => c.type === 'trak')
    .map((t) => trackOf(buf, t))
    .filter((t): t is LayoutTrack => t !== null);
  return {
    movieDurationSec: movie && movie.timescale > 0 ? movie.duration / movie.timescale : null,
    fragmentDurationSec: movie ? fragmentDuration(buf, top, movie.timescale) : null,
    tracks,
    hasMvex: !!find(buf, top, 'mvex'),
    trex: trexDurations(buf, top),
  };
}

export async function scanIsoBmffLayout(path: string, size: number): Promise<FileLayout | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const types: string[] = [];
    const seen = new Set<string>();
    let moov: MoovScan = { movieDurationSec: null, fragmentDurationSec: null, tracks: [], hasMvex: false, trex: new Map() };
    let moovOffset: number | null = null;
    let moovSize: number | null = null;
    let firstMdatOffset: number | null = null;
    let sidxBeforeFirstMoof = false;
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
      if (type === 'moov' && moovOffset === null) {
        moovOffset = offset;
        moovSize = boxSize;
      }
      if (type === 'mdat' && firstMdatOffset === null) firstMdatOffset = offset;
      if (type === 'sidx' && !seen.has('moof')) sidxBeforeFirstMoof = true;
      if (type === 'moov' && !seen.has('moov') && offset + boxSize <= size && boxSize <= MOOV_READ_CAP) moov = await readMoov(handle, offset, boxSize);
      if (type === 'moof' && offset + boxSize <= size && boxSize <= MOOV_READ_CAP) {
        const buf = Buffer.alloc(boxSize);
        await handle.read(buf, 0, boxSize, offset);
        for (const traf of children(buf, head.readUInt32BE(0) === 1 ? 16 : 8, boxSize).filter((c) => c.type === 'traf')) {
          const last = lastFragmentSample(buf, traf, moov.trex);
          const track = last ? moov.tracks?.find((t) => t.id === last.id) : undefined;
          if (track && last) track.lastSampleTicks = last.ticks;
        }
      }
      if (!seen.has(type)) {
        seen.add(type);
        if (types.length < TOP_LEVEL_LIST_LIMIT) types.push(type);
      }
      offset += boxSize;
    }
    if (!seen.has('moov') && !seen.has('moof') && !seen.has('ftyp')) return null;
    const { trex: _trex, ...movie } = moov;
    return { fragmented: seen.has('moof'), hasSidx: seen.has('sidx'), topLevel: types, ...movie, moovOffset, moovSize, firstMdatOffset, sidxBeforeFirstMoof };
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

const MKV_CODEC_ID = 0x86;
const MKV_CODEC_PRIVATE = 0x63a2;
const MKV_FLAG_ENABLED = 0xb9;
const MKV_FLAG_DEFAULT = 0x88;
const MKV_VIDEO = 0xe0;
const MKV_COLOUR = 0x55b0;
const MKV_BLOCK_ADDITION_MAPPING = 0x41e4;
const MKV_BLOCK_ADD_ID_TYPE = 0x41e7;
const MKV_VIDEO_FIELDS: Readonly<Record<number, 'pixelWidth' | 'pixelHeight' | 'displayWidth' | 'displayHeight' | 'displayUnit'>> = { 0xb0: 'pixelWidth', 0xba: 'pixelHeight', 0x54b0: 'displayWidth', 0x54ba: 'displayHeight', 0x54b2: 'displayUnit' };
const MKV_CONFIG: Readonly<Record<string, (b: Uint8Array) => CodecConfigFacts | null>> = { 'V_MPEG4/ISO/AVC': avcConfig, 'V_MPEGH/ISO/HEVC': hevcConfig, V_AV1: av1Config, V_VP9: vp9PrivateConfig };

function matroskaColour(b: Buffer, colour: EbmlElement): ContainerColor {
  const out: ContainerColor = { kind: 'Colour', primaries: null, transfer: null, matrix: null, fullRange: null };
  for (const c of ebmlChildren(b, colour.dataStart, colour.end ?? colour.dataStart)) {
    if (c.id === 0x55bb) out.primaries = ebmlUint(b, c);
    else if (c.id === 0x55ba) out.transfer = ebmlUint(b, c);
    else if (c.id === 0x55b1) out.matrix = ebmlUint(b, c);
    else if (c.id === 0x55b9) {
      const range = ebmlUint(b, c);
      out.fullRange = range === 2 ? true : range === 1 ? false : null;
    }
  }
  return out;
}

function matroskaTracks(b: Buffer): MatroskaLayoutTrack[] {
  return ebmlChildren(b, 0, b.length)
    .filter((e) => e.id === MKV_TRACK_ENTRY && e.end !== null)
    .map((entry) => {
      const t: MatroskaLayoutTrack = { number: null, type: null, defaultDurationNs: null, blockDurations: 0 };
      let codecPrivate: Uint8Array | null = null;
      for (const c of ebmlChildren(b, entry.dataStart, entry.end ?? entry.dataStart)) {
        if (c.id === MKV_TRACK_NUMBER) t.number = ebmlUint(b, c);
        else if (c.id === MKV_TRACK_TYPE) t.type = ebmlUint(b, c);
        else if (c.id === MKV_DEFAULT_DURATION) t.defaultDurationNs = ebmlUint(b, c);
        else if (c.id === MKV_CODEC_ID) t.codecId = b.toString('latin1', c.dataStart, c.end ?? c.dataStart).replace(/\0+$/, '');
        else if (c.id === MKV_CODEC_PRIVATE) codecPrivate = b.subarray(c.dataStart, c.end ?? c.dataStart);
        else if (c.id === MKV_FLAG_ENABLED) t.flagEnabled = ebmlUint(b, c) !== 0;
        else if (c.id === MKV_FLAG_DEFAULT) t.flagDefault = ebmlUint(b, c) !== 0;
        else if (c.id === MKV_BLOCK_ADDITION_MAPPING) {
          const type = ebmlChildren(b, c.dataStart, c.end ?? c.dataStart).find((x) => x.id === MKV_BLOCK_ADD_ID_TYPE);
          if (type && type.end !== null && type.end - type.dataStart === 4) (t.blockAdditionTypes ??= []).push(b.toString('latin1', type.dataStart, type.end));
        } else if (c.id === MKV_VIDEO) {
          for (const v of ebmlChildren(b, c.dataStart, c.end ?? c.dataStart)) {
            const field = MKV_VIDEO_FIELDS[v.id];
            if (field) t[field] = ebmlUint(b, v);
            else if (v.id === MKV_COLOUR) t.colour = matroskaColour(b, v);
          }
        }
      }
      t.flagEnabled ??= true;
      t.flagDefault ??= true;
      const parse = t.codecId ? MKV_CONFIG[t.codecId] : undefined;
      t.config = parse && codecPrivate ? parse(codecPrivate) : null;
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
