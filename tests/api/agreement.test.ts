import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareResults } from '../../src/api/agreement.ts';
import { analyze } from '../../src/core/analyze.ts';
import { emptyAnalysis, emptyTrack } from '../../src/core/result.ts';
import type { EngineId, FileResult, Provenance, Rational, VideoTrackResult } from '../../src/core/types.ts';
import { analyzeWithMediabunny } from '../../src/engines/mediabunny.ts';
import { analyzeWithMp4box } from '../../src/engines/mp4box.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

const r = (num: number, den: number): Rational => ({ num, den, value: num / den });

function result(engine: EngineId, track: Partial<VideoTrackResult>, extra: Partial<FileResult> = {}): FileResult {
  const t = { ...emptyTrack(1), ...track };
  return { name: 'a.mp4', size: 1, ...emptyAnalysis('mp4'), io: { reads: 0, bytesRead: 0, ms: 0 }, engine, videoTracks: [t], primaryTrackId: 1, ...extra };
}

const base = {
  avgFps: r(30000, 1001),
  nominalFps: { ...r(30000, 1001), kind: 'exact' as const },
  minFps: r(30000, 1001),
  maxFps: r(30000, 1001),
  frames: 300,
  presentedFrames: 300,
  durationSec: 10.01,
};
const field = (a: ReturnType<typeof compareResults>, name: string) => a.fields.find((f) => f.field === name)!;

describe('compareResults', () => {
  it('agrees on identical primary tracks and uses own as the default reference', () => {
    const a = compareResults({ mp4box: result('mp4box', base), own: result('own', base) });
    expect(a.reference).toBe('own');
    expect([...a.engines].sort()).toEqual(['mp4box', 'own']);
    expect(a.agree).toBe(true);
    expect(a.fields.map((f) => f.field)).toEqual(['avgFps', 'nominalFps', 'minFps', 'maxFps', 'frames', 'durationSec']);
    expect(a.fields.every((f) => f.agree === true && f.differ.length === 0)).toBe(true);
  });

  it('compares rationals exactly after reduction', () => {
    const reduced = compareResults({ own: result('own', base), mp4box: result('mp4box', { ...base, avgFps: r(60000, 2002) }) });
    expect(field(reduced, 'avgFps').agree).toBe(true);
    const close = compareResults({ own: result('own', base), mp4box: result('mp4box', { ...base, avgFps: r(2997, 100) }) });
    expect(field(close, 'avgFps')).toMatchObject({ agree: false, differ: ['mp4box'] });
    expect(close.agree).toBe(false);
  });

  it('allows 0.003 relative only when a side is estimated or sampled', () => {
    for (const p of ['estimated', 'sampled'] as Provenance[]) {
      const rvfc = result('rvfc', { ...base, avgFps: r(29970, 1000), provenance: { avgFps: p } });
      expect(field(compareResults({ own: result('own', base), rvfc }), 'avgFps').agree).toBe(true);
    }
    const snapped = result('rvfc', { ...base, avgFps: r(30, 1), provenance: { avgFps: 'estimated' } });
    expect(field(compareResults({ own: result('own', base), rvfc: snapped }), 'avgFps').agree).toBe(true);
    const tooFar = result('rvfc', { ...base, avgFps: r(3010, 100), provenance: { avgFps: 'estimated' } });
    expect(field(compareResults({ own: result('own', base), rvfc: tooFar }), 'avgFps').agree).toBe(false);
    const exactSides = result('mp4box', { ...base, avgFps: r(29970, 1000), provenance: { avgFps: 'exact' } });
    expect(field(compareResults({ own: result('own', base), mp4box: exactSides }), 'avgFps').agree).toBe(false);
  });

  it('compares presented frames, falling back to frames, exactly', () => {
    const fallback = result('mp4box', { ...base, presentedFrames: null, frames: 300 });
    expect(field(compareResults({ own: result('own', { ...base, frames: 302 }), mp4box: fallback }), 'frames').agree).toBe(true);
    const off = result('mp4box', { ...base, presentedFrames: 299 });
    expect(field(compareResults({ own: result('own', base), mp4box: off }), 'frames').agree).toBe(false);
  });

  it('compares durations within 1e-6 s', () => {
    const near = result('mp4box', { ...base, durationSec: 10.01 + 5e-7 });
    expect(field(compareResults({ own: result('own', base), mp4box: near }), 'durationSec').agree).toBe(true);
    const far = result('mp4box', { ...base, durationSec: 10.01 + 2e-6 });
    expect(field(compareResults({ own: result('own', base), mp4box: far }), 'durationSec').agree).toBe(false);
  });

  it('skips missing values instead of counting them as disagreement', () => {
    const partial = result('mediabunny', { ...base, nominalFps: null, minFps: null, maxFps: null });
    const a = compareResults({ own: result('own', base), mediabunny: partial });
    expect(field(a, 'nominalFps')).toMatchObject({ agree: null, differ: [], values: { mediabunny: null } });
    expect(a.agree).toBe(true);
  });

  it('looks only at the primary track', () => {
    const second = { ...emptyTrack(2), avgFps: r(1, 1), frames: 1 };
    const own = result('own', base);
    const other = result('mp4box', base);
    other.videoTracks = [...other.videoTracks, second];
    expect(compareResults({ own, mp4box: other }).agree).toBe(true);
    expect(compareResults({ own, mp4box: { ...other, primaryTrackId: 2 } }).agree).toBe(false);
  });

  it('leaves out results with an error or no primary track, and honours an explicit reference', () => {
    const failed = result('mp4box', base, { error: 'boom' });
    const empty = result('mediabunny', base, { primaryTrackId: null });
    const a = compareResults({ own: result('own', base), mp4box: failed, mediabunny: empty });
    expect(a.engines).toEqual(['own']);
    expect(a.agree).toBeNull();
    expect(compareResults({ own: result('own', base), mp4box: result('mp4box', base) }, 'mp4box').reference).toBe('mp4box');
    const missingRef = compareResults<EngineId>({ own: result('own', base) }, 'rvfc');
    expect(missingRef.reference).toBeNull();
    expect(missingRef.agree).toBeNull();
    expect(compareResults({ mediabunny: result('mediabunny', base), mp4box: result('mp4box', base) }).reference).toBe('mediabunny');
    expect(compareResults({}).reference).toBeNull();
  });

  it('agrees for own, mp4box and mediabunny on a plain CFR MP4', async () => {
    const name = 'cfr_h264_30.mp4';
    const blob = await openAsBlob(join(FILES_DIR, name));
    const a = compareResults({ own: await analyze(blob, name), mp4box: await analyzeWithMp4box(blob, name), mediabunny: await analyzeWithMediabunny(blob, name) });
    expect([...a.engines].sort()).toEqual(['mediabunny', 'mp4box', 'own']);
    expect(field(a, 'avgFps').agree).toBe(true);
    expect(field(a, 'frames').agree).toBe(true);
  });
});
