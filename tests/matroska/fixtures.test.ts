import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanMatroskaLayout } from '../../scripts/compare/layout.ts';
import { analyze } from '../../src/core/analyze.ts';
import { parseDurationTag } from '../../src/core/matroska/header.ts';
import type { FileResult, MatroskaMode, Rational, VideoTrackResult } from '../../src/core/types.ts';
import { FIXTURES_DIR, fixturePath, loadManifest, loadRef, type FixtureRef, type ManifestEntry } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';

interface RefRatio {
  num: number;
  den: number;
  value: number;
}

interface RefVideo {
  index: number;
  timeBase: string;
  packets: number;
  duplicateTimestamps: number;
  instFpsExcludingTail: { distinctDeltas: number; minFps: RefRatio | null; maxFps: RefRatio | null } | null;
  vfr: { isVfr: boolean; medianDeltaTicks: number } | null;
  avgFromPts: { frames: number; firstPts: number; lastPts: number; lastDurationTicks: number; spanTicks: number; fps: RefRatio } | null;
  lastPacketEnd: { ticks: number; seconds: number } | null;
}

interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width: number;
  height: number;
  avg_frame_rate: string;
  r_frame_rate: string;
  nb_read_packets?: string;
  nb_read_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
}

interface Probe {
  format: { duration?: string };
  streams: ProbeStream[];
}

const DEVIATIONS = JSON.parse(readFileSync(join(FIXTURES_DIR, 'known-deviations', 'own-matroska.json'), 'utf8')) as Record<string, Record<string, string>>;
const ROWS = loadManifest().filter((r) => (r.container === 'webm' || r.container === 'matroska') && (r.committed || fixturePath(r.name) !== null));
const NO_DEFAULT_DURATION = /\bDefaultDuration\b[^.]*\b(overwritten|voided|void|not written|missing|absent)\b|\b(no|without|missing)\s+DefaultDuration\b/i;

function deviation(name: string, field: string): string | null {
  const d = DEVIATIONS[name];
  if (!d) return null;
  return d[field] ?? d[field.split('.')[0]] ?? null;
}

function realVideo(probe: Probe): ProbeStream[] {
  return probe.streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
}

function refVideo(ref: FixtureRef, index: number): RefVideo {
  const list = (ref.videoStreams ?? []) as RefVideo[];
  const v = list.find((x) => x.index === index);
  if (!v) throw new Error(`no videoStreams entry for stream ${index}`);
  return v;
}

function ticksPerSecond(timeBase: string): number {
  const [n, d] = timeBase.split('/').map(Number);
  return d / n;
}

function ratioString(r: Rational | RefRatio | null): string | null {
  return r ? `${r.num}/${r.den}` : null;
}

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(b), Number.MIN_VALUE);
}

function ratioValue(s: string): number {
  const [n, d] = s.split('/').map(Number);
  return d === 0 ? 0 : n / d;
}

async function unstoredLastDurations(row: ManifestEntry): Promise<boolean[]> {
  const path = fixturePath(row.name);
  if (!path) throw new Error(`fixture missing: ${row.name}`);
  const layout = await scanMatroskaLayout(path, statSync(path).size);
  return (layout?.matroskaTracks ?? []).filter((t) => t.type === 1).map((t) => t.defaultDurationNs === null && t.blockDurations === 0);
}

function measuredSpanTicks(v: RefVideo, unstored: boolean): number | null {
  const avg = v.avgFromPts;
  if (!avg) return null;
  return unstored && v.vfr ? avg.lastPts - avg.firstPts + v.vfr.medianDeltaTicks : avg.spanTicks;
}

async function run(row: ManifestEntry, mode: MatroskaMode): Promise<FileResult> {
  const path = fixturePath(row.name);
  if (!path) throw new Error(`fixture missing: ${row.name}`);
  return withFixture(path, (blob) => analyze(blob, row.name, { matroskaMode: mode }));
}

function load(row: ManifestEntry): { ref: FixtureRef; probe: Probe; streams: ProbeStream[] } {
  const ref = loadRef(row.name);
  if (!ref) throw new Error(`reference missing: ${row.name}`);
  const probe = ref.probe as Probe;
  return { ref, probe, streams: realVideo(probe) };
}

function checkCommon(row: ManifestEntry, r: FileResult, probe: Probe, streams: ProbeStream[], mode: MatroskaMode): void {
  expect(r.error).toBeNull();
  expect(r.engine).toBe('own');
  expect(r.container).toBe(row.container);
  const fd = probe.format.duration;
  expect(r.formatDurationSec).toBe(fd === undefined || fd === 'N/A' ? null : Number(fd));
  expect(r.videoTracks).toHaveLength(streams.length);
  if (row.expect === 'no-video') {
    expect(r.primaryTrackId).toBeNull();
    expect(r.warnings).toContain('no video track');
    return;
  }
  expect(r.primaryTrackId).toBe(r.videoTracks[0].trackId);
  streams.forEach((s, i) => {
    const t = r.videoTracks[i];
    expect(t.codecName).toBe(s.codec_name);
    expect(t.width).toBe(s.width);
    expect(t.height).toBe(s.height);
    checkDeclared(row, t, s, mode);
  });
}

function checkDeclared(row: ManifestEntry, t: VideoTrackResult, s: ProbeStream, mode: MatroskaMode): void {
  const estimated = t.warnings.some((w) => w.startsWith('no DefaultDuration: avg_frame_rate and r_frame_rate estimated like ffprobe'));
  if (t.nominalFps?.kind !== 'declared' && t.warnings.some((w) => w.startsWith('no DefaultDuration'))) {
    if (mode === 'header') {
      expect(t.avgFpsFfprobe).toBeNull();
      expect(t.rFpsFfprobe).toBeNull();
      return;
    }
    expect(estimated, t.warnings.join(' | ')).toBe(true);
    expect(t.avgFpsFfprobe).toBe(s.avg_frame_rate);
    expect(t.rFpsFfprobe).toBe(s.r_frame_rate);
    return;
  }
  if (t.avgFpsFfprobe !== null) {
    expect(t.avgFpsFfprobe).toBe(s.avg_frame_rate);
    const v = ratioValue(t.avgFpsFfprobe);
    if (v > 5 && v < 1000) expect(t.rFpsFfprobe).toBe(s.r_frame_rate);
    else expect(t.rFpsFfprobe).toBeNull();
    expect(t.nominalFps?.kind).toBe('declared');
    expect(ratioString(t.nominalFps)).toBe(t.avgFpsFfprobe);
    return;
  }
  expect(t.rFpsFfprobe).toBeNull();
  expect(t.warnings.join(' ')).toMatch(/no DefaultDuration/);
  const explained = s.avg_frame_rate === '0/0' || NO_DEFAULT_DURATION.test(row.notes) || deviation(row.name, 'avgFps.declared') !== null;
  expect(explained, `ffprobe declares ${s.avg_frame_rate} but the app found no DefaultDuration`).toBe(true);
}

function checkExact(row: ManifestEntry, r: FileResult, ref: FixtureRef, streams: ProbeStream[], unstored: readonly boolean[]): void {
  expect(r.scan).toBe(row.expect === 'no-video' ? 'header' : 'exact');
  streams.forEach((s, i) => {
    const t = r.videoTracks[i];
    const v = refVideo(ref, s.index);
    const ts = ticksPerSecond(v.timeBase);
    expect(t.timescale).toBe(ts);
    expect(t.frames).toBe(Number(s.nb_read_packets));
    expect(t.presentedFrames).toBe(Number(s.nb_read_frames));
    expect(t.provenance.frames).toBe('computed');
    const avg = v.avgFromPts;
    const span = measuredSpanTicks(v, unstored[i] ?? false);
    if (avg && span !== null) {
      expect(t.startSec).toBe(avg.firstPts / ts);
      expect(t.avgFps, 'measured average').not.toBeNull();
      expect(relDiff(t.avgFps?.value ?? 0, (avg.frames * ts) / span)).toBeLessThanOrEqual(1e-9);
      expect(t.durationSec).toBeCloseTo(span / ts, 9);
    }
    const inst = v.instFpsExcludingTail;
    expect(ratioString(t.minFps)).toBe(ratioString(inst?.minFps ?? null));
    expect(ratioString(t.maxFps)).toBe(ratioString(inst?.maxFps ?? null));
    expect(t.isVfr).toBe(v.vfr?.isVfr ?? null);
    expect(t.duplicateTimestamps).toBe(v.duplicateTimestamps);
    expect(t.timestampsQuantized).toBe(v.vfr?.isVfr === false && (inst?.distinctDeltas ?? 0) > 1);
    expect(t.provenance.avgFps).toBe('exact');
  });
}

function checkHeader(r: FileResult, streams: ProbeStream[]): void {
  expect(r.scan).toBe('header');
  expect(r.io.reads).toBeLessThanOrEqual(5);
  expect(r.io.bytesRead).toBeLessThanOrEqual(1024 * 1024);
  streams.forEach((s, i) => {
    const t = r.videoTracks[i];
    expect(t.frames).toBeNull();
    expect(t.presentedFrames).toBeNull();
    expect(t.avgFps).toBeNull();
    expect(t.minFps).toBeNull();
    expect(t.maxFps).toBeNull();
    expect(t.isVfr).toBeNull();
    const tag = s.tags?.DURATION;
    expect(t.durationSec).toBe(tag === undefined ? null : parseDurationTag(tag));
    if (t.durationSec !== null && t.avgFpsFfprobe !== null) expect(t.warnings.join(' ')).toMatch(/frames \(estimated/);
  });
}

describe('Matroska fixtures', () => {
  it('covers every webm and matroska manifest row, including the renamed and audio-only files', () => {
    const names = ROWS.map((r) => r.name);
    expect(names).toContain('sniff_webm_named_mp4.mp4');
    expect(names).toContain('audio_only_opus.webm');
    expect(ROWS.length).toBeGreaterThanOrEqual(27);
  });

  it('lists only real fixtures and fields in the known deviations', () => {
    const fields = new Set(['avgFps', 'avgFps.declared', 'avgFps.measured', 'nominalFps', 'frames', 'presentedFrames', 'durationSec', 'startSec', 'formatDurationSec', 'minFps', 'maxFps', 'isVfr', 'duplicateTimestamps', 'width', 'height', 'codecName', 'error', 'trackSelection', 'medianFrameInterval', 'sampleAspectRatio', 'displayAspectRatio', 'enabled', 'colorRange', 'colorPrimaries', 'colorTransfer', 'colorSpace', 'bitDepth', 'profile', 'codecString', 'dolbyVision', 'layout', 'errorCode']);
    for (const [name, entry] of Object.entries(DEVIATIONS)) {
      expect(ROWS.some((r) => r.name === name)).toBe(true);
      for (const [field, reason] of Object.entries(entry)) {
        expect(fields.has(field)).toBe(true);
        expect(reason.length).toBeGreaterThanOrEqual(15);
      }
    }
  });

  describe.each(['exact', 'header'] as const)('matroskaMode %s', (mode) => {
    it.each(ROWS.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
      const { ref, probe, streams } = load(row);
      const r = await run(row, mode);
      checkCommon(row, r, probe, streams, mode);
      if (mode === 'exact') checkExact(row, r, ref, streams, await unstoredLastDurations(row));
      else checkHeader(r, streams);
    });
  });

  describe('matroskaMode probe', () => {
    it.each(ROWS.filter((r) => r.expect === 'ok').map((r) => [r.name, r] as const))('%s', async (_name, row) => {
      const { ref, probe, streams } = load(row);
      const r = await run(row, 'probe');
      const unstored = await unstoredLastDurations(row);
      checkCommon(row, r, probe, streams, 'probe');
      expect(r.scan).toBe('probe');
      streams.forEach((s, i) => {
        const t = r.videoTracks[i];
        const v = refVideo(ref, s.index);
        expect(t.avgFps).toBeNull();
        expect(t.frames).toBeNull();
        expect(t.provenance.minFps).toBe('sampled');
        const inst = v.instFpsExcludingTail;
        if (inst?.minFps && inst.maxFps && t.minFps && t.maxFps) {
          expect(t.minFps.value).toBeGreaterThanOrEqual(inst.minFps.value - 1e-9);
          expect(t.maxFps.value).toBeLessThanOrEqual(inst.maxFps.value + 1e-9);
        }
        if (v.vfr?.isVfr === false) expect(t.isVfr).toBe(false);
        const ts = ticksPerSecond(v.timeBase);
        const span = measuredSpanTicks(v, unstored[i] ?? false);
        if (i === 0 && span !== null) {
          expect(t.provenance.durationSec).toBe('sampled');
          expect(t.durationSec).toBeCloseTo(span / ts, 9);
        }
      });
    });
  });

  describe('live and false-Duration files', () => {
    const row = (name: string): ManifestEntry => {
      const r = ROWS.find((x) => x.name === name);
      if (!r) throw new Error(name);
      return r;
    };

    it('tail scan steps back past audio-only clusters to the last video frame (vp9_opus_live_audiotail)', async () => {
      const r = await run(row('vp9_opus_live_audiotail.webm'), 'probe');
      expect(r.audioTrackCount).toBe(1);
      expect(r.formatDurationSec).toBeNull();
      expect(r.videoTracks[0].durationSec).toBeCloseTo(3.0, 9);
      expect(r.warnings.join(' ')).toMatch(/sync search/);
    });

    it('keeps the false Info Duration as format duration but reports the real end (vp9_pipe_t10)', async () => {
      for (const mode of ['probe', 'exact'] as const) {
        const r = await run(row('vp9_pipe_t10.webm'), mode);
        expect(r.formatDurationSec).toBe(10);
        expect(r.videoTracks[0].durationSec).toBeCloseTo(3.0, 9);
        expect(r.warnings.join(' ')).toMatch(/Info Duration 10\.000 s exceeds the last block at 2\.967 s/);
      }
    });

    it('walks unknown-size Clusters (vp9_unknown_clusters)', async () => {
      const r = await run(row('vp9_unknown_clusters.webm'), 'exact');
      expect(r.warnings.join(' ')).toMatch(/unknown size/);
      expect(r.videoTracks[0].frames).toBe(90);
    });

    it('samples clusters through Cues when they exist (vp9)', async () => {
      const r = await run(row('vp9.webm'), 'probe');
      expect(r.warnings.join(' ')).toMatch(/via Cues/);
    });

    it('reads the first cluster in auto mode for small files and stays within a few reads', async () => {
      const r = await run(row('vp9.webm'), 'auto');
      expect(r.scan).toBe('exact');
      expect(r.io.reads).toBeLessThanOrEqual(2);
    });

    it('flags the stream-copied VFR file and keeps its declared average (h264_vfr_remux)', async () => {
      const r = await run(row('h264_vfr_remux.mkv'), 'exact');
      const t = r.videoTracks[0];
      expect(t.isVfr).toBe(true);
      expect(t.avgFpsFfprobe).toBe('130/3');
      expect(ratioString(t.avgFps)).toBe('130/3');
    });

    it('measures the true average when DefaultDuration claims a nominal rate (vfr_screenrec_ts1000.webm)', async () => {
      const r = await run(row('vfr_screenrec_ts1000.webm'), 'exact');
      const t = r.videoTracks[0];
      expect(t.avgFpsFfprobe).toBe('60/1');
      expect(ratioString(t.avgFps)).toBe('246000/5999');
      expect(t.warnings.join(' ')).toMatch(/differs from the measured average/);
    });

    it('applies the median-delta rule for the last frame without DefaultDuration (vfr_concat_10_30_60.webm)', async () => {
      const r = await run(row('vfr_concat_10_30_60.webm'), 'exact');
      expect(ratioString(r.videoTracks[0].avgFps)).toBe('100/3');
      expect(r.videoTracks[0].durationSec).toBe(6);
    });
  });
});
