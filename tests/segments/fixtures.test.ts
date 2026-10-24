import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/analyze.ts';
import { primaryTrack } from '../../src/core/result.ts';
import type { MatroskaMode, RateProfile, VideoTrackResult } from '../../src/core/types.ts';
import { LARGE_DIR, fixturePath, loadManifest } from '../helpers/fixtures.ts';
import { withFixture } from '../helpers/open-blob.ts';

async function track(name: string, matroskaMode: MatroskaMode = 'exact'): Promise<VideoTrackResult> {
  const path = fixturePath(name);
  if (!path) throw new Error(`fixture missing: ${name}`);
  const r = await withFixture(path, (blob) => analyze(blob, name, { matroskaMode }));
  expect(r.error).toBeNull();
  const t = primaryTrack(r);
  expect(t).not.toBeNull();
  return t!;
}

async function profile(name: string): Promise<{ t: VideoTrackResult; p: RateProfile }> {
  const t = await track(name);
  expect(t.rateProfile, name).toBeTruthy();
  return { t, p: t.rateProfile! };
}

function checkTiling(t: VideoTrackResult, p: RateProfile): void {
  expect(p.moreSegments).toBe(0);
  expect(p.segments.reduce((n, s) => n + s.frames, 0)).toBe(t.presentedFrames);
  expect(p.segments[0].startSec).toBe(0);
  for (let i = 1; i < p.segments.length; i++) expect(p.segments[i].startSec).toBeCloseTo(p.segments[i - 1].endSec, 9);
}

const manifest = loadManifest();
const okRows = manifest.filter((r) => r.committed && r.expect === 'ok');

describe('rate profile on fixtures', () => {
  it.each(['vfr_concat_10_30_60.mp4', 'vfr_concat_10_30_60.mov', 'vfr_concat_10_30_60.webm', 'vfr_concat_10_30_60_ts1M.mp4', 'vfr_concat_10_30_60_fmp4.mp4', 'vfr_concat_bframes.mp4'])(
    '%s: three 2 s steady segments at 10/30/60 fps with two rate changes',
    async (name) => {
      const { t, p } = await profile(name);
      checkTiling(t, p);
      expect(p.segments.map((s) => s.kind)).toEqual(['steady', 'steady', 'steady']);
      p.segments.forEach((s, i) => {
        expect(s.fps / [10, 30, 60][i]).toBeCloseTo(1, 2);
        expect(s.endSec - s.startSec).toBeCloseTo(2, 1);
      });
      expect(p.anomalies.map((a) => a.kind)).toEqual(['rate-change', 'rate-change']);
      expect(p.anomalies[0].atSec).toBeCloseTo(2, 1);
      expect(p.anomalies[1].atSec).toBeCloseTo(4, 1);
      expect(p.uneven).toBe(true);
      expect(t.isVfr).toBe(true);
    },
  );

  it.each(['vfr_two_phase_5_200.mp4', 'vfr_two_phase_5_200.webm', 'vfr_two_phase_5_200.mkv'])('%s: 4 s at 5 fps then 4 s at 200 fps, uneven', async (name) => {
    const { t, p } = await profile(name);
    checkTiling(t, p);
    expect(p.segments.map((s) => [s.kind, s.frames, Math.round(s.fps)])).toEqual([
      ['steady', 20, 5],
      ['steady', 800, 200],
    ]);
    expect(p.segments[1].startSec).toBeCloseTo(4, 2);
    expect(p.segments[1].endSec).toBeCloseTo(8, 2);
    expect(p.anomalies).toHaveLength(1);
    expect(p.anomalies[0]).toMatchObject({ kind: 'rate-change', fromFps: 5, toFps: 200 });
    expect(p.anomalies[0].atSec).toBeCloseTo(4, 2);
    expect(p.uneven).toBe(true);
    expect(p.dominantShare).toBeCloseTo(0.5, 2);
    expect(p.summary).toBe('Uneven: 5 fps for 4 s, 200 fps for 4 s');
  });

  it('vfr_freeze_2s.mp4: one 2 s freeze inside a 30 fps stream', async () => {
    const { t, p } = await profile('vfr_freeze_2s.mp4');
    checkTiling(t, p);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ kind: 'steady', fps: 30, frames: 120 });
    expect(p.anomalies).toHaveLength(1);
    expect(p.anomalies[0].kind).toBe('freeze');
    expect(p.anomalies[0].atSec).toBeCloseTo(59 / 30, 6);
    expect(p.anomalies[0].durationSec).toBeCloseTo(2, 6);
    expect(p.uneven).toBe(true);
    expect(p.summary).toMatch(/; 1 freeze$/);
  });

  it.each([
    ['late_30_to_60.mp4', 6000, 30, 1200, 60, 200],
    ['late_25_to_12.5.webm', 5500, 25, 500, 12.5, 220],
  ] as const)('%s: a rate change after more than 5000 constant frames', async (name, firstFrames, firstFps, lastFrames, lastFps, atSec) => {
    const { t, p } = await profile(name);
    checkTiling(t, p);
    expect(p.segments.map((s) => [s.kind, s.frames, s.fps])).toEqual([
      ['steady', firstFrames, firstFps],
      ['steady', lastFrames, lastFps],
    ]);
    expect(p.anomalies).toHaveLength(1);
    expect(p.anomalies[0]).toMatchObject({ kind: 'rate-change', fromFps: firstFps, toFps: lastFps });
    expect(p.anomalies[0].atSec).toBeCloseTo(atSec, 6);
    expect(p.uneven).toBe(true);
    expect(t.isVfr).toBe(true);
  });

  it('late_freeze_10s.mkv: one 10.04 s freeze after 5999 frames at 25 fps', async () => {
    const { t, p } = await profile('late_freeze_10s.mkv');
    checkTiling(t, p);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ kind: 'steady', fps: 25, frames: 6250 });
    expect(p.anomalies).toHaveLength(1);
    expect(p.anomalies[0].kind).toBe('freeze');
    expect(p.anomalies[0].atSec).toBeCloseTo(239.96, 6);
    expect(p.anomalies[0].durationSec).toBeCloseTo(10.04, 6);
    expect(t.isVfr).toBe(true);
    expect(p.summary).toMatch(/; 1 freeze$/);
  });

  it('every MediaRecorder recording shows the pacing it was recorded with: rAF, a 0.6 s freeze, a 15 fps timer, rAF', async () => {
    const recordings = okRows.filter((r) => r.category === 'recorder').map((r) => r.name);
    expect(recordings.length).toBeGreaterThanOrEqual(12);
    for (const name of recordings) {
      const { t, p } = await profile(name);
      checkTiling(t, p);
      expect(t.isVfr, name).toBe(true);
      expect(p.segments.map((s) => s.kind), name).toEqual(['steady', 'steady', 'steady']);
      p.segments.forEach((s, i) => expect(Math.abs(s.fps - [60, 15, 60][i]), `${name} segment ${i}`).toBeLessThan(1.5));
      const freezes = p.anomalies.filter((a) => a.kind === 'freeze');
      expect(freezes, name).toHaveLength(1);
      expect(Math.abs(freezes[0].atSec - 1.5), name).toBeLessThan(0.1);
      expect(Math.abs((freezes[0].durationSec ?? 0) - 0.69), name).toBeLessThan(0.1);
      expect(p.anomalies.filter((a) => a.kind === 'rate-change').map((a) => Math.round(a.atSec * 10) / 10), name).toEqual([1.5, 3.6]);
    }
  });

  it('vfr_mpdecimate.mp4 and the screen recordings report their stalls instead of extra segments', async () => {
    const mp = await profile('vfr_mpdecimate.mp4');
    expect(mp.p.segments).toHaveLength(1);
    expect(mp.p.anomalies.map((a) => a.kind)).toEqual(['freeze']);
    for (const name of ['vfr_screenrec_ts1000.mp4', 'vfr_screenrec_ts1000.webm']) {
      const { t, p } = await profile(name);
      checkTiling(t, p);
      expect(p.segments.map((s) => [s.kind, Math.round(s.fps)])).toEqual([['steady', 60]]);
      expect(p.anomalies.map((a) => a.kind)).toEqual(['gap', 'gap']);
      expect(p.uneven).toBe(true);
    }
  });

  it('cadence VFR (2:3 pulldown, periodic drops) is one steady segment at the average rate', async () => {
    for (const [name, fps] of [
      ['vfr_pulldown_2_3.mp4', 24],
      ['vfr_select_drop.mp4', 36],
    ] as const) {
      const { t, p } = await profile(name);
      expect(t.isVfr).toBe(true);
      expect(p.segments).toHaveLength(1);
      expect(Math.round(p.segments[0].fps)).toBe(fps);
      expect(p.anomalies).toEqual([]);
      expect(p.uneven).toBe(false);
    }
  });

  it('a CFR fixture has no rate profile, also when its 1 ms ticks spread more than the drift', async () => {
    const rows = okRows.filter((r) => r.name.startsWith('cfr_'));
    expect(rows.length).toBe(21);
    const profiled: string[] = [];
    for (const row of rows) {
      const t = await track(row.name);
      const p = t.rateProfile ?? null;
      if (!p) continue;
      profiled.push(row.name);
      expect(p.segments, row.name).toHaveLength(1);
      expect(p.segments[0].kind).toBe('steady');
      expect(p.segments[0].frames).toBe(t.presentedFrames);
      expect(p.segments[0].endSec / (t.durationSec ?? NaN)).toBeCloseTo(1, 3);
      expect(p.anomalies).toEqual([]);
      expect(p.uneven).toBe(false);
      expect(p.dominantShare).toBe(1);
      expect(p.summary).toMatch(/^Steady: /);
    }
    expect(profiled).toEqual([]);
  });

  it('every VFR fixture has a profile, every fixture the VFR rule calls CFR has none or one steady segment, and every profile tiles the frames', async () => {
    let vfr = 0;
    let cfr = 0;
    for (const row of okRows) {
      const t = await track(row.name);
      const p = t.rateProfile ?? null;
      if (t.isStill || t.presentedFrames === null || t.presentedFrames < 2) {
        expect(p, row.name).toBeNull();
        continue;
      }
      if (t.isVfr) {
        expect(p, row.name).not.toBeNull();
        vfr++;
      }
      if (!p) continue;
      checkTiling(t, p);
      if (t.isVfr === false) {
        expect(p.segments.map((s) => s.kind), row.name).toEqual(['steady']);
        expect(p.anomalies, row.name).toEqual([]);
        cfr++;
      }
    }
    expect(vfr).toBe(37);
    expect(cfr).toBe(0);
  });

  it('Matroska shows a profile only after an exact scan', async () => {
    for (const mode of ['header', 'probe'] as const) {
      const t = await track('vfr_two_phase_5_200.webm', mode);
      expect(t.rateProfile ?? null).toBeNull();
    }
    expect((await track('vfr_two_phase_5_200.webm', 'auto')).rateProfile?.uneven).toBe(true);
  });

  it.skipIf(!existsSync(LARGE_DIR) || !fixturePath('long_cfr_3h_60fps.mp4'))('long_cfr_3h_60fps.mp4: no rate profile and no extra work on the fast path', async () => {
    const t0 = performance.now();
    const t = await track('long_cfr_3h_60fps.mp4');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(t.presentedFrames).toBe(648000);
    expect(t.rateProfile ?? null).toBeNull();
  });

  it.skipIf(!existsSync(LARGE_DIR) || !fixturePath('long_vfr_1h_screenrec.mp4'))('long_vfr_1h_screenrec.mp4: 60 fps with periodic gaps', async () => {
    const { t, p } = await profile('long_vfr_1h_screenrec.mp4');
    checkTiling(t, p);
    expect(Math.round(p.segments[0].fps)).toBe(60);
    expect(p.uneven).toBe(true);
    expect(p.anomalies.length + p.moreAnomalies).toBeGreaterThan(1000);
  });
});
