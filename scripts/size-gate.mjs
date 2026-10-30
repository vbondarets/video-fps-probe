import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = 'standalone';

const USAGE = `Usage: node scripts/size-gate.mjs [--config <file>] [--report <file>] [--baseline <file>] [--normalized-baseline <file>] [--stage <n>]

Compares the size matrix report against the 0.3.0 baseline and against the report the current stage started
from (the stage base), with the allowances and caps of scripts/size-gate.json. Every comparison uses the
hash-normalized gzip sizes that scripts/size-matrix.mjs records under the key normalized: the content hash
in every emitted file name is replaced by a fixed placeholder before gzip, so a change in one chunk does not
move the size of the chunks that only name it. The caps apply to the raw sizes, which users download.

The baseline is the committed 0.3.0 report, fixtures/snapshots/size-matrix-v0.3.0.json. Its normalized
sizes come from fixtures/snapshots/size-matrix-v0.3.0-normalized.json, the same build measured with the
current scripts/size-matrix.mjs: without its normalized keys it must be the baseline byte for byte.

It exits 1 when a snapshot does not match its pinned SHA-256, when the normalized baseline is not the
baseline with normalized sizes, when a gated row grows past its cumulative allowance over the baseline,
past the share of the current stage over the stage base or past its cap, when a gated row whose share in
the current stage is 0 differs from the stage base in either direction, when a row that must stay
identical to the baseline changes, or when a gated row is missing. Rows are <configuration>:<metric> of
the report, or standalone:<file> for the prebuilt worker files.

It also gates every emitted file outside the entry chunk of each 0.3.0 configuration on its own, so a
sum row such as firstMp4, allOwn or lazyTotal cannot hide a change in a file that holds no parser. Files
are matched by their normalized name and the worker that loads them (page for the main thread). A file
that holds a parser or an engine may grow by the allowance of each one it holds under files.growth, with
the same cumulative allowance and stage share rules as a row, and every other file must stay identical to
the stage base. A file that appears, disappears or changes what it holds fails.

The share of a stage is its cumulative allowance minus the allowance of the stage before. In a stage
listed under frozen.stages, every row that no group gates must equal the stage base, except the rows that
the stage lists. Stage 1 starts from the 0.3.0 release, so its stage base is the normalized baseline. A
stage that starts from another report commits that report as fixtures/snapshots/size-matrix-s<previous
stage>.json, points stageBase and stageBaseSha256 at it and advances stage, in one commit of its own made
before any code change of the stage. So from stage 2 on the stage base is report/size-matrix.json of the
commit before the one that last advanced stage.

  --config <file>               gate configuration (default scripts/size-gate.json)
  --report <file>               measured report (default: the report named in the configuration)
  --baseline <file>             baseline report, checked against baselineSha256 (default: the baseline of the configuration)
  --normalized-baseline <file>  normalized baseline, checked against normalizedBaselineSha256 (default: the one of the configuration)
  --stage <n>                   stage whose allowances apply (default: the stage of the configuration)

Paths on the command line resolve against the working directory, paths in the configuration against the
repository root.
`;

const fromRoot = (p) => (isAbsolute(p) ? p : join(REPO_ROOT, p));
const fromCwd = (p) => resolve(process.cwd(), p);
const fmt = (n) => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'));
const signed = (n) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const rawPart = (matrix) => `${JSON.stringify(matrix, (key, value) => (key === 'normalized' ? undefined : value), 2)}\n`;

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`${what} ${path} does not exist`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pinProblem(path, pin, what) {
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin)) return `the configuration pins no SHA-256 for the ${what}`;
  if (!existsSync(path)) return `the ${what} ${path} does not exist`;
  const actual = sha256(path);
  return actual === pin ? null : `the ${what} ${path} has SHA-256 ${actual}, the configuration pins ${pin}, so it is not the committed snapshot`;
}

function normalizedProblem(report, what) {
  const fixtures = (report.fixtures ?? []).filter((f) => !f.normalized?.metrics || (f.files ?? []).some((x) => !x.normalized)).map((f) => f.name);
  const standalone = (report.standalone ?? []).filter((s) => !s.normalized).map((s) => s.file);
  const missing = [...fixtures, ...standalone];
  return missing.length === 0 ? null : `the ${what} has no normalized sizes for ${missing.join(', ')}: measure it with the current scripts/size-matrix.mjs`;
}

function splitRow(row) {
  const at = row.indexOf(':');
  return at < 0 ? [row, ''] : [row.slice(0, at), row.slice(at + 1)];
}

function lookup(report, row) {
  const [config, metric] = splitRow(row);
  if (config === STANDALONE) {
    const s = (report.standalone ?? []).find((x) => x.file === metric);
    if (!s) return { found: false, why: `no standalone file ${metric}` };
    return typeof s.gzip === 'number' ? { found: true, value: s.normalized?.gzip ?? null, raw: s.gzip } : { found: false, why: `standalone file ${metric} has no gzip size` };
  }
  const f = (report.fixtures ?? []).find((x) => x.name === config);
  if (!f) return { found: false, why: `no configuration ${config}` };
  if (!f.metrics || !Object.hasOwn(f.metrics, metric)) return { found: false, why: `configuration ${config} has no metric ${metric}` };
  return { found: true, value: f.normalized?.metrics?.[metric] ?? null, raw: f.metrics[metric] };
}

function everyRow(report) {
  const out = new Map();
  for (const f of report.fixtures ?? []) for (const k of Object.keys(f.metrics ?? {})) out.set(`${f.name}:${k}`, f.normalized?.metrics?.[k] ?? null);
  for (const s of report.standalone ?? []) out.set(`${STANDALONE}:${s.file}`, s.normalized?.gzip ?? null);
  return out;
}

function capOf(group, row) {
  if (group.cap === null || typeof group.cap === 'number') return { cap: group.cap };
  if (group.cap && typeof group.cap === 'object' && typeof group.cap[row] === 'number') return { cap: group.cap[row] };
  return { problem: `group "${group.name}" gives no cap for ${row}: cap must be a number, an object with a number per row, or null for a growth-only row` };
}

function allowances(growth, stage, what) {
  const key = String(stage);
  if (!growth || !(key in growth)) return { problem: `${what} has no growth allowance for stage ${stage}` };
  const allowed = growth[key];
  const before = stage === 1 ? 0 : growth[String(stage - 1)];
  if (before === undefined) return { problem: `${what} has no growth allowance for stage ${stage - 1}` };
  const share = allowed === null || before === null ? null : allowed - before;
  return { allowed, share };
}

const fileKey = (x) => `${x.normalized.file} (${x.worker ?? 'page'})`;

function lazyFiles(fixture) {
  const out = new Map();
  const twice = [];
  for (const x of fixture?.files ?? []) {
    if (!x.normalized || x.normalized.entry) continue;
    const key = fileKey(x);
    if (out.has(key)) twice.push(key);
    out.set(key, x);
  }
  return { files: out, twice };
}

function gateFiles(config, report, baseline, base, stage) {
  const problems = [];
  const rows = [];
  let count = 0;
  const growth = config.files?.growth ?? {};
  const kinds = new Map();
  for (const [kind, g] of Object.entries(growth)) {
    const a = allowances(g, stage, `files.growth.${kind}`);
    if (a.problem) problems.push(a.problem);
    else kinds.set(kind, a);
  }
  for (const f of base.fixtures ?? []) {
    if (!(baseline.fixtures ?? []).some((b) => b.name === f.name)) continue;
    const sides = { 'stage base': lazyFiles(f), baseline: lazyFiles((baseline.fixtures ?? []).find((b) => b.name === f.name)), measured: lazyFiles((report.fixtures ?? []).find((m) => m.name === f.name)) };
    for (const [what, side] of Object.entries(sides)) for (const key of side.twice) problems.push(`${f.name} file ${key}: two files of the ${what} report have this normalized name and worker, so the files cannot be matched`);
    const { files: start } = sides['stage base'];
    const { files: was } = sides.baseline;
    const { files: now } = sides.measured;
    for (const key of now.keys()) if (!start.has(key)) problems.push(`${f.name} file ${key}: not in the stage base, and no file may be added to a configuration of 0.3.0`);
    for (const [key, s] of start) {
      count++;
      const n = now.get(key);
      const b = was.get(key);
      if (!n) {
        problems.push(`${f.name} file ${key}: in the stage base but not in the measured report`);
        continue;
      }
      if (!b) {
        problems.push(`${f.name} file ${key}: not in the 0.3.0 baseline`);
        continue;
      }
      const holds = n.normalized.holds ?? [];
      if (JSON.stringify(holds) !== JSON.stringify(s.normalized.holds ?? [])) {
        problems.push(`${f.name} file ${key}: holds ${holds.join(', ') || 'no parser or engine'} against ${(s.normalized.holds ?? []).join(', ') || 'no parser or engine'} in the stage base`);
        continue;
      }
      const unknown = holds.filter((h) => !Object.hasOwn(growth, h));
      if (unknown.length > 0) {
        problems.push(`${f.name} file ${key}: holds ${unknown.join(', ')}, which files.growth gives no allowance`);
        continue;
      }
      const parts = holds.map((h) => kinds.get(h)).filter(Boolean);
      if (parts.length !== holds.length) continue;
      const allowed = parts.some((p) => p.allowed === null) ? null : parts.reduce((t, p) => t + p.allowed, 0);
      const share = parts.some((p) => p.share === null) ? null : parts.reduce((t, p) => t + p.share, 0);
      const value = n.normalized.gzip;
      const delta = value - b.normalized.gzip;
      const sinceBase = value - s.normalized.gzip;
      const out = { config: f.name, key, holds, baseline: b.normalized.gzip, base: s.normalized.gzip, value, delta, allowed, sinceBase, share, status: 'ok' };
      const fail = (status, text) => {
        problems.push(`${f.name} file ${key}: ${text} (files)`);
        if (out.status === 'ok') out.status = status;
      };
      const what = holds.join(' and ') || 'a file without a parser or engine';
      if (allowed !== null && delta > allowed) fail('over growth', `${fmt(value)} B is ${fmt(delta)} B above the 0.3.0 baseline of ${fmt(b.normalized.gzip)} B, stage ${stage} allows ${fmt(allowed)} B for ${what}`);
      else if (share === 0 && sinceBase !== 0) fail('changed', `${fmt(value)} B differs from the stage base of ${fmt(s.normalized.gzip)} B by ${signed(sinceBase)} B, and the share of stage ${stage} for ${what} is 0`);
      else if (share !== null && sinceBase > share) fail('over share', `${fmt(value)} B is ${fmt(sinceBase)} B above the stage base of ${fmt(s.normalized.gzip)} B, the share of stage ${stage} for ${what} is ${fmt(share)} B`);
      if (sinceBase !== 0 || out.status !== 'ok') rows.push(out);
    }
  }
  return { problems, rows, count };
}

function gate(config, report, baseline, base, stage) {
  const problems = [];
  const rows = [];
  const frozenStages = config.frozen?.stages ?? {};
  const frozen = Object.hasOwn(frozenStages, String(stage));
  const exempt = new Set(frozen ? frozenStages[String(stage)] : []);
  for (const row of exempt) if (!row.includes(':')) problems.push(`frozen.stages of stage ${stage} lists ${row}, which is not a <configuration>:<metric> row`);
  const gated = new Set();
  for (const group of config.groups) {
    const a = allowances(group.growth, stage, `group "${group.name}"`);
    if (a.problem) {
      problems.push(a.problem);
      continue;
    }
    for (const row of group.rows) {
      gated.add(row);
      const c = capOf(group, row);
      if (c.problem) problems.push(c.problem);
      const cap = c.cap ?? null;
      const now = lookup(report, row);
      const was = lookup(baseline, row);
      const start = lookup(base, row);
      const out = { row, baseline: was.value ?? null, base: start.value ?? null, value: now.value ?? null, raw: now.raw ?? null, delta: null, allowed: a.allowed, sinceBase: null, share: a.share, cap, status: 'ok' };
      rows.push(out);
      const fail = (status, text) => {
        problems.push(`${row}: ${text} (${group.name})`);
        if (out.status === 'ok') out.status = status;
      };
      if (!was.found) fail('no baseline', `not in the baseline report: ${was.why}`);
      if (!start.found) fail('no stage base', `not in the stage base report: ${start.why}`);
      if (!now.found) fail('missing', `not in the measured report: ${now.why}`);
      if (!was.found || !start.found || !now.found) continue;
      if (was.value === null || start.value === null || now.value === null || now.raw === null) {
        fail('no value', `has no value in the ${was.value === null ? 'baseline' : start.value === null ? 'stage base' : 'measured'} report, so it cannot be gated`);
        continue;
      }
      out.delta = now.value - was.value;
      out.sinceBase = now.value - start.value;
      if (group.exact === true && a.allowed !== null && out.delta !== 0) {
        fail('changed', `${fmt(now.value)} B differs from the 0.3.0 baseline of ${fmt(was.value)} B by ${signed(out.delta)} B, and the group keeps it identical`);
      } else if (a.allowed !== null && out.delta > a.allowed) {
        fail('over growth', `${fmt(now.value)} B is ${fmt(out.delta)} B above the 0.3.0 baseline of ${fmt(was.value)} B, stage ${stage} allows ${fmt(a.allowed)} B`);
      } else if (a.share === 0 && out.sinceBase !== 0) {
        fail('changed', `${fmt(now.value)} B differs from the stage base of ${fmt(start.value)} B by ${signed(out.sinceBase)} B, and its share in stage ${stage} is 0`);
      } else if (a.share !== null && out.sinceBase > a.share) {
        fail('over share', `${fmt(now.value)} B is ${fmt(out.sinceBase)} B above the stage base of ${fmt(start.value)} B, the share of stage ${stage} is ${fmt(a.share)} B`);
      }
      if (cap !== null && now.raw > cap) fail('over cap', `${fmt(now.raw)} B as built is above its cap of ${fmt(cap)} B`);
    }
  }
  let frozenRows = 0;
  if (frozen) {
    const measured = everyRow(report);
    for (const [row, was] of everyRow(base)) {
      if (gated.has(row) || exempt.has(row)) continue;
      frozenRows++;
      if (!measured.has(row)) problems.push(`${row}: in the stage base report but not in the measured report, and stage ${stage} keeps every other row identical`);
      else if (measured.get(row) !== was) problems.push(`${row}: measured ${fmt(measured.get(row))} B against ${fmt(was)} B in the stage base, and stage ${stage} keeps every other row identical`);
    }
  }
  const files = gateFiles(config, report, baseline, base, stage);
  problems.push(...files.problems);
  const gatedTriggers = new Set([...gated].filter((r) => r.endsWith(':trigger')).map((r) => splitRow(r)[0]));
  for (const f of baseline.fixtures ?? []) {
    if (!gatedTriggers.has(f.name)) problems.push(`configuration ${f.name} of the baseline has no gated critical path row`);
  }
  const names = (r) => (r.fixtures ?? []).map((f) => f.name);
  const added = names(report).filter((n) => !names(baseline).includes(n));
  return { rows, files, problems, added, frozen, exempt: [...exempt], frozenRows };
}

function printTable(head, body) {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(line(head));
  for (const b of body) console.log(line(b));
}

function printResult(result, stage) {
  printTable(
    ['row', 'baseline', 'stage base', 'measured', 'delta', `stage ${stage} allows`, 'since base', 'share', 'as built', 'cap', 'status'],
    result.rows.map((r) => [r.row, fmt(r.baseline), fmt(r.base), fmt(r.value), signed(r.delta), r.allowed === null ? 'any' : fmt(r.allowed), signed(r.sinceBase), r.share === null ? 'any' : fmt(r.share), fmt(r.raw), r.cap === null ? 'none' : fmt(r.cap), r.status]),
  );
  console.log('baseline, stage base, measured, delta and since base are hash-normalized gzip bytes, as built is the raw gzip size that the cap applies to');
  if (result.files.rows.length > 0) {
    printTable(
      ['file', 'holds', 'baseline', 'stage base', 'measured', 'delta', `stage ${stage} allows`, 'since base', 'share', 'status'],
      result.files.rows.map((r) => [`${r.config} ${r.key}`, r.holds.join('+') || '-', fmt(r.baseline), fmt(r.base), fmt(r.value), signed(r.delta), r.allowed === null ? 'any' : fmt(r.allowed), signed(r.sinceBase), r.share === null ? 'any' : fmt(r.share), r.status]),
    );
  }
  console.log(`files: ${result.files.count} emitted files outside the entry chunk of the 0.3.0 configurations, ${result.files.rows.length} of them changed since the stage base or failed`);
  if (result.frozen) {
    const except = result.exempt.length > 0 ? `, except the rows ${result.exempt.join(', ')}` : '';
    console.log(`stage ${stage} keeps every row that no group gates identical to the stage base: ${result.frozenRows} rows${except}`);
  } else console.log(`stage ${stage} does not freeze the rows that no group gates`);
  if (result.added.length > 0) console.log(`configurations added after 0.3.0, gated only by their budgets in size-matrix: ${result.added.join(', ')}`);
}

function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      report: { type: 'string' },
      baseline: { type: 'string' },
      'normalized-baseline': { type: 'string' },
      stage: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const config = readJson(values.config === undefined ? fromRoot('scripts/size-gate.json') : fromCwd(values.config), 'gate configuration');
  const stage = values.stage === undefined ? config.stage : Number(values.stage);
  if (!Number.isInteger(stage) || stage < 1) {
    console.error(`the stage must be a positive integer, got ${values.stage ?? config.stage}`);
    return 2;
  }
  const baselinePath = values.baseline === undefined ? fromRoot(config.baseline) : fromCwd(values.baseline);
  const normalizedPath = values['normalized-baseline'] === undefined ? fromRoot(config.normalizedBaseline ?? '') : fromCwd(values['normalized-baseline']);
  const basePath = fromRoot(config.stageBase);
  const pins = [
    pinProblem(baselinePath, config.baselineSha256, 'baseline'),
    typeof config.normalizedBaseline === 'string' ? pinProblem(normalizedPath, config.normalizedBaselineSha256, 'normalized baseline') : 'the configuration names no normalizedBaseline',
    pinProblem(basePath, config.stageBaseSha256, 'stage base'),
  ].filter((p) => p !== null);
  if (pins.length === 0) {
    const normalized = readJson(normalizedPath, 'normalized baseline');
    if (rawPart(normalized) !== readFileSync(baselinePath, 'utf8')) pins.push(`the normalized baseline ${normalizedPath} without its normalized keys is not the baseline ${baselinePath}, so it measures another build`);
    const problem = normalizedProblem(normalized, 'normalized baseline');
    if (problem) pins.push(problem);
  }
  if (pins.length > 0) {
    for (const p of pins) console.error(`FAIL ${p}`);
    console.error(`size gate: ${pins.length} snapshot problem(s), nothing was gated`);
    return 1;
  }
  const report = readJson(values.report === undefined ? fromRoot(config.report) : fromCwd(values.report), 'report');
  const baseline = readJson(normalizedPath, 'normalized baseline');
  const base = readJson(basePath, 'stage base');
  const unnormalized = [normalizedProblem(report, 'measured report'), normalizedProblem(base, 'stage base')].filter((p) => p !== null);
  if (unnormalized.length > 0) {
    for (const p of unnormalized) console.error(`FAIL ${p}`);
    console.error(`size gate: ${unnormalized.length} report problem(s), nothing was gated`);
    return 1;
  }
  const result = gate(config, report, baseline, base, stage);
  printResult(result, stage);
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(`FAIL ${p}`);
    console.error(`size gate: ${result.problems.length} problem(s) at stage ${stage}`);
    return 1;
  }
  console.log(`size gate: ${result.rows.length} gated rows and ${result.files.count} files within the stage ${stage} allowances, shares and caps`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
}
