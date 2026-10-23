import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(REPO_ROOT, 'tests', 'consumers', 'fixtures');
const INSTALLED = ['vite', 'mp4box', 'mediabunny', 'react', 'react-dom'];

export const FIXTURES = [
  { name: 'default', imports: ['./lazy'], engines: ['own'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/', 'video-fps-probe/dist/engines/'] },
  {
    name: 'custom',
    imports: ['./client/lazy', './worker-runtime'],
    note: 'host worker serving own',
    engines: ['own'],
    workers: ['fps.worker'],
    mustNot: ['video-fps-probe/dist/plugins/own.js', 'video-fps-probe/dist/worker/own.worker.js', 'node_modules/mp4box/', 'node_modules/mediabunny/'],
  },
  { name: 'mp4box', imports: ['./lazy', './mp4box'], engines: ['own', 'mp4box'], workers: ['own.worker', 'mp4box.worker'], mustNot: ['node_modules/mediabunny/'] },
  { name: 'mediabunny', imports: ['./lazy', './mediabunny'], engines: ['own', 'mediabunny'], workers: ['own.worker', 'mediabunny.worker'], mustNot: ['node_modules/mp4box/'] },
  { name: 'rvfc', imports: ['./lazy', './rvfc'], engines: ['own', 'rvfc'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/'] },
  { name: 'all', imports: ['./lazy', './mp4box', './mediabunny', './rvfc'], engines: ['own', 'mp4box', 'mediabunny', 'rvfc'], workers: ['own.worker', 'mp4box.worker', 'mediabunny.worker'], mustNot: [] },
  {
    name: 'iife-nosplit',
    imports: ['./lazy'],
    note: 'Vite worker format iife with codeSplitting false',
    engines: ['own'],
    workers: ['own.worker'],
    singleFileWorkers: true,
    mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/'],
  },
];

export function consumersDir(arg) {
  return resolve(arg ?? process.env.CONSUMERS_DIR ?? join(tmpdir(), 'video-fps-probe-consumers'));
}

export const fixtureRoot = (dir, name) => join(dir, 'fixtures', name);
export const fixtureDist = (dir, name) => join(fixtureRoot(dir, name), 'dist');
export const installedPackage = (dir) => join(dir, 'node_modules', 'video-fps-probe');

function viteBin(dir) {
  const bin = join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(bin)) throw new Error(`${bin} not found: run node scripts/consumers.mjs setup --dir ${dir} first`);
  return bin;
}

export function setup(dir) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.tgz')) rmSync(join(dir, f));
  const out = execSync(`npm pack --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const [{ filename }] = JSON.parse(out.slice(out.indexOf('[')));
  const dependencies = { 'video-fps-probe': `file:./${filename}` };
  for (const name of INSTALLED) {
    const version = manifest.devDependencies[name];
    if (!version) throw new Error(`${name} is not a devDependency of ${manifest.name}`);
    dependencies[name] = version;
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'video-fps-probe-consumers', private: true, type: 'module', dependencies }, null, 2)}\n`);
  rmSync(join(dir, 'node_modules', 'video-fps-probe'), { recursive: true, force: true });
  execSync('npm install --prefer-offline --no-audit --no-fund --no-package-lock', { cwd: dir, stdio: 'inherit' });
  console.log(`installed ${filename}, ${INSTALLED.map((n) => `${n}@${dependencies[n]}`).join(', ')} into ${dir}`);
}

export function copyFixtures(dir) {
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  cpSync(join(SOURCES, 'vite.base.ts'), join(dir, 'fixtures', 'vite.base.ts'));
  for (const { name } of FIXTURES) {
    const root = fixtureRoot(dir, name);
    rmSync(root, { recursive: true, force: true });
    cpSync(join(SOURCES, name), root, { recursive: true });
    if (!existsSync(join(root, 'index.html'))) cpSync(join(SOURCES, 'index.html'), join(root, 'index.html'));
  }
}

export function build(dir, names = FIXTURES.map((f) => f.name)) {
  const vite = viteBin(dir);
  copyFixtures(dir);
  for (const name of names) {
    execFileSync(process.execPath, [vite, 'build', '--emptyOutDir'], { cwd: fixtureRoot(dir, name), stdio: 'inherit' });
    console.log(`built ${name}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { dir: { type: 'string' }, only: { type: 'string' } }, allowPositionals: true, strict: true });
  const dir = consumersDir(values.dir);
  const [command] = positionals;
  if (command === 'setup') setup(dir);
  else if (command === 'build') build(dir, values.only ? values.only.split(',') : undefined);
  else {
    console.error('Usage: node scripts/consumers.mjs setup|build [--dir <consumers dir>] [--only <fixture,...>]');
    process.exitCode = 2;
  }
}
