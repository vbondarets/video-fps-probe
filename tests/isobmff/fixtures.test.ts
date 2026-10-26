import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { analyzeIsoBmffDetailed, type IsoMovie, type IsoTrack } from '../../src/core/isobmff/index.ts';
import { sampleTotals } from '../../src/core/isobmff/track.ts';
import { resolveOptions } from '../../src/core/options.ts';
import { BlobReader } from '../../src/core/reader.ts';
import { primaryTrack } from '../../src/core/result.ts';
import type { FileResult, VideoTrackResult } from '../../src/core/types.ts';
import { FILES_DIR, FIXTURES_DIR, REPO_ROOT, fixturePath, loadManifest, loadRef, type FixtureRef, type ManifestEntry } from '../helpers/fixtures.ts';
import { openFixture } from '../helpers/open-blob.ts';

const DEVIATION_FIELDS = new Set([
  'avgFps',
  'nominalFps',
  'frames',
  'presentedFrames',
  'durationSec',
  'startSec',
  'formatDurationSec',
  'minFps',
  'maxFps',
  'isVfr',
  'duplicateTimestamps',
  'width',
  'height',
  'codecName',
  'error',
  'trackSelection',
]);

const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

type Deviations = Record<string, Record<string, string>>;
const DEVIATIONS_PATH = join(FIXTURES_DIR, 'known-deviations', 'own-isobmff.json');
const deviations: Deviations = JSON.parse(readFileSync(DEVIATIONS_PATH, 'utf8')) as Deviations;

const SUBSTITUTE_REFS: Record<string, { ref: string; warning: RegExp }> = {
  'corrupt_stts_count_huge.mp4': { ref: 'cfr_h264_30.mp4', warning: /declares \d+ entries/ },
  'corrupt_elst64_all_ones.mp4': { ref: 'cfr_h264_30.mp4', warning: /^unknown elst duration: the edit lasts to the end$/m },
};

const EXACT_WARNINGS: Record<string, { file: string[]; track: string[] }> = {
  'mov_trailing_junk.mov': { file: ['ignored trailing data at 88446: not a box'], track: [] },
  'fmp4_mehd_all_ones.mp4': { file: [], track: [] },
  'mp4_stsd_two_entries.mp4': { file: [], track: ['2 sample descriptions, first used'] },
};

const ERROR_MESSAGES: Record<string, string> = {
  'corrupt_trunc_no_moov.mp4': 'incomplete file: no moov',
  'corrupt_trunc_moov_partial.mp4': 'incomplete file: moov is truncated',
};

const READ_BUDGET: Record<string, number> = {
  'av_h264_aac_faststart.mp4': 1,
  'mov_nobf_faststart.mov': 1,
  'cfr_h264_30.mp4': 2,
  'av_h264_aac.mp4': 2,
  'box64_mdat64_wide.mov': 2,
  'fmp4_frag_duration.mp4': 2,
};

interface RationalLike {
  num: number;
  den: number;
}

interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate: string;
  r_frame_rate: string;
  time_base: string;
  nb_frames?: string;
  nb_read_frames?: string;
  nb_read_packets?: string;
  duration_ts?: number;
  start_pts?: number;
  start_time?: string;
  disposition?: { attached_pic?: number };
}

interface RefVideoStreamDetail {
  index: number;
  duplicateTimestamps: number;
  instFpsExcludingTail: { count: number; distinctDeltas: number; minFps: RationalLike; maxFps: RationalLike } | null;
  vfr: { isVfr: boolean; medianDeltaTicks: number } | null;
  avgFromPts: { fps: RationalLike; frames: number; spanTicks: number } | null;
}

interface Probe {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

function probeOf(ref: FixtureRef): Probe {
  return (ref.probe ?? {}) as Probe;
}

function realVideoStreams(ref: FixtureRef): ProbeStream[] {
  const attached = new Set((ref.attachedPicStreams as number[] | undefined) ?? []);
  return (probeOf(ref).streams ?? []).filter((s) => s.codec_type === 'video' && !attached.has(s.index) && s.disposition?.attached_pic !== 1);
}

function detailOf(ref: FixtureRef, index: number): RefVideoStreamDetail {
  const list = (ref.videoStreams as RefVideoStreamDetail[] | undefined) ?? [];
  const found = list.find((v) => v.index === index);
  if (!found) throw new Error(`reference has no videoStreams entry for stream ${index}`);
  return found;
}

function str(r: RationalLike | null | undefined): string {
  return r ? `${r.num}/${r.den}` : '0/0';
}

function known(value: string | undefined): number | null {
  return value === undefined || value === 'N/A' ? null : Number(value);
}

function hasSidx(movie: IsoMovie): boolean {
  return movie.topLevel.some((b) => b.type === 'sidx');
}

function hasTextOrDataStreams(ref: FixtureRef): boolean {
  return (probeOf(ref).streams ?? []).some((s) => s.codec_type === 'subtitle' || s.codec_type === 'data');
}

function isIsoRow(row: ManifestEntry): boolean {
  return row.container === 'mp4' || row.container === 'mov';
}

interface Analysed {
  result: FileResult;
  movie: IsoMovie | null;
}

async function analyzeFixture(path: string, name: string): Promise<Analysed> {
  const opened = await openFixture(path);
  try {
    const result = await analyze(opened.blob, name);
    const movie = result.error ? null : (await analyzeIsoBmffDetailed(new BlobReader(opened.blob), resolveOptions())).movie;
    return { result, movie };
  } finally {
    await opened.close();
  }
}

function assertTrack(track: VideoTrackResult, stream: ProbeStream, detail: RefVideoStreamDetail, mt: IsoTrack, movie: IsoMovie, dev: Record<string, string>, ffprobeFails: boolean): void {
  const unless = (field: string, check: () => void): void => {
    if (!dev[field]) check();
  };
  const ts = Number(stream.time_base.split('/')[1]);
  expect(stream.time_base).toBe(`1/${ts}`);
  expect(track.timescale).toBe(ts);
  unless('codecName', () => expect(track.codecName).toBe(stream.codec_name));
  unless('width', () => expect(track.width).toBe(stream.width));
  unless('height', () => expect(track.height).toBe(stream.height));

  if (ffprobeFails) expect(track.avgFpsFfprobe).toBeNull();
  else expect(track.avgFpsFfprobe).toBe(stream.avg_frame_rate);
  const measured = detail.avgFromPts;
  if (track.provenance.avgFps === 'exact' && measured) {
    if (str(track.avgFps) !== str(measured.fps)) {
      expect(track.presentedFrames).toBe(measured.frames);
      const span = ((track.presentedFrames ?? 0) * ts) / (track.avgFps?.value ?? NaN);
      expect(Math.abs(span - measured.spanTicks)).toBeLessThan(detail.vfr?.medianDeltaTicks ?? 0);
    }
  } else expect(str(track.avgFps)).toBe(stream.avg_frame_rate);

  const totals = sampleTotals(mt);
  const cfr = detail.vfr === null || detail.vfr.isVfr === false;
  if (totals.moovSamples === 0 || ffprobeFails) expect(track.rFpsFfprobe).toBeNull();
  else if (cfr && detail.instFpsExcludingTail?.distinctDeltas === 1) expect(track.rFpsFfprobe).toBe(stream.r_frame_rate);
  else if (track.rFpsFfprobe !== null) expect(track.rFpsFfprobe).toBe(stream.r_frame_rate);
  unless('nominalFps', () => {
    if (detail.instFpsExcludingTail && detail.instFpsExcludingTail.distinctDeltas === 1) expect(track.nominalFps?.kind).toBe('exact');
    if (track.nominalFps?.kind === 'exact') expect(str(track.nominalFps)).toBe(stream.r_frame_rate);
  });

  const fragmented = mt.fragments.length > 0;
  unless('frames', () => {
    if (!fragmented) {
      expect(track.frames).toBe(known(stream.nb_frames));
    } else if (totals.moovSamples === 0) {
      expect(known(stream.nb_frames)).toBeNull();
      expect(track.frames).toBe(known(stream.nb_read_packets));
    } else {
      expect(totals.moovSamples).toBe(known(stream.nb_frames));
      expect(track.frames).toBe(known(stream.nb_read_packets));
    }
  });
  unless('presentedFrames', () => {
    const readFrames = known(stream.nb_read_frames);
    if (readFrames !== null) expect(track.presentedFrames).toBe(readFrames);
  });

  unless('durationSec', () => {
    expect(track.durationSec).not.toBeNull();
    const refDuration = (stream.duration_ts ?? NaN) / ts;
    if (fragmented && hasSidx(movie)) {
      const frame = track.avgFps ? 1 / track.avgFps.value : 0;
      const tol = Math.max(frame, Math.abs(Number(stream.start_time ?? 0)));
      expect(Math.abs(track.durationSec! - refDuration)).toBeLessThanOrEqual(tol + 1e-9);
    } else {
      expect(Math.round(track.durationSec! * ts)).toBe(stream.duration_ts);
    }
  });
  unless('startSec', () => {
    expect(track.startSec).not.toBeNull();
    expect(Math.round(track.startSec! * ts)).toBe(stream.start_pts);
  });

  const ex = detail.instFpsExcludingTail;
  unless('minFps', () => expect(track.minFps ? str(track.minFps) : null).toBe(ex && ex.count > 0 ? str(ex.minFps) : null));
  unless('maxFps', () => expect(track.maxFps ? str(track.maxFps) : null).toBe(ex && ex.count > 0 ? str(ex.maxFps) : null));
  unless('isVfr', () => expect(track.isVfr).toBe(detail.vfr ? detail.vfr.isVfr : null));
  unless('duplicateTimestamps', () => expect(track.duplicateTimestamps).toBe(detail.duplicateTimestamps));
}

function expectedPrimary(result: FileResult, movie: IsoMovie): number | null {
  let best: { id: number; frames: number; enabled: boolean } | null = null;
  for (const t of result.videoTracks) {
    const frames = t.frames ?? 0;
    if (frames <= 1) continue;
    const enabled = movie.tracks.find((m) => m.id === t.trackId)?.enabled ?? false;
    if (!best || (enabled && !best.enabled) || (enabled === best.enabled && frames > best.frames)) best = { id: t.trackId, frames, enabled };
  }
  return best ? best.id : null;
}

function assertFixture(row: ManifestEntry, analysed: Analysed): void {
  const { result, movie } = analysed;
  const dev = deviations[row.name] ?? {};
  if (row.expect === 'error') {
    expect(result.error).toBeTruthy();
    if (ERROR_MESSAGES[row.name]) expect(result.error).toBe(ERROR_MESSAGES[row.name]);
    expect(result.videoTracks).toEqual([]);
    expect(result.primaryTrackId).toBeNull();
    return;
  }
  expect(result.error).toBeNull();
  expect(result.container).toBe(row.container);
  expect(result.scan).toBe('exact');
  expect(movie).not.toBeNull();
  const exact = EXACT_WARNINGS[row.name];
  if (exact) {
    expect(result.warnings).toEqual(exact.file);
    expect(result.videoTracks.map((t) => t.warnings)).toEqual([exact.track]);
  }
  const ownRef = loadRef(row.name);
  expect(ownRef).not.toBeNull();
  const substitute = SUBSTITUTE_REFS[row.name];
  if (substitute) {
    expect(ownRef!.ok).toBe(false);
    expect(result.warnings.concat(...result.videoTracks.map((t) => t.warnings)).join('\n')).toMatch(substitute.warning);
  }
  const ref = substitute ? loadRef(substitute.ref)! : ownRef!;
  expect(ref.ok).toBe(true);
  if (READ_BUDGET[row.name] !== undefined) expect(result.io.reads).toBeLessThanOrEqual(READ_BUDGET[row.name]);

  if (!dev.formatDurationSec && !hasTextOrDataStreams(ref)) {
    const refFormat = known(probeOf(ref).format?.duration);
    if (refFormat === null) expect(result.formatDurationSec).toBeNull();
    else expect(Math.abs((result.formatDurationSec ?? NaN) - refFormat)).toBeLessThanOrEqual(1e-6 + 1e-12);
  }

  if (row.expect === 'no-video') {
    expect(result.videoTracks).toEqual([]);
    expect(result.primaryTrackId).toBeNull();
    expect(result.audioTrackCount).toBeGreaterThan(0);
    return;
  }

  const streams = realVideoStreams(ref);
  expect(result.videoTracks).toHaveLength(streams.length);
  streams.forEach((stream, i) => {
    const track = result.videoTracks[i];
    const mt = movie!.tracks.find((t) => t.id === track.trackId);
    expect(mt).toBeDefined();
    assertTrack(track, stream, detailOf(ref, stream.index), mt!, movie!, dev, substitute !== undefined);
  });

  const primary = primaryTrack(result);
  expect(primary).not.toBeNull();
  if (row.expect === 'still') {
    for (const t of result.videoTracks) expect(t.isStill).toBe(true);
    expect(primary!.minFps).toBeNull();
    expect(primary!.isVfr).toBeNull();
  } else if (!dev.trackSelection) {
    expect(primary!.isStill).toBe(false);
    expect(result.primaryTrackId).toBe(expectedPrimary(result, movie!));
  }
}

const manifest = loadManifest();
const rows = manifest.filter((r) => r.committed && isIsoRow(r));
const largeRows = manifest.filter((r) => !r.committed && isIsoRow(r) && r.category === 'long');
const runLarge = process.env.FPS_PROBE_LARGE === '1';

describe('own ISO BMFF analyzer vs ffprobe 8.1.1 references', () => {
  test('manifest lists the ISO BMFF fixtures', () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(rows.some((r) => r.name.startsWith('sniff_'))).toBe(true);
  });

  test('known deviations name real fixtures and fields with concrete reasons', () => {
    const names = new Set(manifest.map((r) => r.name));
    for (const [name, fields] of Object.entries(deviations)) {
      expect(names.has(name)).toBe(true);
      for (const [field, reason] of Object.entries(fields)) {
        expect(DEVIATION_FIELDS.has(field)).toBe(true);
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThanOrEqual(15);
        expect(reason).not.toMatch(LONG_DASH);
      }
    }
  });

  test.each(rows)('$name', async (row) => {
    const path = fixturePath(row.name);
    expect(path).not.toBeNull();
    assertFixture(row, await analyzeFixture(path!, row.name));
  });
});

describe('an all-ones elst duration on an edit that trims the start', () => {
  const source = 'mp4_elst_trim_start.mp4';
  let dir = '';
  let patched = '';

  beforeAll(() => {
    dir = mkdtempSync(join(process.env.FPS_PROBE_SCRATCH ?? tmpdir(), 'fps-probe-elst64-'));
    patched = join(dir, 'mp4_elst_trim_start_elst64_all_ones.mp4');
    const tool = join(REPO_ROOT, 'scripts', 'fixtures', 'tools', 'patch-mp4.mjs');
    const run = spawnSync(process.execPath, [tool, 'elst64', join(FILES_DIR, source), patched, 'ffffffffffffffff'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('lasts from its media_time to the end of the media, with the frames and durations ffprobe 8.1.1 gives the source file', async () => {
    const { result, movie } = await analyzeFixture(patched, 'mp4_elst_trim_start_elst64_all_ones.mp4');
    const original = (await analyzeFixture(fixturePath(source)!, source)).result;
    expect(result.warnings).toEqual(['ffprobe 8.1.1 rejects this file: an elst duration of -1']);
    expect(result.videoTracks.map((v) => v.warnings)).toEqual([['unknown elst duration: the edit lasts to the end']]);
    expect(movie!.tracks[0]!.edits.map((e) => e.mediaTime)).toEqual([23002]);
    const track = result.videoTracks[0]!;
    expect(track).toMatchObject({ frames: 90, presentedFrames: 69, startSec: 0, durationSec: 2.303, avgFps: { num: 30000, den: 1001 }, avgFpsFfprobe: null, rFpsFfprobe: null });
    expect(result.formatDurationSec).toBe(track.durationSec);
    const same = (r: FileResult) => ({ ...r, name: '', size: 0, io: null, warnings: [], videoTracks: r.videoTracks.map((v) => ({ ...v, warnings: [], avgFpsFfprobe: null, rFpsFfprobe: null })) });
    expect(same(result)).toEqual(same(original));
    const ref = loadRef(source)!;
    expect(Math.abs(result.formatDurationSec! - Number(probeOf(ref).format!.duration))).toBeLessThanOrEqual(1e-6);
    const [stream] = realVideoStreams(ref);
    assertTrack(track, stream!, detailOf(ref, stream!.index), movie!.tracks[0]!, movie!, {}, true);
  });
});

describe('all-ones mvhd, tkhd and mdhd version 1 durations against ffprobe 8.1.1', () => {
  const source = 'cfr_h264_30.mp4';
  const same = { time_base: '1/15360', start_pts: 0, nb_frames: '90', nb_read_frames: '90', nb_read_packets: '90', avg_frame_rate: '30/1', r_frame_rate: '30/1' };
  const recorded = [
    ['mvhd64', 'a024910518a8bdc7d7c691f1f0b52829189b0183c248cac633d055a038264189', { duration: '3.000000' }, { ...same, duration_ts: 46080, duration: '3.000000' }],
    ['tkhd64', '901d0c1693db5733fdae29a41118a04e2ee6e1fb668bdd94223f0925e21a6239', { duration: '3.000000' }, { ...same, duration_ts: 46080, duration: '3.000000' }],
    ['mdhd64', 'defd7c66958497ffc2910e9ded288f5cc94922be625e3354978b3d75cca01e33', { duration: 'N/A' }, { ...same, duration_ts: 0, duration: '0.000000' }],
  ] as const;
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(process.env.FPS_PROBE_SCRATCH ?? tmpdir(), 'fps-probe-header64-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test.each(recorded)('%s of %s: the values ffprobe 8.1.1 printed for the same bytes, -count_frames included', async (mode, sha256, format, stream) => {
    const name = `cfr_h264_30_${mode}.mp4`;
    const patched = join(dir, name);
    const tool = join(REPO_ROOT, 'scripts', 'fixtures', 'tools', 'patch-mp4.mjs');
    const run = spawnSync(process.execPath, [tool, mode, join(FILES_DIR, source), patched, 'ffffffffffffffff'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(createHash('sha256').update(readFileSync(patched)).digest('hex')).toBe(sha256);
    const { result } = await analyzeFixture(patched, name);
    const track = result.videoTracks[0]!;
    expect(result.error).toBeNull();
    expect([...result.warnings, ...track.warnings]).toEqual([]);
    expect(result.formatDurationSec).toBe(known(format.duration));
    expect(`1/${track.timescale}`).toBe(stream.time_base);
    expect(Math.round(track.startSec! * track.timescale)).toBe(stream.start_pts);
    expect(Math.round(track.durationSec! * track.timescale)).toBe(stream.duration_ts);
    expect(track.durationSec).toBe(Number(stream.duration));
    expect([track.frames, track.presentedFrames, track.frames].map(String)).toEqual([stream.nb_frames, stream.nb_read_frames, stream.nb_read_packets]);
    expect([track.avgFpsFfprobe, track.rFpsFfprobe]).toEqual([stream.avg_frame_rate, stream.r_frame_rate]);
    if (stream.duration_ts > 0) {
      const original = (await analyzeFixture(fixturePath(source)!, name)).result;
      expect({ ...result, size: 0, io: null }).toEqual({ ...original, size: 0, io: null });
    }
  });
});

describe.skipIf(!runLarge)('large ISO BMFF fixtures (FPS_PROBE_LARGE=1)', () => {
  test.each(largeRows)('$name', async (row) => {
    const path = fixturePath(row.name);
    if (!path) {
      console.warn(`skipped ${row.name}: not generated (npm run fixtures:generate -- --with-long)`);
      return;
    }
    const analysed = await analyzeFixture(path, row.name);
    assertFixture(row, analysed);
    expect(analysed.result.io.reads).toBeLessThanOrEqual(4);
  });

  describe('sparse 4.5 GB co64 file', () => {
    const name = 'sparse_4_5gb_co64.mp4';
    let dir = '';
    let sparsePath = '';
    let skipReason = '';

    beforeAll(() => {
      dir = mkdtempSync(join(process.env.FPS_PROBE_SCRATCH ?? tmpdir(), 'fps-probe-sparse-'));
      if (process.platform === 'win32') {
        const probe = join(dir, 'probe.bin');
        writeFileSync(probe, 'x');
        spawnSync('fsutil', ['sparse', 'setflag', probe], { encoding: 'utf8' });
        const query = spawnSync('fsutil', ['sparse', 'queryflag', probe], { encoding: 'utf8' });
        rmSync(probe, { force: true });
        if (!/is set as sparse/i.test(query.stdout ?? '')) {
          skipReason = `fsutil cannot create sparse files here: ${(query.stdout || query.stderr || '').trim()}`;
          return;
        }
      }
      sparsePath = join(dir, name);
      const tool = join(REPO_ROOT, 'scripts', 'fixtures', 'tools', 'patch-mp4.mjs');
      const run = spawnSync(process.execPath, [tool, 'sparse', join(FILES_DIR, 'cfr_h264_30.mp4'), sparsePath, '4500000000'], { encoding: 'utf8' });
      if (run.status !== 0 || !existsSync(sparsePath)) skipReason = `sparse generation failed: ${run.stderr}`;
    }, 120000);

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('reads offsets above 4 GiB through a FileSlice and matches the reference', async () => {
      if (skipReason) {
        console.warn(`skipped ${name}: ${skipReason}`);
        return;
      }
      const opened = await openFixture(sparsePath);
      expect(opened.kind).toBe('fileSlice');
      expect(opened.size).toBe(loadRef(name)!.bytes);
      await opened.close();
      const analysed = await analyzeFixture(sparsePath, name);
      const row = manifest.find((r) => r.name === name)!;
      assertFixture(row, analysed);
      expect(analysed.result.io.reads).toBeLessThanOrEqual(3);
      expect(analysed.result.io.bytesRead).toBeLessThan(256 * 1024);
      const track = analysed.movie!.tracks[0];
      expect(track.co64).not.toBeNull();
    });
  });
});
