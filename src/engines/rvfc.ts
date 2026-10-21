import { emptyAnalysis, emptyTrack } from '../core/result.ts';
import type { Rational } from '../core/types.ts';
import type { RvfcOptions, RvfcPass, RvfcResult } from './types.ts';

const RATES = [24, 25, 30, 48, 50, 60, 100, 120, 144, 240];
const MAX_PASSES = 5;
const TOLERANCE = 0.003;

type Frame = [mediaTime: number, presented: number];
type Estimate = Omit<RvfcPass, 'rate' | 'callbacks'>;

const rational = (v: number): Rational => ({ num: Math.round(v * 1000), den: 1000, value: v });
const why = (v: HTMLVideoElement): string => v.error?.message || 'media error';
const fail = (message: string): Error => Error(`unplayable: ${message}`);
const differ = (a: number, b: number): boolean => Math.abs(a / b - 1) > TOLERANCE;

function snap(v: number): Rational | null {
  let best: Rational | null = null;
  let err = TOLERANCE;
  for (const n of RATES) {
    for (const den of n % 6 ? [1] : [1, 1001]) {
      const num = den === 1 ? n : n * 1000;
      const e = Math.abs(v / (num / den) - 1);
      if (e < err) {
        err = e;
        best = { num, den, value: num / den };
      }
    }
  }
  return best;
}

function refresh(): Promise<number> {
  return new Promise((done) => {
    let n = 0;
    const t0 = performance.now();
    const tick = (): void => {
      n++;
      const ms = performance.now() - t0;
      if (ms < 300) requestAnimationFrame(tick);
      else done((n * 1000) / ms);
    };
    requestAnimationFrame(tick);
    setTimeout(() => done(0), 1500);
  });
}

function sample(v: HTMLVideoElement, rate: number, signal?: AbortSignal): Promise<Frame[]> {
  return new Promise((done, fail) => {
    const out: Frame[] = [];
    let t0 = 0;
    const stop = (err?: unknown): void => {
      clearTimeout(guard);
      v.pause();
      v.onended = v.onerror = null;
      if (err) fail(err);
      else done(out);
    };
    const guard = setTimeout(stop, 6000);
    const next: VideoFrameRequestCallback = (now, meta) => {
      t0 ||= now;
      out.push([meta.mediaTime, meta.presentedFrames]);
      if (signal?.aborted) stop(signal.reason);
      else if (now - t0 > 4000 || (now - t0 > 1500 && out.length > 40)) stop();
      else v.requestVideoFrameCallback(next);
    };
    v.onended = () => stop();
    v.onerror = () => stop(fail(why(v)));
    v.playbackRate = rate;
    v.requestVideoFrameCallback(next);
    v.play().catch((e: Error) => stop(fail(e.message)));
  });
}

function estimate(frames: Frame[]): Estimate | null {
  const d: number[] = [];
  for (let i = 4; i < frames.length; i++) {
    const dt = frames[i][0] - frames[i - 1][0];
    if (dt > 0 && frames[i][1] - frames[i - 1][1] === 1) d.push(dt);
  }
  if (d.length < 2) return null;
  d.sort((a, b) => a - b);
  const key = (x: number): number => Math.round(Math.log(x) * 100);
  const bins = new Map<number, number>();
  for (const x of d) bins.set(key(x), (bins.get(key(x)) ?? 0) + 1);
  const top = [...bins].sort((a, b) => b[1] - a[1])[0][0];
  const near = d.filter((x) => Math.abs(key(x) - top) < 2);
  const typical = near[near.length >> 1];
  const first = frames[3];
  const last = frames[frames.length - 1];
  return {
    fps: 1 / typical,
    avg: (last[1] - first[1]) / (last[0] - first[0]),
    pairs: d.length,
    spread: d.filter((x) => Math.abs(x - typical) > Math.max(0.05 * typical, 0.0012)).length / d.length,
    lo: 1 / d[d.length - 1],
    hi: 1 / d[0],
  };
}

// The host element must be attached, visible and in a foreground tab, otherwise no frames are presented.
export async function estimateWithRvfc(file: File, opts: RvfcOptions): Promise<RvfcResult> {
  const { host, signal, onProgress } = opts;
  const t0 = performance.now();
  const r: RvfcResult = { name: file.name, size: file.size, ...emptyAnalysis('unknown'), io: { reads: 0, bytesRead: 0, ms: 0 }, engine: 'rvfc' };
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  try {
    signal?.throwIfAborted();
    if (!('requestVideoFrameCallback' in v)) throw Error('requestVideoFrameCallback unsupported');
    v.muted = v.playsInline = true;
    v.width = 320;
    host.append(v);
    v.src = url;
    const failure = await new Promise<string>((done) => {
      v.onloadedmetadata = () => done('');
      v.onerror = () => done(why(v));
      setTimeout(() => done('metadata timeout'), 8000);
    });
    if (failure) throw fail(`${failure} (canPlayType=${v.canPlayType(file.type)})`);
    if (!v.videoWidth) throw Error('no playable video track');
    const hz = await refresh();
    if (!hz) throw Error('tab not visible: keep it in the foreground');

    let rate = 1;
    const passes: RvfcPass[] = [];
    for (let i = 0; i < MAX_PASSES; i++) {
      onProgress?.({ phase: `play x${rate}`, done: i, total: MAX_PASSES });
      if (i) v.currentTime = 0;
      const frames = await sample(v, rate, signal);
      const e = estimate(frames);
      if (!e) break;
      const prev = passes[passes.length - 1];
      passes.push({ ...e, rate, callbacks: frames.length });
      if (e.fps * rate <= hz * 0.51 && (!prev || e.spread > 0.02 || !differ(e.fps, prev.fps))) break;
      rate /= 2;
    }
    const f = passes[passes.length - 1];
    if (!f) throw Error('too few frames: codec not decodable or tab hidden');

    const snapped = snap(f.fps) ?? snap(f.avg);
    const prev = passes[passes.length - 2];
    const flags: string[] = [];
    if (f.pairs < 20) flags.push('few-samples');
    if (prev && differ(f.fps, prev.fps)) flags.push('passes-differ');
    if (f.fps * f.rate > hz * 0.51) flags.push('display-limited');
    const vfr = f.spread > 0.02;
    if (vfr) flags.push('vfr');
    if (differ(f.avg, f.fps)) flags.push('estimates-differ');
    if (!snapped) flags.push('non-standard');

    const t = emptyTrack(1);
    t.width = v.videoWidth;
    t.height = v.videoHeight;
    t.durationSec = isFinite(v.duration) ? v.duration : null;
    t.avgFps = snapped ?? rational(f.fps);
    t.nominalFps = snapped && { ...snapped, kind: 'snapped' as const };
    t.minFps = rational(f.lo);
    t.maxFps = rational(f.hi);
    t.isVfr = vfr;
    t.vfrRatio = f.spread;
    for (const k of ['avgFps', 'nominalFps', 'minFps', 'maxFps', 'isVfr'] as const) t.provenance[k] = 'estimated';
    t.warnings = ['approximate: estimated by playback', ...flags];
    r.videoTracks = [t];
    r.primaryTrackId = 1;
    r.formatDurationSec = t.durationSec;
    r.rvfc = {
      displayHz: hz,
      rate: f.rate,
      passes,
      confidence: (['high', 'medium', 'low'] as const)[Math.min(flags.length, 2)],
      flags,
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    r.error = String((e as Error).message ?? e);
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
  r.io.ms = performance.now() - t0;
  return r;
}
