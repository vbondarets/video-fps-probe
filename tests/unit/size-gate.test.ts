import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REPO_ROOT } from '../helpers/fixtures.ts';

interface Matrix {
  fixtures: { name: string; metrics: Record<string, number | null>; budgets?: { key: string; limit: number }[]; files?: { file: string; worker: string | null; class: string }[] }[];
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
  report: string;
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
const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' });
const fullHistory = shallow.status === 0 && shallow.stdout.trim() === 'false';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let dir = '';
let configs = 0;

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

function configAt(stage: number, stageBase = BASELINE, edit: (c: GateConfig) => void = () => {}): string {
  const c = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
  c.stage = stage;
  c.stageBase = stageBase;
  c.stageBaseSha256 = sha256(readFileSync(stageBase));
  edit(c);
  const path = join(dir, `config-${++configs}.json`);
  writeFileSync(path, JSON.stringify(c));
  return path;
}

const at = (stage: number, report: string, stageBase = BASELINE) => run(['--config', configAt(stage, stageBase), '--report', report]);

const metric = (m: Matrix, config: string, key: string, by: number) => {
  const f = m.fixtures.find((x) => x.name === config)!;
  f.metrics[key] = (f.metrics[key] ?? 0) + by;
};

const ONE_FILE_ISO_WORKERS = new Set(['own.worker', 'own-isobmff.worker']);
const isoCopies = (f: Matrix['fixtures'][number]) => (f.files ?? []).filter((x) => x.class === 'isobmff' || (x.class === 'shared' && x.worker !== null && ONE_FILE_ISO_WORKERS.has(x.worker))).length;

const isoParser = (m: Matrix, by: number) => {
  for (const f of m.fixtures) {
    for (const key of ['isobmff', 'firstMp4', 'firstMp4Summary', 'allOwn']) if (typeof f.metrics[key] === 'number') f.metrics[key] += by;
    f.metrics.lazyTotal = f.metrics.lazyTotal! + by * isoCopies(f);
    if (f.name === 'standalone-url') f.metrics.firstMkv = f.metrics.firstMkv! + by;
  }
  for (const s of m.standalone) if (s.file !== 'own-matroska.worker.js') s.gzip += by;
};

function committed(rev: string, path: string): Buffer | null {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { cwd: REPO_ROOT, encoding: 'buffer' });
  return r.status === 0 ? r.stdout : null;
}

function stageAt(rev: string): unknown {
  const bytes = committed(rev, 'scripts/size-gate.json');
  return bytes === null ? undefined : (JSON.parse(bytes.toString('utf8')) as GateConfig).stage;
}

function stageBaseCommit(stage: number): string {
  if (stageAt('HEAD') !== stage) return 'HEAD';
  const log = spawnSync('git', ['log', '--format=%H', '--', 'scripts/size-gate.json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const advanced = log.stdout.split('\n').find((sha) => sha !== '' && stageAt(sha) !== stageAt(`${sha}^`));
  if (!advanced) throw new Error('no commit sets the stage of scripts/size-gate.json');
  return `${advanced}^`;
}

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

  test.skipIf(!fullHistory)('the stage base is the report of the commit before the one that last advanced the stage', () => {
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
    const rev = stageBaseCommit(config.stage);
    const report = committed(rev, 'report/size-matrix.json');
    expect(report, `report/size-matrix.json at ${rev}`).not.toBeNull();
    expect(Buffer.compare(report!, readFileSync(join(REPO_ROOT, config.stageBase))), `${config.stageBase} against report/size-matrix.json at ${rev}`).toBe(0);
  });

  test('every pinned cap is at most the budget of its row in the committed report', () => {
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
    const m = JSON.parse(readFileSync(join(REPO_ROOT, config.report), 'utf8')) as Matrix;
    for (const g of config.groups) {
      for (const row of g.rows) {
        const cap = g.cap === null || typeof g.cap === 'number' ? g.cap : g.cap[row];
        const i = row.indexOf(':');
        const [name, key] = [row.slice(0, i), row.slice(i + 1)];
        const budget = name === 'standalone' ? m.standalone.find((s) => s.file === key)?.limit : m.fixtures.find((f) => f.name === name)?.budgets?.find((b) => b.key === key)?.limit;
        if (cap === null) expect(budget, row).toBeUndefined();
        else if (budget !== undefined) expect(cap, row).toBeLessThanOrEqual(budget);
      }
    }
  });

  test('passes the committed report', () => {
    const r = run([]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/size gate: 98 gated rows within the stage \d allowances, shares and caps/);
  });

  test('passes the baseline itself at every stage', () => {
    for (const stage of [1, 2, 3, 4, 5, 6]) {
      const r = at(stage, BASELINE);
      expect(r.status, `stage ${stage}: ${r.err}`).toBe(0);
    }
  });

  test('fails a baseline that is not the pinned snapshot', () => {
    const r = run(['--config', configAt(1), '--baseline', raised('edited-baseline.json', (m) => metric(m, 'custom', 'firstMp4', 300))]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('the configuration pins 1b6c2474');
    expect(r.err).toContain('nothing was gated');
  });

  test('fails a first MP4 row one byte above its stage 1 share', () => {
    const r = at(1, raised('one-byte.json', (m) => metric(m, 'zero-config', 'firstMp4', 1)));
    expect(r.status).toBe(1);
    expect(r.err).toContain('zero-config:firstMp4: 24,473 B is 1 B above the 0.3.0 baseline of 24,472 B, stage 1 allows 0 B');
  });

  test('applies the cumulative share of a later stage', () => {
    const by = (n: number) => at(2, raised(`share-${n}.json`, (m) => metric(m, 'default', 'firstMp4', n)));
    expect(by(390).status).toBe(0);
    const over = by(391);
    expect(over.status).toBe(1);
    expect(over.err).toContain('default:firstMp4: 23,126 B is 391 B above the 0.3.0 baseline of 22,735 B, stage 2 allows 390 B');
  });

  test('bounds the growth over the stage base by the share of the stage', () => {
    const base = raised('stage-2-end.json', (m) => metric(m, 'zero-config', 'firstMp4', 100));
    const within = at(3, raised('stage-3-ok.json', (m) => metric(m, 'zero-config', 'firstMp4', 110)), base);
    expect(within.status, within.err).toBe(0);
    expect(within.out).toMatch(/zero-config:firstMp4 +24,472 +24,572 +24,582 +\+110 +400 +\+10 +10 /);
    const over = at(3, raised('stage-3-over.json', (m) => metric(m, 'zero-config', 'firstMp4', 111)), base);
    expect(over.status).toBe(1);
    expect(over.err).toContain('zero-config:firstMp4: 24,583 B is 11 B above the stage base of 24,572 B, the share of stage 3 is 10 B');
  });

  test('fails a later stage that spends more than its own share although the cumulative growth fits', () => {
    const base = raised('base-100.json', (m) => {
      for (const c of ['zero-config', 'iife-nosplit', 'standalone-split-url', 'default', 'custom', 'custom-eager']) metric(m, c, 'firstMp4', 100);
    });
    const r = at(3, raised('report-390.json', (m) => metric(m, 'default', 'firstMp4', 390)), base);
    expect(r.status).toBe(1);
    expect(r.err).toContain('default:firstMp4: 23,125 B is 290 B above the stage base of 22,835 B, the share of stage 3 is 10 B');
    expect(r.err).not.toContain('above the 0.3.0 baseline');
  });

  test('lets the ISO BMFF parser spend the stage 3 share on every row that holds it', () => {
    const base = raised('stage-2-parser.json', (m) => isoParser(m, 390));
    const stage3End = raised('stage-3-parser-ok.json', (m) => isoParser(m, 400));
    const within = at(3, stage3End, base);
    expect(within.status, within.err).toBe(0);
    expect(within.out).toMatch(/default:lazyTotal +89,206 +89,986 +90,006 +\+800 +1,200 +\+20 +20 +92,000 +ok/);
    const over = at(3, raised('stage-3-parser-over.json', (m) => isoParser(m, 401)), base);
    expect(over.status).toBe(1);
    expect(over.err).toContain('default:lazyTotal: 90,008 B is 22 B above the stage base of 89,986 B, the share of stage 3 is 20 B');
    expect(over.err).toContain('all:lazyTotal: 366,173 B is 44 B above the stage base of 366,129 B, the share of stage 3 is 40 B');
    const matrix = JSON.parse(readFileSync(BASELINE, 'utf8')) as Matrix;
    const parserRows = [
      ...matrix.fixtures.flatMap((f) => [...['isobmff', 'firstMp4', 'firstMp4Summary', 'allOwn', 'lazyTotal'].filter((k) => typeof f.metrics[k] === 'number').map((k) => `${f.name}:${k}`), ...(f.name === 'standalone-url' ? ['standalone-url:firstMkv'] : [])]),
      ...matrix.standalone.filter((s) => s.file !== 'own-matroska.worker.js').map((s) => `standalone:${s.file}`),
    ];
    const failed = new Set(over.err.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5, l.indexOf(': '))));
    expect([...failed].sort()).toEqual(parserRows.sort());
    expect(at(4, stage3End, stage3End).status).toBe(0);
    const stage4 = at(4, raised('stage-4-parser.json', (m) => isoParser(m, 401)), stage3End);
    expect(stage4.status).toBe(1);
    expect(stage4.err).toContain('default:lazyTotal: 90,008 B differs from the stage base of 90,006 B by +2 B, and stage 4 keeps it byte-identical');
  });

  test('keeps a row that holds no ISO BMFF parser byte-identical while the parser spends the stage 3 share', () => {
    const base = raised('stage-2-parser-base.json', (m) => isoParser(m, 390));
    for (const [config, key] of [
      ['default', 'client'],
      ['default', 'segments'],
      ['default', 'matroska'],
      ['zero-config', 'firstMkv'],
      ['rvfc', 'rvfc'],
    ] as const) {
      const r = at(
        3,
        raised(`stage-3-${config}-${key}.json`, (m) => {
          isoParser(m, 400);
          metric(m, config, key, 1);
        }),
        base,
      );
      expect(r.status, `${config}:${key}`).toBe(1);
      const fails = r.err.split('\n').filter((l) => l.startsWith('FAIL '));
      expect(fails, `${config}:${key}`).toHaveLength(1);
      expect(fails[0]).toContain(`FAIL ${config}:${key}: `);
    }
  });

  test('keeps every other row byte-identical in a frozen stage', () => {
    const report = raised('client.json', (m) => metric(m, 'default', 'client', 1));
    const frozen = at(3, report);
    expect(frozen.status).toBe(1);
    expect(frozen.err).toContain('default:client: measured 3,284 B against 3,283 B in the stage base, and stage 3 keeps every other row byte-identical');
    expect(at(2, report).status).toBe(0);
    const matroska = at(3, raised('mkv-shrink.json', (m) => metric(m, 'default', 'firstMkv', -1)));
    expect(matroska.status).toBe(1);
    expect(matroska.err).toContain('default:firstMkv: 25,538 B differs from the stage base of 25,539 B by -1 B, and stage 3 keeps it byte-identical');
  });

  test('lets only the listed rows of the rule entries move in stage 6', () => {
    const rules = raised('check.json', (m) => {
      for (const c of ['check', 'preset']) for (const k of ['trigger', 'entry', 'check']) metric(m, c, k, 50);
    });
    const check = at(6, rules);
    expect(check.status, check.err).toBe(0);
    expect(check.out).toContain('except the rows check:trigger, check:entry, check:check, preset:trigger, preset:entry, preset:check');
    const lazy = at(6, raised('preset-lazy.json', (m) => metric(m, 'preset', 'lazyTotal', 500)));
    expect(lazy.status).toBe(1);
    expect(lazy.err).toContain('preset:lazyTotal: 89,711 B differs from the stage base of 89,211 B by +500 B, and stage 6 keeps it byte-identical');
    const own = at(6, raised('check-own.json', (m) => metric(m, 'check', 'allOwn', 500)));
    expect(own.status).toBe(1);
    expect(own.err).toContain('check:allOwn: 49,114 B differs from the stage base of 48,614 B by +500 B, and stage 6 keeps it byte-identical');
    const first = at(6, raised('check-first.json', (m) => metric(m, 'check', 'firstMp4', 500)));
    expect(first.status).toBe(1);
    expect(first.err).toContain('check:firstMp4: 23,237 B differs from the stage base of 22,737 B by +500 B, and stage 6 keeps it byte-identical');
    const presets = at(6, raised('presets.json', (m) => metric(m, 'preset', 'presets', 1)));
    expect(presets.status).toBe(1);
    expect(presets.err).toContain('preset:presets: 456 B differs from the 0.3.0 baseline of 455 B by +1 B, and the group keeps it byte-identical');
    const capped = at(6, raised('check-cap.json', (m) => metric(m, 'check', 'check', 511)));
    expect(capped.status).toBe(1);
    expect(capped.err).toContain('check:check: 4,501 B is above its cap of 4,500 B');
    const host = at(6, raised('host.json', (m) => metric(m, 'default', 'trigger', 1)));
    expect(host.status).toBe(1);
    expect(host.err).toContain('default:trigger: 667 B differs from the 0.3.0 baseline of 666 B by +1 B, and the group keeps it byte-identical');
    const other = at(6, raised('other.json', (m) => metric(m, 'rvfc', 'rvfc', 1)));
    expect(other.status).toBe(1);
    expect(other.err).toContain('rvfc:rvfc: measured 2,194 B against 2,193 B in the stage base, and stage 6 keeps every other row byte-identical');
  });

  test('fails a configuration name where frozen.stages needs a row', () => {
    const r = run(['--config', configAt(6, BASELINE, (c) => ((c.frozen as { stages: Record<string, string[]> }).stages['6'] = ['check'])), '--report', BASELINE]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('frozen.stages of stage 6 lists check, which is not a <configuration>:<metric> row');
  });

  test('gates the first MP4 of every configuration and the rule chunks in the stages that freeze nothing', () => {
    const rows = ['mp4box:firstMp4', 'preset:firstMp4', 'react:firstMp4Summary'];
    const grow = (m: Matrix, by: number) => {
      for (const row of rows) metric(m, row.slice(0, row.indexOf(':')), row.slice(row.indexOf(':') + 1), by);
    };
    const stage4End = raised('stage-4-end.json', (m) => grow(m, 400));
    for (const [stage, base, start, share] of [
      [2, BASELINE, 0, 390],
      [5, stage4End, 400, 50],
    ] as const) {
      const within = at(stage, raised(`first-${stage}-ok.json`, (m) => grow(m, start + share)), base);
      expect(within.status, `stage ${stage}: ${within.err}`).toBe(0);
      const over = at(stage, raised(`first-${stage}-over.json`, (m) => grow(m, start + share + 1)), base);
      expect(over.status).toBe(1);
      for (const row of rows) expect(over.err, row).toContain(`${row}: `);
      const rules = at(
        stage,
        raised(`rules-${stage}.json`, (m) => {
          grow(m, start);
          metric(m, 'check', 'check', 1);
          metric(m, 'preset', 'presets', -1);
        }),
        base,
      );
      expect(rules.status).toBe(1);
      expect(rules.err).toContain('check:check: 3,991 B differs from the 0.3.0 baseline of 3,990 B by +1 B, and the group keeps it byte-identical');
      expect(rules.err).toContain('preset:presets: 454 B differs from the 0.3.0 baseline of 455 B by -1 B, and the group keeps it byte-identical');
    }
    const over = at(2, raised('mp4box-first.json', (m) => metric(m, 'mp4box', 'firstMp4', 391)));
    expect(over.err).toContain('mp4box:firstMp4: 23,161 B is 391 B above the 0.3.0 baseline of 22,770 B, stage 2 allows 390 B');
  });

  test('fails a critical path that shrinks', () => {
    const r = at(2, raised('shrink.json', (m) => metric(m, 'default', 'trigger', -5)));
    expect(r.status).toBe(1);
    expect(r.err).toContain('default:trigger: 661 B differs from the 0.3.0 baseline of 666 B by -5 B, and the group keeps it byte-identical');
  });

  test('fails a row above its absolute cap', () => {
    const r = at(6, raised('cap.json', (m) => metric(m, 'standalone-split-url', 'firstMp4', 454)));
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone-split-url:firstMp4: 24,951 B is above its cap of 24,950 B');
  });

  test('gates a growth-only row without a cap', () => {
    const by = (n: number) => at(2, raised(`custom-mkv-${n}.json`, (m) => metric(m, 'custom', 'firstMkv', n)));
    expect(by(200).status).toBe(0);
    const over = by(201);
    expect(over.status).toBe(1);
    expect(over.err).toContain('custom:firstMkv: 26,883 B is 201 B above the 0.3.0 baseline of 26,682 B, stage 2 allows 200 B');
  });

  test('fails a standalone worker file above its share', () => {
    const r = at(1, raised('worker.json', (m) => (m.standalone.find((s) => s.file === 'own-isobmff.worker.js')!.gzip += 1)));
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone:own-isobmff.worker.js: 21,144 B is 1 B above the 0.3.0 baseline of 21,143 B');
  });

  test('fails a gated row that no report has', () => {
    const typo = run(['--config', configAt(1, BASELINE, (c) => (c.groups[2].rows = ['custom:firstMP4', 'custom-eager:firstMp4'])), '--report', BASELINE]);
    expect(typo.status).toBe(1);
    expect(typo.err).toContain('custom:firstMP4: not in the baseline report: configuration custom has no metric firstMP4');
    const dropped = at(1, raised('dropped.json', (m) => delete m.fixtures.find((f) => f.name === 'custom')!.metrics.firstMp4));
    expect(dropped.status).toBe(1);
    expect(dropped.err).toContain('custom:firstMp4: not in the measured report: configuration custom has no metric firstMp4');
  });

  test('resolves command line paths against the working directory', () => {
    raised('relative.json', () => {});
    const config = configAt(1);
    const r = run(['--config', config.slice(dir.length + 1), '--report', 'relative.json'], dir);
    expect(r.status, r.err).toBe(0);
  });
});
