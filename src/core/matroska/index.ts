import { DEFAULT_COST_MODEL, predictReadMs } from '../options.ts';
import { avgFrameRate, reduceRational, toFfprobeString } from '../rational.ts';
import type { BlobReader } from '../reader.ts';
import { emptyAnalysis, emptyTrack } from '../result.ts';
import { analyzeTimeline, rateFromTicks, rateProfileOf, VFR_RELATIVE_TOLERANCE, type ProfileJob, type TimelineStats } from '../stats.ts';
import type { ContainerAnalysis, Provenance, ResolvedAnalyzeOptions, VideoTrackResult } from '../types.ts';
import { ID_BLOCK, ID_BLOCK_GROUP, ID_CLUSTER, ID_CRC32, ID_CUES, ID_POSITION, ID_PREV_SIZE, ID_SIMPLE_BLOCK, ID_TIMESTAMP, ID_VOID, readHeader, UNKNOWN_SIZE } from './ebml.ts';
import { parseMaster, readMatroskaHeader, type MkvHeader, type MkvTrack } from './header.ts';
import { findLastClusters, newScanState, parseBlockHeader, scanSegment, walkCluster, type ScanState, type TrackScan } from './scan.ts';
import { ByteSource, findClusterForward } from './source.ts';

export const LARGE_FRAME_BYTES = 32 * 1024;
export const SMALL_SCAN_WINDOW = 4 * 1024;
export const PROBE_CLUSTERS = 8;
export const PROBE_BLOCKS = 32;
export const MAX_TAIL_BYTES = 16 * 1024 * 1024;
export const MAX_CUES_BYTES = 512 * 1024;
const SYNC_SEARCH_BYTES = 1024 * 1024;
const SYNC_SEARCH_STEP = 256 * 1024;
const FIRST_CLUSTER_SEARCH_BYTES = 16 * 1024 * 1024;
const DENSITY_SAMPLE_BYTES = 16 * 1024;
const MAX_CUE_FALLBACKS = 4;
const MAX_BLOCK_BYTES = 0x10000000;
const SAMPLED_IDS: ReadonlySet<number> = new Set([ID_TIMESTAMP, ID_VOID, ID_CRC32, ID_POSITION, ID_PREV_SIZE]);
export const CPU_MS_PER_BLOCK = DEFAULT_COST_MODEL.perBlockMs;

const CODECS =
  'V_AV1:av1 V_VP8:vp8 V_VP9:vp9 V_MPEG4/ISO/AVC:h264 V_MPEGH/ISO/HEVC:hevc V_MPEGI/ISO/VVC:vvc V_MPEG4/ISO/ASP:mpeg4 V_MPEG4/ISO/AP:mpeg4 ' +
  'V_MPEG4/ISO/SP:mpeg4 V_MPEG4/MS/V3:msmpeg4v3 V_MPEG1:mpeg1video V_MPEG2:mpeg2video V_PRORES:prores V_MJPEG:mjpeg V_FFV1:ffv1 ' +
  'V_THEORA:theora V_UNCOMPRESSED:rawvideo V_DIRAC:dirac';

export function codecNameOf(codecId: string): string {
  for (const pair of CODECS.split(' ')) {
    const [prefix, name] = pair.split(':');
    if (codecId.startsWith(prefix)) return name;
  }
  return '';
}

export function declaredRate(defaultDuration: number): { avg: string; r: string | null } | null {
  if (!(defaultDuration > 0)) return null;
  const q = reduceRational(1_000_000_000, defaultDuration, 30000);
  const avg = toFfprobeString(q);
  return { avg, r: q.num < q.den * 1000 && q.num > q.den * 5 ? avg : null };
}

type RateStats = Pick<TimelineStats, 'minFps' | 'maxFps' | 'isVfr' | 'vfrRatio' | 'distinctDeltas' | 'duplicateTimestamps' | 'timestampsQuantized' | 'medianDelta'>;

export function mergeRunStats(timescale: number, runs: readonly TimelineStats[]): RateStats {
  const hist = new Map<number, number>();
  const out: RateStats = { minFps: null, maxFps: null, isVfr: null, vfrRatio: 0, distinctDeltas: 0, duplicateTimestamps: 0, timestampsQuantized: false, medianDelta: null };
  let total = 0;
  for (const r of runs) {
    out.duplicateTimestamps += r.duplicateTimestamps;
    for (const [d, c] of r.histogram) {
      hist.set(d, (hist.get(d) ?? 0) + c);
      total += c;
    }
  }
  const keys = [...hist.keys()].sort((a, b) => a - b);
  out.distinctDeltas = keys.length;
  if (total === 0) return out;
  let acc = 0;
  const median = keys.find((k) => (acc += hist.get(k) ?? 0) * 2 >= total) ?? keys[0];
  const tol = Math.max(1, Math.round(VFR_RELATIVE_TOLERANCE * median));
  let off = 0;
  for (const k of keys) if (Math.abs(k - median) > tol) off += hist.get(k) ?? 0;
  out.medianDelta = median;
  out.minFps = rateFromTicks(timescale, keys[keys.length - 1]);
  out.maxFps = rateFromTicks(timescale, keys[0]);
  out.isVfr = total >= 2 && off > 0;
  out.vfrRatio = off / total;
  out.timestampsQuantized = !out.isVfr && keys.length > 1;
  return out;
}

function fillRates(r: VideoTrackResult, s: RateStats, prov: Provenance): void {
  r.minFps = s.minFps;
  r.maxFps = s.maxFps;
  r.isVfr = s.isVfr;
  r.vfrRatio = s.vfrRatio;
  r.distinctDeltas = s.distinctDeltas;
  r.duplicateTimestamps = s.duplicateTimestamps;
  r.timestampsQuantized = s.timestampsQuantized;
  for (const f of ['minFps', 'maxFps', 'isVfr', 'duplicateTimestamps'] as const) r.provenance[f] = prov;
}

function headerTrack(h: MkvHeader, t: MkvTrack): VideoTrackResult {
  const r = emptyTrack(t.number);
  r.fourccOrCodecId = t.codecId;
  r.codecName = codecNameOf(t.codecId);
  r.width = t.width;
  r.height = t.height;
  r.timescale = 1e9 / (Math.trunc(h.timestampScale * t.trackTimestampScale) || h.timestampScale);
  r.provenance.codec = r.provenance.dimensions = 'header';
  const d = declaredRate(t.defaultDuration);
  if (d) {
    r.avgFpsFfprobe = d.avg;
    r.rFpsFfprobe = d.r;
    r.nominalFps = { ...reduceRational(1_000_000_000, t.defaultDuration, 30000), kind: 'declared' };
    r.provenance.nominalFps = 'header';
    if (t.frameRate > 0 && t.defaultDuration === Math.trunc(1e9 / t.frameRate)) r.warnings.push(`DefaultDuration derived from Video FrameRate ${t.frameRate}`);
  } else r.warnings.push('no DefaultDuration: ffprobe estimates avg_frame_rate, the app declares no rate');
  const tag = h.tagDurations.get(t.uid);
  if (tag !== undefined) {
    r.durationSec = tag;
    r.provenance.durationSec = 'header';
  }
  return r;
}

function infoDurationSec(h: MkvHeader): number {
  return (h.duration * h.timestampScale) / 1e9;
}

function warnEstimatedFrames(h: MkvHeader, t: MkvTrack, r: VideoTrackResult): void {
  const dur = r.durationSec ?? infoDurationSec(h);
  if (dur > 0 && t.defaultDuration > 0) r.warnings.push(`about ${Math.round((dur * 1e9) / t.defaultDuration)} frames (estimated from duration x DefaultDuration, assumes CFR)`);
}

function warnInfoDuration(h: MkvHeader, maxAnyTicks: number, warnings: string[]): void {
  const info = infoDurationSec(h);
  const seen = (maxAnyTicks * h.timestampScale) / 1e9;
  if (info > 0 && Number.isFinite(seen) && info - seen > Math.max(0.5, 0.02 * info)) {
    warnings.push(`Info Duration ${info.toFixed(3)} s exceeds the last block at ${seen.toFixed(3)} s (false Duration or truncated file)`);
  }
}

function setScannedDuration(r: VideoTrackResult, sec: number, prov: Provenance): void {
  if (r.provenance.durationSec === 'header' && r.durationSec !== null && Math.abs(r.durationSec - sec) > Math.max(2 / r.timescale, 1 / (r.nominalFps?.value || Infinity))) {
    r.warnings.push(`DURATION tag ${r.durationSec.toFixed(3)} s differs from the scanned ${sec.toFixed(3)} s`);
  }
  r.durationSec = sec;
  r.provenance.durationSec = prov;
}

export interface BlockDensity {
  bytes: number;
  blocks: number;
  video: number;
  large: number;
  smallBytes: number;
}

export interface ScanEstimate {
  blocks: number;
  large: number;
  smallBytes: number;
}

async function sampleDensity(src: ByteSource, video: readonly MkvTrack[], first: number, region: number): Promise<BlockDensity | null> {
  const want = Math.min(region, DENSITY_SAMPLE_BYTES);
  await src.load(first, want, want);
  const chunk = src.chunkAt(first);
  if (!chunk) return null;
  const b = chunk.buf;
  const base = chunk.base;
  const end = base + b.length;
  const d: BlockDensity = { bytes: 0, blocks: 0, video: 0, large: 0, smallBytes: 0 };
  let p = first;
  while (p < end) {
    const e = readHeader(b, p - base, base);
    if (e?.id === ID_CLUSTER) {
      p = e.dataStart;
      continue;
    }
    if (!e || e.size === UNKNOWN_SIZE) break;
    const eEnd = e.dataStart + e.size;
    const block = e.id === ID_SIMPLE_BLOCK || e.id === ID_BLOCK_GROUP;
    if (block ? e.size > MAX_BLOCK_BYTES || eEnd > first + region : eEnd > end || !SAMPLED_IDS.has(e.id)) break;
    if (block) {
      const g = e.id === ID_BLOCK_GROUP ? readHeader(b, e.dataStart - base, base) : e;
      const blk = g && (g.id === ID_SIMPLE_BLOCK || g.id === ID_BLOCK) ? parseBlockHeader(b, g.dataStart - base, g.size) : null;
      d.blocks++;
      if (blk && video.some((v) => v.number === blk.track)) d.video++;
      if (eEnd - e.pos >= SMALL_SCAN_WINDOW) d.large++;
      else d.smallBytes += eEnd - e.pos;
    }
    d.bytes = eEnd - first;
    p = eEnd;
  }
  return d.blocks && d.bytes > 0 ? d : null;
}

export function estimateScan(region: number, d: BlockDensity | null, durationFrames: number): ScanEstimate | null {
  if (!d) {
    if (!(durationFrames > 0)) return null;
    const large = region / durationFrames >= SMALL_SCAN_WINDOW;
    return { blocks: durationFrames, large: large ? durationFrames : 0, smallBytes: large ? 0 : region };
  }
  const k = region / d.bytes;
  const sampledVideo = d.video * k;
  const blocks = d.blocks * k * (d.video > 0 && durationFrames > sampledVideo ? durationFrames / sampledVideo : 1);
  return { blocks, large: d.large * k, smallBytes: d.smallBytes * k };
}

export interface ScanPlan {
  window: number;
  ms: number;
  reads: number;
  bytes: number;
}

export function planExactScan(region: number, est: ScanEstimate | null, opts: ResolvedAnalyzeOptions): ScanPlan {
  const cpu = (est?.blocks ?? 0) * opts.costModel.perBlockMs;
  const plan = (window: number, reads: number, bytes: number): ScanPlan => ({ window, reads, bytes, ms: predictReadMs(opts.costModel, reads, bytes) + cpu });
  const big = opts.readAhead.matroskaScan;
  const wide = plan(big, Math.ceil(region / big), region);
  if (!est) return wide;
  const reads = Math.ceil(est.large + est.smallBytes / SMALL_SCAN_WINDOW);
  const narrow = plan(SMALL_SCAN_WINDOW, reads, Math.min(region, reads * SMALL_SCAN_WINDOW));
  return narrow.ms < wide.ms ? narrow : wide;
}

async function exactScan(src: ByteSource, st: ScanState, start: number, opts: ResolvedAnalyzeOptions): Promise<void> {
  const reader = src.reader;
  const progress = opts.onProgress;
  let reads = reader.reads;
  let total = st.header.segmentEnd - start;
  progress?.({ phase: 'matroska-exact', done: 0, total });
  await scanSegment(src, st, start, (p, end) => {
    total = Math.max(total, end - start);
    if (progress && reader.reads !== reads) {
      reads = reader.reads;
      progress({ phase: 'matroska-exact', done: Math.min(p - start, total), total });
    }
  });
  progress?.({ phase: 'matroska-exact', done: total, total });
}

async function findFirstCluster(src: ByteSource, h: MkvHeader): Promise<number | null> {
  const e = h.firstCluster === null ? null : await src.header(h.firstCluster);
  if (e?.id === ID_CLUSTER) return e.pos;
  const from = Math.max(h.segmentData, h.walkEnd);
  const q = await findClusterForward(src, from, Math.min(h.segmentEnd, from + FIRST_CLUSTER_SEARCH_BYTES), h.declaredEnd, { step: SYNC_SEARCH_STEP });
  if (q >= 0) return q;
  for (const c of (await cuePositions(src, h)).slice(0, MAX_CUE_FALLBACKS)) {
    if ((await src.header(c))?.id === ID_CLUSTER) return c;
  }
  return null;
}

async function cuePositions(src: ByteSource, h: MkvHeader): Promise<number[]> {
  const e = h.cuesPos === null || h.cuesPos >= h.segmentEnd ? null : await src.header(h.cuesPos);
  if (e?.id !== ID_CUES || e.size === UNKNOWN_SIZE) return [];
  const len = Math.min(e.size, MAX_CUES_BYTES, src.size - e.dataStart);
  await src.load(e.dataStart, len, len);
  const out: number[] = [];
  parseMaster(h, src.buf, e.dataStart - src.base, e.dataStart - src.base + len, ID_CUES, out);
  return [...new Set(out)].filter((x) => x < h.segmentEnd).sort((x, y) => x - y);
}

function pickEvenly(list: readonly number[], k: number): number[] {
  if (list.length <= k) return [...list];
  return [...new Set(Array.from({ length: k }, (_, i) => list[Math.round((i * (list.length - 1)) / (k - 1))]))];
}

async function tailScan(src: ByteSource, h: MkvHeader, video: readonly MkvTrack[], first: number, opts: ResolvedAnalyzeOptions): Promise<{ st: ScanState; maxAnyTicks: number } | null> {
  let size = Math.max(opts.readAhead.tail, 4096);
  let hi = h.segmentEnd;
  let maxAnyTicks = -Infinity;
  for (;;) {
    const lo = Math.max(first, h.segmentEnd - size);
    for (const q of lo < hi ? await findLastClusters(src, lo, hi, h.declaredEnd) : []) {
      const st = newScanState(h, src.size, video);
      await walkCluster(src, st, q);
      maxAnyTicks = Math.max(maxAnyTicks, st.maxAnyTicks);
      if (st.tracks.get(video[0].number)?.n) return { st, maxAnyTicks };
    }
    if (lo <= first || size >= MAX_TAIL_BYTES) return null;
    hi = lo + 4;
    size = Math.min(size * 4, MAX_TAIL_BYTES);
  }
}

async function probeScan(src: ByteSource, h: MkvHeader, video: readonly MkvTrack[], results: VideoTrackResult[], first: number, opts: ResolvedAnalyzeOptions, warnings: string[]): Promise<void> {
  const tail = await tailScan(src, h, video, first, opts);
  const cues = await cuePositions(src, h);
  let positions = pickEvenly(cues[0] === first || !cues.length ? cues : [first, ...cues.filter((c) => c > first)], PROBE_CLUSTERS);
  if (!cues.length) {
    positions = [first];
    const region = h.segmentEnd - first;
    for (let k = 1; k < PROBE_CLUSTERS; k++) {
      const from = first + Math.floor((k * region) / PROBE_CLUSTERS);
      const q = await findClusterForward(src, from, Math.min(h.segmentEnd, from + SYNC_SEARCH_BYTES), h.declaredEnd, { step: SYNC_SEARCH_STEP });
      if (q > positions[positions.length - 1]) positions.push(q);
    }
  }
  const runs = new Map<number, TimelineStats[]>();
  let firstRun: ScanState | null = null;
  let visited = 0;
  for (const pos of positions) {
    const st = newScanState(h, src.size, video);
    if (!(await walkCluster(src, st, pos, PROBE_BLOCKS))) continue;
    visited++;
    if (pos === first) firstRun = st;
    for (const s of st.tracks.values()) {
      if (s.n < 2) continue;
      const list = runs.get(s.track.number) ?? [];
      list.push(analyzeTimeline({ timescale: 1e9 / s.tickNs, pts: s.pts.subarray(0, s.n), tickQuantized: true }));
      runs.set(s.track.number, list);
    }
  }
  warnings.push(`probe: ${visited} cluster(s) sampled via ${cues.length ? 'Cues' : 'sync search'}, up to ${PROBE_BLOCKS} video blocks each`);
  if (!tail) warnings.push('probe: no video block found in the tail');
  warnInfoDuration(h, tail?.maxAnyTicks ?? -Infinity, warnings);
  video.forEach((t, i) => {
    const r = results[i];
    const ts = r.timescale;
    const merged = mergeRunStats(ts, runs.get(t.number) ?? []);
    if (merged.isVfr !== null) fillRates(r, merged, 'sampled');
    const head = firstRun?.tracks.get(t.number);
    const start = head?.n ? Math.min(...head.pts.subarray(0, head.n)) : null;
    if (start !== null) {
      r.startSec = start / ts;
      r.provenance.startSec = 'sampled';
    }
    const last = tail?.st.tracks.get(t.number);
    if (last?.n) setScannedDuration(r, (last.maxPts + (last.maxPtsDur > 0 ? last.maxPtsDur : (merged.medianDelta ?? 0)) - (start ?? 0)) / ts, 'sampled');
    warnEstimatedFrames(h, t, r);
  });
}

function applyExact(r: VideoTrackResult, s: TrackScan): ProfileJob | null {
  const ts = r.timescale;
  r.frames = r.presentedFrames = s.frames;
  r.provenance.frames = r.provenance.presentedFrames = 'computed';
  r.isStill = s.frames === 1;
  if (s.invisible) r.warnings.push(`${s.invisible} invisible block(s) counted as frames`);
  if (s.missingPts) r.warnings.push(`${s.missingPts} laced frame(s) without a timestamp`);
  if (s.noPtsFrames) r.warnings.push(`${s.noPtsFrames} frame(s) before time 0 have no timestamp; interpolated from the neighbouring frames like ffmpeg`);
  if (s.overLimit) r.warnings.push(`per-frame statistics skipped: more than ${s.n} frames`);
  if (!s.n || s.overLimit) {
    if (!s.n) r.warnings.push('no blocks for this track');
    return null;
  }
  const tl = analyzeTimeline({ timescale: ts, pts: s.pts.subarray(0, s.n), lastDuration: s.maxPtsDur > 0 ? s.maxPtsDur : null, tickQuantized: true });
  r.warnings.push(...tl.warnings);
  setScannedDuration(r, tl.durationSum / ts, 'exact');
  fillRates(r, tl, 'exact');
  r.avgFps = s.frames !== s.n && Number.isSafeInteger(ts) && Number.isSafeInteger(tl.durationSum) ? avgFrameRate(ts, s.frames, tl.durationSum) : tl.avgFps;
  r.startSec = tl.firstPts === null ? null : tl.firstPts / ts;
  r.dominantFps = tl.dominantFps;
  r.provenance.avgFps = r.provenance.startSec = r.provenance.dominantFps = 'exact';
  if (!r.nominalFps && tl.nominalFps) {
    r.nominalFps = tl.nominalFps;
    r.provenance.nominalFps = 'exact';
  } else if (r.nominalFps && r.avgFps && Math.abs(r.avgFps.value / r.nominalFps.value - 1) > 0.005) {
    r.warnings.push(`declared rate ${r.avgFpsFfprobe} differs from the measured average ${r.avgFps.value.toFixed(3)}`);
  }
  if (tl.duplicateTimestamps) r.warnings.push(`${tl.duplicateTimestamps} duplicate block timestamp(s) excluded from the instantaneous rates`);
  return tl.profile;
}

export async function analyzeMatroska(reader: BlobReader, opts: ResolvedAnalyzeOptions): Promise<ContainerAnalysis> {
  const src = new ByteSource(reader, opts.readAhead.head);
  const h = await readMatroskaHeader(src);
  const a = emptyAnalysis(h.docType === 'webm' ? 'webm' : 'matroska');
  const w = a.warnings;
  a.brand = h.docType;
  a.scan = 'header';
  w.push(...h.warnings);
  if (h.docType !== 'webm' && h.docType !== 'matroska') w.push(`unexpected DocType '${h.docType}'`);
  if (h.segmentUnknownSize) w.push('Segment has an unknown size (live or unfinished recording)');
  a.formatDurationSec = h.duration !== 0 ? Math.trunc((h.duration * h.timestampScale * 1000) / 1_000_000) / 1_000_000 : null;
  a.audioTrackCount = h.tracks.filter((t) => t.type === 2).length;
  if (h.attachedImages) w.push(`${h.attachedImages} attached image(s) ignored: ffprobe lists them as attached_pic video streams`);
  const video = h.tracks.filter((t) => t.type === 1);
  if (!video.length) {
    w.push('no video track');
    return a;
  }
  a.primaryTrackId = video[0].number;
  a.videoTracks = video.map((t) => headerTrack(h, t));

  let mode = opts.matroskaMode;
  let first: number | null = null;
  if (mode !== 'header') {
    first = await findFirstCluster(src, h);
    if (first === null) w.push('no Cluster found: nothing to scan');
  }
  if (first === null) {
    video.forEach((t, i) => warnEstimatedFrames(h, t, a.videoTracks[i]));
    return a;
  }
  const region = h.segmentEnd - first;
  const t0 = video[0];
  const dur = h.tagDurations.get(t0.uid) ?? infoDurationSec(h);
  const durationFrames = dur > 0 && t0.defaultDuration > 0 ? (dur * 1e9) / t0.defaultDuration : 0;
  const plan = planExactScan(region, estimateScan(region, await sampleDensity(src, video, first, region), durationFrames), opts);
  if (mode === 'auto') {
    mode = plan.ms <= opts.exactBudgetMs ? 'exact' : 'probe';
    if (mode === 'probe') w.push(`exact block scan skipped: predicted ${plan.ms.toFixed(0)} ms exceeds the ${opts.exactBudgetMs} ms budget`);
  }
  if (mode === 'exact') {
    src.window = plan.window;
    const st = newScanState(h, src.size, video, opts.maxExpandedSamples);
    if (plan.window < opts.readAhead.matroskaScan) {
      st.switchReads = reader.reads + 2 * plan.reads + 16;
      st.largeWindow = opts.readAhead.matroskaScan;
    }
    await exactScan(src, st, first, opts);
    a.scan = 'exact';
    w.push(...st.warnings);
    if (st.truncated) w.push('truncated file: the last Cluster or block ends beyond EOF');
    if (st.missingClusterTs) w.push(`${st.missingClusterTs} block(s) in Clusters without a Timestamp`);
    warnInfoDuration(h, st.maxAnyTicks, w);
    for (const [i, t] of video.entries()) {
      const r = a.videoTracks[i];
      r.rateProfile = await rateProfileOf(applyExact(r, st.tracks.get(t.number) as TrackScan));
    }
    return a;
  }
  src.window = plan.window === SMALL_SCAN_WINDOW ? SMALL_SCAN_WINDOW : opts.readAhead.head;
  await probeScan(src, h, video, a.videoTracks, first, opts, w);
  a.scan = 'probe';
  return a;
}
