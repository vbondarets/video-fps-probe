import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERDICTS = ['exact', 'within-tol', 'known-deviation', 'mismatch', 'n/a'];
const LISTED = 40;

const USAGE = `Usage: node scripts/canary-summary.mjs --measured <accuracy.json> [--committed <accuracy.json>] [--matrix <size-matrix.json>] [--committed-matrix <size-matrix.json>] [--smoke <dir>] [--summary <file>]

Compares a compare-ffprobe run against the committed report/accuracy.json, fixture by fixture, on the
fixtures both runs have, and prints a Markdown summary: per arm the library version, the verdict counts
and the fixtures whose checks changed. --matrix adds the versions the size matrix measured and its
failures, and, from a size matrix written with --third-party-informational, every budget that measures
mp4box or mediabunny code with its size in --committed-matrix (default report/size-matrix.json) and
in the canary. --smoke adds the mp4box and mediabunny runs that the consumer smoke test recorded in <dir>
with CONSUMERS_LIBRARY_REPORT=<dir>, where it asserts the own engine only: each run that does not equal
Node analyze from the same tarball. --summary appends the Markdown to a file, such as
$GITHUB_STEP_SUMMARY, instead of printing it.

Exits 1 when a check of the own engine changed, 0 when only library arms changed, in the comparison or
in the smoke test.
`;

function checkStates(fixture) {
  const states = new Map([['result', `${fixture.appError ?? ''}|${fixture.threw ?? ''}`]]);
  for (const c of [...fixture.fileChecks, ...fixture.tracks.flatMap((t) => t.checks)]) {
    const base = `${c.trackId ?? 'file'}.${c.id}${c.sub ? `.${c.sub}` : ''}`;
    let key = base;
    for (let n = 2; states.has(key); n++) key = `${base}#${n}`;
    states.set(key, `${c.verdict}${c.outcome ? ` (${c.outcome})` : ''}: ${c.app ?? '-'}`);
  }
  return states;
}

function tally(fixtures) {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const f of fixtures) for (const c of [...f.fileChecks, ...f.tracks.flatMap((t) => t.checks)]) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
  return counts;
}

export function diffReports(committed, measured) {
  return measured.engines.map((m) => {
    const c = committed.engines.find((e) => e.engine === m.engine) ?? null;
    const before = new Map((c?.fixtures ?? []).map((f) => [f.name, f]));
    const common = m.fixtures.filter((f) => before.has(f.name));
    const changed = [];
    for (const f of common) {
      const a = checkStates(before.get(f.name));
      const b = checkStates(f);
      const checks = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map((k) => ({ check: k, before: a.get(k) ?? null, after: b.get(k) ?? null }));
      if (checks.length > 0) changed.push({ fixture: f.name, checks });
    }
    return {
      engine: m.engine,
      own: m.engine === 'own',
      version: { before: c?.arm.version ?? null, after: m.arm.version ?? null },
      loadSkipped: { before: c?.loadSkipped ?? null, after: m.loadSkipped ?? null },
      compared: common.length,
      counts: { before: tally(common.map((f) => before.get(f.name))), after: tally(common) },
      changed,
    };
  });
}

const numbers = (v) => v.split('.').map(Number);

function caret(version, base) {
  if (version.includes('-')) return false;
  const [a, b, c] = numbers(version);
  const [x, y, z] = numbers(base);
  if (x > 0) return a === x && (b > y || (b === y && c >= z));
  if (y > 0) return a === 0 && b === y && c >= z;
  return a === 0 && b === 0 && c === z;
}

export const satisfies = (version, range) => range.split('||').some((r) => (r.trim().startsWith('^') ? caret(version, r.trim().slice(1)) : r.trim() === version));

export function outsidePeers(peers, versions) {
  return Object.entries(peers)
    .filter(([name]) => typeof versions[name] === 'string')
    .filter(([name, range]) => !satisfies(versions[name], range))
    .map(([name, range]) => `${name} ${versions[name]} is outside the peer range ${range} of the package`);
}

const kb = (n) => (n === null || n === undefined ? '-' : `${(n / 1000).toFixed(2)} KB`);

const change = (before, after) => {
  if (typeof before !== 'number' || typeof after !== 'number') return '-';
  const text = kb(Math.abs(after - before));
  return after > before ? `+${text}` : after < before ? `-${text}` : text;
};

export function engineBudgetRows(matrix, committed = null) {
  return (matrix?.informational ?? []).map((b) => ({ ...b, before: committed?.fixtures?.find((f) => f.name === b.fixture)?.budgets.find((x) => x.key === b.key)?.gzip ?? null }));
}

export function renderEngineBudgets(rows, matrix = null, committed = null) {
  const versions = (v) => `mp4box ${v?.mp4box ?? '-'} and mediabunny ${v?.mediabunny ?? '-'}`;
  const over = rows.filter((r) => r.status === 'over').length;
  return [
    '### Third-party engine budgets',
    '',
    `Informational: these budgets measure mp4box or mediabunny code, so the canary reports them and does not fail on them. CI enforces them with the locked versions. ${over} of ${rows.length} are over their limit. Committed: report/size-matrix.json, ${versions(committed?.versions)}. Canary: ${versions(matrix?.versions)}.`,
    '',
    '| Configuration | Budget | Limit | Committed | Canary | Change | Status |',
    '|---|---|---:|---:|---:|---:|---|',
    ...rows.map((r) => `| ${r.fixture} | ${r.label} | ${kb(r.limit)} | ${kb(r.before)} | ${kb(r.gzip)} | ${change(r.before, r.gzip)} | ${r.status} |`),
  ];
}

const arrow = (a, b) => (a === b ? `${a ?? '-'}` : `${a ?? '-'} → ${b ?? '-'}`);

const cell = (text) => String(text).replaceAll('|', '\\|').replace(/\s+/g, ' ');

export function renderSmoke(runs) {
  const out = ['### Library arms in the consumer smoke test', ''];
  if (runs.length === 0) {
    out.push('The consumer smoke test recorded no run of mp4box or mediabunny.');
    return out;
  }
  const off = runs.filter((r) => r.outcome !== 'equal');
  out.push(`Informational: the smoke test asserts the own engine only. ${runs.length - off.length} of ${runs.length} runs of mp4box and mediabunny in the browsers equal Node analyze from the same tarball.`);
  if (off.length === 0) return out;
  out.push('', '| Browser | Fixture | Mode | File | Arm | Outcome |', '|---|---|---|---|---|---|');
  for (const r of off.slice(0, LISTED)) out.push(`| ${r.browser} | ${r.fixture} | ${r.mode} | \`${r.file}\` | ${r.engine} | ${r.outcome}${r.detail ? `: ${cell(r.detail)}` : ''} |`);
  if (off.length > LISTED) out.push('', `And ${off.length - LISTED} more run(s), in the uploaded smoke reports.`);
  return out;
}

export function renderSummary(arms, matrix = null, peers = {}, smoke = null, committedMatrix = null) {
  const out = ['## Canary', ''];
  const own = arms.filter((a) => a.own);
  const ownChanged = own.some((a) => a.changed.length > 0 || a.loadSkipped.after !== a.loadSkipped.before);
  out.push(ownChanged ? '**The own engine changed: the canary fails.**' : 'The own engine is unchanged.');
  out.push('');
  if (matrix) {
    const v = matrix.versions ?? {};
    const rows = engineBudgetRows(matrix, committedMatrix);
    const over = rows.filter((r) => r.status === 'over').length;
    const passes = over === 0 ? 'every size budget and check passes.' : `every size budget of own code and every check passes, and ${over} third-party engine budget(s) are over their limit, informational.`;
    out.push(`Consumer build with Vite ${v.vite ?? '-'}, rolldown ${v.rolldown ?? '-'}, mp4box ${v.mp4box ?? '-'} and mediabunny ${v.mediabunny ?? '-'}: ${matrix.failures.length === 0 ? passes : `${matrix.failures.length} size matrix failure(s).`}`);
    for (const f of matrix.failures) out.push(`- ${f}`);
    out.push('');
    if (rows.length > 0) out.push(...renderEngineBudgets(rows, matrix, committedMatrix), '');
  }
  const versions = { ...Object.fromEntries(arms.filter((a) => a.version.after).map((a) => [a.engine.split('-')[0], a.version.after])), ...matrix?.versions };
  const outside = outsidePeers(peers, versions);
  if (outside.length > 0) {
    out.push('Installed with --legacy-peer-deps:');
    for (const line of outside) out.push(`- ${line}`);
    out.push('');
  }
  out.push('### Arms against the committed references');
  out.push('');
  out.push(`Compared fixture by fixture on the fixtures both runs have (${arms[0]?.compared ?? 0} for the first arm); the committed report also covers fixtures/large.`);
  out.push('');
  out.push(`| Arm | Version | ${VERDICTS.join(' | ')} | Changed fixtures |`);
  out.push(`|---|---|${VERDICTS.map(() => '---:').join('|')}|---:|`);
  for (const a of arms) {
    const version = a.loadSkipped.after ? `skipped: ${a.loadSkipped.after}` : arrow(a.version.before, a.version.after);
    out.push(`| ${a.engine} | ${version} | ${VERDICTS.map((v) => arrow(a.counts.before[v], a.counts.after[v])).join(' | ')} | ${a.changed.length} |`);
  }
  for (const a of arms.filter((x) => x.changed.length > 0)) {
    out.push('');
    out.push(`<details><summary>${a.engine}: ${a.changed.length} fixture(s) changed</summary>`);
    out.push('');
    const lines = a.changed.flatMap((f) => f.checks.map((c) => `- \`${f.fixture}\` ${c.check}: ${c.before ?? '(none)'} → ${c.after ?? '(none)'}`));
    out.push(...lines.slice(0, LISTED));
    if (lines.length > LISTED) out.push(`- and ${lines.length - LISTED} more check(s), in the uploaded accuracy report`);
    out.push('');
    out.push('</details>');
  }
  if (smoke) out.push('', ...renderSmoke(smoke));
  out.push('');
  return { markdown: out.join('\n'), ownChanged };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export const readSmoke = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .flatMap((f) => readJson(join(dir, f)))
    : [];

function main() {
  const { values } = parseArgs({
    options: { measured: { type: 'string' }, committed: { type: 'string' }, matrix: { type: 'string' }, 'committed-matrix': { type: 'string' }, smoke: { type: 'string' }, summary: { type: 'string' }, help: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.help || !values.measured) {
    console[values.help ? 'log' : 'error'](USAGE);
    return values.help ? 0 : 2;
  }
  const committed = readJson(values.committed ?? join(REPO_ROOT, 'report', 'accuracy.json'));
  const matrix = values.matrix && existsSync(values.matrix) ? readJson(values.matrix) : null;
  const committedMatrixPath = values['committed-matrix'] ?? join(REPO_ROOT, 'report', 'size-matrix.json');
  const committedMatrix = existsSync(committedMatrixPath) ? readJson(committedMatrixPath) : null;
  const { peerDependencies = {} } = readJson(join(REPO_ROOT, 'package.json'));
  const { markdown, ownChanged } = renderSummary(diffReports(committed, readJson(values.measured)), matrix, peerDependencies, values.smoke ? readSmoke(values.smoke) : null, committedMatrix);
  if (values.summary) appendFileSync(values.summary, `${markdown}\n`);
  else console.log(markdown);
  if (ownChanged) console.error('FAIL: a check of the own engine differs from the committed report/accuracy.json');
  return ownChanged ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
