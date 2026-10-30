import {
  childUint,
  children,
  ID_ATTACHED_FILE,
  ID_ATTACHMENTS,
  ID_CLUSTER,
  ID_CODEC_DELAY,
  ID_CODEC_ID,
  ID_CODEC_PRIVATE,
  ID_CONTENT_ENCODINGS,
  ID_CRC32,
  ID_CUE_CLUSTER_POSITION,
  ID_CUE_POINT,
  ID_CUE_TRACK_POSITIONS,
  ID_CUES,
  ID_DEFAULT_DURATION,
  ID_DOC_TYPE,
  ID_DURATION,
  ID_EBML,
  ID_FILE_MEDIA_TYPE,
  ID_FRAME_RATE,
  ID_INFO,
  ID_PIXEL_HEIGHT,
  ID_PIXEL_WIDTH,
  ID_SEEK,
  ID_SEEK_HEAD,
  ID_SEEK_ID,
  ID_SEEK_POSITION,
  ID_SEGMENT,
  ID_SIMPLE_TAG,
  ID_TAG,
  ID_TAG_NAME,
  ID_TAG_STRING,
  ID_TAG_TRACK_UID,
  ID_TAGS,
  ID_TARGETS,
  ID_TIMESTAMP_SCALE,
  ID_TRACK_ENTRY,
  ID_TRACK_NUMBER,
  ID_TRACK_TIMESTAMP_SCALE,
  ID_TRACK_TYPE,
  ID_TRACK_UID,
  ID_TRACKS,
  ID_VIDEO,
  ID_VOID,
  LEVEL1_IDS,
  readFloat,
  readString,
  readUintBig,
  UNKNOWN_SIZE,
  vintLength,
  type ElementHeader,
} from './ebml.ts';
import { withErrorCode } from '../reader.ts';
import { findLevel1Forward, type ByteSource } from './source.ts';

export interface MkvTrack {
  number: number;
  uid: bigint;
  type: number;
  codecId: string;
  defaultDuration: number;
  frameRate: number;
  trackTimestampScale: number;
  codecDelay: number;
  codecPrivate: Uint8Array | null;
  encoded: boolean;
  disabled?: boolean;
  width: number;
  height: number;
}

export interface MkvHeader {
  docType: string;
  segmentData: number;
  segmentEnd: number;
  declaredEnd: number;
  segmentUnknownSize: boolean;
  segmentExtended: boolean;
  timestampScale: number;
  duration: number;
  tracks: MkvTrack[];
  tagDurations: Map<bigint, number>;
  firstCluster: number | null;
  walkEnd: number;
  cuesPos: number | null;
  seek: Map<number, number>;
  attachedImages: number;
  warnings: string[];
}

export const HEADER_MAX_READS = 5;
export const HEADER_MAX_BYTES = 1024 * 1024;
export const MAX_DEPTH = 16;
const SPARSE_CHILD_MAX = 64 * 1024;
const CODEC_PRIVATE_MAX = 4096;
const ID_FLAG_ENABLED = 0xb9;
const SEGMENT_SEARCH_HOPS = 16;
const SKIPPED_NAMES: ReadonlyMap<number, string> = new Map([
  [ID_SEEK_HEAD, 'SeekHead'],
  [ID_INFO, 'Info'],
  [ID_TAGS, 'Tags'],
]);

const PARSED: ReadonlySet<number> = new Set([ID_SEEK_HEAD, ID_INFO, ID_TRACKS, ID_TAGS, ID_ATTACHMENTS]);
const CHILDREN: ReadonlyMap<number, readonly number[]> = new Map([
  [ID_SEEK_HEAD, [ID_SEEK]],
  [ID_SEEK, [ID_SEEK_ID, ID_SEEK_POSITION]],
  [ID_INFO, [ID_TIMESTAMP_SCALE, ID_DURATION]],
  [ID_TRACKS, [ID_TRACK_ENTRY]],
  [ID_TRACK_ENTRY, [ID_TRACK_NUMBER, ID_TRACK_UID, ID_TRACK_TYPE, ID_FLAG_ENABLED, ID_CODEC_ID, ID_CODEC_PRIVATE, ID_CONTENT_ENCODINGS, ID_DEFAULT_DURATION, ID_TRACK_TIMESTAMP_SCALE, ID_CODEC_DELAY, ID_VIDEO]],
  [ID_VIDEO, [ID_PIXEL_WIDTH, ID_PIXEL_HEIGHT, ID_FRAME_RATE]],
  [ID_TAGS, [ID_TAG]],
  [ID_TAG, [ID_TARGETS, ID_SIMPLE_TAG]],
  [ID_TARGETS, [ID_TAG_TRACK_UID]],
  [ID_SIMPLE_TAG, [ID_TAG_NAME, ID_TAG_STRING, ID_SIMPLE_TAG]],
  [ID_ATTACHMENTS, [ID_ATTACHED_FILE]],
  [ID_ATTACHED_FILE, [ID_FILE_MEDIA_TYPE]],
  [ID_CUES, [ID_CUE_POINT]],
  [ID_CUE_POINT, [ID_CUE_TRACK_POSITIONS]],
  [ID_CUE_TRACK_POSITIONS, [ID_CUE_CLUSTER_POSITION]],
]);

const hex = (id: number): string => id.toString(16).toUpperCase();

export function withinHeaderBudget(src: ByteSource, len = 0): boolean {
  return src.reader.reads < HEADER_MAX_READS && src.reader.bytesFetched + Math.max(len, src.window) <= HEADER_MAX_BYTES;
}

export function parseDurationTag(s: string): number | null {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(s);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function newTrack(): MkvTrack {
  return { number: 0, uid: 0n, type: 0, codecId: '', defaultDuration: 0, frameRate: 0, trackTimestampScale: 1, codecDelay: 0, codecPrivate: null, encoded: false, width: 0, height: 0 };
}

function finishTrack(h: MkvHeader, t: MkvTrack): void {
  if (!(t.trackTimestampScale >= 0.01)) t.trackTimestampScale = 1;
  if (!t.defaultDuration && t.frameRate > 0) t.defaultDuration = Math.trunc(1e9 / t.frameRate);
  if (!Number.isSafeInteger(t.defaultDuration)) t.defaultDuration = 0;
  h.tracks.push(t);
}

export function parseMaster(h: MkvHeader, b: Uint8Array, start: number, end: number, parent: number, cues: number[] | null = null, entry: MkvTrack | null = null): void {
  let t: MkvTrack = entry ?? newTrack();
  let seekId = -1;
  let seekPos = -1;
  let uids: bigint[] = [];
  let durations: number[] = [];
  let tagName = '';
  let tagValue = '';
  let deep = false;
  const walk = (parentId: number, s: number, e: number, depth: number): void => {
    const allowed = CHILDREN.get(parentId) ?? [];
    if (depth > MAX_DEPTH) {
      deep = true;
      return;
    }
    for (const c of children(b, s, e)) {
      if (!allowed.includes(c.id)) continue;
      const p = c.start;
      const n = c.size;
      const uint = (): number => childUint(b, c);
      const nest = (): void => walk(c.id, p, p + n, depth + 1);
      switch (c.id) {
        case ID_TRACK_ENTRY:
          t = newTrack();
          nest();
          finishTrack(h, t);
          break;
        case ID_TAG:
          uids = [];
          durations = [];
          nest();
          for (const d of durations) for (const u of uids.length ? uids : [0n]) if (!h.tagDurations.has(u)) h.tagDurations.set(u, d);
          break;
        case ID_SIMPLE_TAG: {
          const outer = [tagName, tagValue];
          tagName = tagValue = '';
          nest();
          const d = parentId === ID_TAG && (tagName === 'DURATION' || tagName.startsWith('DURATION-')) ? parseDurationTag(tagValue) : null;
          if (d !== null) durations.push(d);
          [tagName, tagValue] = outer;
          break;
        }
        case ID_SEEK:
          seekId = seekPos = -1;
          nest();
          if (seekId >= 0 && seekPos >= 0 && !h.seek.has(seekId)) h.seek.set(seekId, h.segmentData + seekPos);
          break;
        case ID_TRACK_NUMBER:
          t.number = uint();
          break;
        case ID_TRACK_UID:
          t.uid = readUintBig(b, p, n);
          break;
        case ID_TRACK_TYPE:
          t.type = uint();
          break;
        case ID_FLAG_ENABLED:
          t.disabled = !uint();
          break;
        case ID_CODEC_ID:
          t.codecId = readString(b, p, n);
          break;
        case ID_DEFAULT_DURATION:
          t.defaultDuration = uint();
          break;
        case ID_TRACK_TIMESTAMP_SCALE:
          t.trackTimestampScale = readFloat(b, p, n);
          break;
        case ID_CODEC_DELAY:
          t.codecDelay = uint();
          break;
        case ID_CONTENT_ENCODINGS:
          t.encoded = true;
          break;
        case ID_CODEC_PRIVATE:
          t.codecPrivate = b.slice(p, p + Math.min(n, CODEC_PRIVATE_MAX));
          break;
        case ID_PIXEL_WIDTH:
          t.width = uint();
          break;
        case ID_PIXEL_HEIGHT:
          t.height = uint();
          break;
        case ID_FRAME_RATE:
          t.frameRate = readFloat(b, p, n);
          break;
        case ID_TIMESTAMP_SCALE:
          if (uint() > 0) h.timestampScale = uint();
          break;
        case ID_DURATION: {
          const d = readFloat(b, p, n);
          if (n !== 0 && n !== 4 && n !== 8) h.warnings.push(`Duration has an invalid size of ${n} bytes`);
          else if (Number.isFinite(d)) h.duration = d;
          else h.warnings.push(`invalid Duration value ${d}`);
          break;
        }
        case ID_SEEK_ID:
          seekId = n <= 4 ? uint() : -1;
          break;
        case ID_SEEK_POSITION:
          seekPos = uint();
          break;
        case ID_TAG_TRACK_UID:
          uids.push(readUintBig(b, p, n));
          break;
        case ID_TAG_NAME:
          tagName = readString(b, p, n).toUpperCase();
          break;
        case ID_TAG_STRING:
          tagValue = readString(b, p, n);
          break;
        case ID_FILE_MEDIA_TYPE:
          if (readString(b, p, n).startsWith('image/')) h.attachedImages++;
          break;
        case ID_CUE_CLUSTER_POSITION:
          cues?.push(h.segmentData + uint());
          break;
        default:
          nest();
      }
    }
  };
  walk(parent, start, end, 2);
  if (deep) h.warnings.push(`elements nested deeper than ${MAX_DEPTH} levels ignored`);
}

interface Seen {
  ids: Set<number>;
  at: Set<number>;
}

async function headerIn(src: ByteSource, q: number): Promise<ElementHeader | null> {
  return src.cached(q, 12) || withinHeaderBudget(src) ? src.header(q) : null;
}

async function sparseTracks(src: ByteSource, h: MkvHeader, e: ElementHeader): Promise<void> {
  const end = Math.min(e.dataStart + e.size, src.size);
  let q = e.dataStart;
  while (q < end) {
    const te = await headerIn(src, q);
    if (!te || te.size === UNKNOWN_SIZE) break;
    const teEnd = Math.min(te.dataStart + te.size, end);
    if (te.id === ID_TRACK_ENTRY) {
      const t = newTrack();
      for (let r = te.dataStart; r < teEnd; ) {
        const c = await headerIn(src, r);
        if (!c || c.size === UNKNOWN_SIZE) break;
        const len = c.dataStart + c.size - c.pos;
        if (c.size <= SPARSE_CHILD_MAX && c.pos + len <= teEnd && (src.cached(c.pos, len) || withinHeaderBudget(src, len))) {
          await src.load(c.pos, len);
          parseMaster(h, src.buf, c.pos - src.base, c.pos - src.base + len, ID_TRACK_ENTRY, null, t);
        }
        r = c.pos + len;
      }
      finishTrack(h, t);
    }
    q = te.dataStart + te.size;
  }
  if (q < end) h.warnings.push(`Tracks at ${e.pos} only partly read (header budget)`);
}

async function parseLevel1(src: ByteSource, h: MkvHeader, e: ElementHeader, seen: Seen): Promise<void> {
  seen.at.add(e.pos);
  if (e.id === ID_CUES) h.cuesPos ??= e.pos;
  if (!PARSED.has(e.id)) return;
  const avail = Math.max(0, Math.min(e.size, src.size - e.dataStart));
  const len = Math.min(avail, HEADER_MAX_BYTES);
  const cached = src.cached(e.dataStart, len);
  if (e.id === ID_TRACKS && len < avail && !cached) {
    seen.ids.add(e.id);
    await sparseTracks(src, h, e);
    return;
  }
  if (!cached && (!withinHeaderBudget(src, len) || e.id === ID_ATTACHMENTS)) {
    if (e.id === ID_TRACKS) {
      seen.ids.add(e.id);
      await sparseTracks(src, h, e);
    } else if (e.id !== ID_ATTACHMENTS) h.warnings.push(`${SKIPPED_NAMES.get(e.id) ?? hex(e.id)} element at byte ${e.pos} not read (header budget)`);
    return;
  }
  seen.ids.add(e.id);
  await src.load(e.dataStart, len);
  const s = e.dataStart - src.base;
  parseMaster(h, src.buf, s, s + len, e.id);
}

function extendSegment(h: MkvHeader, src: ByteSource, why: string): void {
  if (h.segmentUnknownSize || h.segmentExtended) return;
  h.segmentExtended = true;
  h.segmentEnd = src.size;
  h.declaredEnd = Math.max(h.declaredEnd, src.size);
  h.warnings.push(`${why}: the Segment size is wrong, reading to the end of the file like ffprobe`);
}

async function findSegment(src: ByteSource, h: MkvHeader, from: number): Promise<ElementHeader | null> {
  let p = from;
  for (let i = 0; i < SEGMENT_SEARCH_HOPS && p < src.size; i++) {
    if (!src.cached(p, 12) && !withinHeaderBudget(src)) {
      h.warnings.push(`Segment search stopped at ${p} (header budget)`);
      return null;
    }
    const e = await src.header(p);
    const b = src.buf;
    const o = p - src.base;
    if (b[o] === 0x18 && b[o + 1] === 0x53 && b[o + 2] === 0x80 && b[o + 3] === 0x67) {
      if (e) return e;
      h.warnings.push(`corrupt Segment size at ${p}`);
      h.segmentExtended = true;
      return { id: ID_SEGMENT, pos: p, size: UNKNOWN_SIZE, dataStart: p + 4 + (vintLength(b[o + 4]) || 8) };
    }
    if (!e || e.size === UNKNOWN_SIZE) return null;
    p = e.dataStart + e.size;
  }
  return null;
}

export async function readMatroskaHeader(src: ByteSource): Promise<MkvHeader> {
  const h: MkvHeader = {
    docType: 'matroska',
    segmentData: 0,
    segmentEnd: 0,
    declaredEnd: 0,
    segmentUnknownSize: false,
    segmentExtended: false,
    timestampScale: 1_000_000,
    duration: 0,
    tracks: [],
    tagDurations: new Map(),
    firstCluster: null,
    walkEnd: 0,
    cuesPos: null,
    seek: new Map(),
    attachedImages: 0,
    warnings: [],
  };
  const ebml = await src.header(0);
  if (!ebml || ebml.id !== ID_EBML || ebml.size === UNKNOWN_SIZE || ebml.dataStart + ebml.size > src.size) throw withErrorCode('corrupt', 'invalid EBML header');
  await src.load(ebml.dataStart, Math.min(ebml.size, 4096));
  const s0 = ebml.dataStart - src.base;
  for (const c of children(src.buf, s0, s0 + ebml.size)) if (c.id === ID_DOC_TYPE) h.docType = readString(src.buf, c.start, c.size);

  const canLoad = (): boolean => withinHeaderBudget(src);
  let seg = await findSegment(src, h, ebml.dataStart + ebml.size);
  if (!seg) {
    const q = await findLevel1Forward(src, ebml.dataStart + ebml.size, src.size, src.size, { canLoad });
    if (q < 0) throw withErrorCode('no-header', 'no Segment element');
    h.warnings.push(`no valid Segment header: reading level-1 elements from ${q}`);
    h.segmentExtended = true;
    seg = { id: ID_SEGMENT, pos: q, size: UNKNOWN_SIZE, dataStart: q };
  }
  h.segmentData = seg.dataStart;
  h.segmentUnknownSize = seg.size === UNKNOWN_SIZE && !h.segmentExtended;
  h.declaredEnd = seg.size === UNKNOWN_SIZE ? Number.MAX_SAFE_INTEGER : seg.dataStart + seg.size;
  h.segmentEnd = Math.min(src.size, h.declaredEnd);
  if (h.declaredEnd > src.size && seg.size !== UNKNOWN_SIZE) h.warnings.push(`truncated file: Segment ends ${h.declaredEnd - src.size} bytes after EOF`);

  const seen: Seen = { ids: new Set(), at: new Set() };
  let p = h.segmentData;
  let from = p;
  let stop = -1;
  for (;;) {
    if (p >= h.segmentEnd) {
      if (p >= src.size) break;
      extendSegment(h, src, `Segment ends at ${p} before any Cluster`);
      if (p >= h.segmentEnd) break;
    }
    if (!src.cached(p, 12) && !canLoad()) {
      h.warnings.push(`header walk stopped at ${p} (header budget)`);
      stop = p;
      break;
    }
    const e = await src.header(p);
    if (e?.id === ID_CLUSTER) {
      h.firstCluster = p;
      break;
    }
    let what = `invalid data at ${p} before the first Cluster`;
    if (e && e.size !== UNKNOWN_SIZE && (LEVEL1_IDS.has(e.id) || e.id === ID_VOID || e.id === ID_CRC32)) {
      const end = e.dataStart + e.size;
      if (end > h.segmentEnd && end <= src.size) extendSegment(h, src, `${hex(e.id)} at ${p} ends after the Segment`);
      await parseLevel1(src, h, e, seen);
      from = p + 1;
      if (end <= src.size) {
        p = end;
        continue;
      }
      what = `${hex(e.id)} at ${p} ends after the end of the file`;
    }
    const q = await findLevel1Forward(src, from, src.size, Math.max(h.declaredEnd, src.size), { canLoad });
    h.warnings.push(q < 0 ? what : `${what}: resynchronised at ${q}`);
    if (q < 0) break;
    if (q >= h.segmentEnd) extendSegment(h, src, `level-1 element at ${q} after the Segment end`);
    from = q + 1;
    p = q;
  }
  h.walkEnd = h.firstCluster ?? (stop >= 0 ? stop : from);

  for (const id of [ID_SEEK_HEAD, ID_INFO, ID_TRACKS, ID_TAGS]) {
    const pos = h.seek.get(id);
    if (pos === undefined || seen.at.has(pos) || (id !== ID_SEEK_HEAD && seen.ids.has(id)) || pos >= h.segmentEnd) continue;
    const e = await headerIn(src, pos);
    if (e?.id === id) await parseLevel1(src, h, e, seen);
    else h.warnings.push(`SeekHead entry ${hex(id)} not followed`);
  }
  h.cuesPos ??= h.seek.get(ID_CUES) ?? null;
  if (!seen.ids.has(ID_INFO)) h.warnings.push('no Info element: TimestampScale 1000000 assumed');
  if (!h.tracks.length) throw seen.ids.has(ID_TRACKS) ? withErrorCode('truncated', 'no complete TrackEntry in Tracks') : withErrorCode('no-header', 'no Tracks element found');
  return h;
}
