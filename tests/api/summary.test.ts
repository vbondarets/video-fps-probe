import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarize } from '../../src/api/summary.ts';
import { analyze } from '../../src/core/analyze.ts';
import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import type { FileResult } from '../../src/core/types.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const run = async (name: string) => analyze(await openAsBlob(join(FILES_DIR, name)), name);

describe('summarize', () => {
  it('flattens the primary track of a CFR MP4', async () => {
    const s = summarize(await run('cfr_h264_29.97.mp4'));
    expect(s).toMatchObject({
      ok: true,
      name: 'cfr_h264_29.97.mp4',
      container: 'mp4',
      engine: 'own',
      fpsRational: '30000/1001',
      isVfr: false,
      approximate: false,
      error: null,
    });
    expect(s.fps).toBeCloseTo(29.97, 2);
    expect(s.nominalFps).toBeCloseTo(29.97, 2);
    expect(s.frames).toBeGreaterThan(0);
    expect(s.durationSec).toBeGreaterThan(0);
    expect(s.width).toBeGreaterThan(0);
    expect(s.height).toBeGreaterThan(0);
  });

  it('reports VFR with min and max', async () => {
    const s = summarize(await run('vfr_two_phase_5_200.mp4'));
    expect(s.ok).toBe(true);
    expect(s.isVfr).toBe(true);
    expect(s.minFps).toBeCloseTo(5, 6);
    expect(s.maxFps).toBeCloseTo(200, 6);
    expect(s.frames).toBe(820);
  });

  it('is not ok for a file error, keeping the message', async () => {
    const s = summarize(await run('corrupt_png_named.mp4'));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/not a recognised container/);
    expect(s.fps).toBeNull();
    expect(s.frames).toBeNull();
  });

  it('is not ok for a file without a video track', async () => {
    const s = summarize(await run('audio_only_aac.mp4'));
    expect(s.ok).toBe(false);
    expect(s.error).toBe('no video track');
    expect(s.durationSec).toBeGreaterThan(0);
  });

  it('is not ok for a video track without a frame rate, and marks estimated rates as approximate', () => {
    const base: FileResult = { name: 'x.mp4', size: 1, ...emptyAnalysis('mp4'), io: { reads: 0, bytesRead: 0, ms: 0 }, engine: 'rvfc' };
    const track = emptyTrack(1);
    const noRate = summarize({ ...base, videoTracks: [track], primaryTrackId: 1 });
    expect(noRate).toMatchObject({ ok: false, error: 'no frame rate', approximate: false });
    const estimated = { ...track, avgFps: { num: 25, den: 1, value: 25 }, provenance: { avgFps: 'estimated' as const } };
    const s = summarize({ ...base, videoTracks: [estimated], primaryTrackId: 1, warnings: ['file'] });
    expect(s).toMatchObject({ ok: true, fps: 25, fpsRational: '25/1', approximate: true, engine: 'rvfc', warnings: ['file'] });
  });
});
