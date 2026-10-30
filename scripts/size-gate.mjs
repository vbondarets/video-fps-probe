import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = 'standalone';

const USAGE = `Usage: node scripts/size-gate.mjs [--config <file>] [--report <file>] [--baseline <file>] [--stage <n>]

Compares the size matrix report against the committed 0.3.0 baseline with the cumulative growth
allowances and caps of scripts/size-gate.json, and exits 1 when a gated row grows past the share
of the current stage or past its cap. Rows are <configuration>:<metric> of the report, or
standalone:<file> for the prebuilt worker files. The table also shows the growth since the report
of the stage base commit, when git has that commit.

  --config <file>     gate configuration (default scripts/size-gate.json)
  --report <file>     measured report (default: the report named in the configuration)
  --baseline <file>   baseline report (default: the baseline named in the configuration)
  --stage <n>         stage whose allowances apply (default: the stage of the configuration)
`;

const fromRoot = (p) => (isAbsolute(p) ? p : join(REPO_ROOT, p));
const fmt = (n) => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'));
const signed = (n) => (n === null ? '-' : `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`);

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`${what} ${path} does not exist`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function lookup(report, row) {
  const [config, metric] = row.split(/:(.*)/s);
  if (config === STANDALONE) {
    const s = (report.standalone ?? []).find((x) => x.file === metric);
    return s ? { value: s.gzip ?? null, budget: s.limit ?? null, found: true } : { value: null, budget: null, found: false };
  }
  const f = (report.fixtures ?? []).find((x) => x.name === config);
  if (!f) return { value: null, budget: null, found: false };
  const budget = (f.budgets ?? []).find((b) => b.key === metric);
  return { value: f.metrics?.[metric] ?? null, budget: budget?.limit ?? null, found: true };
}

function stageBaseReport(config) {
  if (!config.stageBase) return { report: null, note: 'no stage base commit in the configuration' };
  try {
    const text = execFileSync('git', ['show', `${config.stageBase}:${config.report}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
    return { report: JSON.parse(text), note: `growth since the report of ${config.stageBase}` };
  } catch {
    return { report: null, note: `the report of ${config.stageBase} is not available here (a shallow clone has only the checked-out commit), so the growth since the stage base is not shown` };
  }
}

function gate(config, report, baseline, stage, base) {
  const problems = [];
  const rows = [];
  const key = String(stage);
  for (const group of config.groups) {
    if (!(key in group.growth)) problems.push(`group "${group.name}" has no growth allowance for stage ${stage}`);
    const allowed = group.growth[key] ?? null;
    for (const row of group.rows) {
      const now = lookup(report, row);
      const was = lookup(baseline, row);
      const before = base ? lookup(base, row).value : null;
      const cap = group.cap === 'budget' ? now.budget : group.cap;
      const out = { row, group: group.name, baseline: was.value, value: now.value, delta: null, allowed, cap, sinceBase: null, status: 'ok' };
      rows.push(out);
      if (!was.found) {
        problems.push(`${row}: not in the baseline report, so it cannot be gated`);
        out.status = 'no baseline';
        continue;
      }
      if (!now.found) {
        problems.push(`${row}: not in the measured report`);
        out.status = 'missing';
        continue;
      }
      if (was.value === null || now.value === null) {
        if (was.value !== now.value) {
          problems.push(`${row}: measured ${fmt(now.value)} B against a baseline of ${fmt(was.value)} B`);
          out.status = 'changed';
        }
        continue;
      }
      out.delta = now.value - was.value;
      out.sinceBase = before === null ? null : now.value - before;
      if (allowed !== null && out.delta > allowed) {
        problems.push(`${row}: ${fmt(now.value)} B is ${fmt(out.delta)} B above the 0.3.0 baseline of ${fmt(was.value)} B, stage ${stage} allows ${fmt(allowed)} B (${group.name})`);
        out.status = 'over share';
      }
      if (cap === null || cap === undefined) {
        problems.push(`${row}: has no budget in the measured report to use as its cap`);
        out.status = 'no cap';
      } else if (now.value > cap) {
        problems.push(`${row}: ${fmt(now.value)} B is above its cap of ${fmt(cap)} B (${group.name})`);
        out.status = 'over cap';
      }
    }
  }
  const gatedTriggers = new Set(rows.filter((r) => r.row.endsWith(':trigger')).map((r) => r.row.split(':')[0]));
  for (const f of baseline.fixtures ?? []) {
    if (!gatedTriggers.has(f.name)) problems.push(`configuration ${f.name} of the baseline has no gated critical path row`);
  }
  const added = (report.fixtures ?? []).map((f) => f.name).filter((n) => !(baseline.fixtures ?? []).some((f) => f.name === n));
  return { rows, problems, added };
}

function printTable(result, stage, baseNote) {
  const head = ['row', 'baseline', 'measured', 'delta', `stage ${stage} allows`, 'cap', 'since base', 'status'];
  const body = result.rows.map((r) => [r.row, fmt(r.baseline), fmt(r.value), signed(r.delta), r.allowed === null ? 'any' : fmt(r.allowed), fmt(r.cap), signed(r.sinceBase), r.status]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(line(head));
  for (const b of body) console.log(line(b));
  console.log(`since base: ${baseNote}`);
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
  const config = readJson(fromRoot(values.config ?? 'scripts/size-gate.json'), 'gate configuration');
  const report = readJson(fromRoot(values.report ?? config.report), 'report');
  const baseline = readJson(fromRoot(values.baseline ?? config.baseline), 'baseline');
  const stage = values.stage === undefined ? config.stage : Number(values.stage);
  if (!Number.isInteger(stage) || stage < 1) {
    console.error(`the stage must be a positive integer, got ${values.stage ?? config.stage}`);
    return 2;
  }
  const base = stageBaseReport(config);
  const result = gate(config, report, baseline, stage, base.report);
  printTable(result, stage, base.note);
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(`FAIL ${p}`);
    console.error(`size gate: ${result.problems.length} problem(s) at stage ${stage}`);
    return 1;
  }
  console.log(`size gate: ${result.rows.length} rows within the stage ${stage} allowances and caps`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
}
