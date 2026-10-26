import { makeRational } from '../core/rational.ts';
import { emptyAnalysis } from '../core/result.ts';
import type { TimelineStats } from '../core/stats.ts';
import type { EngineId, FileResult, Provenance, Rational, VideoTrackResult } from '../core/types.ts';

const CODEC_BY_FOURCC: Readonly<Record<string, string>> = {
  avc1: 'h264',
  avc2: 'h264',
  avc3: 'h264',
  avc4: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  dvh1: 'hevc',
  dvhe: 'hevc',
  vp08: 'vp8',
  vp09: 'vp9',
  av01: 'av1',
  vvc1: 'vvc',
  vvi1: 'vvc',
  mp4v: 'mpeg4',
  apch: 'prores',
  apcn: 'prores',
  apcs: 'prores',
  apco: 'prores',
  ap4h: 'prores',
  ap4x: 'prores',
  jpeg: 'mjpeg',
  mjpa: 'mjpeg',
  AVdn: 'dnxhd',
  AVdh: 'dnxhd',
  m2v1: 'mpeg2video',
  h263: 'h263',
  s263: 'h263',
  'png ': 'png',
};

const CODEC_BY_MATROSKA_ID: Readonly<Record<string, string>> = {
  V_VP8: 'vp8',
  V_VP9: 'vp9',
  V_AV1: 'av1',
  V_MPEG4_ISO_AVC: 'h264',
  V_MPEGH_ISO_HEVC: 'hevc',
};

export function codecNameFromFourcc(fourcc: string): string {
  return CODEC_BY_FOURCC[fourcc] ?? CODEC_BY_MATROSKA_ID[fourcc] ?? fourcc.trim();
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

export function isAbort(e: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted) return true;
  return typeof e === 'object' && e !== null && 'name' in e && (e as { name: unknown }).name === 'AbortError';
}

export function newResult(name: string, size: number, engine: EngineId): FileResult {
  return { name, size, ...emptyAnalysis('unknown'), io: { reads: 0, bytesRead: 0, ms: 0 }, engine };
}

const printable = (warnings: string[]): string[] => warnings.map((w) => w.replace(/[^\x20-\x7e\xa0-\uffff]/g, '?'));

export function printableWarnings(result: FileResult): void {
  result.warnings = printable(result.warnings);
  for (const t of result.videoTracks) t.warnings = printable(t.warnings);
}

export function ffprobeRotation(matrix: ArrayLike<number>): number {
  const a = matrix[0] / 65536;
  const b = matrix[1] / 65536;
  const c = matrix[3] / 65536;
  const d = matrix[4] / 65536;
  const s0 = Math.hypot(a, c);
  const s1 = Math.hypot(b, d);
  if (!s0 || !s1) return 0;
  const degrees = -(Math.atan2(b / s1, a / s0) * 180) / Math.PI;
  return Math.round(degrees * 1000) / 1000 || 0;
}

export function approxRational(value: number, relTol = 1e-9, maxDen = 1_000_000): Rational | null {
  if (!(value > 0) || !Number.isFinite(value)) return null;
  let h1 = 1;
  let h0 = 0;
  let k1 = 0;
  let k0 = 1;
  let x = value;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1;
    h1 = h2;
    k0 = k1;
    k1 = k2;
    if (Math.abs(h1 / k1 - value) <= relTol * value) break;
    const frac = x - a;
    if (frac < 1e-12) break;
    x = 1 / frac;
  }
  return makeRational(h1, k1);
}

export function applyStats(track: VideoTrackResult, stats: TimelineStats, source: Provenance = 'exact'): void {
  track.frames = stats.sampleCount;
  track.presentedFrames = stats.presentedFrames;
  track.avgFps = stats.presentedAvgFps ?? stats.avgFps;
  track.avgFpsFfprobe = stats.avgFps ? stats.avgFpsString : null;
  track.rFpsFfprobe = stats.nominalFps?.kind === 'exact' ? `${stats.nominalFps.num}/${stats.nominalFps.den}` : null;
  track.nominalFps = stats.nominalFps;
  track.dominantFps = stats.dominantFps;
  track.minFps = stats.minFps;
  track.maxFps = stats.maxFps;
  track.isVfr = stats.isVfr;
  track.vfrRatio = stats.vfrRatio;
  track.distinctDeltas = stats.distinctDeltas;
  track.duplicateTimestamps = stats.duplicateTimestamps;
  track.timestampsQuantized = stats.timestampsQuantized;
  track.isStill = stats.sampleCount <= 1;
  track.warnings.push(...stats.warnings);
  const nominalSource: Provenance = stats.nominalFps?.kind === 'snapped' ? 'estimated' : source;
  Object.assign(track.provenance, {
    frames: source,
    presentedFrames: source,
    avgFps: source,
    nominalFps: nominalSource,
    dominantFps: source,
    minFps: source,
    maxFps: source,
    isVfr: source,
    duplicateTimestamps: source,
  });
}
