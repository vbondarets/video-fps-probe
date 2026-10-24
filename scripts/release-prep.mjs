import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM_ENV = { ...process.env, npm_config_update_notifier: 'false' };
const UNRELEASED = '## Unreleased';
const BUMPED = ['package.json', 'package-lock.json'];
export const GENERATED = ['CHANGELOG.md', 'report/size.md', 'report/size.json', 'report/size-matrix.md', 'report/size-matrix.json', 'README.md', 'docs/benchmarks.md', 'docs/bundlers.md'];

const USAGE = `Usage: node scripts/release-prep.mjs [--preversion | --notes <version>]

  (no option)        the npm "version" step, after npm bumped package.json and package-lock.json:
                     moves the CHANGELOG Unreleased section under the new version and today's date,
                     rebuilds the demo and report/size.*, rebuilds the consumer fixtures from the new
                     tarball (CONSUMERS_OFFLINE=1) and report/size-matrix.*, regenerates the doc tables
                     and stages exactly the files that changed, so npm commits them with the bump
  --preversion       the npm "preversion" step: refuses a dirty tree or an empty Unreleased section,
                     prints the git identity of the release commit and runs the fast gates
  --notes <version>  prints the CHANGELOG section of a version, for the GitHub Release

Release: npm version minor -m "chore(release): bumped the version to %s" (docs/releasing.md).
`;

const PREVERSION_GATES = [
  ['npm', 'run typecheck'],
  ['npm', 'run lint'],
  ['npm', 'run check:aliases'],
  ['npm', 'test -- --maxWorkers=4'],
  ['node', 'scripts/compare-ffprobe.ts --self-test'],
  ['node', 'scripts/compare-ffprobe.ts --no-write'],
  ['node', 'scripts/size-report.mjs --self-test'],
  ['node', 'scripts/check-dist.mjs --self-test'],
  ['node', 'scripts/readme-tables.ts --check'],
];

const isSectionHeading = (line) => line.startsWith('## ');
const isVersionHeading = (line, version) => line === `## ${version}` || line.startsWith(`## ${version} `);

function section(lines, start) {
  let end = start + 1;
  while (end < lines.length && !isSectionHeading(lines[end])) end++;
  return { start, end, body: lines.slice(start + 1, end) };
}

function unreleased(lines) {
  const start = lines.indexOf(UNRELEASED);
  if (start < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading`);
  const found = section(lines, start);
  if (found.body.every((line) => line.trim() === '')) throw new Error('the Unreleased section of CHANGELOG.md is empty: nothing to release');
  return found;
}

export function releaseChangelog(text, version, date) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const { start, end, body } = unreleased(lines);
  if (lines.some((line) => isVersionHeading(line, version))) throw new Error(`CHANGELOG.md already has a ${version} section`);
  const lead = body[0]?.trim() === '' ? [] : [''];
  const out = [...lines.slice(0, start), UNRELEASED, '', `## ${version} - ${date}`, ...lead, ...body, ...lines.slice(end)];
  return out.join('\n').replace(/\n/g, eol);
}

export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => isVersionHeading(line, version));
  if (start < 0) throw new Error(`CHANGELOG.md has no ${version} section`);
  return section(lines, start).body.join('\n').trim();
}

export function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const statusLines = () => git('status', '--porcelain').split('\n').filter(Boolean);
const pathOf = (statusLine) => statusLine.slice(3).replace(/^"|"$/g, '');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

function run(tool, args, env = NPM_ENV) {
  console.log(`\n> ${tool} ${args}`);
  if (tool === 'node') execFileSync(process.execPath, args.split(' '), { cwd: REPO_ROOT, env, stdio: 'inherit' });
  else execSync(`${tool} ${args}`, { cwd: REPO_ROOT, env, stdio: 'inherit' });
}

function preversion() {
  const dirty = statusLines();
  if (dirty.length > 0) throw new Error(`the working tree is not clean, commit or stash first:\n${dirty.join('\n')}`);
  unreleased(read('CHANGELOG.md').replace(/\r\n/g, '\n').split('\n'));
  console.log(`release commit and tag as ${git('config', 'user.name')} <${git('config', 'user.email')}>`);
  for (const [tool, args] of PREVERSION_GATES) run(tool, args);
}

function version() {
  const { version: next } = JSON.parse(read('package.json'));
  const unexpected = statusLines().filter((line) => !BUMPED.includes(pathOf(line)));
  if (unexpected.length > 0) throw new Error(`files other than ${BUMPED.join(' and ')} changed before the version step:\n${unexpected.join('\n')}`);
  const before = new Map(GENERATED.map((rel) => [rel, read(rel)]));
  writeFileSync(join(REPO_ROOT, 'CHANGELOG.md'), releaseChangelog(before.get('CHANGELOG.md'), next, localDate()));
  run('npm', 'run build:demo');
  run('node', 'scripts/size-report.mjs demo/dist --check');
  run('node', 'scripts/consumers.mjs setup', { ...NPM_ENV, CONSUMERS_OFFLINE: '1' });
  run('node', 'scripts/consumers.mjs build');
  run('node', 'scripts/size-matrix.mjs');
  run('node', 'scripts/size-matrix.mjs --check');
  run('node', 'scripts/readme-tables.ts');
  run('node', 'scripts/readme-tables.ts --check');
  const changed = GENERATED.filter((rel) => read(rel) !== before.get(rel));
  git('add', '--', ...changed);
  const stray = statusLines().filter((line) => line[1] !== ' ' && !BUMPED.includes(pathOf(line)));
  if (stray.length > 0) throw new Error(`the version step changed files it does not stage:\n${stray.join('\n')}`);
  console.log(`\nstaged for ${next}: ${changed.join(', ')}`);
}

function main() {
  const { values } = parseArgs({ options: { preversion: { type: 'boolean', default: false }, notes: { type: 'string' }, help: { type: 'boolean', default: false } }, strict: true });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.notes) console.log(changelogSection(read('CHANGELOG.md'), values.notes));
  else if (values.preversion) preversion();
  else version();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`release-prep: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
