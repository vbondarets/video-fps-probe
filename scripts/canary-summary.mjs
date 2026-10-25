import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERDICTS = ['exact', 'within-tol', 'known-deviation', 'mismatch', 'n/a'];
const LISTED = 40;

const USAGE = `Usage: node scripts/canary-summary.mjs --measured <accuracy.json> [--committed <accuracy.json>] [--matrix <size-matrix.json>] [--summary <file>]

Compares a compare-ffprobe run against the committed report/accuracy.json, fixture by fixture, on the
fixtures both runs have, and prints a Markdown summary: per arm the library version, the verdict counts
and the fixtures whose checks changed. --matrix adds the versions the size matrix measured and its
failures. --summary appends the Markdown to a file, such as $GITHUB_STEP_SUMMARY, instead of printing it.

Exits 1 when a check of the own engine changed, 0 when only library arms changed.
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

const arrow = (a, b) => (a === b ? `${a ?? '-'}` : `${a ?? '-'} → ${b ?? '-'}`);

export function renderSummary(arms, matrix = null, peers = {}) {
  const out = ['## Canary', ''];
  const own = arms.filter((a) => a.own);
  const ownChanged = own.some((a) => a.changed.length > 0 || a.loadSkipped.after !== a.loadSkipped.before);
  out.push(ownChanged ? '**The own engine changed: the canary fails.**' : 'The own engine is unchanged.');
  out.push('');
  if (matrix) {
    const v = matrix.versions ?? {};
    out.push(`Consumer build with Vite ${v.vite ?? '-'}, rolldown ${v.rolldown ?? '-'}, mp4box ${v.mp4box ?? '-'} and mediabunny ${v.mediabunny ?? '-'}: ${matrix.failures.length === 0 ? 'every size budget and check passes.' : `${matrix.failures.length} size matrix failure(s).`}`);
    for (const f of matrix.failures) out.push(`- ${f}`);
    out.push('');
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
  out.push('');
  return { markdown: out.join('\n'), ownChanged };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function main() {
  const { values } = parseArgs({
    options: { measured: { type: 'string' }, committed: { type: 'string' }, matrix: { type: 'string' }, summary: { type: 'string' }, help: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.help || !values.measured) {
    console[values.help ? 'log' : 'error'](USAGE);
    return values.help ? 0 : 2;
  }
  const committed = readJson(values.committed ?? join(REPO_ROOT, 'report', 'accuracy.json'));
  const matrix = values.matrix && existsSync(values.matrix) ? readJson(values.matrix) : null;
  const { peerDependencies = {} } = readJson(join(REPO_ROOT, 'package.json'));
  const { markdown, ownChanged } = renderSummary(diffReports(committed, readJson(values.measured)), matrix, peerDependencies);
  if (values.summary) appendFileSync(values.summary, `${markdown}\n`);
  else console.log(markdown);
  if (ownChanged) console.error('FAIL: a check of the own engine differs from the committed report/accuracy.json');
  return ownChanged ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
