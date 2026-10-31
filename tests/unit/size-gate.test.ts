import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { normalizedName } from '../../scripts/size-matrix.mjs';
import { REPO_ROOT } from '../helpers/fixtures.ts';

interface Sized {
  gzip: number;
  normalized: { gzip: number };
}

interface MatrixFile extends Sized {
  file: string;
  worker: string | null;
  class: string;
  normalized: { file: string; gzip: number; entry: boolean; sources: string[] };
}

interface Fixture {
  name: string;
  metrics: Record<string, number | null>;
  normalized: { metrics: Record<string, number | null> };
  budgets?: { key: string; limit: number }[];
  files: MatrixFile[];
}

interface Matrix {
  fixtures: Fixture[];
  standalone: (Sized & { file: string; limit?: number })[];
}

interface Group {
  name: string;
  rows: string[];
  growth: Record<string, number | null>;
  cap: number | null | Record<string, number>;
}

interface GateConfig {
  baselineSha256: string;
  normalizedBaseline: string;
  normalizedBaselineSha256: string;
  report: string;
  stageBase: string;
  stageBaseSha256: string;
  stage: number;
  files: { kinds: Record<string, { sources: string; growth: Record<string, number> }> };
  groups: Group[];
  [key: string]: unknown;
}

interface Pair {
  change: string;
  structure: string;
  rows: Record<string, [number, number]>;
  files: Record<string, [number, number]>;
  rawOnlyRows: Record<string, [number, number]>;
}

const BASELINE_SHA256 = '1b6c24749acae07a3fea4b2477d8c88517d303c617f629c6c3f8b179db6f5fe2';
const NORMALIZED_SHA256 = '594fef2ab36ae0c2d665bc6d3ddb36ff800e3cdabe90bded04e75945defd7617';
const GATE = join(REPO_ROOT, 'scripts', 'size-gate.mjs');
const CONFIG = join(REPO_ROOT, 'scripts', 'size-gate.json');
const SNAPSHOTS = join(REPO_ROOT, 'fixtures', 'snapshots');
const BASELINE = join(SNAPSHOTS, 'size-matrix-v0.3.0.json');
const NORMALIZED = join(SNAPSHOTS, 'size-matrix-v0.3.0-normalized.json');
const PAIRS = JSON.parse(readFileSync(join(SNAPSHOTS, 'size-gate-pairs.json'), 'utf8')) as Record<string, Pair>;
const PAIR_NAMES = ['parserOnly', 'nonParser', 'core', 'median'] as const;
const hasTag = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'v0.3.0^{commit}'], { cwd: REPO_ROOT }).status === 0;
const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' });
const fullHistory = shallow.status === 0 && shallow.stdout.trim() === 'false';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const rawPart = (text: string) => `${JSON.stringify(JSON.parse(text), (key: string, value: unknown) => (key === 'normalized' ? undefined : value), 2)}\n`;
const fmt = (n: number) => n.toLocaleString('en-US');
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;
const fileKey = (x: MatrixFile) => `${x.normalized.file} (${x.worker ?? 'page'})`;
const failures = (err: string) => err.split('\n').filter((l) => l.startsWith('FAIL '));
const failedRow = (line: string) => line.slice(5, line.indexOf(': '));
let dir = '';
let configs = 0;

const template = () => JSON.parse(readFileSync(NORMALIZED, 'utf8')) as Matrix;
const START = template();
const fixtureOf = (m: Matrix, name: string) => m.fixtures.find((f) => f.name === name)!;
const norm = (config: string, key: string) => fixtureOf(START, config).normalized.metrics[key]!;
const raw = (config: string, key: string) => fixtureOf(START, config).metrics[key]!;

function run(args: string[], cwd = REPO_ROOT): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function written(name: string, m: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(m));
  return path;
}

function raised(name: string, edit: (m: Matrix) => void): string {
  const m = template();
  edit(m);
  return written(name, m);
}

function configAt(stage: number, stageBase = NORMALIZED, edit: (c: GateConfig) => void = () => {}): string {
  const c = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
  c.stage = stage;
  c.stageBase = stageBase;
  c.stageBaseSha256 = sha256(readFileSync(stageBase));
  edit(c);
  return written(`config-${++configs}.json`, c);
}

const at = (stage: number, report: string, stageBase = NORMALIZED) => run(['--config', configAt(stage, stageBase), '--report', report]);

const grow = (x: Sized, by: number) => {
  x.gzip += by;
  x.normalized.gzip += by;
};

const metric = (m: Matrix, config: string, key: string, by: number) => {
  const f = fixtureOf(m, config);
  f.metrics[key] = (f.metrics[key] ?? 0) + by;
  f.normalized.metrics[key] = (f.normalized.metrics[key] ?? 0) + by;
};

const KINDS = (JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig).files.kinds;
const holds = (x: MatrixFile, kind: string) => x.normalized.sources.some((s) => new RegExp(KINDS[kind]!.sources).test(s));
const holding = (f: Fixture, kind: string) => f.files.filter((x) => !x.normalized.entry && holds(x, kind));

const FAMILIES = {
  isobmff: { rows: ['isobmff', 'firstMp4', 'firstMp4Summary', 'allOwn'], oneFile: 'firstMkv', standalone: ['own.worker.js', 'own-isobmff.worker.js'] },
  matroska: { rows: ['matroska', 'firstMkv', 'allOwn'], oneFile: 'firstMp4', standalone: ['own.worker.js', 'own-matroska.worker.js'] },
} as const;

const parser = (m: Matrix, family: keyof typeof FAMILIES, by: number) => {
  const p = FAMILIES[family];
  for (const f of m.fixtures) {
    for (const key of p.rows) if (typeof f.metrics[key] === 'number') metric(m, f.name, key, by);
    if (f.name === 'standalone-url') metric(m, f.name, p.oneFile, by);
    const copies = holding(f, family);
    metric(m, f.name, 'lazyTotal', by * copies.length);
    for (const x of copies) grow(x, by);
  }
  for (const s of m.standalone) if ((p.standalone as readonly string[]).includes(s.file)) grow(s, by);
};

const isoParser = (m: Matrix, by: number) => parser(m, 'isobmff', by);
const bothParsers = (iso: number, mkv: number) => (m: Matrix) => {
  parser(m, 'isobmff', iso);
  parser(m, 'matroska', mkv);
};

const parserRows = (m: Matrix, family: keyof typeof FAMILIES) => [
  ...m.fixtures.flatMap((f) => [
    ...[...FAMILIES[family].rows, 'lazyTotal'].filter((k) => typeof f.metrics[k] === 'number' && (k !== 'lazyTotal' || holding(f, family).length > 0)).map((k) => `${f.name}:${k}`),
    ...(f.name === 'standalone-url' ? [`standalone-url:${FAMILIES[family].oneFile}`] : []),
  ]),
  ...m.standalone.filter((s) => (FAMILIES[family].standalone as readonly string[]).includes(s.file)).map((s) => `standalone:${s.file}`),
];
const parserFiles = (m: Matrix, family: string) => m.fixtures.flatMap((f) => holding(f, family).map((x) => `${f.name} file ${fileKey(x)}`));
const parserOnlyFiles = (m: Matrix, family: string) => m.fixtures.flatMap((f) => holding(f, family).filter((x) => !holds(x, 'core')).map((x) => `${f.name} file ${fileKey(x)}`));

const structureOf = (m: Matrix) =>
  sha256(
    m.fixtures
      .flatMap((f) => f.files.map((x) => `${f.name} ${fileKey(x)} ${x.normalized.entry ? 'entry' : 'lazy'} ${x.normalized.sources.join(' ')}`))
      .sort()
      .join('\n'),
  );

function applied(name: string, pair: Pair): string {
  return raised(name, (m) => {
    for (const [row, [rawValue, normalizedValue]] of [...Object.entries(pair.rows), ...Object.entries(pair.rawOnlyRows)]) {
      const at = row.indexOf(':');
      const [config, key] = [row.slice(0, at), row.slice(at + 1)];
      if (config === 'standalone') {
        const s = m.standalone.find((x) => x.file === key)!;
        s.gzip = rawValue;
        s.normalized.gzip = normalizedValue;
      } else {
        const f = fixtureOf(m, config);
        f.metrics[key] = rawValue;
        f.normalized.metrics[key] = normalizedValue;
      }
    }
    for (const [key, [rawValue, normalizedValue]] of Object.entries(pair.files)) {
      const at = key.indexOf(' ');
      const x = fixtureOf(m, key.slice(0, at)).files.find((y) => fileKey(y) === key.slice(at + 1));
      if (!x) throw new Error(`the pair names the file ${key}, which the normalized baseline does not have`);
      x.gzip = rawValue;
      x.normalized.gzip = normalizedValue;
    }
  });
}

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

  test('the baselines are the pinned 0.3.0 reports', () => {
    expect(sha256(readFileSync(BASELINE))).toBe(BASELINE_SHA256);
    expect(sha256(readFileSync(NORMALIZED))).toBe(NORMALIZED_SHA256);
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
    expect(config.baselineSha256).toBe(BASELINE_SHA256);
    expect(join(REPO_ROOT, config.normalizedBaseline)).toBe(NORMALIZED);
    expect(config.normalizedBaselineSha256).toBe(NORMALIZED_SHA256);
  });

  test('the normalized baseline is the 0.3.0 report with normalized sizes', () => {
    expect(rawPart(readFileSync(NORMALIZED, 'utf8'))).toBe(readFileSync(BASELINE, 'utf8'));
    for (const f of START.fixtures) {
      expect(Object.keys(f.normalized.metrics), f.name).toEqual(Object.keys(f.metrics));
      for (const x of f.files) expect(x.normalized.file, x.file).toBe(normalizedName(x.file));
    }
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
    const base = readFileSync(join(REPO_ROOT, config.stageBase));
    const text = report!.toString('utf8');
    if (rawPart(text) !== text) expect(Buffer.compare(report!, base), `${config.stageBase} against report/size-matrix.json at ${rev}`).toBe(0);
    else expect(rawPart(base.toString('utf8')), `${config.stageBase} without its normalized sizes against report/size-matrix.json at ${rev}`).toBe(text);
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

  test('passes the committed report, with every row at its stage base while the report is the stage base', () => {
    const r = run([]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/size gate: 138 gated rows and 292 files within the stage \d allowances, shares and caps/);
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as GateConfig;
    const atBase = readFileSync(join(REPO_ROOT, config.report)).equals(readFileSync(join(REPO_ROOT, config.stageBase)));
    const noShare = Object.values(config.files.kinds).every((k) => k.growth[String(config.stage)] === k.growth[String(config.stage - 1)]);
    if (atBase || noShare) expect(r.out).toContain('0 of them changed since the stage base or failed');
    else expect(r.out).toMatch(/files: 292 emitted files outside the entry chunk of the 0\.3\.0 configurations, [1-9]\d* of them changed since the stage base or failed/);
  });

  test('passes the baseline itself at every stage', () => {
    for (const stage of [1, 2, 3, 4, 5, 6]) {
      const r = at(stage, NORMALIZED);
      expect(r.status, `stage ${stage}: ${r.err}`).toBe(0);
    }
  });

  test('fails a baseline or a normalized baseline that is not the pinned snapshot', () => {
    const edited = JSON.parse(readFileSync(BASELINE, 'utf8')) as Matrix;
    fixtureOf(edited, 'custom').metrics.firstMp4! += 300;
    const r = run(['--config', configAt(1), '--baseline', written('edited-baseline.json', edited)]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('the configuration pins 1b6c2474');
    expect(r.err).toContain('nothing was gated');
    const normalized = raised('edited-normalized.json', (m) => metric(m, 'custom', 'firstMp4', 300));
    const n = run(['--config', configAt(1), '--normalized-baseline', normalized]);
    expect(n.status).toBe(1);
    expect(n.err).toContain('the configuration pins 594fef2a');
    const other = run([
      '--config',
      configAt(1, NORMALIZED, (c) => {
        c.normalizedBaseline = normalized;
        c.normalizedBaselineSha256 = sha256(readFileSync(normalized));
      }),
    ]);
    expect(other.status).toBe(1);
    expect(other.err).toContain('without its normalized keys is not the baseline');
  });

  test('fails a measured report without normalized sizes', () => {
    const r = at(1, BASELINE);
    expect(r.status).toBe(1);
    expect(r.err).toContain('the measured report has no normalized sizes for default, zero-config');
    expect(r.err).toContain('measure it with the current scripts/size-matrix.mjs');
  });

  test('fails a first MP4 row one byte above its stage 1 share', () => {
    const r = at(1, raised('one-byte.json', (m) => metric(m, 'zero-config', 'firstMp4', 1)));
    expect(r.status).toBe(1);
    const n = norm('zero-config', 'firstMp4');
    expect(r.err).toContain(`zero-config:firstMp4: ${fmt(n + 1)} B is 1 B above the 0.3.0 baseline of ${fmt(n)} B, stage 1 allows 0 B`);
  });

  test('applies the cumulative share of a later stage', () => {
    const by = (n: number) => at(2, raised(`share-${n}.json`, (m) => metric(m, 'default', 'firstMp4', n)));
    expect(by(390).status).toBe(0);
    const over = by(391);
    expect(over.status).toBe(1);
    const n = norm('default', 'firstMp4');
    expect(over.err).toContain(`default:firstMp4: ${fmt(n + 391)} B is 391 B above the 0.3.0 baseline of ${fmt(n)} B, stage 2 allows 390 B`);
  });

  test('bounds the growth over the stage base by the share of the stage', () => {
    const base = raised('stage-2-end.json', (m) => metric(m, 'zero-config', 'firstMp4', 100));
    const within = at(3, raised('stage-3-ok.json', (m) => metric(m, 'zero-config', 'firstMp4', 110)), base);
    expect(within.status, within.err).toBe(0);
    const n = norm('zero-config', 'firstMp4');
    const r = raw('zero-config', 'firstMp4');
    expect(within.out).toMatch(new RegExp(`zero-config:firstMp4 +${fmt(n)} +${fmt(n + 100)} +${fmt(n + 110)} +\\+110 +400 +\\+10 +10 +${fmt(r + 110)} +24,950 +ok`));
    const over = at(3, raised('stage-3-over.json', (m) => metric(m, 'zero-config', 'firstMp4', 111)), base);
    expect(over.status).toBe(1);
    expect(over.err).toContain(`zero-config:firstMp4: ${fmt(n + 111)} B is 11 B above the stage base of ${fmt(n + 100)} B, the share of stage 3 is 10 B`);
  });

  test('fails a later stage that spends more than its own share although the cumulative growth fits', () => {
    const base = raised('base-100.json', (m) => {
      for (const c of ['zero-config', 'iife-nosplit', 'standalone-split-url', 'default', 'custom', 'custom-eager']) metric(m, c, 'firstMp4', 100);
    });
    const r = at(3, raised('report-390.json', (m) => metric(m, 'default', 'firstMp4', 390)), base);
    expect(r.status).toBe(1);
    const n = norm('default', 'firstMp4');
    expect(r.err).toContain(`default:firstMp4: ${fmt(n + 390)} B is 290 B above the stage base of ${fmt(n + 100)} B, the share of stage 3 is 10 B`);
    expect(r.err).not.toContain('above the 0.3.0 baseline');
  });

  test('lets the ISO BMFF parser spend the stage 3 share on every row and file that holds it', () => {
    const base = raised('stage-2-parser.json', (m) => isoParser(m, 390));
    const stage3End = raised('stage-3-parser-ok.json', (m) => isoParser(m, 400));
    const within = at(3, stage3End, base);
    expect(within.status, within.err).toBe(0);
    const lazy = norm('default', 'lazyTotal');
    expect(within.out).toMatch(new RegExp(`default:lazyTotal +${fmt(lazy)} +${fmt(lazy + 780)} +${fmt(lazy + 800)} +\\+800 +1,200 +\\+20 +20 +${fmt(raw('default', 'lazyTotal') + 800)} +92,000 +ok`));
    const over = at(3, raised('stage-3-parser-over.json', (m) => isoParser(m, 401)), base);
    expect(over.status).toBe(1);
    expect(over.err).toContain(`default:lazyTotal: ${fmt(lazy + 802)} B is 22 B above the stage base of ${fmt(lazy + 780)} B, the share of stage 3 is 20 B`);
    const all = norm('all', 'lazyTotal');
    expect(over.err).toContain(`all:lazyTotal: ${fmt(all + 1604)} B is 44 B above the stage base of ${fmt(all + 1560)} B, the share of stage 3 is 40 B`);
    expect(over.err).toMatch(/FAIL default file assets\/isobmff-00000000\.js \(page\): [\d,]+ B is 401 B above the 0\.3\.0 baseline of [\d,]+ B, stage 3 allows 400 B for isobmff \(files\)/);
    expect(over.err).toMatch(/FAIL default file assets\/own-isobmff\.worker-00000000\.js \(own-isobmff\.worker\): [\d,]+ B is 11 B above the stage base of [\d,]+ B, the share of stage 3 for isobmff and core is 10 B \(files\)/);
    const failed = new Set(failures(over.err).map(failedRow));
    expect([...failed].sort()).toEqual([...parserRows(START, 'isobmff'), ...parserFiles(START, 'isobmff')].sort());
    expect(at(4, stage3End, stage3End).status).toBe(0);
    const stage4 = at(4, raised('stage-4-parser.json', (m) => isoParser(m, 401)), stage3End);
    expect(stage4.status).toBe(1);
    expect(stage4.err).toContain(`default:lazyTotal: ${fmt(lazy + 802)} B differs from the stage base of ${fmt(lazy + 800)} B by +2 B, and its share in stage 4 is 0`);
  });

  test('keeps a row that holds no ISO BMFF parser identical while the parser spends the stage 3 share', () => {
    const base = raised('stage-2-parser-base.json', (m) => isoParser(m, 390));
    for (const [config, key] of [
      ['default', 'client'],
      ['default', 'segments'],
      ['default', 'matroska'],
      ['zero-config', 'firstMkv'],
      ['rvfc', 'rvfc'],
      ['all', 'mp4box'],
      ['all', 'pageEngineShared'],
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
      const fails = failures(r.err);
      expect(fails, `${config}:${key}`).toHaveLength(1);
      expect(fails[0]).toContain(`FAIL ${config}:${key}: `);
    }
  });

  test('passes a real parser-only change at stage 3 within the share and fails it over the share', () => {
    const pair = PAIRS.parserOnly!;
    const report = applied('real-parser-only.json', pair);
    const within = at(3, report);
    expect(within.status, within.err).toBe(0);
    expect(within.out).toMatch(/size gate: 138 gated rows and 292 files within the stage 3 allowances, shares and caps/);
    const growth = Object.entries(pair.files).map(([key, [, value]]) => {
      const at = key.indexOf(' ');
      return value - fixtureOf(START, key.slice(0, at)).files.find((x) => fileKey(x) === key.slice(at + 1))!.normalized.gzip;
    });
    const largest = Math.max(...growth);
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(10);
    const lowered = configAt(3, NORMALIZED, (c) => {
      const iso = c.files.kinds.isobmff!.growth;
      iso['3'] = iso['2']! + largest - 1;
      for (const g of c.groups) {
        const share = (g.growth['3'] ?? 0) - (g.growth['2'] ?? 0);
        if (share > 0) g.growth['3'] = g.growth['2']! + (share / 10) * (largest - 1);
      }
    });
    const over = run(['--config', lowered, '--report', report]);
    expect(over.status).toBe(1);
    const fails = failures(over.err);
    expect(fails.length).toBeGreaterThan(0);
    for (const line of fails) expect(Object.hasOwn(pair.rows, failedRow(line)) || Object.hasOwn(pair.files, failedRow(line).replace(' file ', ' ')), line).toBe(true);
    expect(over.err).toMatch(new RegExp(`B above the stage base of [\\d,]+ B, the share of stage 3 for isobmff(?: and core)? is ${largest - 1} B`));
  });

  test('moves only rows and files that hold the parser in a real parser-only change, while the content hashes move many more raw sizes', () => {
    const pair = PAIRS.parserOnly!;
    const isoRows = new Set(parserRows(START, 'isobmff'));
    for (const row of Object.keys(pair.rows)) expect(isoRows.has(row), row).toBe(true);
    const isoFiles = new Set(parserFiles(START, 'isobmff').map((k) => k.replace(' file ', ' ')));
    for (const key of Object.keys(pair.files)) expect(isoFiles.has(key), key).toBe(true);
    expect(Object.keys(pair.rawOnlyRows)).toEqual(expect.arrayContaining(['default:trigger', 'default:client', 'default:firstMkv', 'default:segments', 'all:mp4box', 'rvfc:rvfc']));
    expect(Object.keys(pair.rawOnlyRows).filter((row) => !isoRows.has(row)).length).toBeGreaterThan(Object.keys(pair.rows).length);
    for (const [row, [rawValue, normalizedValue]] of Object.entries(pair.rawOnlyRows)) {
      const at = row.indexOf(':');
      const [config, key] = [row.slice(0, at), row.slice(at + 1)];
      if (config === 'standalone') continue;
      expect(normalizedValue, row).toBe(norm(config, key));
      expect(rawValue, row).not.toBe(raw(config, key));
    }
    const within = at(3, applied('real-parser-only-raw.json', pair));
    const [trigger] = pair.rawOnlyRows['default:trigger']!;
    expect(trigger).not.toBe(raw('default', 'trigger'));
    expect(within.out).toMatch(new RegExp(`default:trigger +[\\d,]+ +[\\d,]+ +[\\d,]+ +0 +0 +0 +0 +${fmt(trigger)} +1,000 +ok`));
  });

  test('fails a real change outside the parsers at stage 3 that every sum row holding it would let pass', () => {
    const pair = PAIRS.nonParser!;
    expect(Object.keys(pair.rows).length).toBeGreaterThan(0);
    for (const row of Object.keys(pair.rows)) expect(row, 'the change moves only the emitted lazy totals').toMatch(/:lazyTotal$/);
    for (const [row, [, value]] of Object.entries(pair.rows)) {
      const at = row.indexOf(':');
      expect(value - norm(row.slice(0, at), 'lazyTotal'), row).toBeLessThanOrEqual(20);
    }
    const r = at(3, applied('real-non-parser.json', pair));
    expect(r.status).toBe(1);
    const fails = failures(r.err);
    expect(fails).toHaveLength(Object.keys(pair.files).length);
    for (const line of fails) expect(line).toMatch(/^FAIL [\w-]+ file assets\/compare-00000000\.js \(page\): [\d,]+ B is \d+ B above the 0\.3\.0 baseline of [\d,]+ B, stage 3 allows 0 B for a file that holds no kind \(files\)$/);
  });

  test('every recorded real pair emits the same files from the same modules as the baseline', () => {
    const base = structureOf(START);
    for (const name of PAIR_NAMES) expect(PAIRS[name]!.structure, name).toBe(base);
  });

  test('passes a real change in the shared core at stages 2 and 5 and fails it at stage 3', () => {
    const pair = PAIRS.core!;
    for (const key of Object.keys(pair.files)) {
      const at = key.indexOf(' ');
      const x = fixtureOf(START, key.slice(0, at)).files.find((y) => fileKey(y) === key.slice(at + 1))!;
      expect(holds(x, 'core'), key).toBe(true);
    }
    expect(Object.keys(pair.files).length).toBeGreaterThan(50);
    const report = applied('real-core.json', pair);
    for (const stage of [2, 5]) {
      const r = at(stage, report);
      expect(r.status, `stage ${stage}: ${r.err}`).toBe(0);
    }
    const stage3 = at(3, report);
    expect(stage3.status).toBe(1);
    const fails = failures(stage3.err);
    for (const line of fails) expect(Object.hasOwn(pair.rows, failedRow(line)) || Object.hasOwn(pair.files, failedRow(line).replace(' file ', ' ')), line).toBe(true);
    expect(stage3.err).toMatch(/FAIL default file assets\/runtime-00000000\.js \(page\): [\d,]+ B is \d+ B above the 0\.3\.0 baseline of [\d,]+ B, stage 3 allows 390 B for core \(files\)|FAIL default file assets\/runtime-00000000\.js \(page\): [\d,]+ B differs from the stage base of [\d,]+ B by \+\d+ B, and the share of stage 3 for core is 0 \(files\)/);
  });

  test('fails a real change outside the parsers and the core in every stage', () => {
    const pair = PAIRS.nonParser!;
    const report = applied('real-non-parser-every-stage.json', pair);
    for (const stage of [1, 2, 3, 4, 5, 6]) {
      const r = at(stage, report);
      expect(r.status, `stage ${stage}`).toBe(1);
      const fails = failures(r.err);
      expect(fails.filter((line) => / file assets\/compare-00000000\.js \(page\): /.test(line)), `stage ${stage}`).toHaveLength(Object.keys(pair.files).length);
      for (const line of fails) expect(line).toMatch(/^FAIL ([\w-]+ file assets\/compare-00000000\.js \(page\)|[\w-]+:lazyTotal): /);
    }
  });

  test('passes a real stage 2 median change except where it spends more than the 0.03 KB engine share', () => {
    const pair = PAIRS.median!;
    const kinds = ['isobmff', 'matroska', 'core', 'engine'];
    for (const key of Object.keys(pair.files)) {
      const at = key.indexOf(' ');
      const x = fixtureOf(START, key.slice(0, at)).files.find((y) => fileKey(y) === key.slice(at + 1))!;
      expect(kinds.some((k) => holds(x, k)), key).toBe(true);
    }
    expect(Object.keys(pair.rows)).toEqual(expect.arrayContaining(['zero-config:segments', 'iife-nosplit:segments', 'zero-config:rfps', 'iife-nosplit:rfps']));
    const report = applied('real-median.json', pair);
    const r = at(2, report);
    expect(r.status).toBe(1);
    const fails = failures(r.err);
    expect(fails.length).toBeGreaterThan(0);
    for (const line of fails) expect(line).toMatch(/stage 2 allows 30 B( for engine)? \((engine chunks|files)\)$/);
    const wider = configAt(2, NORMALIZED, (c) => {
      c.files.kinds.engine!.growth['2'] = 50;
      c.groups.find((g) => g.name === 'engine chunks')!.growth['2'] = 50;
    });
    const fits = run(['--config', wider, '--report', report]);
    expect(fits.status, fits.err).toBe(0);
    expect(at(3, report).status).toBe(1);
  });

  test('lets both parsers spend the stage 2 shares and fails one byte over on either parser', () => {
    const ok = at(2, raised('stage-2-both.json', bothParsers(390, 200)));
    expect(ok.status, ok.err).toBe(0);
    const allLazy = raw('all', 'lazyTotal') + 4 * 390 + 4 * 200;
    expect(allLazy).toBeLessThanOrEqual(367000);
    expect(ok.out).toMatch(new RegExp(`all:lazyTotal +[\\d,]+ +[\\d,]+ +[\\d,]+ +\\+2,360 +2,360 +\\+2,360 +2,360 +${fmt(allLazy)} +367,000 +ok`));
    for (const [family, iso, mkv] of [
      ['isobmff', 391, 200],
      ['matroska', 390, 201],
    ] as const) {
      const r = at(2, raised(`stage-2-${family}-over.json`, bothParsers(iso, mkv)));
      expect(r.status, family).toBe(1);
      const failed = new Set(failures(r.err).map(failedRow));
      expect([...failed].sort(), family).toEqual([...new Set([...parserRows(START, family), ...parserOnlyFiles(START, family)])].sort());
    }
  });

  test('lets both parsers spend the stage 5 shares, under the all:lazyTotal cap only once stage 5 re-sets it', () => {
    const base = raised('stage-4-both.json', bothParsers(400, 200));
    const full = raised('stage-5-both.json', bothParsers(450, 250));
    const capped = at(5, full, base);
    expect(capped.status).toBe(1);
    const allLazy = raw('all', 'lazyTotal') + 4 * 450 + 4 * 250;
    expect(failures(capped.err)).toEqual([`FAIL all:lazyTotal: ${fmt(allLazy)} B as built is above its cap of 367,000 B (emitted lazy total with both engine workers)`]);
    const reset = (c: GateConfig) => {
      c.groups.find((g) => g.rows.includes('all:lazyTotal'))!.cap = Math.ceil(allLazy * 1.01);
    };
    const ok = run(['--config', configAt(5, base, reset), '--report', full]);
    expect(ok.status, ok.err).toBe(0);
    for (const [family, iso, mkv] of [
      ['isobmff', 451, 250],
      ['matroska', 450, 251],
    ] as const) {
      const r = run(['--config', configAt(5, base, reset), '--report', raised(`stage-5-${family}-over.json`, bothParsers(iso, mkv))]);
      expect(r.status, family).toBe(1);
      const failed = new Set(failures(r.err).map(failedRow));
      expect([...failed].sort(), family).toEqual([...new Set([...parserRows(START, family), ...parserOnlyFiles(START, family)])].sort());
    }
  });

  test('lets every file that holds the engine result helpers grow by the engine share in stage 2', () => {
    const engine = (by: number) => (m: Matrix) => {
      for (const f of m.fixtures) {
        const copies = holding(f, 'engine');
        if (copies.length === 0) continue;
        for (const key of ['mp4box', 'mediabunny', 'pageEngineShared']) if (typeof f.metrics[key] === 'number') metric(m, f.name, key, by);
        metric(m, f.name, 'lazyTotal', by * copies.length);
        for (const x of copies) grow(x, by);
      }
    };
    expect(START.fixtures.flatMap((f) => holding(f, 'engine')).length).toBe(7);
    const ok = at(2, raised('engine-30.json', engine(30)));
    expect(ok.status, ok.err).toBe(0);
    const over = at(2, raised('engine-31.json', engine(31)));
    expect(over.status).toBe(1);
    expect(over.err).toContain(`all:mp4box: ${fmt(norm('all', 'mp4box') + 31)} B is 31 B above the 0.3.0 baseline of ${fmt(norm('all', 'mp4box'))} B, stage 2 allows 30 B`);
    expect(over.err).toContain(`all:pageEngineShared: ${fmt(norm('all', 'pageEngineShared') + 31)} B is 31 B above the 0.3.0 baseline of ${fmt(norm('all', 'pageEngineShared'))} B, stage 2 allows 30 B`);
    expect(over.err).toMatch(/FAIL all file assets\/counting-00000000\.js \(page\): [\d,]+ B is 31 B above the 0\.3\.0 baseline of [\d,]+ B, stage 2 allows 30 B for engine \(files\)/);
    expect(at(3, raised('engine-stage-3.json', engine(1)), raised('engine-stage-2.json', engine(0))).status).toBe(1);
    const library = at(2, raised('engine-library.json', (m) => grow(fixtureOf(m, 'all').files.find((x) => x.normalized.file === 'assets/mp4box-00000000.js' && x.worker === null)!, 1)));
    expect(library.status).toBe(1);
    expect(failures(library.err)).toEqual([expect.stringMatching(/^FAIL all file assets\/mp4box-00000000\.js \(page\): [\d,]+ B is 1 B above the 0\.3\.0 baseline of [\d,]+ B, stage 2 allows 0 B for a file that holds no kind \(files\)$/)]);
  });

  test('lets a file that holds only the shared core spend the core share of stages 2 and 5 and nothing in stage 3', () => {
    const core = (by: number) => (m: Matrix) => {
      const f = fixtureOf(m, 'default');
      const files = f.files.filter((x) => x.worker === null && ['assets/result-00000000.js', 'assets/runtime-00000000.js'].includes(x.normalized.file));
      expect(files.map((x) => holds(x, 'core'))).toEqual([true, true]);
      for (const x of files) grow(x, by);
      metric(m, 'default', 'lazyTotal', 2 * by);
    };
    const ok = at(2, raised('core-390.json', core(390)));
    expect(ok.status, ok.err).toBe(0);
    const over = at(2, raised('core-391.json', core(391)));
    expect(over.status).toBe(1);
    expect(failures(over.err)).toEqual([
      expect.stringMatching(/^FAIL default file assets\/result-00000000\.js \(page\): [\d,]+ B is 391 B above the 0\.3\.0 baseline of [\d,]+ B, stage 2 allows 390 B for core \(files\)$/),
      expect.stringMatching(/^FAIL default file assets\/runtime-00000000\.js \(page\): [\d,]+ B is 391 B above the 0\.3\.0 baseline of [\d,]+ B, stage 2 allows 390 B for core \(files\)$/),
    ]);
    const stage2End = raised('core-stage-2-end.json', core(300));
    const stage3 = at(3, raised('core-stage-3.json', core(301)), stage2End);
    expect(stage3.status).toBe(1);
    expect(failures(stage3.err)).toHaveLength(2);
    expect(stage3.err).toMatch(/FAIL default file assets\/result-00000000\.js \(page\): [\d,]+ B differs from the stage base of [\d,]+ B by \+1 B, and the share of stage 3 for core is 0 \(files\)/);
    expect(at(5, raised('core-stage-5.json', core(350)), stage2End).status).toBe(0);
    const stage5 = at(5, raised('core-stage-5-over.json', core(351)), stage2End);
    expect(stage5.status).toBe(1);
    expect(stage5.err).toMatch(/FAIL default file assets\/runtime-00000000\.js \(page\): [\d,]+ B is 51 B above the stage base of [\d,]+ B, the share of stage 5 for core is 50 B \(files\)/);
  });

  test('fails a file that appears, disappears or changes what it holds', () => {
    const dropped = at(1, raised('file-dropped.json', (m) => fixtureOf(m, 'default').files.splice(fixtureOf(m, 'default').files.findIndex((x) => x.normalized.file === 'assets/compare-00000000.js'), 1)));
    expect(dropped.status).toBe(1);
    expect(dropped.err).toContain('default file assets/compare-00000000.js (page): in the stage base but not in the measured report');
    const added = at(
      1,
      raised('file-added.json', (m) => {
        const files = fixtureOf(m, 'default').files;
        const x = files.find((y) => y.normalized.file === 'assets/compare-00000000.js')!;
        files.push({ ...x, file: 'assets/extra-AAAAAAAA.js', normalized: { ...x.normalized, file: 'assets/extra-00000000.js' } });
      }),
    );
    expect(added.status).toBe(1);
    expect(added.err).toContain('default file assets/extra-00000000.js (page): not in the stage base, and no file may be added to a configuration of 0.3.0');
    const moved = at(1, raised('file-holds.json', (m) => (fixtureOf(m, 'default').files.find((x) => x.normalized.file === 'assets/stats-00000000.js')!.normalized.sources.push('core/isobmff/index.js'))));
    expect(moved.status).toBe(1);
    expect(moved.err).toContain('default file assets/stats-00000000.js (page): holds isobmff, core against core in the stage base');
  });

  test('keeps every other row identical in every stage', () => {
    const report = raised('client.json', (m) => metric(m, 'default', 'client', 1));
    const client = norm('default', 'client');
    for (const stage of [1, 2, 3, 4, 5, 6]) {
      const frozen = at(stage, report);
      expect(frozen.status, `stage ${stage}`).toBe(1);
      expect(failures(frozen.err)).toEqual([`FAIL default:client: measured ${fmt(client + 1)} B against ${fmt(client)} B in the stage base, and stage ${stage} keeps every other row identical`]);
    }
    for (const stage of [2, 5]) {
      const entry = at(stage, raised(`entry-${stage}.json`, (m) => metric(m, 'default', 'entry', 50)));
      expect(entry.status, `stage ${stage}`).toBe(1);
      expect(entry.err).toContain(`default:entry: measured ${fmt(norm('default', 'entry') + 50)} B against ${fmt(norm('default', 'entry'))} B in the stage base, and stage ${stage} keeps every other row identical`);
    }
    const matroska = at(3, raised('mkv-shrink.json', (m) => metric(m, 'default', 'firstMkv', -1)));
    expect(matroska.status).toBe(1);
    const mkv = norm('default', 'firstMkv');
    expect(matroska.err).toContain(`default:firstMkv: ${fmt(mkv - 1)} B differs from the stage base of ${fmt(mkv)} B by -1 B, and its share in stage 3 is 0`);
  });

  test('keeps a gated row whose share is 0 identical, in both directions', () => {
    const base = raised('engine-stage-4.json', (m) => metric(m, 'mp4box', 'mp4box', 20));
    for (const by of [1, -1]) {
      const r = at(5, raised(`engine-stage-5-${by}.json`, (m) => metric(m, 'mp4box', 'mp4box', 20 + by)), base);
      expect(r.status, `${by}`).toBe(1);
      expect(r.err).toContain(`mp4box:mp4box: ${fmt(norm('mp4box', 'mp4box') + 20 + by)} B differs from the stage base of ${fmt(norm('mp4box', 'mp4box') + 20)} B by ${signed(by)} B, and its share in stage 5 is 0`);
    }
  });

  test('lets the rows cut out of a single own worker file move only in the stages that change that file', () => {
    const cut = (rows: string[], by: number) => (m: Matrix) => {
      for (const row of rows) metric(m, row.slice(0, row.indexOf(':')), row.slice(row.indexOf(':') + 1), by);
    };
    const segments = ['zero-config:segments', 'iife-nosplit:segments'];
    const rfps = ['zero-config:rfps', 'iife-nosplit:rfps'];
    for (const [stage, moving] of [
      [2, [...segments, ...rfps]],
      [3, segments],
      [5, [...segments, ...rfps]],
    ] as const) {
      const r = at(stage, raised(`cut-${stage}.json`, cut([...moving], -3)));
      expect(r.status, `stage ${stage}: ${r.err}`).toBe(0);
      expect(r.out).toContain(`except the rows ${moving.join(', ')}`);
    }
    for (const stage of [1, 4, 6]) expect(at(stage, raised(`cut-frozen-${stage}.json`, cut(segments, 1))).status, `stage ${stage}`).toBe(1);
    const rfps3 = at(3, raised('cut-rfps-3.json', cut(rfps, 1)));
    expect(rfps3.status).toBe(1);
    expect(failures(rfps3.err).map(failedRow)).toEqual(rfps);
    expect(at(2, raised('cut-default-2.json', (m) => metric(m, 'default', 'segments', 1))).status).toBe(1);
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
    const presetLazy = norm('preset', 'lazyTotal');
    expect(lazy.err).toContain(`preset:lazyTotal: ${fmt(presetLazy + 500)} B differs from the stage base of ${fmt(presetLazy)} B by +500 B, and its share in stage 6 is 0`);
    const own = at(6, raised('check-own.json', (m) => metric(m, 'check', 'allOwn', 500)));
    expect(own.status).toBe(1);
    const allOwn = norm('check', 'allOwn');
    expect(own.err).toContain(`check:allOwn: ${fmt(allOwn + 500)} B differs from the stage base of ${fmt(allOwn)} B by +500 B, and its share in stage 6 is 0`);
    const first = at(6, raised('check-first.json', (m) => metric(m, 'check', 'firstMp4', 500)));
    expect(first.status).toBe(1);
    const firstMp4 = norm('check', 'firstMp4');
    expect(first.err).toContain(`check:firstMp4: ${fmt(firstMp4 + 500)} B is 500 B above the 0.3.0 baseline of ${fmt(firstMp4)} B, stage 6 allows 450 B`);
    const presets = at(6, raised('presets.json', (m) => metric(m, 'preset', 'presets', 1)));
    expect(presets.status).toBe(1);
    const p = norm('preset', 'presets');
    expect(presets.err).toContain(`preset:presets: ${fmt(p + 1)} B differs from the 0.3.0 baseline of ${fmt(p)} B by +1 B, and the group keeps it identical`);
    const capped = at(6, raised('check-cap.json', (m) => metric(m, 'check', 'check', 4501 - raw('check', 'check'))));
    expect(capped.status).toBe(1);
    expect(capped.err).toContain('check:check: 4,501 B as built is above its cap of 4,500 B');
    const host = at(6, raised('host.json', (m) => metric(m, 'default', 'trigger', 1)));
    expect(host.status).toBe(1);
    const trigger = norm('default', 'trigger');
    expect(host.err).toContain(`default:trigger: ${fmt(trigger + 1)} B differs from the 0.3.0 baseline of ${fmt(trigger)} B by +1 B, and the group keeps it identical`);
    const other = at(6, raised('other.json', (m) => metric(m, 'rvfc', 'entry', 1)));
    expect(other.status).toBe(1);
    const entry = norm('rvfc', 'entry');
    expect(other.err).toContain(`rvfc:entry: measured ${fmt(entry + 1)} B against ${fmt(entry)} B in the stage base, and stage 6 keeps every other row identical`);
  });

  test('fails a configuration name where frozen.stages needs a row', () => {
    const r = run(['--config', configAt(6, NORMALIZED, (c) => ((c.frozen as { stages: Record<string, string[]> }).stages['6'] = ['check'])), '--report', NORMALIZED]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('frozen.stages of stage 6 lists check, which is not a <configuration>:<metric> row');
  });

  test('gates the first MP4 of every configuration and the rule chunks in stages 2 and 5', () => {
    const rows = ['mp4box:firstMp4', 'preset:firstMp4', 'react:firstMp4Summary'];
    const growRows = (m: Matrix, by: number) => {
      for (const row of rows) metric(m, row.slice(0, row.indexOf(':')), row.slice(row.indexOf(':') + 1), by);
    };
    const stage4End = raised('stage-4-end.json', (m) => growRows(m, 400));
    for (const [stage, base, start, share] of [
      [2, NORMALIZED, 0, 390],
      [5, stage4End, 400, 50],
    ] as const) {
      const within = at(stage, raised(`first-${stage}-ok.json`, (m) => growRows(m, start + share)), base);
      expect(within.status, `stage ${stage}: ${within.err}`).toBe(0);
      const over = at(stage, raised(`first-${stage}-over.json`, (m) => growRows(m, start + share + 1)), base);
      expect(over.status).toBe(1);
      for (const row of rows) expect(over.err, row).toContain(`${row}: `);
      const rules = at(
        stage,
        raised(`rules-${stage}.json`, (m) => {
          growRows(m, start);
          metric(m, 'check', 'check', 1);
          metric(m, 'preset', 'presets', -1);
        }),
        base,
      );
      expect(rules.status).toBe(1);
      const check = norm('check', 'check');
      const presets = norm('preset', 'presets');
      expect(rules.err).toContain(`check:check: ${fmt(check + 1)} B differs from the 0.3.0 baseline of ${fmt(check)} B by +1 B, and the group keeps it identical`);
      expect(rules.err).toContain(`preset:presets: ${fmt(presets - 1)} B differs from the 0.3.0 baseline of ${fmt(presets)} B by -1 B, and the group keeps it identical`);
    }
    const over = at(2, raised('mp4box-first.json', (m) => metric(m, 'mp4box', 'firstMp4', 391)));
    const n = norm('mp4box', 'firstMp4');
    expect(over.err).toContain(`mp4box:firstMp4: ${fmt(n + 391)} B is 391 B above the 0.3.0 baseline of ${fmt(n)} B, stage 2 allows 390 B`);
  });

  test('fails a critical path that shrinks', () => {
    const r = at(2, raised('shrink.json', (m) => metric(m, 'default', 'trigger', -5)));
    expect(r.status).toBe(1);
    const n = norm('default', 'trigger');
    expect(r.err).toContain(`default:trigger: ${fmt(n - 5)} B differs from the 0.3.0 baseline of ${fmt(n)} B by -5 B, and the group keeps it identical`);
  });

  test('applies the cap to the raw size as built', () => {
    const r = at(6, raised('cap.json', (m) => metric(m, 'standalone-split-url', 'firstMp4', 24951 - raw('standalone-split-url', 'firstMp4'))));
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone-split-url:firstMp4: 24,951 B as built is above its cap of 24,950 B');
    expect(norm('standalone-split-url', 'firstMp4')).toBeLessThan(raw('standalone-split-url', 'firstMp4'));
  });

  test('gates a growth-only row without a cap', () => {
    const by = (n: number) => at(2, raised(`custom-mkv-${n}.json`, (m) => metric(m, 'custom', 'firstMkv', n)));
    expect(by(200).status).toBe(0);
    const over = by(201);
    expect(over.status).toBe(1);
    const n = norm('custom', 'firstMkv');
    expect(over.err).toContain(`custom:firstMkv: ${fmt(n + 201)} B is 201 B above the 0.3.0 baseline of ${fmt(n)} B, stage 2 allows 200 B`);
  });

  test('fails a standalone worker file above its share', () => {
    const r = at(1, raised('worker.json', (m) => grow(m.standalone.find((s) => s.file === 'own-isobmff.worker.js')!, 1)));
    expect(r.status).toBe(1);
    expect(r.err).toContain('standalone:own-isobmff.worker.js: 21,144 B is 1 B above the 0.3.0 baseline of 21,143 B');
  });

  test('fails a gated row that no report has', () => {
    const typo = run(['--config', configAt(1, NORMALIZED, (c) => (c.groups[2]!.rows = ['custom:firstMP4', 'custom-eager:firstMp4'])), '--report', NORMALIZED]);
    expect(typo.status).toBe(1);
    expect(typo.err).toContain('custom:firstMP4: not in the baseline report: configuration custom has no metric firstMP4');
    const dropped = at(1, raised('dropped.json', (m) => delete fixtureOf(m, 'custom').metrics.firstMp4));
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
