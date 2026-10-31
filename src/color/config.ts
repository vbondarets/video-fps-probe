import type { CodecConfig } from '../core/types.ts';

export interface Span {
  start: number;
  end: number;
}

export interface ChildBox extends Span {
  type: string;
}

export interface SampleEntry {
  type: string;
  children: ChildBox[];
}

export interface IsoConfig {
  bytes: Uint8Array;
  entries: SampleEntry[];
  tkhd: Uint8Array | null;
  mvhd: Uint8Array | null;
}

export interface MatroskaConfig {
  bytes: Uint8Array;
  codecId: string;
  codecPrivate: Span | null;
  video: Map<number, Span>;
  colour: Map<number, Span>;
  mappings: Array<Map<number, Span>>;
}

export const ID_VIDEO = 0xe0;
export const ID_PIXEL_WIDTH = 0xb0;
export const ID_PIXEL_HEIGHT = 0xba;
export const ID_DISPLAY_WIDTH = 0x54b0;
export const ID_DISPLAY_HEIGHT = 0x54ba;
export const ID_DISPLAY_UNIT = 0x54b2;
export const ID_STEREO_MODE = 0x53b8;
export const ID_COLOUR = 0x55b0;
export const ID_MATRIX_COEFFICIENTS = 0x55b1;
export const ID_BITS_PER_CHANNEL = 0x55b2;
export const ID_RANGE = 0x55b9;
export const ID_TRANSFER_CHARACTERISTICS = 0x55ba;
export const ID_PRIMARIES = 0x55bb;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_BLOCK_ADDITION_MAPPING = 0x41e4;
export const ID_BLOCK_ADD_ID_TYPE = 0x41e7;
export const ID_BLOCK_ADD_ID_EXTRA_DATA = 0x41ed;

const VISUAL_ENTRY_HEADER = 86;
const MAX_CODEC_ID = 64;
const MIXED_ENTRY_TYPES = ['apcn', 'apch', 'dvpp', 'dvcp', 'jpeg'];

export function u16(b: Uint8Array, p: number): number {
  return (b[p] << 8) | b[p + 1];
}

export function u32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

export function i32(b: Uint8Array, p: number): number {
  return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
}

export function fourccAt(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}

interface Box extends Span {
  type: string;
  payload: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourccAt(b, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end || u32(b, p + 8) !== 0) return;
      size = u32(b, p + 12);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header) return;
    const boxEnd = Math.min(p + size, end);
    yield { type, start: p, end: boxEnd, payload: p + header };
    p += size;
  }
}

function sampleEntries(stsd: Uint8Array): SampleEntry[] {
  const out: SampleEntry[] = [];
  const top = boxes(stsd, 0, stsd.length).next();
  if (top.done || top.value.type !== 'stsd') return out;
  const s = top.value;
  if (s.payload + 8 > s.end) return out;
  const count = u32(stsd, s.payload + 4);
  let seen = 0;
  let first = '';
  for (const e of boxes(stsd, s.payload + 8, s.end)) {
    if (seen++ >= count) break;
    first ||= e.type;
    if (e.type !== first && !MIXED_ENTRY_TYPES.includes(first) && (first !== 'AV1x' || e.type !== 'AVup')) continue;
    const entry: SampleEntry = { type: e.type, children: [] };
    out.push(entry);
    if (e.start + VISUAL_ENTRY_HEADER > e.end) continue;
    for (const c of boxes(stsd, e.start + VISUAL_ENTRY_HEADER, e.end)) {
      if (c.type === 'sinf') {
        for (const f of boxes(stsd, c.payload, c.end)) if (f.type === 'frma' && f.payload + 4 <= f.end) entry.type = fourccAt(stsd, f.payload);
      }
      entry.children.push({ type: c.type, start: c.payload, end: c.end });
    }
  }
  return out;
}

const bytesOf = (b: Uint8Array | null): Uint8Array | null => (b && ArrayBuffer.isView(b) ? b : null);

export function isoConfig(config: CodecConfig): IsoConfig | null {
  const bytes = config.family === 'isobmff' ? bytesOf(config.stsd) : null;
  return bytes && config.family === 'isobmff' ? { bytes, entries: sampleEntries(bytes), tkhd: bytesOf(config.tkhd), mvhd: bytesOf(config.mvhd) } : null;
}

export function firstBox(entry: SampleEntry | undefined, type: string): Span | null {
  return entry?.children.find((c) => c.type === type) ?? null;
}

export function boxPayload(box: Uint8Array | null): Span | null {
  if (!box) return null;
  const b = boxes(box, 0, box.length).next();
  return b.done ? null : { start: b.value.payload, end: b.value.end };
}

function vint(b: Uint8Array, p: number, end: number, marker: boolean): [value: number, length: number] | null {
  if (p >= end) return null;
  const first = b[p];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > end) return null;
  let v = marker ? first : first & (0xff >> len);
  let ones = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[p + i];
    ones &&= b[p + i] === 0xff;
  }
  return [!marker && ones ? -1 : v, len];
}

export function* elements(b: Uint8Array, start: number, end: number): Generator<{ id: number } & Span> {
  let p = start;
  while (p < end) {
    const id = vint(b, p, end, true);
    if (!id) return;
    const size = vint(b, p + id[1], end, false);
    if (!size || size[0] < 0) return;
    const data = p + id[1] + size[1];
    const dataEnd = Math.min(data + size[0], end);
    yield { id: id[0], start: data, end: dataEnd };
    p = data + size[0];
  }
}

export function elementUint(b: Uint8Array, span: Span | null | undefined): number | null {
  if (!span || span.end === span.start || span.end - span.start > 8) return null;
  let v = 0;
  for (let p = span.start; p < span.end; p++) v = v * 256 + b[p];
  return v;
}

function children(b: Uint8Array, span: Span, out = new Map<number, Span>()): Map<number, Span> {
  for (const e of elements(b, span.start, span.end)) if (e.id !== ID_COLOUR || !out.has(e.id)) out.set(e.id, e);
  return out;
}

function codecIdAt(b: Uint8Array, span: Span): string {
  let id = '';
  for (let p = span.start; p < span.end && p < span.start + MAX_CODEC_ID && b[p]; p++) id += String.fromCharCode(b[p]);
  return id;
}

export function matroskaConfig(config: CodecConfig): MatroskaConfig | null {
  const b = config.family === 'matroska' ? config.trackEntry : null;
  if (!b || !ArrayBuffer.isView(b)) return null;
  const out: MatroskaConfig = { bytes: b, codecId: '', codecPrivate: null, video: new Map(), colour: new Map(), mappings: [] };
  for (const e of elements(b, 0, b.length)) {
    if (e.id === ID_CODEC_ID) out.codecId = codecIdAt(b, e);
    else if (e.id === ID_CODEC_PRIVATE) out.codecPrivate = e;
    else if (e.id === ID_VIDEO) children(b, e, out.video);
    else if (e.id === ID_BLOCK_ADDITION_MAPPING) out.mappings.push(children(b, e));
  }
  const colour = out.video.get(ID_COLOUR);
  if (colour) out.colour = children(b, colour);
  return out;
}
