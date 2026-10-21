import {
  ID_BLOCK,
  ID_BLOCK_ADDITIONS,
  ID_BLOCK_DURATION,
  ID_BLOCK_GROUP,
  ID_CLUSTER,
  ID_CODEC_STATE,
  ID_CRC32,
  ID_DISCARD_PADDING,
  ID_POSITION,
  ID_PREV_SIZE,
  ID_REFERENCE_BLOCK,
  ID_SEGMENT,
  ID_SIMPLE_BLOCK,
  ID_TIMESTAMP,
  ID_VOID,
  LEVEL1_IDS,
  MAX_HEADER_BYTES,
  UNKNOWN_SIZE,
  headerShort,
  readHeader,
  readUint,
  readVint,
  vintLength,
  type ElementHeader,
} from './ebml.ts';
import type { MkvHeader, MkvTrack } from './header.ts';
import { findLevel1Forward, isClusterAt, type ByteSource } from './source.ts';

export interface TrackScan {
  track: MkvTrack;
  tickNs: number;
  codecDelayTicks: number;
  pts: Float64Array;
  n: number;
  blocks: number;
  frames: number;
  invisible: number;
  missingPts: number;
  noPtsFrames: number;
  nextPts: number;
  pending: number[];
  overLimit: number;
  maxPts: number;
  maxPtsDur: number;
}

export interface ScanState {
  header: MkvHeader;
  tracks: Map<number, TrackScan>;
  known: ReadonlySet<number>;
  fileSize: number;
  maxSamples: number;
  clusters: number;
  truncated: boolean;
  missingClusterTs: number;
  maxAnyTicks: number;
  lastGood: number;
  resyncs: number;
  afterSegment: number;
  switchReads: number;
  largeWindow: number;
  warnings: string[];
}

export type ScanFailure = 'invalid' | 'eof';

const BLOCK_HEADER_BYTES = 16;
const MAX_BINARY = 0x10000000;
const MAX_LACE = 0x7fffffffn;
const MAX_RESYNC_WARNINGS = 5;
const CLUSTER_CHILDREN: ReadonlySet<number> = new Set([ID_TIMESTAMP, ID_SIMPLE_BLOCK, ID_BLOCK_GROUP, ID_POSITION, ID_PREV_SIZE, ID_VOID, ID_CRC32]);
const GROUP_CHILDREN: ReadonlySet<number> = new Set([ID_BLOCK, ID_BLOCK_DURATION, ID_REFERENCE_BLOCK, ID_DISCARD_PADDING, ID_BLOCK_ADDITIONS, ID_CODEC_STATE, ID_VOID, ID_CRC32]);
const UINT_IDS: ReadonlySet<number> = new Set([ID_TIMESTAMP, ID_BLOCK_DURATION, ID_REFERENCE_BLOCK, ID_DISCARD_PADDING]);

export function newScanState(h: MkvHeader, fileSize: number, tracks: readonly MkvTrack[], maxSamples = Infinity): ScanState {
  const map = new Map<number, TrackScan>();
  for (const t of tracks) {
    const tickNs = Math.trunc(h.timestampScale * t.trackTimestampScale) || h.timestampScale;
    map.set(t.number, {
      track: t,
      tickNs,
      codecDelayTicks: Math.round(t.codecDelay / tickNs),
      pts: new Float64Array(256),
      n: 0,
      blocks: 0,
      frames: 0,
      invisible: 0,
      missingPts: 0,
      noPtsFrames: 0,
      nextPts: NaN,
      pending: [],
      overLimit: 0,
      maxPts: -Infinity,
      maxPtsDur: 0,
    });
  }
  return {
    header: h,
    tracks: map,
    known: new Set(h.tracks.map((t) => t.number)),
    fileSize,
    maxSamples,
    clusters: 0,
    truncated: false,
    missingClusterTs: 0,
    maxAnyTicks: -Infinity,
    lastGood: -1,
    resyncs: 0,
    afterSegment: -1,
    switchReads: Infinity,
    largeWindow: 0,
    warnings: [],
  };
}

function pushPts(t: TrackScan, v: number, max: number): void {
  if (t.n === t.pts.length) {
    const next = new Float64Array(Math.max(t.n + 1, Math.min(t.pts.length * 2, max)));
    next.set(t.pts);
    t.pts = next;
  }
  t.pts[t.n++] = v;
}

export interface BlockInfo {
  track: number;
  rel: number;
  flags: number;
  laces: number;
}

export function parseBlockHeader(b: Uint8Array, p: number, size: number): BlockInfo | null {
  const end = Math.min(b.length, p + size);
  const tn = readVint(b, p, end);
  if (!tn) return null;
  const q = p + tn.length;
  if (q + 3 > end) return null;
  const rel = ((b[q] << 24) >> 16) | b[q + 1];
  const flags = b[q + 2];
  let laces = 1;
  if (flags & 0x06) {
    if (q + 4 > end) return null;
    laces = b[q + 3] + 1;
  }
  return { track: tn.value, rel, flags, laces };
}

type Vint = { v: bigint; n: number } | 'invalid' | 'more';

function bigVint(b: Uint8Array, p: number, end: number, avail: number): Vint {
  if (p >= end) return 'invalid';
  if (p >= avail) return 'more';
  const n = vintLength(b[p]);
  if (!n || p + n > end) return 'invalid';
  if (p + n > avail) return 'more';
  let v = BigInt(b[p] & (0xff >> n));
  for (let i = 1; i < n; i++) v = v * 256n + BigInt(b[p + i]);
  return { v, n };
}

export function parseBlock(b: Uint8Array, o: number, size: number, known: ReadonlySet<number> | null): BlockInfo | 'invalid' | 'more' {
  const end = o + size;
  const avail = Math.min(end, b.length);
  const blk = parseBlockHeader(b, o, avail - o);
  if (!blk) {
    const tl = o < avail ? vintLength(b[o]) : 0;
    return avail < end && (o >= avail || (tl > 0 && o + tl + 4 > avail)) ? 'more' : 'invalid';
  }
  const q = o + vintLength(b[o]);
  if (known && !known.has(blk.track)) return 'invalid';
  const type = (blk.flags >> 1) & 3;
  if (!type) return blk;
  let rem = end - q - 4;
  if (rem < 0) return 'invalid';
  const laces = blk.laces;
  let r = q + 4;
  if (type === 2) return rem % laces ? 'invalid' : blk;
  if (type === 1) {
    let total = 0;
    for (let n = 0; n < laces - 1; n++) {
      let temp: number;
      do {
        if (rem <= total) return 'invalid';
        if (r >= avail) return 'more';
        temp = b[r++];
        total += temp;
        rem--;
      } while (temp === 0xff);
    }
    return rem < total ? 'invalid' : blk;
  }
  let x = bigVint(b, r, end, avail);
  if (typeof x === 'string') return x;
  if (x.v > MAX_LACE) return 'invalid';
  let prev = x.v;
  let total = x.v;
  r += x.n;
  for (let n = 1; n < laces - 1; n++) {
    x = bigVint(b, r, end, avail);
    if (typeof x === 'string') return x;
    const cur = prev + x.v - ((1n << BigInt(7 * x.n - 1)) - 1n);
    if (cur < 0n || cur > MAX_LACE) return 'invalid';
    prev = cur;
    total += cur;
    r += x.n;
  }
  return BigInt(end - r) < total ? 'invalid' : blk;
}

function emit(st: ScanState, t: TrackScan, pts: number, dur: number): void {
  if (t.n < st.maxSamples) pushPts(t, pts, st.maxSamples);
  else t.overLimit++;
  if (pts >= t.maxPts) {
    t.maxPts = pts;
    t.maxPtsDur = dur;
  }
  t.nextPts = pts + dur;
}

export function addBlock(st: ScanState, blk: BlockInfo, clusterTs: number, blockDuration: number): TrackScan | null {
  const anyTicks = clusterTs + blk.rel;
  if (anyTicks > st.maxAnyTicks) st.maxAnyTicks = anyTicks;
  const t = st.tracks.get(blk.track);
  if (!t) return null;
  const laces = blk.laces;
  t.blocks++;
  t.frames += laces;
  if (blk.flags & 0x08) t.invisible++;
  const bd = blockDuration > 0 ? blockDuration : Math.floor((t.track.defaultDuration * laces) / st.header.timestampScale);
  const off = (i: number): number => Math.floor((bd * i) / laces);
  if (anyTicks < 0) {
    t.noPtsFrames += laces;
    for (let i = 0; i < laces; i++) {
      if (Number.isNaN(t.nextPts)) t.pending.push(off(i + 1) - off(i));
      else emit(st, t, t.nextPts, off(i + 1) - off(i));
    }
    return t;
  }
  const div = t.track.trackTimestampScale;
  const base = (div === 1 ? clusterTs : Math.floor(clusterTs / div)) + blk.rel - t.codecDelayTicks;
  let fill = base;
  for (const d of t.pending) fill -= d;
  for (const d of t.pending.splice(0)) {
    emit(st, t, fill, d);
    fill += d;
  }
  for (let i = 0; i < laces; i++) {
    if (i > 0 && bd === 0) {
      t.missingPts += laces - i;
      break;
    }
    emit(st, t, base + off(i), off(i + 1) - off(i));
  }
  return t;
}

async function readBlock(src: ByteSource, st: ScanState, e: ElementHeader): Promise<BlockInfo | 'invalid'> {
  let need = Math.min(e.size, BLOCK_HEADER_BYTES);
  for (;;) {
    if (!src.has(e.dataStart, need)) await src.load(e.dataStart, need);
    const r = parseBlock(src.buf, e.dataStart - src.base, e.size, st.known);
    if (r !== 'more') return r;
    if (need >= e.size) return 'invalid';
    need = Math.min(e.size, need * 8);
  }
}

function cachedHeader(src: ByteSource, p: number): ElementHeader | null | undefined {
  return src.has(p, MAX_HEADER_BYTES) ? readHeader(src.buf, p - src.base, src.base) : undefined;
}

async function headerAt(src: ByteSource, p: number): Promise<ElementHeader | ScanFailure> {
  const e = cachedHeader(src, p) ?? (await src.header(p));
  if (e) return e;
  return headerShort(src.buf, p - src.base) ? 'eof' : 'invalid';
}

function uintIn(src: ByteSource, e: ElementHeader): number | undefined {
  return src.has(e.dataStart, e.size) ? readUint(src.buf, e.dataStart - src.base, e.size) : undefined;
}

async function uintAt(src: ByteSource, e: ElementHeader): Promise<number> {
  await src.load(e.dataStart, e.size);
  return readUint(src.buf, e.dataStart - src.base, e.size);
}

function checkChild(e: ElementHeader, parentEnd: number): ScanFailure | null {
  if (e.size === UNKNOWN_SIZE) return 'invalid';
  const end = e.dataStart + e.size;
  if (end > parentEnd || (UINT_IDS.has(e.id) && e.size > 8) || ((e.id === ID_SIMPLE_BLOCK || e.id === ID_BLOCK) && e.size > MAX_BINARY)) return 'invalid';
  return null;
}

export interface ClusterWalk {
  next: number;
  videoBlocks: number;
  error: ScanFailure | null;
}

export async function walkCluster(src: ByteSource, st: ScanState, pos: number, maxVideoBlocks = Infinity): Promise<ClusterWalk | null> {
  const c = cachedHeader(src, pos) ?? (await src.header(pos));
  if (!c || c.id !== ID_CLUSTER) return null;
  const size = st.fileSize;
  const end = c.size === UNKNOWN_SIZE ? Infinity : c.dataStart + c.size;
  st.clusters++;
  let clusterTs = -1;
  let videoBlocks = 0;
  let p = c.dataStart;
  const fail = (error: ScanFailure): ClusterWalk => ({ next: p, videoBlocks, error });
  while (p < end) {
    if (videoBlocks >= maxVideoBlocks) return { next: Math.min(end, p), videoBlocks, error: null };
    if (st.switchReads <= src.reader.reads) {
      src.window = st.largeWindow;
      st.switchReads = Infinity;
    }
    if (p >= size) return end === Infinity ? { next: p, videoBlocks, error: null } : fail('eof');
    let e: ElementHeader | ScanFailure | null | undefined = cachedHeader(src, p);
    if (!e) e = await headerAt(src, p);
    if (typeof e === 'string') return fail(e);
    const known = CLUSTER_CHILDREN.has(e.id);
    if (!known && end === Infinity && (LEVEL1_IDS.has(e.id) || e.id === ID_SEGMENT)) return { next: p, videoBlocks, error: null };
    const bad = checkChild(e, end);
    if (bad) return fail(bad);
    if (known) st.lastGood = p;
    const eEnd = e.dataStart + e.size;
    if (eEnd > size) return fail('eof');
    if (e.id === ID_TIMESTAMP) clusterTs = uintIn(src, e) ?? (await uintAt(src, e));
    else if (e.id === ID_SIMPLE_BLOCK || e.id === ID_BLOCK_GROUP) {
      let block: ElementHeader | null = e;
      let duration = 0;
      if (e.id === ID_BLOCK_GROUP) {
        block = null;
        for (let q = e.dataStart; q < eEnd; ) {
          const g = cachedHeader(src, q) || (await headerAt(src, q));
          const gBad = typeof g === 'string' ? g : checkChild(g, eEnd);
          if (gBad || typeof g === 'string') {
            p = q;
            return fail(gBad ?? 'invalid');
          }
          if (GROUP_CHILDREN.has(g.id)) st.lastGood = q;
          if (g.id === ID_BLOCK) block = g;
          else if (g.id === ID_BLOCK_DURATION) duration = uintIn(src, g) ?? (await uintAt(src, g));
          q = g.dataStart + g.size;
        }
      }
      if (block) {
        let blk = src.has(block.dataStart, Math.min(block.size, BLOCK_HEADER_BYTES)) ? parseBlock(src.buf, block.dataStart - src.base, block.size, st.known) : 'more';
        if (blk === 'more') blk = await readBlock(src, st, block);
        if (blk === 'invalid') return fail('invalid');
        if (clusterTs < 0) {
          st.missingClusterTs++;
          clusterTs = 0;
        }
        const t = addBlock(st, blk, clusterTs, duration);
        if (t && t.track.type === 1) videoBlocks++;
      }
    }
    p = eEnd;
  }
  return { next: end, videoBlocks, error: null };
}

function noteResync(st: ScanState, at: number, q: number, error: ScanFailure): void {
  if (q < 0 && error === 'eof') {
    st.truncated = true;
    return;
  }
  if (++st.resyncs > MAX_RESYNC_WARNINGS) return;
  if (q < 0) st.warnings.push(`invalid data at ${at}, no further level-1 element`);
  else if (q >= at) st.warnings.push(`skipped ${q - at} bytes of invalid data at ${at}`);
  else st.warnings.push(`invalid data at ${at}: resynchronised at ${q}`);
}

export async function scanSegment(src: ByteSource, st: ScanState, start: number, onStep?: (pos: number, end: number) => void): Promise<void> {
  const h = st.header;
  const size = st.fileSize;
  let segEnd = h.segmentUnknownSize || h.segmentExtended ? Infinity : h.declaredEnd;
  let p = start;
  st.lastGood = start - 1;
  for (;;) {
    src.reader.checkAbort();
    onStep?.(p, Math.min(size, segEnd));
    let error: ScanFailure | null = null;
    let at = p;
    if (p >= size) {
      if (p < segEnd && segEnd !== Infinity) st.truncated = true;
      break;
    }
    if (p >= segEnd) {
      segEnd = Infinity;
      const q = await findLevel1Forward(src, Math.max(st.lastGood + 1, p), size, Infinity);
      if (q < 0) break;
      if (st.afterSegment < 0) st.afterSegment = p;
      p = q;
      continue;
    }
    const e = await headerAt(src, p);
    if (typeof e === 'string') error = e;
    else {
      const l1 = LEVEL1_IDS.has(e.id) || e.id === ID_VOID || e.id === ID_CRC32;
      if (e.id === ID_SEGMENT && segEnd === Infinity) {
        if (st.afterSegment < 0) st.afterSegment = p;
        error = 'invalid';
      } else if (e.size === UNKNOWN_SIZE) {
        if (e.id === ID_CLUSTER) segEnd = Infinity;
        else error = 'invalid';
      } else if (e.dataStart + e.size > segEnd) error = 'invalid';
      if (!error) {
        if (l1) st.lastGood = p;
        if (e.id === ID_CLUSTER) {
          const w = (await walkCluster(src, st, p)) as ClusterWalk;
          if (w.error) {
            error = w.error;
            at = w.next;
          } else p = w.next;
        } else if (e.dataStart + e.size > size) error = 'eof';
        else p = e.dataStart + e.size;
      }
    }
    if (!error) continue;
    segEnd = Infinity;
    const q = await findLevel1Forward(src, st.lastGood + 1, size, Infinity);
    if (!(error === 'invalid' && at === st.afterSegment)) noteResync(st, at, q, error);
    if (q < 0) break;
    p = q;
  }
  if (st.resyncs > MAX_RESYNC_WARNINGS) st.warnings.push(`${st.resyncs - MAX_RESYNC_WARNINGS} more resynchronisation(s) after invalid data`);
  if (st.afterSegment >= 0) st.warnings.push(`data after the Segment end at ${st.afterSegment} was scanned like ffprobe does (concatenated files?)`);
}

export async function findLastClusters(src: ByteSource, from: number, to: number, limit: number): Promise<number[]> {
  await src.load(from, to - from, to - from);
  const b = src.buf;
  const base = src.base;
  const out: number[] = [];
  for (let i = to - base - 4; i >= from - base; i--) {
    if (b[i] === 0x1f && isClusterAt(b, i, limit - base)) out.push(base + i);
  }
  return out;
}
