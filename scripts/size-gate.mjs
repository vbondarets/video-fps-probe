import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = 'standalone';

const USAGE = `Usage: node scripts/size-gate.mjs [--config <file>] [--report <file>] [--baseline <file>] [--stage <n>]

Compares the size matrix report against the committed 0.3.0 baseline and against the committed report
the current stage started from (the stage base), with the allowances and caps of scripts/size-gate.json.
It exits 1 when a snapshot does not match its pinned SHA-256, when a gated row grows past its cumulative
allowance over the baseline, past the share of the current stage over the stage base or past its cap,
when a row that must stay byte-identical changes, or when a gated row is missing. Rows are
<configuration>:<metric> of the report, or standalone:<file> for the prebuilt worker files.

The share of a stage is its cumulative allowance minus the allowance of the stage before. In a stage
listed under frozen.stages, every row whose share is 0 and every row no group gates must equal the stage
base, except the rows that the stage lists. A stage that starts from a report other than the baseline
commits that report as fixtures/snapshots/size-matrix-s<previous stage>.json and points stageBase and
stageBaseSha256 at it.

  --config <file>     gate configuration (default scripts/size-gate.json)
  --report <file>     measured report (default: the report named in the configuration)
  --baseline <file>   baseline report, checked against baselineSha256 (default: the baseline of the configuration)
  --stage <n>         stage whose allowances apply (default: the stage of the configuration)

Paths on the command line resolve against the working directory, paths in the configuration against the
repository root.
`;

const fromRoot = (p) => (isAbsolute(p) ? p : join(REPO_ROOT, p));
const fromCwd = (p) => resolve(process.cwd(), p);
const fmt = (n) => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'));
const signed = (n) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

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

function splitRow(row) {
  const at = row.indexOf(':');
  return at < 0 ? [row, ''] : [row.slice(0, at), row.slice(at + 1)];
}

function lookup(report, row) {
  const [config, metric] = splitRow(row);
  if (config === STANDALONE) {
    const s = (report.standalone ?? []).find((x) => x.file === metric);
    if (!s) return { found: false, why: `no standalone file ${metric}` };
    return typeof s.gzip === 'number' ? { found: true, value: s.gzip } : { found: false, why: `standalone file ${metric} has no gzip size` };
  }
  const f = (report.fixtures ?? []).find((x) => x.name === config);
  if (!f) return { found: false, why: `no configuration ${config}` };
  if (!f.metrics || !Object.hasOwn(f.metrics, metric)) return { found: false, why: `configuration ${config} has no metric ${metric}` };
  return { found: true, value: f.metrics[metric] };
}

function everyRow(report) {
  const out = new Map();
  for (const f of report.fixtures ?? []) for (const [k, v] of Object.entries(f.metrics ?? {})) out.set(`${f.name}:${k}`, v);
  for (const s of report.standalone ?? []) out.set(`${STANDALONE}:${s.file}`, s.gzip ?? null);
  return out;
}

function capOf(group, row) {
  if (group.cap === null || typeof group.cap === 'number') return { cap: group.cap };
  if (group.cap && typeof group.cap === 'object' && typeof group.cap[row] === 'number') return { cap: group.cap[row] };
  return { problem: `group "${group.name}" gives no cap for ${row}: cap must be a number, an object with a number per row, or null for a growth-only row` };
}

function allowances(group, stage) {
  const key = String(stage);
  if (!group.growth || !(key in group.growth)) return { problem: `group "${group.name}" has no growth allowance for stage ${stage}` };
  const allowed = group.growth[key];
  const before = stage === 1 ? 0 : group.growth[String(stage - 1)];
  if (before === undefined) return { problem: `group "${group.name}" has no growth allowance for stage ${stage - 1}` };
  const share = allowed === null || before === null ? null : allowed - before;
  return { allowed, share };
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
    const a = allowances(group, stage);
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
      const out = { row, baseline: was.value ?? null, base: start.value ?? null, value: now.value ?? null, delta: null, allowed: a.allowed, sinceBase: null, share: a.share, cap, status: 'ok' };
      rows.push(out);
      const fail = (status, text) => {
        problems.push(`${row}: ${text} (${group.name})`);
        if (out.status === 'ok') out.status = status;
      };
      if (!was.found) fail('no baseline', `not in the baseline report: ${was.why}`);
      if (!start.found) fail('no stage base', `not in the stage base report: ${start.why}`);
      if (!now.found) fail('missing', `not in the measured report: ${now.why}`);
      if (!was.found || !start.found || !now.found) continue;
      if (was.value === null || start.value === null || now.value === null) {
        fail('no value', `has no value in the ${was.value === null ? 'baseline' : start.value === null ? 'stage base' : 'measured'} report, so it cannot be gated`);
        continue;
      }
      out.delta = now.value - was.value;
      out.sinceBase = now.value - start.value;
      if (group.exact === true && a.allowed !== null && out.delta !== 0) {
        fail('changed', `${fmt(now.value)} B differs from the 0.3.0 baseline of ${fmt(was.value)} B by ${signed(out.delta)} B, and the group keeps it byte-identical`);
      } else if (a.allowed !== null && out.delta > a.allowed) {
        fail('over growth', `${fmt(now.value)} B is ${fmt(out.delta)} B above the 0.3.0 baseline of ${fmt(was.value)} B, stage ${stage} allows ${fmt(a.allowed)} B`);
      }
      if (a.share !== null) {
        if (frozen && !exempt.has(row) && a.share === 0 && out.sinceBase !== 0) {
          fail('changed', `${fmt(now.value)} B differs from the stage base of ${fmt(start.value)} B by ${signed(out.sinceBase)} B, and stage ${stage} keeps it byte-identical`);
        } else if (out.sinceBase > a.share) {
          fail('over share', `${fmt(now.value)} B is ${fmt(out.sinceBase)} B above the stage base of ${fmt(start.value)} B, the share of stage ${stage} is ${fmt(a.share)} B`);
        }
      }
      if (cap !== null && now.value > cap) fail('over cap', `${fmt(now.value)} B is above its cap of ${fmt(cap)} B`);
    }
  }
  let frozenRows = 0;
  if (frozen) {
    const measured = everyRow(report);
    for (const [row, was] of everyRow(base)) {
      if (gated.has(row) || exempt.has(row)) continue;
      frozenRows++;
      if (!measured.has(row)) problems.push(`${row}: in the stage base report but not in the measured report, and stage ${stage} keeps every other row byte-identical`);
      else if (measured.get(row) !== was) problems.push(`${row}: measured ${fmt(measured.get(row))} B against ${fmt(was)} B in the stage base, and stage ${stage} keeps every other row byte-identical`);
    }
  }
  const gatedTriggers = new Set([...gated].filter((r) => r.endsWith(':trigger')).map((r) => splitRow(r)[0]));
  for (const f of baseline.fixtures ?? []) {
    if (!gatedTriggers.has(f.name)) problems.push(`configuration ${f.name} of the baseline has no gated critical path row`);
  }
  const names = (r) => (r.fixtures ?? []).map((f) => f.name);
  const added = names(report).filter((n) => !names(baseline).includes(n));
  return { rows, problems, added, frozen, exempt: [...exempt], frozenRows };
}

function printTable(result, stage) {
  const head = ['row', 'baseline', 'stage base', 'measured', 'delta', `stage ${stage} allows`, 'since base', 'share', 'cap', 'status'];
  const body = result.rows.map((r) => [r.row, fmt(r.baseline), fmt(r.base), fmt(r.value), signed(r.delta), r.allowed === null ? 'any' : fmt(r.allowed), signed(r.sinceBase), r.share === null ? 'any' : fmt(r.share), r.cap === null ? 'none' : fmt(r.cap), r.status]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(line(head));
  for (const b of body) console.log(line(b));
  if (result.frozen) {
    const except = result.exempt.length > 0 ? `, except the rows ${result.exempt.join(', ')}` : '';
    console.log(`stage ${stage} keeps every row that no group gates byte-identical to the stage base: ${result.frozenRows} rows${except}`);
  } else console.log(`stage ${stage} does not freeze the rows that no group gates`);
  if (result.added.length > 0) console.log(`configurations added after 0.3.0, gated only by their budgets in size-matrix: ${result.added.join(', ')}`);
}

function main() {
  const { values } = parseArgs({
    options: { config: { type: 'string' }, report: { type: 'string' }, baseline: { type: 'string' }, stage: { type: 'string' }, help: { type: 'boolean', default: false } },
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
  const basePath = fromRoot(config.stageBase);
  const pins = [pinProblem(baselinePath, config.baselineSha256, 'baseline'), pinProblem(basePath, config.stageBaseSha256, 'stage base')].filter((p) => p !== null);
  if (pins.length > 0) {
    for (const p of pins) console.error(`FAIL ${p}`);
    console.error(`size gate: ${pins.length} snapshot problem(s), nothing was gated`);
    return 1;
  }
  const report = readJson(values.report === undefined ? fromRoot(config.report) : fromCwd(values.report), 'report');
  const baseline = readJson(baselinePath, 'baseline');
  const base = readJson(basePath, 'stage base');
  const result = gate(config, report, baseline, base, stage);
  printTable(result, stage);
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(`FAIL ${p}`);
    console.error(`size gate: ${result.problems.length} problem(s) at stage ${stage}`);
    return 1;
  }
  console.log(`size gate: ${result.rows.length} gated rows within the stage ${stage} allowances, shares and caps`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
}
