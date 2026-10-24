import { describe, expect, it } from 'vitest';
import { probeFullBlock, staleBenchChunks, withinTolText } from '../../scripts/readme-tables.ts';

type Inputs = Parameters<typeof staleBenchChunks>[0];

function inputs(build: Array<{ file: string; hash?: string }>, fetched: Array<{ path: string; hash?: string | null }>): Inputs {
  return {
    size: { budgets: [], composites: {}, chunks: build.map((c) => ({ kind: 'lazy', raw: 1, gzip: 1, brotli: 1, ...c })) },
    bench: { chrome: { coldFirst: [{ name: 'a.mp4', label: 'MP4', coldWallMs: 1, warmWallMs: 1, chunks: fetched.map((k) => ({ bytes: 1, ...k })) }] } },
  } as unknown as Inputs;
}

describe('readme-tables staleBenchChunks', () => {
  it('keeps a fetched chunk whose content hash is in the build, under another file name', () => {
    expect(staleBenchChunks(inputs([{ file: 'assets/isobmff-NEWNAME1.js', hash: 'aaaa' }], [{ path: '/assets/isobmff-OLDNAME1.js', hash: 'aaaa' }]))).toEqual([]);
  });

  it('marks a fetched chunk whose content hash is not in the build, even when its file name is', () => {
    expect(staleBenchChunks(inputs([{ file: 'assets/isobmff-SAMENAME.js', hash: 'bbbb' }], [{ path: '/assets/isobmff-SAMENAME.js', hash: 'aaaa' }]))).toEqual(['isobmff-SAMENAME.js']);
  });

  it('falls back to the file name for a report without hashes', () => {
    const build = [{ file: 'assets/isobmff-SAMENAME.js', hash: 'bbbb' }];
    expect(staleBenchChunks(inputs(build, [{ path: '/assets/isobmff-SAMENAME.js' }]))).toEqual([]);
    expect(staleBenchChunks(inputs(build, [{ path: '/assets/isobmff-OLDNAME1.js', hash: null }]))).toEqual(['isobmff-OLDNAME1.js']);
  });

  it('lists each stale chunk once', () => {
    const fetched = [
      { path: '/assets/main-OLDNAME1.js', hash: 'cccc' },
      { path: '/assets/main-OLDNAME1.js', hash: 'cccc' },
    ];
    expect(staleBenchChunks(inputs([{ file: 'assets/main-NEWNAME1.js', hash: 'dddd' }], fetched))).toEqual(['main-OLDNAME1.js']);
  });
});

describe('readme-tables withinTolText', () => {
  type Checks = Parameters<typeof withinTolText>[0];
  const check = (verdict: string, detail: string | null) => ({ id: 'avgFps.measured', field: 'avgFps', verdict, app: null, ffprobe: null, detail });

  it('names the within-tolerance checks that are a definition difference by design', () => {
    const checks = [check('within-tol', 'definition difference by design: the file stores no last frame duration'), check('within-tol', 'spans differ by 499 ticks'), check('exact', null)] as Checks;
    expect(withinTolText(checks)).toMatch(/^2 within tolerance \(1 of them a definition difference by design: /);
  });

  it('adds nothing when no check is a definition difference by design', () => {
    expect(withinTolText([check('within-tol', 'spans differ by 499 ticks')] as Checks)).toBe('1 within tolerance');
  });
});

describe('readme-tables probeFullBlock', () => {
  type ProbeInputs = Parameters<typeof probeFullBlock>[0];
  const fixture = (name: string, avg: string, vfr: string) => ({
    name,
    category: 'vfr',
    tracks: [{ trackId: 1, refIndex: 0, primary: true, checks: [{ id: 'avgFps', field: 'avgFps', verdict: 'exact', app: avg, ffprobe: null }, { id: 'isVfr', field: 'isVfr', verdict: 'exact', app: vfr, ffprobe: null }] }],
  });
  const arms = (probe: ReturnType<typeof fixture>[], full: ReturnType<typeof fixture>[]) =>
    ({
      acc: { engines: [{ engine: 'mediabunny-idiomatic', loadSkipped: null, fixtures: probe }, { engine: 'mediabunny-full', loadSkipped: null, fixtures: full }] },
      manifest: [{ name: 'a.mp4', committed: true }, { name: 'b.mp4', committed: false }, { name: 'late_x.mp4', committed: true }],
    }) as unknown as ProbeInputs;

  it('lists the fixtures whose probe and full scan rates differ, without the late-change files', () => {
    const lines = probeFullBlock(arms([fixture('a.mp4', '30/1', 'false'), fixture('b.mp4', '25/1', 'true'), fixture('late_x.mp4', '30/1', 'false')], [fixture('a.mp4', '60/1', 'true'), fixture('b.mp4', '25/1', 'true'), fixture('late_x.mp4', '60/1', 'true')]));
    expect(lines).toEqual(['- `a.mp4`: average 30/1 (30.000) from the probe, 60/1 (60.000) from the full scan; VFR flag false from the probe, true from the full scan.']);
  });

  it('says so when they agree everywhere', () => {
    expect(probeFullBlock(arms([fixture('a.mp4', '30/1', 'false')], [fixture('a.mp4', '30/1 (exact)', 'false')]))).toEqual(['- None: the probe and the full scan agree on every other fixture.']);
  });
});
