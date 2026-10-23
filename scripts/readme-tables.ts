import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type Verdict = 'exact' | 'within-tol' | 'known-deviation' | 'mismatch' | 'n/a';

interface Check {
  id: string;
  field: string;
  verdict: Verdict;
  app: string | null;
  ffprobe: string | null;
  deviation?: string;
}

interface TrackEval {
  trackId: number;
  primary: boolean;
  checks: Check[];
}

interface FixtureIo {
  reads: number;
  bytesRead: number;
  percent: number;
  ms: number;
}

interface AccFixture {
  name: string;
  category: string;
  container: string;
  expect: string;
  sizeBytes: number;
  family: 'isobmff' | 'matroska' | null;
  io: FixtureIo | null;
  appError: string | null;
  fileChecks: Check[];
  tracks: TrackEval[];
}

interface EngineReport {
  engine: string;
  informational: boolean;
  loadSkipped: string | null;
  fixtures: AccFixture[];
  skipped: { name: string; reason: string }[];
  counts: Record<Verdict, number>;
  mismatchFixtures: string[];
}

interface AccuracyReport {
  node: string;
  ffprobeVersions: string[];
  options: { repeat: number; withLarge: boolean; filter: string | null; matroskaMode: string };
  engines: EngineReport[];
}

interface Budget {
  key: string;
  label: string;
  limit: number;
  gzip: number;
  headroom: number;
  status: string;
}

interface Composite {
  raw: number;
  gzip: number;
  brotli: number;
}

interface Chunk {
  file: string;
  kind: string;
  raw: number;
  gzip: number;
  brotli: number;
}

interface SizeReport {
  budgets: Budget[];
  composites: Record<string, Composite>;
  chunks: Chunk[];
}

interface Summary {
  avg: string | null;
  frames: number | null;
}

interface Timed {
  medianMs: number;
  medianWallMs: number;
  reads: number;
  bytesRead: number;
  error?: string | null;
  summary: Summary;
  agreement?: string;
}

interface RvfcRow {
  name: string;
  ref: string;
  refValue: number;
  refVfr: boolean;
  estimate: string | null;
  value: number | null;
  errorPct: number | null;
  isVfr: boolean | null;
  confidence: string | null;
  passes: unknown[];
  rate: number;
  ms: number;
  error: string | null;
}

interface ColdFirst {
  name: string;
  label: string;
  coldWallMs: number;
  warmWallMs: number;
  chunks: { path: string; bytes: number }[];
}

interface BenchReport {
  options: { reps: number; engineReps: number; coldReps: number };
  chrome: {
    pageLoad: { readyMs: number };
    coldBatch: { files: number; wallMs: number; sumMs: number };
    reloadBatch: { medianMs: number; minMs: number; maxMs: number };
    warm: Record<string, Timed>;
    engines: Record<string, Record<string, Timed>>;
    large: Record<string, Record<string, Timed>>;
    coldFirst: ColdFirst[];
    rvfc: { rows: RvfcRow[] };
  };
  edge: { warm: Record<string, Timed> } | null;
  sanity: { compared: number; identical: number };
  environment: {
    os: string;
    cpu: string;
    logicalCores: number;
    memoryGiB: number;
    node: string;
    displayHzOs: number[];
    chrome: { product: string };
    edge?: { product: string } | null;
  };
}

interface ManifestRow {
  name: string;
  container: string;
  category: string;
  expect: string;
  committed: boolean;
}

interface ScenarioModel {
  totalMs: number;
  extraMs: number;
  preMs: number | null;
}

interface ProfileModel {
  id: string;
  label: string;
  cold: ScenarioModel;
  prefetch: ScenarioModel;
  prewarm: ScenarioModel;
}

interface PrivateDelta {
  processPrivateDelta: number;
}

interface IntegrationReport {
  host: { initialGzipBytes: number; fullGzipBytes: number };
  profiles: { id: string; latencyMs: number; downKbps: number | null }[];
  main: { batchFiles: number };
  cpu: { perFile: Record<string, { label: string; name: string; medianMs: number }> };
  chunks: Record<string, string | undefined>;
  environment: { browser: string; date: string };
  model: {
    triggerGzip: number;
    initialIncreaseMeasuredPct: number;
    lazyMp4Gzip: number;
    lazyBothGzip: number;
    lazyMp4VsInitialPct: number;
    profiles: ProfileModel[];
    options: { eagerBytes: number; eagerVsInitialPct: number; eagerTransferMs: Record<string, number> };
    main: { firstFileProbeCpuMs: number; coldBatchProbeCpuMs: number; coldBatchTbtMs: number; firstFileTbtMs: number };
    memory: { probe: { first: PrivateDelta; idle: PrivateDelta } };
  };
}

interface MatrixBudget {
  key: string;
  label: string;
  limit: number;
  gzip: number | null;
  status: string;
}

interface MatrixFixture {
  name: string;
  imports: string[];
  note: string | null;
  worker: string;
  metrics: Record<string, number | null>;
  workers: { name: string; entry: number; chunks: number; sha256: string }[];
  budgets: MatrixBudget[];
  problems: string[];
}

interface SizeMatrix {
  versions: Record<string, string | null>;
  fixtures: MatrixFixture[];
  standalone: { gzip: number | null; limit: number; status: string };
}

interface Inputs {
  acc: AccuracyReport;
  size: SizeReport;
  matrix: SizeMatrix;
  bench: BenchReport;
  integration: IntegrationReport;
  manifest: ManifestRow[];
}

const FRAME_RATE_FIELDS = new Set([
  'avgFps',
  'avgFps.declared',
  'avgFps.measured',
  'nominalFps',
  'frames',
  'presentedFrames',
  'minFps',
  'maxFps',
  'isVfr',
  'duplicateTimestamps',
]);

const FAMILY_LABEL: Record<string, string> = { isobmff: 'ISO BMFF (MP4, MOV)', matroska: 'Matroska, WebM', none: 'not a video container' };

const ENGINE_LABEL: Record<string, string> = { own: 'own parsers', mp4box: 'mp4box.js', mediabunny: 'mediabunny' };

const ENGINE_FAMILIES: Record<string, readonly string[]> = {
  own: ['isobmff', 'matroska', 'none'],
  mp4box: ['isobmff'],
  mediabunny: ['isobmff', 'matroska'],
};

const SPEED_FILES: ReadonlyArray<readonly [string, string]> = [
  ['av_h264_aac_faststart.mp4', 'MP4, moov before mdat (faststart)'],
  ['av_h264_aac.mp4', 'same file, moov at the end'],
  ['mp4_bf_elst.mp4', 'MP4 with B-frames and an edit list'],
  ['fmp4_frag_duration.mp4', 'fragmented MP4'],
  ['frag_vfr_global_sidx.mp4', 'fragmented VFR MP4 with a global sidx'],
  ['vfr_screenrec_ts1000.mp4', 'VFR screen recording, timescale 1000'],
  ['cfr_vp9_30.webm', 'WebM, VP9'],
  ['vp9_unknown_clusters.webm', 'WebM with unknown-size clusters (live)'],
  ['h264_vfr_remux.mkv', 'Matroska, stream-copied VFR with BlockGroups'],
  ['corrupt_trunc_no_moov.mp4', 'interrupted recording, no moov (error)'],
  ['long_cfr_3h_60fps.mp4', 'long CFR MP4, moov at the end'],
  ['long_vfr_1h_screenrec.mp4', 'long VFR screen recording MP4'],
  ['big_1080p_moov_end.mp4', '1080p MP4 of 1 min, moov at the end'],
  ['big_1080p_faststart.mp4', 'same file, faststart'],
  ['big_1080p.mkv', 'same stream in Matroska (auto mode)'],
];

const OPTIONAL_SPEED_FILES: ReadonlySet<string> = new Set(['big_1080p_moov_end.mp4', 'big_1080p_faststart.mp4', 'big_1080p.mkv']);

const PROFILE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['vfr_two_phase_5_200.mp4', '2 steady segments, 5 fps for 4 s then 200 fps for 4 s; 1 rate change; uneven'],
  ['vfr_two_phase_5_200.mkv', 'the same stream in Matroska: the same 2 segments'],
  ['vfr_freeze_2s.mp4', '1 steady segment at 30 fps; 1 freeze of 2 s at 1.967 s; uneven'],
  ['vfr_concat_10_30_60.mp4', '3 steady segments at 10, 30 and 60 fps, 2 s each; 2 rate changes; uneven'],
  ['vfr_screenrec_ts1000.mp4', '1 steady segment at 60 fps; 2 gaps of about 1 s; uneven'],
  ['vfr_pulldown_2_3.mp4', '1 steady segment at 24 fps (a 2:3 cadence is not uneven)'],
  ['cfr_h264_30.mp4', 'none: all intervals equal, the chunk is not loaded'],
  ['long_vfr_1h_screenrec.mp4', '60 fps for 3598 s plus a 1.5 s variable tail; 1439 gaps (50 listed); uneven'],
];

const INTEGRATION_PROFILES = ['fast4g', 'slow4g', '3g'];

const INTEGRATION_CHUNKS = ['entry', 'isobmff', 'matroska'];

const READ_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['mov_nobf_faststart.mov', 'mov_nobf_default.mov'],
  ['av_h264_aac_faststart.mp4', 'av_h264_aac.mp4'],
];

const CATEGORY_TEXT: Record<string, string> = {
  cfr: 'H.264 MP4 and VP9 WebM at film, PAL, NTSC and high frame rates',
  mov: 'MOV and MP4 with and without B-frames, edit lists (empty edit, trimmed start), faststart',
  fmp4: 'fragmented MP4: empty moov, default-base-is-moof, CMAF, DASH, sidx, hybrid',
  codec: 'HEVC (hvc1, hev1), AV1, VP8, VP9 and ProRes in MP4, MOV, WebM and Matroska',
  live: 'WebM from live, pipe and MediaRecorder-like muxing: unknown sizes, no Duration or Cues, a false Duration, an audio-only tail',
  vfr: 'VFR from concatenation, non-linear setpts, frame dropping, mpdecimate, screen recording, pulldown, a 5/200 fps two-phase file and a 2 s freeze, also with B-frames, fragmented, in MOV, WebM and Matroska',
  box64: '64-bit mdat headers, co64 chunk offsets, an mdat with size 0',
  multi: 'video plus audio, two video tracks, a still image track before the video',
  cover: 'cover art in M4A, MP4 and Matroska',
  audio: 'audio-only MP4, M4A and WebM',
  edge: 'a single-frame video',
  corrupt: 'empty, random, text and PNG files, truncated moov, mdat or fragment, a lying stts count',
  sniff: 'files with the wrong extension',
  matroska: 'H.264 in Matroska, WebM without DefaultDuration',
  long: 'long CFR and VFR MP4 (generated, not committed)',
  sparse: 'sparse MP4 above 4 GiB with 64-bit offsets (generated, not committed)',
};

const CHUNK_WHEN: Record<string, string> = {
  main: 'page load',
  css: 'page load',
  client: 'first file',
  'client-compare': 'first probe.compare',
  'client-fallback': 'first call with a fallback chain or a skipped engine',
  'client-inline': 'first main-thread engine run (rVFC)',
  'client-shared': 'with the fallback chain, compare, rVFC or the own engine in this thread',
  'inline-own': 'only with worker inline or without a Worker global (own engine in this thread)',
  worker: 'first file',
  isobmff: 'first MP4 or MOV file, once per worker',
  matroska: 'first WebM or MKV file, once per worker',
  rvfc: 'click on Run (approximate)',
  segments: 'first VFR timeline, once per worker',
  'parser-shared': 'with the first parser, in parallel, once per worker',
  rateProfile: 'first card with a rate profile',
  deviceInfo: 'on idle after the first result, or the first export (footer device line, JSON export)',
  lazy: 'first open of a Compare engines panel',
  mp4box: 'Compare engines on an MP4 or MOV card',
  mediabunny: 'Compare engines',
  'engine-shared': 'with mp4box or mediabunny',
};

const CHUNK_NAME: Record<string, string> = {
  main: 'main (React, UI, store)',
  css: 'CSS',
  client: 'probe client (lazy)',
  'client-compare': 'probe compare (agreement rules)',
  'client-fallback': 'probe fallback chain',
  'client-inline': 'in-thread engine runner',
  'client-shared': 'shared by the lazy client parts and rVFC (result builders, sniffing)',
  'inline-own': 'own engine in this thread (runtime and parser copies for worker inline)',
  worker: 'worker entry (reader, sniffing, worker runtime)',
  isobmff: 'ISO BMFF parser',
  matroska: 'Matroska parser',
  rvfc: 'rVFC fallback',
  segments: 'rate profile core (segments, anomalies, sparkline buckets)',
  'parser-shared': 'shared by the parsers and engines (timeline statistics)',
  rateProfile: 'rate profile panel (UI)',
  deviceInfo: 'device info and JSON export',
  lazy: 'Compare panel',
  mp4box: 'mp4box.js engine',
  mediabunny: 'mediabunny engine',
  'engine-shared': 'shared by mp4box and mediabunny',
};

const CHUNK_ORDER = ['main', 'css', 'client', 'client-fallback', 'client-compare', 'client-inline', 'client-shared', 'inline-own', 'worker', 'parser-shared', 'isobmff', 'matroska', 'segments', 'rateProfile', 'deviceInfo', 'rvfc', 'lazy', 'mp4box', 'mediabunny', 'engine-shared'];

const COMPOSITE_BUDGET: Record<string, string> = { initial: 'initial', firstMp4: 'firstMp4', firstVfrMp4: 'firstVfrMp4', firstMatroska: 'firstMkv' };

const OPTIONAL_COMPOSITES = new Set(['firstVfrMp4']);

const COMPOSITE_LABEL: Record<string, string> = {
  initial: 'initial: main + CSS + worker entry',
  firstMp4: 'first MP4 analysis: initial + probe client + statistics + ISO BMFF parser',
  firstVfrMp4: 'first VFR MP4 analysis: first MP4 + rate profile core',
  firstMatroska: 'first Matroska analysis: initial + probe client + statistics + Matroska parser',
};

function fail(message: string): never {
  throw new Error(message);
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) fail(`missing in reports: ${what}`);
  return value;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    return fail(`cannot read ${path}: ${(e as Error).message}`);
  }
}

function readManifest(path: string): ManifestRow[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = need(lines[0], `${path} header`).split('\t');
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) fail(`${path}: no column ${name}`);
    return i;
  };
  const [n, c, cat, exp, com] = [col('name'), col('container'), col('category'), col('expect'), col('committed')];
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return { name: cells[n] ?? '', container: cells[c] ?? '', category: cells[cat] ?? '', expect: cells[exp] ?? '', committed: cells[com] === 'yes' };
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function geomeanRatio(pairs: ReadonlyArray<readonly [number, number]>): number {
  const usable = pairs.filter(([a, b]) => a > 0 && b > 0);
  if (usable.length === 0) return Number.NaN;
  return Math.exp(usable.reduce((s, [a, b]) => s + Math.log(a / b), 0) / usable.length);
}

const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2012)}-${String.fromCharCode(0x2015)}]`, 'g');

function plain(s: string): string {
  return s.replace(LONG_DASHES, '-');
}

function cell(s: string | number | null | undefined): string {
  return plain(String(s ?? '-')).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function row(cells: ReadonlyArray<string | number | null | undefined>): string {
  return `| ${cells.map(cell).join(' | ')} |`;
}

function table(header: readonly string[], align: string, rows: readonly string[]): string[] {
  if (align.length !== header.length) fail(`table alignment does not match ${header.join(', ')}`);
  const sep = [...align].map((a) => (a === 'r' ? '---:' : a === 'c' ? ':-:' : '---'));
  for (const r of rows) {
    const cells = r.slice(2, -2).split(/(?<!\\)\|/).length;
    if (cells !== header.length) fail(`row has ${cells} cells, header ${header.length}: ${r}`);
  }
  return [row(header), `|${sep.join('|')}|`, ...rows];
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function fmtKB(n: number): string {
  return `${(n / 1000).toFixed(2)} KB`;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms >= 100) return ms.toFixed(0);
  if (ms >= 10) return ms.toFixed(1);
  return ms.toFixed(2);
}

function fmtPct(p: number): string {
  if (p >= 99.95 && p < 100) return '99.9';
  if (p >= 100) return '100';
  if (p >= 10) return p.toFixed(1);
  return p.toFixed(2);
}

function fmtRatio(r: number): string {
  return `${r.toFixed(2)}x`;
}

function fmtDuration(sec: number): string {
  if (sec >= 3600) return `${Number((sec / 3600).toFixed(2))} h`;
  if (sec >= 60) return `${Number((sec / 60).toFixed(2))} min`;
  return `${Number(sec.toFixed(3))} s`;
}

function decimal(r: string | null | undefined): string {
  if (!r) return '-';
  const m = /^(-?\d+)\/(-?\d+)$/.exec(r);
  if (!m || Number(m[2]) === 0) return r;
  const v = Number(m[1]) / Number(m[2]);
  return v >= 100 ? v.toFixed(1) : v.toFixed(3);
}

function majorVersion(product: string): string {
  const m = /^([A-Za-z]+)\/(\d+)/.exec(product);
  return m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : product;
}

function checksOf(f: AccFixture): Check[] {
  return [...f.fileChecks, ...f.tracks.flatMap((t) => t.checks)];
}

function familyOf(f: AccFixture): string {
  return f.family ?? 'none';
}

function primaryOf(f: AccFixture): TrackEval | null {
  return f.tracks.find((t) => t.primary) ?? f.tracks[0] ?? null;
}

function findCheck(checks: readonly Check[], id: string): Check | undefined {
  return checks.find((c) => c.id === id);
}

function engine(acc: AccuracyReport, name: string): EngineReport {
  const e = need(
    acc.engines.find((x) => x.engine === name),
    `engine ${name} in accuracy.json`,
  );
  if (e.loadSkipped) fail(`engine ${name} was skipped in accuracy.json: ${e.loadSkipped}`);
  return e;
}

function fixture(e: EngineReport, name: string): AccFixture {
  return need(
    e.fixtures.find((f) => f.name === name),
    `${e.engine} fixture ${name} in accuracy.json`,
  );
}

function io(f: AccFixture): FixtureIo {
  return need(f.io, `io of ${f.name}`);
}

function isLarge(f: AccFixture, manifest: readonly ManifestRow[]): boolean {
  const m = manifest.find((r) => r.name === f.name);
  return m ? !m.committed : f.category === 'long';
}

function verdictText(checks: readonly Check[]): string {
  const ids = (v: Verdict) => checks.filter((c) => c.verdict === v).map((c) => c.id);
  const exact = ids('exact').length;
  const parts: string[] = [];
  const mismatch = ids('mismatch');
  if (mismatch.length > 0) parts.push(`MISMATCH: ${mismatch.join(', ')}`);
  const known = ids('known-deviation');
  if (known.length > 0) parts.push(`known deviation: ${known.join(', ')}`);
  const within = ids('within-tol');
  if (within.length > 0) parts.push(`within tolerance: ${within.join(', ')}`);
  if (parts.length === 0 && exact > 0 && checks.every((c) => c.id === 'error' || c.verdict === 'n/a')) return 'expected outcome (manifest)';
  if (parts.length === 0) return exact > 0 ? `all exact (${exact})` : 'n/a';
  return `${exact} exact; ${parts.join('; ')}`;
}

function ownTotals(e: EngineReport): { checks: number; counts: Record<Verdict, number> } {
  const counts = e.counts;
  return { checks: counts.exact + counts['within-tol'] + counts['known-deviation'] + counts.mismatch + counts['n/a'], counts };
}

function headline(inp: Inputs): string[] {
  const own = engine(inp.acc, 'own');
  const { checks, counts } = ownTotals(own);
  const committed = own.fixtures.filter((f) => !isLarge(f, inp.manifest));
  const large = own.fixtures.filter((f) => isLarge(f, inp.manifest));
  const reads = committed.map((f) => io(f).reads);
  const long = fixture(own, 'long_cfr_3h_60fps.mp4');
  const longFrames = findCheck(primaryOf(long)?.checks ?? [], 'frames')?.app ?? '-';
  const longDur = Number(findCheck(long.fileChecks, 'formatDurationSec')?.app ?? Number.NaN);
  const warm = Object.values(inp.bench.chrome.warm);
  const chromeLong = need(inp.bench.chrome.large['long_cfr_3h_60fps.mp4']?.['own'], 'chrome large own 3 h');
  const browser = majorVersion(inp.bench.environment.chrome.product);
  const firstMp4 = need(inp.size.composites['firstMp4'], 'size composite firstMp4');
  const firstMkv = need(inp.size.composites['firstMatroska'], 'size composite firstMatroska');
  const { prof } = integrationModel(inp.integration);
  const fast = prof('fast4g');
  const bigFixture = own.fixtures.find((f) => f.name === 'big_1080p_moov_end.mp4');
  const bigChrome = inp.bench.chrome.large['big_1080p_moov_end.mp4']?.['own'];
  const bigMkv = own.fixtures.find((f) => f.name === 'big_1080p.mkv');
  const bigMkvChrome = inp.bench.chrome.large['big_1080p.mkv']?.['own'];
  const big =
    bigFixture && bigChrome
      ? ` A ${fmtMB(bigFixture.sizeBytes)} 1080p MP4 with the moov at the end takes ${io(bigFixture).reads} reads (${fmtBytes(io(bigFixture).bytesRead)}) and ${fmtMs(bigChrome.medianMs)} ms${bigMkv && bigMkvChrome ? `; the same stream in Matroska takes ${fmtMs(bigMkvChrome.medianMs)} ms in auto mode (${io(bigMkv).reads} reads; a probe, so no frame count until "Scan all frames")` : ''}.`
      : '';
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    `- **Accuracy.** The own parsers were checked against ffprobe 8.1.1 on ${own.fixtures.length} synthetic fixtures made with ffmpeg (${committed.length} committed, ${large.length} large local files; real recorder output is not in the corpus, see Limitations): ${checks} field checks, ${counts.exact} exact, ${counts['within-tol']} within tolerance, ${plural(counts['known-deviation'], 'known deviation')} with a recorded reason, ${plural(counts.mismatch, 'mismatch').replace(/hs$/, 'hes')}, ${counts['n/a']} not applicable.`,
    `- **Reads.** Median ${median(reads)} reads per committed fixture, at most ${Math.max(...reads)}. The ${fmtDuration(longDur)}, ${longFrames}-frame MP4 (${fmtBytes(long.sizeBytes)}) takes ${io(long).reads} reads and ${fmtBytes(io(long).bytesRead)} (${fmtPct(io(long).percent)}% of the file).`,
    `- **Speed.** In ${browser}, warm: median ${fmtMs(median(warm.map((w) => w.medianMs)))} ms per file in the worker and ${fmtMs(median(warm.map((w) => w.medianWallMs)))} ms from file pick to rendered result; the ${fmtDuration(longDur)} file takes ${fmtMs(chromeLong.medianMs)} ms.${big}`,
    `- **Size.** A default install (\`video-fps-probe/lazy\`) adds ${fmtKB(matrixMetric(inp, 'default', 'trigger'))} gzip to a host app's critical path. Its first MP4 file loads ${fmtKB(matrixMetric(inp, 'default', 'firstMp4'))} lazily when the host's Vite config sets \`worker: { format: 'es' }\`, and ${fmtKB(matrixMetric(inp, 'zero-config', 'firstMp4'))} with Vite's default worker format, 'iife', which builds the own worker as one file ([Package size](#package-size)). The demo page plus its first MP4 result loads ${fmtKB(firstMp4.gzip)} gzip (page, ${kindGzip(inp.size, 'client') === null ? '' : 'probe client, '}worker entry, ${sharedParserGzip(inp.size) === null ? '' : 'shared statistics chunk, '}ISO BMFF parser); the first Matroska result ${fmtKB(firstMkv.gzip)}.`,
    `- **Embedding.** In a host app with a ${fmtMB(inp.integration.host.initialGzipBytes)} gzip initial load, prewarming the worker when the upload dialog opens makes the first result on fast 4G take ${fmtMs(fast.prewarm.totalMs)} ms instead of ${fmtMs(fast.cold.totalMs)} ms ([Embedding in an existing app](#embedding-in-an-existing-app)).${integrationStale(inp) ? ` Measured on an earlier build whose worker entry and parser chunks differ from the current ones, so these figures are not current.` : ''}`,
    `- **Same result in Node and Chrome.** ${inp.bench.sanity.identical} of ${inp.bench.sanity.compared} files give identical results field by field (timing excluded).`,
    `- **Machine.** ${machine(inp)}.`,
  ];
}

function machine(inp: Inputs): string {
  const env = inp.bench.environment;
  const os = env.os.replace(/^Windows_NT [\d.]+ \((.+)\) x64$/, '$1');
  return `${os}, ${env.cpu.replace(/\s+@.*$/, '').replace(/\(R\)|\(TM\)/g, '').replace(/\s+CPU$/, '').replace(/\s+/g, ' ')} (${env.logicalCores} threads), ${env.memoryGiB} GiB, Node ${env.node}, ${majorVersion(env.chrome.product)} headless; ffprobe ${inp.acc.ffprobeVersions.join(', ').replace(/^ffprobe version /, '')}`;
}

function methodLine(inp: Inputs): string {
  const o = inp.bench.options;
  const browser = majorVersion(inp.bench.environment.chrome.product);
  return `Node: \`npm run compare\` (\`analyze()\` on \`fs.openAsBlob\`), median of ${inp.acc.options.repeat} runs per file; library engines run the long files once. ${browser}: \`npm run bench\` on the built app, file picked through the real file input, median of ${o.reps} warm runs (own) or ${o.engineReps} runs (libraries, long files); "UI ms" runs from the input's change event to the rendered result. Times are worker-side \`io.ms\`.`;
}

function readsBlock(inp: Inputs): string[] {
  const own = engine(inp.acc, 'own');
  const warm = inp.bench.chrome.warm;
  const rows = READ_PAIRS.flatMap((pair) =>
    pair.map((name) => {
      const f = fixture(own, name);
      const w = need(warm[name], `chrome warm ${name}`);
      return row([`\`${name}\``, fmtBytes(f.sizeBytes), io(f).reads, fmtBytes(io(f).bytesRead), fmtMs(io(f).ms), fmtMs(w.medianMs)]);
    }),
  );
  const committed = own.fixtures.filter((f) => !isLarge(f, inp.manifest));
  const byReads = new Map<number, AccFixture[]>();
  for (const f of committed) byReads.set(io(f).reads, [...(byReads.get(io(f).reads) ?? []), f]);
  const groups = [...byReads.entries()].sort((a, b) => a[0] - b[0]);
  const groupRows = groups.map(([reads, list]) => {
    const chrome = list.map((f) => warm[f.name]?.medianMs).filter((v): v is number => v !== undefined);
    return row([
      `${reads} read${reads === 1 ? '' : 's'}`,
      list.length,
      fmtBytes(median(list.map((f) => io(f).bytesRead))),
      fmtMs(median(list.map((f) => io(f).ms))),
      fmtMs(median(chrome)),
    ]);
  });
  return [
    ...table(['File', 'Size', 'Reads', 'Bytes read', 'Node ms', 'Chrome ms'], 'lrrrrr', rows),
    '',
    ...table(['Committed fixtures read in', 'Files', 'Median bytes read', 'Node ms (median)', 'Chrome ms (median)'], 'lrrrr', groupRows),
  ];
}

interface EngineStats {
  fixtures: AccFixture[];
  checks: Check[];
  fpsMismatch: number;
  otherMismatch: number;
  mismatchFixtures: number;
}

function engineStats(e: EngineReport, family: string): EngineStats {
  const fixtures = e.fixtures.filter((f) => familyOf(f) === family);
  const checks = fixtures.flatMap(checksOf);
  const mism = checks.filter((c) => c.verdict === 'mismatch');
  return {
    fixtures,
    checks,
    fpsMismatch: mism.filter((c) => FRAME_RATE_FIELDS.has(c.id)).length,
    otherMismatch: mism.filter((c) => !FRAME_RATE_FIELDS.has(c.id)).length,
    mismatchFixtures: fixtures.filter((f) => checksOf(f).some((c) => c.verdict === 'mismatch')).length,
  };
}

function supported(e: EngineReport, manifest: readonly ManifestRow[]): AccFixture[] {
  const fams = ENGINE_FAMILIES[e.engine] ?? [];
  return e.fixtures.filter((f) => fams.includes(familyOf(f)) && !isLarge(f, manifest));
}

function benchMs(inp: Inputs, eng: string, name: string): Timed | undefined {
  return eng === 'own' ? inp.bench.chrome.warm[name] : inp.bench.chrome.engines[name]?.[eng];
}

function kindGzip(size: SizeReport, kind: string): number | null {
  const chunks = size.chunks.filter((c) => c.kind === kind);
  return chunks.length > 0 ? chunks.reduce((n, c) => n + c.gzip, 0) : null;
}

const sharedParserGzip = (size: SizeReport): number | null => kindGzip(size, 'parser-shared');

function chunkGzip(size: SizeReport, kind: string): number {
  return need(
    size.chunks.find((c) => c.kind === kind),
    `size chunk ${kind}`,
  ).gzip;
}

function approachesBlock(inp: Inputs): string[] {
  const own = engine(inp.acc, 'own');
  const libs = ['mp4box', 'mediabunny'].map((n) => engine(inp.acc, n));
  const all = [own, ...libs];
  const ownByName = new Map(own.fixtures.map((f) => [f.name, f]));
  const rv = inp.bench.chrome.rvfc.rows;
  const rvEst = rv.filter((r) => r.estimate !== null);
  const rvEqual = rvEst.filter((r) => r.value !== null && Math.abs(r.value - r.refValue) <= 1e-9 * r.refValue);
  const rvVfr = rvEst.filter((r) => r.refVfr);
  const rvFailed = rv.filter((r) => r.estimate === null);
  const browser = majorVersion(inp.bench.environment.chrome.product);
  const sz = inp.size;

  const accuracyCell = (e: EngineReport) => {
    const { checks, counts } = ownTotals(e);
    const unsupported = ['isobmff', 'matroska']
      .filter((fam) => !(ENGINE_FAMILIES[e.engine] ?? []).includes(fam))
      .reduce((n, fam) => n + engineStats(e, fam).checks.filter((c) => c.verdict === 'mismatch').length, 0);
    const note = unsupported > 0 ? ` (${unsupported} of them on WebM/MKV files it cannot open)` : '';
    return `${checks} checks: ${counts.exact} exact, ${counts['known-deviation']} known deviation, ${counts.mismatch} mismatch${note}`;
  };
  const fpsCell = (e: EngineReport) =>
    ['isobmff', 'matroska']
      .map((fam) => {
        if (!(ENGINE_FAMILIES[e.engine] ?? []).includes(fam)) return `${fam === 'isobmff' ? 'MP4' : 'MKV'}: not supported`;
        const s = engineStats(e, fam);
        return `${fam === 'isobmff' ? 'MP4' : 'MKV'}: ${s.fpsMismatch}`;
      })
      .join(', ');
  const bytesCell = (e: EngineReport, fam: string) => {
    if (!(ENGINE_FAMILIES[e.engine] ?? []).includes(fam)) return 'not supported';
    const list = e.fixtures.filter((f) => familyOf(f) === fam && !isLarge(f, inp.manifest));
    const read = list.reduce((s, f) => s + io(f).bytesRead, 0);
    const total = list.reduce((s, f) => s + f.sizeBytes, 0);
    return `${fmtBytes(read)} of ${fmtBytes(total)} (${fmtPct((read / total) * 100)}%)`;
  };
  const readsCell = (e: EngineReport) => {
    const r = supported(e, inp.manifest).map((f) => io(f).reads);
    return `${median(r)} / ${Math.max(...r)}`;
  };
  const nodeCell = (e: EngineReport) => {
    const list = supported(e, inp.manifest);
    const ms = median(list.map((f) => io(f).ms));
    if (e.engine === 'own') return `${fmtMs(ms)} ms`;
    const ratio = geomeanRatio(list.map((f) => [io(f).ms, io(need(ownByName.get(f.name), `own ${f.name}`)).ms] as const));
    return `${fmtMs(ms)} ms (${fmtRatio(ratio)} own)`;
  };
  const chromeCell = (e: EngineReport) => {
    const names = Object.keys(inp.bench.chrome.warm).filter((n) => benchMs(inp, e.engine, n) !== undefined);
    const ms = median(names.map((n) => benchMs(inp, e.engine, n)!.medianMs));
    if (e.engine === 'own') return `${fmtMs(ms)} ms`;
    const ratio = geomeanRatio(names.map((n) => [benchMs(inp, e.engine, n)!.medianMs, need(inp.bench.chrome.warm[n], `chrome warm ${n}`).medianMs] as const));
    return `${fmtMs(ms)} ms (${fmtRatio(ratio)} own)`;
  };
  const largeCell = (e: EngineReport, name: string) => {
    const f = fixture(e, name);
    const c = need(inp.bench.chrome.large[name]?.[e.engine], `chrome large ${e.engine} ${name}`);
    return `${io(f).reads} reads, ${fmtBytes(io(f).bytesRead)}; Node ${fmtMs(io(f).ms)} ms, Chrome ${fmtMs(c.medianMs)} ms`;
  };
  const longCfr = fixture(own, 'long_cfr_3h_60fps.mp4');
  const longVfr = fixture(own, 'long_vfr_1h_screenrec.mp4');
  const durOf = (f: AccFixture) => fmtDuration(Number(findCheck(f.fileChecks, 'formatDurationSec')?.app ?? Number.NaN));
  const shared = chunkGzip(sz, 'engine-shared');
  const rvMs = rvEst.map((r) => r.ms);
  const rvVfrText = rvVfr.map((r) => `${r.errorPct !== null && r.errorPct > 0 ? '+' : ''}${(r.errorPct ?? 0).toFixed(1)}%`).join(' and ');

  const header = ['', 'Own parsers (this repo)', 'mp4box.js 2.4.1', 'mediabunny 1.62.0', `requestVideoFrameCallback (${browser})`];
  const rows = [
    row(['Containers', 'MP4, MOV, WebM, Matroska', 'MP4, MOV', 'MP4, MOV, WebM, Matroska', 'whatever the browser can play']),
    row(['Checks vs ffprobe, all fixtures', ...all.map(accuracyCell), 'no ffprobe-equivalent fields']),
    row(['Frame-rate field mismatches', ...all.map(fpsCell), `${rvEqual.length} of ${rvEst.length} estimates equal ffprobe's average; VFR files off by ${rvVfrText}; ${rvFailed.length} of ${rv.length} files did not play`]),
    row([`Bytes read, ${engineStats(own, 'isobmff').fixtures.filter((f) => !isLarge(f, inp.manifest)).length} committed MP4/MOV files`, ...all.map((e) => bytesCell(e, 'isobmff')), 'the media element streams the file']),
    row([`Bytes read, ${engineStats(own, 'matroska').fixtures.length} committed WebM/MKV files`, ...all.map((e) => bytesCell(e, 'matroska')), 'the media element streams the file']),
    row(['Reads per file, median / max', ...all.map(readsCell), 'n/a']),
    row(['Time per file, Node 24 (median; geometric mean vs own)', ...all.map(nodeCell), 'needs a browser']),
    row([`Time per file, ${browser} (median; geometric mean vs own)`, ...all.map(chromeCell), `${fmtMs(median(rvMs) / 1000)} s (max ${fmtMs(Math.max(...rvMs) / 1000)} s)`]),
    row([`${durOf(longCfr)} CFR MP4, ${fmtBytes(longCfr.sizeBytes)}`, ...all.map((e) => largeCell(e, longCfr.name)), 'not measured']),
    row([`${durOf(longVfr)} VFR MP4, ${fmtBytes(longVfr.sizeBytes)}`, ...all.map((e) => largeCell(e, longVfr.name)), 'not measured']),
    row([
      'gzip, loaded on demand',
      `${kindGzip(sz, 'client') === null ? '' : `probe client ${fmtKB(kindGzip(sz, 'client')!)} + `}worker entry ${fmtKB(chunkGzip(sz, 'worker'))}${sharedParserGzip(sz) === null ? '' : ` + statistics ${fmtKB(sharedParserGzip(sz)!)}`} + ISO BMFF ${fmtKB(chunkGzip(sz, 'isobmff'))} or Matroska ${fmtKB(chunkGzip(sz, 'matroska'))}`,
      `${fmtKB(chunkGzip(sz, 'mp4box'))} + ${fmtKB(shared)} shared`,
      `${fmtKB(chunkGzip(sz, 'mediabunny'))} + ${fmtKB(shared)} shared`,
      fmtKB(chunkGzip(sz, 'rvfc')),
    ]),
    row([
      'Main risk',
      'own code to maintain; cases outside the corpus are flagged, not verified',
      'last sample duration overridden; must be fed box by box; no Matroska',
      'packet-rate average, edit-list start trim ignored, whole-cluster Matroska reads',
      'needs a visible tab and a playable codec; wrong on VFR; seconds per file',
    ]),
  ];
  return [methodLine(inp), '', ...table(header, 'lllll', rows)];
}

function enginesBlock(inp: Inputs): string[] {
  const engines = inp.acc.engines.filter((e) => !e.loadSkipped);
  const summary = engines.map((e) => {
    const { checks, counts } = ownTotals(e);
    return row([
      ENGINE_LABEL[e.engine] ?? e.engine,
      e.informational ? 'informational' : 'gating',
      e.fixtures.length,
      checks,
      counts.exact,
      counts['within-tol'],
      counts['known-deviation'],
      counts.mismatch,
      counts['n/a'],
      e.mismatchFixtures.length,
    ]);
  });
  const byFamily = engines.flatMap((e) =>
    ['isobmff', 'matroska', 'none']
      .filter((fam) => e.fixtures.some((f) => familyOf(f) === fam))
      .map((fam) => {
        const s = engineStats(e, fam);
        const supportedHere = fam === 'none' || (ENGINE_FAMILIES[e.engine] ?? []).includes(fam);
        return row([
          ENGINE_LABEL[e.engine] ?? e.engine,
          FAMILY_LABEL[fam] ?? fam,
          s.fixtures.length,
          s.checks.length,
          s.fpsMismatch,
          s.otherMismatch,
          s.mismatchFixtures,
          supportedHere ? '' : 'container not supported by the library',
        ]);
      }),
  );
  const fieldLines = engines
    .filter((e) => e.informational)
    .map((e) => {
      const counts = new Map<string, number>();
      for (const c of e.fixtures.flatMap(checksOf)) if (c.verdict === 'mismatch') counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
      const list = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return `- ${ENGINE_LABEL[e.engine] ?? e.engine} mismatches by field: ${list.map(([id, n]) => `\`${id}\` ${n}`).join(', ')}.`;
    });
  return [
    ...table(['Engine', 'Role', 'Fixtures', 'Checks', 'exact', 'within-tol', 'known-deviation', 'mismatch', 'n/a', 'Fixtures with a mismatch'], 'llrrrrrrrr', summary),
    '',
    ...table(['Engine', 'Files', 'Fixtures', 'Checks', 'Frame-rate mismatches', 'Other mismatches', 'Fixtures with a mismatch', 'Note'], 'llrrrrrl', byFamily),
    '',
    ...fieldLines,
  ];
}

const fileOf = (path: string): string => path.split('/').pop() ?? path;
const stemOf = (path: string): string => fileOf(path).replace(/\.(?:js|css)$/, '').replace(/-[A-Za-z0-9_-]{8}$/, '');

function distinctLabels(chunks: readonly Chunk[]): string[] {
  const once = (labels: readonly string[], i: number) => labels.indexOf(labels[i]) === labels.lastIndexOf(labels[i]);
  const names = chunks.map((c) => CHUNK_NAME[c.kind] ?? c.kind);
  const stems = chunks.map((c, i) => `${names[i]}: \`${stemOf(c.file)}\``);
  return chunks.map((c, i) => (once(names, i) ? names[i] : once(stems, i) ? stems[i] : `${names[i]}: \`${fileOf(c.file)}\``));
}

function bundleBlock(inp: Inputs): string[] {
  const budgets = new Map(inp.size.budgets.map((b) => [b.key, b]));
  const chunks = [...inp.size.chunks].sort((a, b) => {
    const ia = CHUNK_ORDER.indexOf(a.kind);
    const ib = CHUNK_ORDER.indexOf(b.kind);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.file.localeCompare(b.file);
  });
  const budgetCells = (b: Budget | undefined) => (b ? [fmtKB(b.limit), fmtKB(b.headroom), b.status] : ['not budgeted', '-', '-']);
  const labels = distinctLabels(chunks);
  const rows = chunks.map((c, i) =>
    row([labels[i], CHUNK_WHEN[c.kind] ?? 'lazy', fmtKB(c.raw), `**${fmtKB(c.gzip)}**`, fmtKB(c.brotli), ...budgetCells(budgets.get(c.kind))]),
  );
  const compRows = Object.entries(COMPOSITE_BUDGET)
    .filter(([key]) => !OPTIONAL_COMPOSITES.has(key) || inp.size.composites[key])
    .map(([key, budgetKey]) => {
      const c = need(inp.size.composites[key], `size composite ${key}`);
      return row([COMPOSITE_LABEL[key] ?? key, '', fmtKB(c.raw), `**${fmtKB(c.gzip)}**`, fmtKB(c.brotli), ...budgetCells(budgets.get(budgetKey))]);
    });
  return table(['Chunk', 'Loaded', 'Raw', 'gzip -9', 'brotli q11', 'Budget (gzip)', 'Headroom', 'Status'], 'llrrrrrl', [...rows, ...compRows]);
}

function matrixFixture(inp: Inputs, name: string): MatrixFixture {
  return need(
    inp.matrix.fixtures.find((f) => f.name === name),
    `size matrix fixture ${name}`,
  );
}

function matrixMetric(inp: Inputs, name: string, metric: string): number {
  return need(matrixFixture(inp, name).metrics[metric], `size matrix ${name} ${metric}`);
}

const MATRIX_ENGINES: ReadonlyArray<readonly [string, string]> = [
  ['mp4box', 'mp4box'],
  ['mediabunny', 'mediabunny'],
  ['rvfc', 'rVFC'],
];

function packageBlock(inp: Inputs, doc: Doc): string[] {
  const kbOrDash = (n: number | null | undefined): string => (n === null || n === undefined ? '-' : fmtKB(n));
  const imports = (f: MatrixFixture): string => `${f.imports.map((i) => `\`video-fps-probe${i.slice(1)}\``).join(' + ')}${f.note ? ` (${f.note})` : ''}`;
  const engines = (f: MatrixFixture): string =>
    MATRIX_ENGINES.filter(([key]) => typeof f.metrics[key] === 'number')
      .map(([key, label]) => `${label} ${fmtKB(f.metrics[key]!)}`)
      .join(', ') || '-';
  const status = (f: MatrixFixture): string => {
    const failed = f.problems.length + f.budgets.filter((b) => b.status === 'over' || b.status === 'missing').length;
    return failed === 0 ? `ok (${f.budgets.filter((b) => b.status === 'ok').length} budgets)` : 'fails';
  };
  const rows = inp.matrix.fixtures.map((f) =>
    row([
      f.name === 'default' ? '**default**' : f.name,
      imports(f),
      f.name === 'default' ? `${f.worker} (recommended)` : f.worker,
      `**${fmtKB(matrixMetric(inp, f.name, 'trigger'))}**`,
      kbOrDash(f.metrics['firstMp4']),
      kbOrDash(f.metrics['allOwn']),
      engines(f),
      f.workers.length,
      status(f),
    ]),
  );
  const s = inp.matrix.standalone;
  rows.push(row(['standalone worker file', '`video-fps-probe/standalone/own.worker.js`', '-', '-', kbOrDash(s.gzip), kbOrDash(s.gzip), '-', '1 file, no imports', s.status]));
  const v = inp.matrix.versions;
  return [
    `**A default install adds ${fmtKB(matrixMetric(inp, 'default', 'trigger'))} gzip to the host app's critical path:** the package code in the entry chunk of a Vite ${v['vite'] ?? ''} app that imports \`video-fps-probe/lazy\` (with Vite's preload helper, which any app with a dynamic import already has, that entry chunk is ${fmtKB(matrixMetric(inp, 'default', 'entry'))}). With \`worker: { format: 'es' }\` in the host's Vite config the first MP4 or MOV file then loads ${fmtKB(matrixMetric(inp, 'default', 'firstMp4'))} lazily: the probe client, the own worker, the statistics chunk and the ISO BMFF parser; every own path together is ${fmtKB(matrixMetric(inp, 'default', 'allOwn'))}. Without a worker option Vite builds workers as 'iife', which cannot split, so the own worker is one file with both parsers and the first file loads ${fmtKB(matrixMetric(inp, 'zero-config', 'firstMp4'))} (zero-config). mp4box.js and mediabunny are only in the build when their entries are imported. Everything the default build emits outside the entry chunk is ${fmtKB(matrixMetric(inp, 'default', 'lazyTotal'))}, because it also holds main-thread copies of the parsers, the statistics and the worker runtime: they exist for SSR, Node, \`worker: 'inline'\` and the root \`analyze()\`, and a browser with a \`Worker\` global does not download them otherwise.`,
    '',
    `Recommended: one line in the host's Vite config, so the own worker splits and the first MP4 loads ${fmtKB(matrixMetric(inp, 'default', 'firstMp4'))} instead of ${fmtKB(matrixMetric(inp, 'zero-config', 'firstMp4'))}. Module workers run on the whole package floor (Chrome and Edge 94, Firefox 114, Safari 15.4).`,
    '',
    '```js',
    "export default defineConfig({ worker: { format: 'es' } });",
    '```',
    '',
    ...table(['Configuration', 'Imports', 'Vite worker option', 'Critical path', 'First MP4, lazy', 'All own paths, lazy', 'Engine chunks, lazy', 'Worker files', 'Budgets'], 'lllrrrrrl', rows),
    '',
    `Measured by \`npm run size:matrix\` on production builds of the fixtures in \`tests/consumers/fixtures/\`, installed from the packed tarball into a directory outside the repository with mp4box ${v['mp4box'] ?? ''} and mediabunny ${v['mediabunny'] ?? ''}; gzip -9, KB = 1000 bytes. The critical path is the package code in the entry chunk, cut out by the hidden sourcemap. CI fails when a budget is exceeded, a configuration builds an unexpected worker file, or a sourcemap lists a module that must not be there (mp4box or mediabunny where they are not imported, the prebuilt own worker in the custom-worker build); [report/size-matrix.md](${doc.link('report/size-matrix.md')}) lists every budget with its reason.`,
  ];
}

function speedBlock(inp: Inputs): string[] {
  const own = engine(inp.acc, 'own');
  const warm = inp.bench.chrome.warm;
  const measured = (name: string): boolean => own.fixtures.some((f) => f.name === name) && !!(warm[name] ?? inp.bench.chrome.large[name]?.['own']);
  const rows = SPEED_FILES.filter(([name]) => !OPTIONAL_SPEED_FILES.has(name) || measured(name)).map(([name, label]) => {
    const f = fixture(own, name);
    const t = primaryOf(f);
    const frames = findCheck(t?.checks ?? [], 'frames')?.app ?? '-';
    const dur = findCheck(f.fileChecks, 'formatDurationSec')?.app;
    const chrome = warm[name] ?? inp.bench.chrome.large[name]?.['own'];
    const c = need(chrome, `chrome timing for ${name}`);
    return row([
      `\`${name}\``,
      label,
      fmtBytes(f.sizeBytes),
      dur ? fmtDuration(Number(dur)) : '-',
      frames,
      io(f).reads,
      `${fmtBytes(io(f).bytesRead)} (${fmtPct(io(f).percent)}%)`,
      fmtMs(io(f).ms),
      fmtMs(c.medianMs),
      fmtMs(c.medianWallMs),
    ]);
  });
  const committed = own.fixtures.filter((f) => !isLarge(f, inp.manifest));
  const total = committed.reduce((s, f) => s + f.sizeBytes, 0);
  const read = committed.reduce((s, f) => s + io(f).bytesRead, 0);
  const w = Object.values(warm);
  rows.push(
    row([
      `**all ${committed.length} committed fixtures**`,
      'median per file; bytes are totals',
      fmtBytes(total),
      '',
      '',
      `${median(committed.map((f) => io(f).reads))} (max ${Math.max(...committed.map((f) => io(f).reads))})`,
      `${fmtBytes(read)} (${fmtPct((read / total) * 100)}%)`,
      fmtMs(median(committed.map((f) => io(f).ms))),
      fmtMs(median(w.map((x) => x.medianMs))),
      fmtMs(median(w.map((x) => x.medianWallMs))),
    ]),
  );
  const cold = inp.bench.chrome.coldFirst.map((c) => {
    const steady = need(warm[c.name], `chrome warm ${c.name}`).medianWallMs;
    return row([
      c.label,
      `\`${c.name}\``,
      fmtMs(c.coldWallMs),
      fmtMs(c.warmWallMs),
      fmtMs(steady),
      fmtMs(c.coldWallMs - steady),
      c.chunks.map((k) => `${k.path.replace(/^\/assets\//, '').replace(/-[A-Za-z0-9_]{8}\.js$/, '.js')} ${fmtKB(k.bytes)}`).join(', '),
    ]);
  });
  const cb = inp.bench.chrome.coldBatch;
  const rb = inp.bench.chrome.reloadBatch;
  const browser = majorVersion(inp.bench.environment.chrome.product);
  const edgeLine: string[] = [];
  if (inp.bench.edge && inp.bench.environment.edge) {
    const edgeWarm = inp.bench.edge.warm;
    const names = Object.keys(edgeWarm).filter((n) => warm[n]);
    const ratio = geomeanRatio(names.map((n) => [edgeWarm[n]!.medianMs, warm[n]!.medianMs] as const));
    edgeLine.push(
      `- ${majorVersion(inp.bench.environment.edge.product)}, same warm run: median ${fmtMs(median(names.map((n) => edgeWarm[n]!.medianMs)))} ms per file, geometric mean ${fmtRatio(ratio)} of ${browser}.`,
    );
  }
  return [
    methodLine(inp),
    '',
    ...table(['File', 'What it is', 'Size', 'Duration', 'Frames', 'Reads', 'Bytes read', 'Node ms', `${browser} ms`, `${browser} UI ms`], 'lllrrrrrrr', rows),
    '',
    `- Cold start, ${browser}: the app is ready ${fmtMs(inp.bench.chrome.pageLoad.readyMs)} ms after navigation; ${cb.files} files picked at once on a fresh profile show all results after ${fmtMs(cb.wallMs)} ms (median of ${fmtMs(rb.medianMs)} ms over reloads, range ${fmtMs(rb.minMs)} to ${fmtMs(rb.maxMs)} ms).`,
    ...edgeLine,
    '',
    ...table(['First file of a container', 'File', 'UI ms, fresh page', 'UI ms, 2nd pick', 'UI ms, steady', 'Extra ms (fresh - steady)', 'Chunks fetched (raw)'], 'llrrrrl', cold),
  ];
}

function ownFixtureRow(f: AccFixture, inp: Inputs): string {
  const t = primaryOf(f);
  const all = checksOf(f);
  const warm = inp.bench.chrome.warm[f.name] ?? inp.bench.chrome.large[f.name]?.['own'];
  const extra = f.tracks.length > 1 ? ` (+${f.tracks.length - 1} track)` : '';
  const ioCells = f.io ? [f.io.reads, f.sizeBytes > 0 ? `${fmtBytes(f.io.bytesRead)} (${fmtPct(f.io.percent)}%)` : fmtBytes(f.io.bytesRead)] : ['-', '-'];
  const chrome = warm ? fmtMs(warm.medianMs) : '-';
  if (!t) {
    const outcome = findCheck(f.fileChecks, 'error');
    return row([`\`${f.name}\``, f.category, outcome?.ffprobe ?? '-', outcome?.app ?? '-', '-', '-', '-', verdictText(all), ...ioCells, chrome]);
  }
  const c = t.checks;
  let ffAvg: string;
  let appAvg: string;
  if (f.family === 'matroska') {
    const d = findCheck(c, 'avgFps.declared');
    const m = findCheck(c, 'avgFps.measured');
    ffAvg = d?.ffprobe ?? '-';
    appAvg = d?.app ?? 'none';
    if (m?.app) appAvg += `; measured ${m.app}`;
  } else {
    const a = findCheck(c, 'avgFps');
    ffAvg = a?.ffprobe ?? '-';
    appAvg = a?.app ?? '-';
  }
  const frames = findCheck(c, 'frames');
  const min = findCheck(c, 'minFps')?.app;
  const max = findCheck(c, 'maxFps')?.app;
  const vfr = findCheck(c, 'isVfr')?.app;
  return row([
    `\`${f.name}\`${extra}`,
    f.category,
    ffAvg,
    appAvg,
    frames ? `${frames.app ?? '-'} / ${frames.ffprobe ?? 'N/A'}` : '-',
    min || max ? `${decimal(min)} to ${decimal(max)}` : '-',
    vfr === 'true' ? 'yes' : vfr === 'false' ? 'no' : '-',
    verdictText(all),
    ...ioCells,
    chrome,
  ]);
}

function accuracyBlock(inp: Inputs): string[] {
  const own = engine(inp.acc, 'own');
  const browser = majorVersion(inp.bench.environment.chrome.product);
  return [
    `<details><summary>Own parsers: all ${own.fixtures.length} fixtures</summary>`,
    '',
    ...table(
      ['Fixture', 'Category', 'ffprobe avg_frame_rate', 'App average', 'Frames app / ffprobe', 'Min to max FPS', 'VFR', 'Verdict', 'Reads', 'Bytes read', `${browser} ms`],
      'llllllllrrr',
      own.fixtures.map((f) => ownFixtureRow(f, inp)),
    ),
    '',
    '</details>',
  ];
}

function deviationsBlock(inp: Inputs): string[] {
  const own = engine(inp.acc, 'own');
  const out: string[] = [];
  for (const f of own.fixtures) {
    for (const c of checksOf(f)) {
      if (c.verdict !== 'known-deviation') continue;
      out.push(`- \`${f.name}\`, \`${c.id}\`: app ${c.app ?? '-'}, ffprobe ${c.ffprobe ?? '-'}. ${plain(c.deviation ?? 'no reason recorded')}`);
    }
  }
  if (out.length === 0) out.push('- None.');
  const skipped = own.skipped.map((s) => `- Not run: \`${s.name}\`, ${s.reason}.`);
  return [...out, ...skipped];
}

function rvfcBlock(inp: Inputs): string[] {
  const rows = inp.bench.chrome.rvfc.rows.map((r) => {
    const err = r.error ? (r.error.length > 60 ? `${r.error.slice(0, 57)}...` : r.error) : null;
    return row([
      `\`${r.name}\``,
      `${r.ref} (${decimal(r.ref)})`,
      r.estimate ? `${r.estimate} (${decimal(r.estimate)})` : `error: ${err}`,
      r.errorPct === null ? '-' : `${r.errorPct > 0 ? '+' : ''}${r.errorPct.toFixed(1)}%`,
      `${r.refVfr ? 'yes' : 'no'} / ${r.isVfr === null ? '-' : r.isVfr ? 'yes' : 'no'}`,
      r.confidence ?? '-',
      r.estimate ? `${r.passes.length} (rate ${r.rate})` : '-',
      `${(r.ms / 1000).toFixed(2)} s`,
    ]);
  });
  const hz = inp.bench.environment.displayHzOs;
  return [
    `Headless ${majorVersion(inp.bench.environment.chrome.product)}, GPU decoding on, display ${hz.length > 0 ? `${hz.join(', ')} Hz` : 'unknown'}.`,
    '',
    ...table(['File', 'ffprobe avg', 'rVFC estimate', 'Error', 'VFR ffprobe / rVFC', 'Confidence', 'Passes', 'Time'], 'llllllll', rows),
  ];
}

function corpusBlock(inp: Inputs): string[] {
  const cats = new Map<string, ManifestRow[]>();
  for (const r of inp.manifest) cats.set(r.category, [...(cats.get(r.category) ?? []), r]);
  const rows = [...cats.entries()].map(([cat, list]) => {
    const committed = list.filter((r) => r.committed).length;
    const expects = [...new Set(list.map((r) => r.expect))].join(', ');
    return row([cat, list.length, committed, expects, CATEGORY_TEXT[cat] ?? '']);
  });
  const committed = inp.manifest.filter((r) => r.committed).length;
  rows.push(row(['**total**', inp.manifest.length, committed, '', '']));
  return table(['Category', 'Fixtures', 'Committed', 'Expected outcome', 'Covers'], 'lrrll', rows);
}

function profileBlock(inp: Inputs): string[] {
  const own = engine(inp.acc, 'own');
  const sz = inp.size;
  const browser = majorVersion(inp.bench.environment.chrome.product);
  const vfr = need(sz.composites['firstVfrMp4'], 'size composite firstVfrMp4');
  const mp4 = need(sz.composites['firstMp4'], 'size composite firstMp4');
  const limit = sz.budgets.find((b) => b.key === 'firstVfrMp4');
  const rows = PROFILE_FILES.map(([name, label]) => {
    const f = fixture(own, name);
    const c = primaryOf(f)?.checks ?? [];
    const min = findCheck(c, 'minFps')?.app;
    const max = findCheck(c, 'maxFps')?.app;
    const chrome = need(inp.bench.chrome.warm[name] ?? inp.bench.chrome.large[name]?.['own'], `chrome timing for ${name}`);
    return row([`\`${name}\``, label, findCheck(c, 'frames')?.app ?? '-', min || max ? `${decimal(min)} to ${decimal(max)}` : '-', fmtMs(io(f).ms), fmtMs(chrome.medianMs)]);
  });
  return [
    `The profile code is ${fmtKB(chunkGzip(sz, 'segments'))} gzip in the worker and the panel ${fmtKB(chunkGzip(sz, 'rateProfile'))} on the main thread, both lazy. The first VFR MP4 loads ${fmtKB(vfr.gzip)} gzip, ${fmtKB(vfr.gzip - mp4.gzip)} more than a CFR one${limit ? ` (budget ${fmtKB(limit.limit)})` : ''}. Times are the whole analysis, profile included.`,
    '',
    ...table(['File', 'Rate profile', 'Frames', 'Min to max FPS', 'Node ms', `${browser} ms`], 'llrlrr', rows),
  ];
}

function integrationStale(inp: Inputs): boolean {
  const current = new Set(inp.size.chunks.map((c) => c.file.split('/').pop()));
  return INTEGRATION_CHUNKS.some((k) => !current.has(inp.integration.chunks[k]));
}

function integrationModel(ic: IntegrationReport) {
  const m = ic.model;
  const prof = (id: string): ProfileModel => need(m.profiles.find((p) => p.id === id), `integration profile ${id}`);
  const link = (id: string): string => {
    const p = need(
      ic.profiles.find((x) => x.id === id),
      `integration link ${id}`,
    );
    return `${prof(id).label} (${p.downKbps === null ? 'unthrottled' : `${Number((p.downKbps / 1000).toFixed(2))} Mbps`}, ${p.latencyMs} ms)`;
  };
  return { m, prof, link };
}

function pctSmall(p: number): string {
  return `${p < 0.1 ? p.toFixed(3) : p.toFixed(2)}%`;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

function integrationBlock(inp: Inputs): string[] {
  const ic = inp.integration;
  const { m, prof, link } = integrationModel(ic);
  const first = m.memory.probe.first.processPrivateDelta;
  const idle = m.memory.probe.idle.processPrivateDelta;
  const batch = ic.main.batchFiles;
  const rows = [
    row([
      'Critical path, gzip',
      `${fmtKB(m.triggerGzip)} trigger (+${pctSmall(m.initialIncreaseMeasuredPct)})`,
      'same',
      `${fmtKB(m.options.eagerBytes)} (+${pctSmall(m.options.eagerVsInitialPct)})`,
    ]),
    row(['Downloaded on use, gzip', `${fmtKB(m.lazyMp4Gzip)} for the first MP4, ${fmtKB(m.lazyBothGzip)} with both parsers`, 'the same, when the dialog opens', 'nothing more']),
    ...INTEGRATION_PROFILES.map((id) => {
      const p = prof(id);
      return row([
        `First video, ${link(id)}`,
        `+${fmtMs(p.cold.extraMs)} ms once`,
        `${fmtMs(p.prewarm.totalMs)} ms prewarmed, ${fmtMs(p.prefetch.totalMs)} ms HTTP-prefetched`,
        `${fmtMs(p.prewarm.totalMs)} ms, plus ${fmtMs(need(m.options.eagerTransferMs[id], `eager transfer ${id}`))} ms of transfer on every page load`,
      ]);
    }),
    row([
      'Main thread',
      `0 long tasks, TBT ${fmtMs(m.main.coldBatchTbtMs)} ms for ${batch} files at once; ${fmtMs(m.main.firstFileProbeCpuMs)} ms of main-thread CPU for the first file`,
      'same',
      'same, plus a worker started on every page load',
    ]),
    row(['Memory (renderer private, probe share)', `+${fmtMB(first)} after the first video, +${fmtMB(idle)} idle after ${batch}`, 'same, from the dialog open', `+${fmtMB(first)} for every visitor`]),
  ];
  const cpu = Object.values(ic.cpu.perFile).map((f) => `\`${f.name}\` ${fmtMs(f.medianMs)} ms`);
  const stale = integrationStale(inp)
    ? [
        `**Not current.** Measured on ${ic.environment.date.slice(0, 10)} on an earlier build (worker entry \`${ic.chunks['entry']}\`). The worker entry and parser chunks of the current build differ (see [Bundle size](#bundle-size)), so re-run \`scripts/bench/integration.mjs\` before quoting these sizes and timings.`,
        '',
      ]
    : [];
  return [
    ...stale,
    `Host model: an SPA with a ${fmtMB(ic.host.initialGzipBytes)} gzip initial load, ${majorVersion(ic.environment.browser)} headless, local server with CDP network throttling; the probe is the real worker pool, worker entry and parser chunks. "Prewarmed" means the worker was started and the parser loaded before the pick. The trigger is an inline script and the glue the WorkerPool class bundled by the bench, so the sizes below are not those of the package entries: what an app that imports \`video-fps-probe/lazy\` adds is in [Package size](#package-size).`,
    '',
    ...table(['', 'Lazy on the first pick', 'Lazy + prefetch when the upload dialog opens', 'Eager (in the critical bundle)'], 'llll', rows),
    '',
    `Worker time per file after warm-up: ${cpu.join(', ')}.`,
  ];
}

interface Doc {
  link(path: string): string;
}

const BLOCKS: Record<string, (inp: Inputs, doc: Doc) => string[]> = {
  headline,
  profile: profileBlock,
  integration: integrationBlock,
  reads: readsBlock,
  approaches: approachesBlock,
  engines: enginesBlock,
  package: packageBlock,
  bundle: bundleBlock,
  speed: speedBlock,
  accuracy: accuracyBlock,
  deviations: deviationsBlock,
  rvfc: rvfcBlock,
  corpus: corpusBlock,
};

export const TARGETS: ReadonlyArray<{ path: string; blocks: readonly string[] }> = [{ path: 'README.md', blocks: Object.keys(BLOCKS) }];

export function renderBlocks(inp: Inputs, path: string, names: readonly string[]): Record<string, string> {
  const doc: Doc = { link: (to) => posix.relative(posix.dirname(path), to) };
  const out: Record<string, string> = {};
  for (const name of names) out[name] = plain(need(BLOCKS[name], `block ${name}`)(inp, doc).join('\n'));
  return out;
}

function checkTargets(): void {
  const placed = TARGETS.flatMap((t) => t.blocks);
  for (const name of Object.keys(BLOCKS)) {
    const n = placed.filter((b) => b === name).length;
    if (n !== 1) fail(`block ${name} is placed in ${n} target files, expected 1`);
  }
}

export function applyBlocks(readme: string, blocks: Record<string, string>): { text: string; missing: string[] } {
  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  let text = readme.replace(/\r\n/g, '\n');
  const missing: string[] = [];
  for (const [name, body] of Object.entries(blocks)) {
    const start = `<!-- tables:${name}:start -->`;
    const end = `<!-- tables:${name}:end -->`;
    const i = text.indexOf(start);
    const j = text.indexOf(end);
    if (i < 0 || j < 0 || j < i || text.indexOf(start, i + 1) >= 0) {
      missing.push(name);
      continue;
    }
    text = `${text.slice(0, i + start.length)}\n\n${body}\n\n${text.slice(j)}`;
  }
  return { text: eol === '\n' ? text : text.replace(/\n/g, eol), missing };
}

function main(): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({
    options: {
      report: { type: 'string' },
      check: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(`Usage: node scripts/readme-tables.ts [--check] [--report <dir>]

Rewrites the sections between <!-- tables:<name>:start --> and <!-- tables:<name>:end -->
in ${TARGETS.map((t) => t.path).join(', ')} from report/accuracy.json, report/size.json,
report/size-matrix.json, report/browser-bench.json, report/integration-cost.json and fixtures/manifest.tsv.
${TARGETS.map((t) => `${t.path}: ${t.blocks.join(', ')}.`).join('\n')}

  --check    exit 1 if a file is not up to date, write nothing
  --report   report directory (default report)`);
    return 0;
  }
  checkTargets();
  const reportDir = resolve(root, values.report ?? 'report');
  const inputs: Inputs = {
    acc: readJson<AccuracyReport>(join(reportDir, 'accuracy.json')),
    size: readJson<SizeReport>(join(reportDir, 'size.json')),
    matrix: readJson<SizeMatrix>(join(reportDir, 'size-matrix.json')),
    bench: readJson<BenchReport>(join(reportDir, 'browser-bench.json')),
    integration: readJson<IntegrationReport>(join(reportDir, 'integration-cost.json')),
    manifest: readManifest(join(root, 'fixtures', 'manifest.tsv')),
  };
  let failed = 0;
  for (const target of TARGETS) {
    const path = resolve(root, target.path);
    const before = readFileSync(path, 'utf8');
    const { text, missing } = applyBlocks(before, renderBlocks(inputs, target.path, target.blocks));
    if (missing.length > 0) {
      console.error(`${path}: missing or duplicated markers for ${missing.join(', ')}`);
      failed++;
    } else if (text === before) {
      console.log(values.check ? `${path} is up to date` : `${path} unchanged`);
    } else if (values.check) {
      console.error(`${path} is out of date: run node scripts/readme-tables.ts`);
      failed++;
    } else {
      writeFileSync(path, text);
      console.log(`updated ${path}: ${target.blocks.join(', ')}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
  }
}
