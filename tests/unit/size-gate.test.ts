import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REPO_ROOT } from '../helpers/fixtures.ts';

interface Matrix {
  fixtures: { name: string; metrics: Record<string, number | null> }[];
  standalone: { file: string; gzip: number }[];
}

const GATE = join(REPO_ROOT, 'scripts', 'size-gate.mjs');
const BASELINE = join(REPO_ROOT, 'fixtures', 'snapshots', 'size-matrix-v0.3.0.json');
let dir = '';

function run(args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function raised(name: string, edit: (m: Matrix) => void): string {
  const m = JSON.parse(readFileSync(BASELINE, 'utf8')) as Matrix;
  edit(m);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(m));
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

  test('the baseline is the 0.3.0 report byte for byte', () => {
    const show = spawnSync('git', ['show', 'v0.3.0:report/size-matrix.json'], { cwd: REPO_ROOT, encoding: 'buffer' });
    if (show.status !== 0) return;
    expect(Buffer.compare(show.stdout, readFileSync(BASELINE))).toBe(0);
  });

  test('passes the committed report', () => {
    const r = run([]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/size gate: 33 rows within the stage \d allowances and caps/);
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

  test('fails a row above its absolute cap', () => {
    const r = run(['--report', raised('cap.json', (m) => metric(m, 'standalone-split-url', 'firstMp4', 454)), '--stage', '6']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone-split-url:firstMp4: 24,951 B is above its cap of 24,950 B');
  });

  test('fails a standalone worker file above its share', () => {
    const r = run(['--report', raised('worker.json', (m) => (m.standalone.find((s) => s.file === 'own-isobmff.worker.js')!.gzip += 1))]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone:own-isobmff.worker.js: 21,144 B is 1 B above the 0.3.0 baseline of 21,143 B');
  });

  test('lets only the rule entries move their critical path in stage 6', () => {
    const check = run(['--report', raised('check.json', (m) => metric(m, 'check', 'trigger', 50)), '--stage', '6']);
    expect(check.status, check.err).toBe(0);
    const host = run(['--report', raised('host.json', (m) => metric(m, 'default', 'trigger', 1)), '--stage', '6']);
    expect(host.status).toBe(1);
    expect(host.err).toContain('default:trigger: 667 B is 1 B above the 0.3.0 baseline of 666 B, stage 6 allows 0 B');
  });
});
