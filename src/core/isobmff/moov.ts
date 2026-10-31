import { fourcc } from '../reader.ts';
import { boundEntries, boxI64, boxU64, childBoxes, IsoBmffError, readBoxHeader, type BoxHeader } from './boxes.ts';
import { newTrack, TO_MEDIA_END, type IsoMovie, type IsoTrack, type TableRef } from './model.ts';

export const MAX_STTS_DELTA = 4294487295;
const UINT32_ALL_ONES = 0xffffffff;

interface ParseContext {
  strict: boolean;
  warnings: string[];
  base: number;
}

function children(dv: DataView, h: BoxHeader, ctx: ParseContext, skip = 0): Generator<BoxHeader> {
  return guard(childBoxes(dv, h.start + h.headerSize + skip, h.end, ctx.warnings), ctx, h.type);
}

function* guard(gen: Generator<BoxHeader>, ctx: ParseContext, parent: string): Generator<BoxHeader> {
  for (const c of gen) {
    if (c.truncated) {
      if (ctx.strict) throw new IsoBmffError('truncated', 'incomplete file: moov is truncated');
      ctx.warnings.push(`'${c.type}' overruns '${parent}'`);
    }
    yield c;
  }
}

function payload(h: BoxHeader): number {
  return h.start + h.headerSize;
}

function readMatrix(dv: DataView, p: number): Int32Array {
  const m = new Int32Array(9);
  for (let i = 0; i < 9; i++) m[i] = dv.getInt32(p + i * 4);
  return m;
}

export function normalizeTimescale(raw: number): number {
  return raw > 0 && raw <= 0x7fffffff ? raw : 1;
}

function tableRef(h: BoxHeader): TableRef {
  return { start: payload(h), end: h.end };
}

export function parseStts(dv: DataView, h: BoxHeader, tr: IsoTrack): void {
  const p = payload(h);
  if (p + 8 > h.end) return;
  const declared = dv.getUint32(p + 4);
  const n = boundEntries(declared, h.end - p - 8, 8, 'stts', tr.warnings);
  if (n < declared) tr.overruns.push('stts');
  const counts = new Uint32Array(n);
  const deltas = new Uint32Array(n);
  let large = false;
  for (let i = 0; i < n; i++) {
    counts[i] = dv.getUint32(p + 8 + i * 8);
    deltas[i] = dv.getUint32(p + 12 + i * 8);
    if (deltas[i] > MAX_STTS_DELTA) large = true;
  }
  if (large) correctLargeDeltas(counts, deltas, tr.warnings);
  tr.sttsCounts = counts;
  tr.sttsDeltas = deltas;
}

function correctLargeDeltas(counts: Uint32Array, deltas: Uint32Array, warnings: string[]): void {
  let current = 0n;
  let corrected = 0n;
  for (let i = 0; i < counts.length; i++) {
    const count = BigInt(counts[i]);
    let d = deltas[i];
    if (d > MAX_STTS_DELTA) {
      warnings.push(`stts delta ${d} clipped to 1`);
      const magnitude = d | 0;
      d = 1;
      corrected += BigInt(magnitude < 0 ? magnitude : 1) * count;
    } else {
      corrected += BigInt(d) * count;
    }
    current += BigInt(d) * count;
    if (current > corrected) {
      const drift = (current - corrected) / (count > 0n ? count : 1n);
      const correction = BigInt(d) > drift ? drift : BigInt((d - 1) >>> 0);
      current -= correction * count;
      d = Number((BigInt(d) - correction) & 0xffffffffn);
    }
    deltas[i] = d;
  }
}

export function parseCtts(dv: DataView, h: BoxHeader, tr: IsoTrack): void {
  const p = payload(h);
  if (p + 8 > h.end) return;
  const declared = dv.getUint32(p + 4);
  const n = boundEntries(declared, h.end - p - 8, 8, 'ctts', tr.warnings);
  if (n < declared) tr.overruns.push('ctts');
  if (n === 0) return;
  const counts: number[] = [];
  const offsets: number[] = [];
  let shift = 0;
  for (let i = 0; i < n; i++) {
    const count = dv.getInt32(p + 8 + i * 8);
    const offset = dv.getInt32(p + 12 + i * 8);
    if (count <= 0) continue;
    counts.push(count);
    offsets.push(offset);
    if (i + 2 < declared && offset < 0) shift = Math.max(shift, offset === -2147483648 ? 2147483647 : -offset);
  }
  tr.cttsCounts = Uint32Array.from(counts);
  tr.cttsOffsets = Int32Array.from(offsets);
  tr.dtsShift = shift;
}

function parseElst(dv: DataView, h: BoxHeader, tr: IsoTrack, ctx: ParseContext, movie: IsoMovie): void {
  const p = payload(h);
  if (p + 8 > h.end) return;
  const v = dv.getUint8(p);
  const size = v === 1 ? 20 : 12;
  const declared = dv.getUint32(p + 4);
  const room = h.end - p - 8;
  const n = declared * size === room ? declared : Math.floor(room / size);
  if (n !== declared) tr.warnings.push(`elst declares ${declared} entries but its box holds ${n}`);
  if (n === 0) return;
  if (tr.edits.length) {
    tr.warnings.push('duplicated elst: the last one is used');
    tr.edits = [];
  }
  const at = ctx.base + h.start;
  for (let i = 0; i < n; i++) {
    const o = p + 8 + i * size;
    if (v === 1) {
      const mediaTime = boxI64(dv, o + 8, 'elst', at);
      const unknown = dv.getBigInt64(o) === -1n;
      if (unknown) {
        tr.warnings.push(`unknown elst duration: ${mediaTime === -1 ? 'the empty edit is ignored' : 'the edit lasts to the end'}`);
        movie.ffprobeReject ??= { moof: -1, reason: 'rejects this file: an elst duration of -1' };
      }
      tr.edits.push({ duration: !unknown ? boxU64(dv, o, 'elst', at) : mediaTime === -1 ? 0 : TO_MEDIA_END, mediaTime, rate: dv.getInt32(o + 16) / 65536 });
    } else tr.edits.push({ duration: dv.getUint32(o), mediaTime: dv.getInt32(o + 4), rate: dv.getInt32(o + 8) / 65536 });
  }
}

function parseEsds(dv: DataView, start: number, end: number): number | null {
  let p = start + 4;
  const descriptor = (): [tag: number, size: number] | null => {
    if (p + 2 > end) return null;
    const tag = dv.getUint8(p++);
    let size = 0;
    for (let i = 0; i < 4 && p < end; i++) {
      const b = dv.getUint8(p++);
      size = size * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return [tag, size];
  };
  let d = descriptor();
  if (d && d[0] === 3) {
    if (p + 3 > end) return null;
    const flags = dv.getUint8(p + 2);
    p += 3;
    if (flags & 0x80) p += 2;
    if (flags & 0x40 && p < end) p += 1 + dv.getUint8(p);
    if (flags & 0x20) p += 2;
    d = descriptor();
  }
  if (d && d[0] === 4 && p < end) return dv.getUint8(p);
  return null;
}

function parseStsd(dv: DataView, h: BoxHeader, tr: IsoTrack, ctx: ParseContext): void {
  const p = payload(h);
  if (p + 8 > h.end) return;
  tr.stsdCount = dv.getUint32(p + 4);
  if (tr.stsdCount === 0) return;
  let e: BoxHeader | null;
  try {
    e = readBoxHeader(dv, p + 8, h.end);
  } catch (err) {
    tr.warnings.push((err as Error).message);
    return;
  }
  if (!e) return;
  tr.sampleEntry = e.type;
  if (tr.handler === 'soun' || e.start + 86 > e.end) return;
  tr.width = dv.getUint16(e.start + 32);
  tr.height = dv.getUint16(e.start + 34);
  for (const c of childBoxes(dv, e.start + 86, e.end, ctx.warnings)) {
    if (c.type === 'esds') tr.esdsObjectType = parseEsds(dv, payload(c), c.end);
    else if (c.type === 'hvcC') tr.hasHvcc = true;
    else if (c.type === 'sinf') {
      for (const s of childBoxes(dv, payload(c), c.end, ctx.warnings)) {
        if (s.type === 'frma' && payload(s) + 4 <= s.end) tr.originalFormat = fourcc(dv, payload(s));
      }
    }
  }
}

function parseStbl(dv: DataView, h: BoxHeader, tr: IsoTrack, ctx: ParseContext): void {
  for (const c of children(dv, h, ctx)) {
    const p = payload(c);
    switch (c.type) {
      case 'stsd':
        parseStsd(dv, c, tr, ctx);
        break;
      case 'stts':
        parseStts(dv, c, tr);
        break;
      case 'ctts':
        parseCtts(dv, c, tr);
        break;
      case 'stsz':
      case 'stz2':
        if (p + 12 <= c.end) {
          tr.sampleCount = dv.getUint32(p + 8);
          tr.sampleSize = c.type === 'stsz' ? dv.getUint32(p + 4) : 0;
        }
        if (c.type === 'stsz') tr.stsz = tableRef(c);
        else tr.stz2 = tableRef(c);
        break;
      case 'stss':
        tr.stss = tableRef(c);
        if (p + 8 <= c.end && dv.getUint32(p + 4) > Math.floor((c.end - p - 8) / 4)) tr.overruns.push('stss');
        break;
      case 'stsc':
        tr.stsc = tableRef(c);
        break;
      case 'stco':
        tr.stco = tableRef(c);
        break;
      case 'co64':
        tr.co64 = tableRef(c);
        break;
    }
  }
}

function parseMdia(dv: DataView, h: BoxHeader, tr: IsoTrack, ctx: ParseContext): void {
  for (const c of children(dv, h, ctx)) {
    const p = payload(c);
    if (c.type === 'mdhd' && p + 24 <= c.end) {
      const v1 = dv.getUint8(p) === 1;
      if (v1 && p + 32 > c.end) continue;
      tr.hasMdhd = true;
      const raw = dv.getUint32(p + (v1 ? 20 : 12));
      tr.timescale = normalizeTimescale(raw);
      if (tr.timescale !== raw) tr.warnings.push(`invalid mdhd timescale ${raw}, using 1`);
      if (v1) {
        const d = dv.getBigUint64(p + 24);
        tr.mdhdDuration = d === 0xffffffffffffffffn ? 0 : Number(d);
      } else {
        const d = dv.getUint32(p + 16);
        tr.mdhdDuration = d === UINT32_ALL_ONES ? 0 : d;
      }
    } else if (c.type === 'hdlr' && p + 12 <= c.end) {
      tr.handler = fourcc(dv, p + 8);
    } else if (c.type === 'minf') {
      for (const s of children(dv, c, ctx)) if (s.type === 'stbl') parseStbl(dv, s, tr, ctx);
    }
  }
}

function parseTrak(dv: DataView, h: BoxHeader, movie: IsoMovie, ctx: ParseContext): IsoTrack {
  const tr = newTrack();
  tr.dv = dv;
  for (const c of children(dv, h, ctx)) {
    const p = payload(c);
    if (c.type === 'tkhd' && p + 84 <= c.end) {
      const v1 = dv.getUint8(p) === 1;
      if (v1 && p + 96 > c.end) continue;
      tr.enabled = (dv.getUint8(p + 3) & 1) === 1;
      tr.id = dv.getUint32(p + (v1 ? 20 : 12));
      tr.matrix = readMatrix(dv, p + (v1 ? 52 : 40));
    } else if (c.type === 'edts') {
      for (const e of children(dv, c, ctx)) if (e.type === 'elst') parseElst(dv, e, tr, ctx, movie);
    } else if (c.type === 'mdia') {
      parseMdia(dv, c, tr, ctx);
    } else if (c.type === 'tref') {
      for (const r of children(dv, c, ctx)) {
        if (r.type !== 'chap') continue;
        for (let q = payload(r); q + 4 <= r.end; q += 4) movie.chapterTrackIds.add(dv.getUint32(q));
      }
    }
  }
  return tr;
}

export function parseMoov(dv: DataView, h: BoxHeader, movie: IsoMovie, strict: boolean, base = 0): void {
  const ctx: ParseContext = { strict, warnings: movie.warnings, base };
  for (const c of children(dv, h, ctx)) {
    const p = payload(c);
    switch (c.type) {
      case 'mvhd': {
        if (p + 24 > c.end) break;
        const v1 = dv.getUint8(p) === 1;
        if (v1 && p + 84 > c.end) break;
        movie.hasMvhd = true;
        movie.timescale = normalizeTimescale(dv.getUint32(p + (v1 ? 20 : 12)));
        movie.duration = v1 ? Number(dv.getBigUint64(p + 24)) : dv.getUint32(p + 16);
        if (p + (v1 ? 84 : 72) <= c.end) movie.matrix = readMatrix(dv, p + (v1 ? 48 : 36));
        break;
      }
      case 'trak':
        movie.tracks.push(parseTrak(dv, c, movie, ctx));
        break;
      case 'mvex':
        movie.hasMvex = true;
        for (const m of children(dv, c, ctx)) {
          const q = payload(m);
          if (m.type === 'trex' && q + 24 <= m.end) movie.trex.set(dv.getUint32(q + 4), { duration: dv.getUint32(q + 12), size: dv.getUint32(q + 16) });
        }
        break;
      case 'cmov':
        throw new IsoBmffError('unsupported', 'unsupported: compressed movie header (cmov)');
    }
  }
}
