import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM_ENV = { ...process.env, npm_config_update_notifier: 'false' };
const UNRELEASED = '## Unreleased';
const BUMPED = ['package.json', 'package-lock.json'];
export const GENERATED = ['CHANGELOG.md', 'report/size.md', 'report/size.json', 'report/size-matrix.md', 'report/size-matrix.json', 'README.md', 'docs/benchmarks.md', 'docs/bundlers.md', 'report/README.md'];

const USAGE = `Usage: node scripts/release-prep.mjs [--preversion | --notes <version> [--out <file>] | --publish-check <tag>]

  (no option)        the npm "version" step, after npm bumped package.json and package-lock.json:
                     moves the CHANGELOG Unreleased section under the new version and today's date
                     (the intro before its first ### heading is dropped and printed),
                     rebuilds the demo and report/size.*, rebuilds the consumer fixtures from the new
                     tarball (CONSUMERS_OFFLINE=1) and report/size-matrix.*, regenerates the doc tables
                     and stages exactly the files that changed, so npm commits them with the bump
  --preversion       the npm "preversion" step: refuses a dirty tree, an empty Unreleased section,
                     "private": true in package.json or an unset git user.name or user.email, prints
                     the git identity of the release commit and runs the fast gates
  --notes <version>  prints the CHANGELOG section of a version, for the GitHub Release
  --out <file>       with --notes: writes the section to <file> (UTF-8, LF line ends) instead and
                     prints the absolute path, for gh release create --notes-file <file>
  --publish-check <tag>
                     the check of the Release workflow before npm publish: fails unless the tag is
                     v plus the package.json version, "private" is not true and npm is 11.5.1 or
                     later (trusted publishing), and prints the dist-tag: next for a prerelease,
                     else latest

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

function splitIntro(body) {
  const first = body.findIndex((line) => line.startsWith('### '));
  return first > 0 ? { intro: body.slice(0, first), rest: body.slice(first) } : { intro: [], rest: body };
}

export function unreleasedIntro(text) {
  return splitIntro(unreleased(text.replace(/\r\n/g, '\n').split('\n')).body).intro.join('\n').trim();
}

export function releaseChangelog(text, version, date) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const { start, end, body } = unreleased(lines);
  if (lines.some((line) => isVersionHeading(line, version))) throw new Error(`CHANGELOG.md already has a ${version} section`);
  const { rest } = splitIntro(body);
  const lead = rest[0]?.trim() === '' ? [] : [''];
  const out = [...lines.slice(0, start), UNRELEASED, '', `## ${version} - ${date}`, ...lead, ...rest, ...lines.slice(end)];
  return out.join('\n').replace(/\n/g, eol);
}

export function gitIdentity(configValue) {
  const name = configValue('user.name');
  const email = configValue('user.email');
  if (!name || !email) {
    throw new Error(`git user.name and user.email must both be set for the release commit and tag (user.name: ${name || 'not set'}, user.email: ${email || 'not set'})`);
  }
  return `${name} <${email}>`;
}

export function publicManifest(manifest) {
  if (manifest.private === true) throw new Error('package.json has "private": true, which npm refuses to publish: commit "private": false before the release (docs/releasing.md)');
}

export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => isVersionHeading(line, version));
  if (start < 0) throw new Error(`CHANGELOG.md has no ${version} section`);
  return section(lines, start).body.join('\n').trim();
}

export function writeNotes(text, version, out) {
  const notes = changelogSection(text, version);
  if (!notes) throw new Error(`the ${version} section of CHANGELOG.md is empty: no release notes to write`);
  if (!out) throw new Error('--out needs the path of the release notes file');
  const path = resolve(out);
  writeFileSync(path, `${notes}\n`);
  return path;
}

const TRUSTED_NPM = [11, 5, 1];

export function publishCheck(manifest, tag, npmVersion) {
  const problems = [];
  if (tag !== `v${manifest.version}`) problems.push(`the tag ${tag} is not v${manifest.version}, the version in package.json`);
  if (manifest.private === true) problems.push('package.json has "private": true, which npm refuses to publish');
  const npm = String(npmVersion).split('.').map((n) => parseInt(n, 10));
  const newer = TRUSTED_NPM.findIndex((n, i) => npm[i] !== n);
  if (!(newer === -1 || npm[newer] > TRUSTED_NPM[newer])) problems.push(`npm ${npmVersion} is older than ${TRUSTED_NPM.join('.')}, the first version with trusted publishing`);
  if (problems.length > 0) throw new Error(`not publishable: ${problems.join('; ')}`);
  return manifest.version.includes('-') ? 'next' : 'latest';
}

export function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trimEnd();
const gitConfig = (key) => {
  try {
    return git('config', key);
  } catch {
    return '';
  }
};
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
  publicManifest(JSON.parse(read('package.json')));
  console.log(`release commit and tag as ${gitIdentity(gitConfig)}`);
  for (const [tool, args] of PREVERSION_GATES) run(tool, args);
}

function version() {
  const { version: next } = JSON.parse(read('package.json'));
  const unexpected = statusLines().filter((line) => !BUMPED.includes(pathOf(line)));
  if (unexpected.length > 0) throw new Error(`files other than ${BUMPED.join(' and ')} changed before the version step:\n${unexpected.join('\n')}`);
  const before = new Map(GENERATED.map((rel) => [rel, read(rel)]));
  const intro = unreleasedIntro(before.get('CHANGELOG.md'));
  if (intro) console.log(`dropped the Unreleased intro, which is not part of the ${next} section:\n${intro}`);
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
  const { values } = parseArgs({
    options: { preversion: { type: 'boolean', default: false }, notes: { type: 'string' }, out: { type: 'string' }, 'publish-check': { type: 'string' }, help: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.out !== undefined && !values.notes) throw new Error('--out <file> writes the release notes and needs --notes <version>');
  if (values['publish-check']) console.log(publishCheck(JSON.parse(read('package.json')), values['publish-check'], execSync('npm --version', { env: NPM_ENV, encoding: 'utf8' }).trim()));
  else if (values.notes && values.out !== undefined) console.log(writeNotes(read('CHANGELOG.md'), values.notes, values.out));
  else if (values.notes) console.log(changelogSection(read('CHANGELOG.md'), values.notes));
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
