import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffReports, outsidePeers, readSmoke, renderSummary, satisfies, type SmokeRun } from '../../scripts/canary-summary.mjs';

const run = (engine: SmokeRun['engine'], outcome: SmokeRun['outcome'], detail: string | null = null, browser = 'chromium'): SmokeRun => ({ browser, fixture: 'all', mode: 'build', file: 'cfr_h264_29.97.mp4', engine, outcome, detail });

const check = (id: string, verdict: string, app: string, trackId: number | null = null) => ({ id, sub: null, trackId, verdict, app });
const fixture = (name: string, checks: ReturnType<typeof check>[], tracks: ReturnType<typeof check>[] = []) => ({ name, appError: null, threw: null, fileChecks: checks, tracks: [{ checks: tracks }] });
const engine = (name: string, version: string | null, fixtures: ReturnType<typeof fixture>[]) => ({ engine: name, arm: { version }, loadSkipped: null, fixtures });
const report = (...engines: ReturnType<typeof engine>[]) => ({ engines });

const committed = report(
  engine('own', null, [fixture('a.mp4', [check('error', 'exact', 'ok')], [check('avgFps', 'exact', '30/1', 1)]), fixture('large.mp4', [check('error', 'exact', 'ok')])]),
  engine('mp4box-tuned', '2.4.1', [fixture('a.mp4', [check('error', 'exact', 'ok')], [check('frames', 'mismatch', '10', 1), check('frames', 'exact', '20', 2)])]),
);

describe('canary summary', () => {
  it('passes when only a library arm changed, on the fixtures both runs have', () => {
    const measured = report(
      engine('own', null, [fixture('a.mp4', [check('error', 'exact', 'ok')], [check('avgFps', 'exact', '30/1', 1)])]),
      engine('mp4box-tuned', '2.5.0', [fixture('a.mp4', [check('error', 'exact', 'ok')], [check('frames', 'exact', '11', 1), check('frames', 'exact', '20', 2)])]),
    );
    const arms = diffReports(committed, measured);
    expect(arms.map((a) => [a.engine, a.compared, a.changed.length])).toEqual([
      ['own', 1, 0],
      ['mp4box-tuned', 1, 1],
    ]);
    expect(arms[1]!.changed[0]!.checks).toEqual([{ check: '1.frames', before: 'mismatch: 10', after: 'exact: 11' }]);
    expect(arms[1]!.counts).toEqual({ before: { exact: 2, 'within-tol': 0, 'known-deviation': 0, mismatch: 1, 'n/a': 0 }, after: { exact: 3, 'within-tol': 0, 'known-deviation': 0, mismatch: 0, 'n/a': 0 } });
    const { markdown, ownChanged } = renderSummary(arms, { versions: { vite: '9.0.0', rolldown: '2.0.0', mp4box: '2.5.0', mediabunny: '1.63.0' }, failures: [] });
    expect(ownChanged).toBe(false);
    expect(markdown).toContain('The own engine is unchanged.');
    expect(markdown).toContain('| mp4box-tuned | 2.4.1 → 2.5.0 | 2 → 3 | 0 | 0 | 1 → 0 | 0 | 1 |');
    expect(markdown).toContain('- `a.mp4` 1.frames: mismatch: 10 → exact: 11');
    expect(markdown).toContain('Vite 9.0.0, rolldown 2.0.0, mp4box 2.5.0 and mediabunny 1.63.0: every size budget and check passes.');
  });

  it('fails when a check of the own engine changed', () => {
    const measured = report(engine('own', null, [fixture('a.mp4', [check('error', 'exact', 'ok')], [check('avgFps', 'within-tol', '30000/1001', 1)])]));
    const { markdown, ownChanged } = renderSummary(diffReports(committed, measured), { failures: ['default client: over (3.60 KB > 3.50 KB)'] });
    expect(ownChanged).toBe(true);
    expect(markdown).toContain('**The own engine changed: the canary fails.**');
    expect(markdown).toContain('- default client: over (3.60 KB > 3.50 KB)');
  });

  it('names a latest peer outside the peer range of the package', () => {
    expect(['2.4.1', '2.9.0', '3.0.0', '2.4.0', '2.5.0-beta.1'].map((v) => satisfies(v, '^2.4.1'))).toEqual([true, true, false, false, false]);
    expect(['18.3.1', '19.2.0', '17.0.2', '20.0.0'].map((v) => satisfies(v, '^18.0.0 || ^19.0.0'))).toEqual([true, true, false, false]);
    expect(['0.4.2', '0.5.0'].map((v) => satisfies(v, '^0.4.1'))).toEqual([true, false]);
    const peers = { mp4box: '^2.4.1', mediabunny: '^1.62.0', react: '^18.0.0 || ^19.0.0' };
    expect(outsidePeers(peers, { mp4box: '3.0.0', mediabunny: '1.63.0', vite: '9.0.0' })).toEqual(['mp4box 3.0.0 is outside the peer range ^2.4.1 of the package']);
    const { markdown } = renderSummary(diffReports(committed, committed), { versions: { mp4box: '3.0.0' }, failures: [] }, peers);
    expect(markdown).toContain('Installed with --legacy-peer-deps:\n- mp4box 3.0.0 is outside the peer range ^2.4.1 of the package');
  });

  it('lists the library runs of the smoke test that differ from Node and still passes', () => {
    const smoke = [run('mp4box', 'equal'), run('mediabunny', 'differs', 'tracks, warnings'), run('mp4box', 'threw', 'worker-failed | load', 'webkit'), run('mediabunny', 'error', 'no video track')];
    const { markdown, ownChanged } = renderSummary(diffReports(committed, committed), null, {}, smoke);
    expect(ownChanged).toBe(false);
    expect(markdown).toContain('The own engine is unchanged.');
    expect(markdown).toContain('### Library arms in the consumer smoke test');
    expect(markdown).toContain('Informational: the smoke test asserts the own engine only. 1 of 4 runs of mp4box and mediabunny in the browsers equal Node analyze from the same tarball.');
    expect(markdown).toContain('| chromium | all | build | `cfr_h264_29.97.mp4` | mediabunny | differs: tracks, warnings |');
    expect(markdown).toContain('| webkit | all | build | `cfr_h264_29.97.mp4` | mp4box | threw: worker-failed \\| load |');
    expect(markdown).toContain('| chromium | all | build | `cfr_h264_29.97.mp4` | mediabunny | error: no video track |');
    expect(markdown).not.toContain('| mp4box | equal');
  });

  it('fails on an own change even when every library run of the smoke test is equal', () => {
    const measured = report(engine('own', null, [fixture('a.mp4', [check('error', 'mismatch', 'no')], [check('avgFps', 'exact', '30/1', 1)])]));
    const { markdown, ownChanged } = renderSummary(diffReports(committed, measured), null, {}, [run('mp4box', 'equal')]);
    expect(ownChanged).toBe(true);
    expect(markdown).toContain('1 of 1 runs of mp4box and mediabunny in the browsers equal Node analyze from the same tarball.');
    expect(markdown).not.toContain('| Browser |');
  });

  it('reads the smoke reports of a directory, and none from a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'video-fps-probe-smoke-'));
    try {
      writeFileSync(join(dir, 'webkit-all-dev.json'), JSON.stringify([run('mp4box', 'differs', 'tracks', 'webkit')]));
      writeFileSync(join(dir, 'chromium-all-build.json'), JSON.stringify([run('mp4box', 'equal'), run('mediabunny', 'equal')]));
      writeFileSync(join(dir, 'notes.txt'), 'not a report');
      expect(readSmoke(dir).map((r) => `${r.browser} ${r.engine} ${r.outcome}`)).toEqual(['chromium mp4box equal', 'chromium mediabunny equal', 'webkit mp4box differs']);
      expect(readSmoke(join(dir, 'missing'))).toEqual([]);
      expect(renderSummary(diffReports(committed, committed), null, {}, []).markdown).toContain('The consumer smoke test recorded no run of mp4box or mediabunny.');
      expect(renderSummary(diffReports(committed, committed)).markdown).not.toContain('smoke test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps two checks of one field on one track apart', () => {
    const twice = report(engine('own', null, [fixture('a.mp4', [check('error', 'exact', 'ok'), check('error', 'exact', 'ok')])]));
    const changed = report(engine('own', null, [fixture('a.mp4', [check('error', 'exact', 'ok'), check('error', 'mismatch', 'no')])]));
    expect(diffReports(twice, changed)[0]!.changed[0]!.checks).toEqual([{ check: 'file.error#2', before: 'exact: ok', after: 'mismatch: no' }]);
  });
});
