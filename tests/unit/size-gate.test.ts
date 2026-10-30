import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REPO_ROOT } from '../helpers/fixtures.ts';

interface Matrix {
  fixtures: { name: string; metrics: Record<string, number | null>; budgets?: { key: string; limit: number }[] }[];
  standalone: { file: string; gzip: number; limit?: number }[];
}

interface Group {
  name: string;
  rows: string[];
  growth: Record<string, number | null>;
  cap: number | null | Record<string, number>;
}

interface GateConfig {
  baselineSha256: string;
  stageBase: string;
  stageBaseSha256: string;
  stage: number;
  groups: Group[];
  [key: string]: unknown;
}

const BASELINE_SHA256 = '1b6c24749acae07a3fea4b2477d8c88517d303c617f629c6c3f8b179db6f5fe2';
const GATE = join(REPO_ROOT, 'scripts', 'size-gate.mjs');
const CONFIG = join(REPO_ROOT, 'scripts', 'size-gate.json');
const BASELINE = join(REPO_ROOT, 'fixtures', 'snapshots', 'size-matrix-v0.3.0.json');
const hasTag = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'v0.3.0^{commit}'], { cwd: REPO_ROOT }).status === 0;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let dir = '';

function run(args: string[], cwd = REPO_ROOT): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function raised(name: string, edit: (m: Matrix) => void): string {
  const m = JSON.parse(readFileSync(BASELINE, 'utf8')) as Matrix;
  edit(m);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(m));
  return path;
}

function configWith(name: string, edit: (c: GateConfig) => void, stageBase?: string): string {
  const c = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
  if (stageBase) {
    c.stageBase = stageBase;
    c.stageBaseSha256 = sha256(readFileSync(stageBase));
  }
  edit(c);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(c));
  return path;
}

const metric = (m: Matrix, config: string, key: string, by: number) => {
  const f = m.fixtures.find((x) => x.name === config)!;
  f.metrics[key] = (f.metrics[key] ?? 0) + by;
};

describe('size gate against the 0.3.0 baseline', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(process.env.FPS_PROBE_SCRATCH ?? tmpdir(), 'fps-probe-size-gate-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the baseline is the pinned 0.3.0 report', () => {
    expect(sha256(readFileSync(BASELINE))).toBe(BASELINE_SHA256);
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
    expect(config.baselineSha256).toBe(BASELINE_SHA256);
  });

  test.skipIf(!hasTag)('the baseline is the report of tag v0.3.0 byte for byte', () => {
    const show = spawnSync('git', ['show', 'v0.3.0:report/size-matrix.json'], { cwd: REPO_ROOT, encoding: 'buffer' });
    expect(show.status).toBe(0);
    expect(Buffer.compare(show.stdout, readFileSync(BASELINE))).toBe(0);
  });

  test('every pinned cap is at most the 0.3.0 budget of its row', () => {
    const m = JSON.parse(readFileSync(BASELINE, 'utf8')) as Matrix;
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
    for (const g of config.groups) {
      for (const row of g.rows) {
        const cap = g.cap === null || typeof g.cap === 'number' ? g.cap : g.cap[row];
        const at = row.indexOf(':');
        const [name, key] = [row.slice(0, at), row.slice(at + 1)];
        const budget = name === 'standalone' ? m.standalone.find((s) => s.file === key)?.limit : m.fixtures.find((f) => f.name === name)?.budgets?.find((b) => b.key === key)?.limit;
        if (cap === null) expect(budget, row).toBeUndefined();
        else if (budget !== undefined) expect(cap, row).toBeLessThanOrEqual(budget);
      }
    }
  });

  test('passes the committed report', () => {
    const r = run([]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/size gate: 44 gated rows within the stage \d allowances, shares and caps/);
  });

  test('fails a baseline that is not the pinned snapshot', () => {
    const r = run(['--baseline', raised('edited-baseline.json', (m) => metric(m, 'custom', 'firstMp4', 300))]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('the configuration pins 1b6c2474');
    expect(r.err).toContain('nothing was gated');
  });

  test('fails a first MP4 row one byte above its stage 1 share', () => {
    const r = run(['--report', raised('one-byte.json', (m) => metric(m, 'zero-config', 'firstMp4', 1)), '--stage', '1']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('zero-config:firstMp4: 24,473 B is 1 B above the 0.3.0 baseline of 24,472 B, stage 1 allows 0 B');
  });

  test('applies the cumulative share of a later stage', () => {
    const at = (by: number) => run(['--report', raised(`share-${by}.json`, (m) => metric(m, 'default', 'firstMp4', by)), '--stage', '2']);
    expect(at(390).status).toBe(0);
    const over = at(391);
    expect(over.status).toBe(1);
    expect(over.err).toContain('default:firstMp4: 23,126 B is 391 B above the 0.3.0 baseline of 22,735 B, stage 2 allows 390 B');
  });

  test('bounds the growth over the stage base by the share of the stage', () => {
    const base = raised('stage-2-end.json', (m) => metric(m, 'zero-config', 'firstMp4', 100));
    const config = configWith('stage-3.json', (c) => (c.stage = 3), base);
    const within = run(['--config', config, '--report', raised('stage-3-ok.json', (m) => metric(m, 'zero-config', 'firstMp4', 110))]);
    expect(within.status, within.err).toBe(0);
    expect(within.out).toMatch(/zero-config:firstMp4 +24,472 +24,572 +24,582 +\+110 +400 +\+10 +10 /);
    const over = run(['--config', config, '--report', raised('stage-3-over.json', (m) => metric(m, 'zero-config', 'firstMp4', 111))]);
    expect(over.status).toBe(1);
    expect(over.err).toContain('zero-config:firstMp4: 24,583 B is 11 B above the stage base of 24,572 B, the share of stage 3 is 10 B');
  });

  test('fails a later stage that spends more than its own share although the cumulative growth fits', () => {
    const base = raised('base-100.json', (m) => {
      for (const c of ['zero-config', 'iife-nosplit', 'standalone-split-url', 'default', 'custom', 'custom-eager']) metric(m, c, 'firstMp4', 100);
    });
    const config = configWith('share-3.json', (c) => (c.stage = 3), base);
    const r = run(['--config', config, '--report', raised('report-390.json', (m) => metric(m, 'default', 'firstMp4', 390))]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('default:firstMp4: 23,125 B is 290 B above the stage base of 22,835 B, the share of stage 3 is 10 B');
    expect(r.err).not.toContain('above the 0.3.0 baseline');
  });

  test('keeps every other row byte-identical in a frozen stage', () => {
    const report = raised('lazy-total.json', (m) => metric(m, 'default', 'lazyTotal', 1));
    const frozen = run(['--report', report, '--stage', '3']);
    expect(frozen.status).toBe(1);
    expect(frozen.err).toContain('default:lazyTotal: measured 89,207 B against 89,206 B in the stage base, and stage 3 keeps every other row byte-identical');
    expect(run(['--report', report, '--stage', '2']).status).toBe(0);
    const matroska = run(['--report', raised('mkv-shrink.json', (m) => metric(m, 'default', 'firstMkv', -1)), '--stage', '3']);
    expect(matroska.status).toBe(1);
    expect(matroska.err).toContain('default:firstMkv: 25,538 B differs from the stage base of 25,539 B by -1 B, and stage 3 keeps it byte-identical');
  });

  test('lets only the rule entries move in stage 6', () => {
    const check = run(['--report', raised('check.json', (m) => {
      metric(m, 'check', 'trigger', 50);
      metric(m, 'preset', 'lazyTotal', 50);
    }), '--stage', '6']);
    expect(check.status, check.err).toBe(0);
    const host = run(['--report', raised('host.json', (m) => metric(m, 'default', 'trigger', 1)), '--stage', '6']);
    expect(host.status).toBe(1);
    expect(host.err).toContain('default:trigger: 667 B differs from the 0.3.0 baseline of 666 B by +1 B, and the group keeps it byte-identical');
    const other = run(['--report', raised('other.json', (m) => metric(m, 'rvfc', 'rvfc', 1)), '--stage', '6']);
    expect(other.status).toBe(1);
    expect(other.err).toContain('rvfc:rvfc: measured 2,194 B against 2,193 B in the stage base, and stage 6 keeps every other row byte-identical');
  });

  test('fails a critical path that shrinks', () => {
    const r = run(['--report', raised('shrink.json', (m) => metric(m, 'default', 'trigger', -5)), '--stage', '2']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('default:trigger: 661 B differs from the 0.3.0 baseline of 666 B by -5 B, and the group keeps it byte-identical');
  });

  test('fails a row above its absolute cap', () => {
    const r = run(['--report', raised('cap.json', (m) => metric(m, 'standalone-split-url', 'firstMp4', 454)), '--stage', '6']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone-split-url:firstMp4: 24,951 B is above its cap of 24,950 B');
  });

  test('gates a growth-only row without a cap', () => {
    const at = (by: number) => run(['--report', raised(`custom-mkv-${by}.json`, (m) => metric(m, 'custom', 'firstMkv', by)), '--stage', '2']);
    expect(at(200).status).toBe(0);
    const over = at(201);
    expect(over.status).toBe(1);
    expect(over.err).toContain('custom:firstMkv: 26,883 B is 201 B above the 0.3.0 baseline of 26,682 B, stage 2 allows 200 B');
  });

  test('fails a standalone worker file above its share', () => {
    const r = run(['--report', raised('worker.json', (m) => (m.standalone.find((s) => s.file === 'own-isobmff.worker.js')!.gzip += 1))]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone:own-isobmff.worker.js: 21,144 B is 1 B above the 0.3.0 baseline of 21,143 B');
  });

  test('fails a gated row that no report has', () => {
    const typo = run(['--config', configWith('typo.json', (c) => (c.groups[2].rows = ['custom:firstMP4', 'custom-eager:firstMp4']))]);
    expect(typo.status).toBe(1);
    expect(typo.err).toContain('custom:firstMP4: not in the baseline report: configuration custom has no metric firstMP4');
    const dropped = run(['--report', raised('dropped.json', (m) => delete m.fixtures.find((f) => f.name === 'custom')!.metrics.firstMp4)]);
    expect(dropped.status).toBe(1);
    expect(dropped.err).toContain('custom:firstMp4: not in the measured report: configuration custom has no metric firstMp4');
  });

  test('resolves command line paths against the working directory', () => {
    raised('relative.json', () => {});
    const r = run(['--report', 'relative.json'], dir);
    expect(r.status, r.err).toBe(0);
  });
});
