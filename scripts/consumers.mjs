import { execFileSync, execSync } from 'node:child_process';
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(REPO_ROOT, 'tests', 'consumers', 'fixtures');
const INSTALLED = ['vite', 'mp4box', 'mediabunny', 'react', 'react-dom'];

const ES = "format: 'es'";

export const FIXTURES = [
  { name: 'default', imports: ['./lazy'], worker: ES, engines: ['own'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/', 'video-fps-probe/dist/engines/'] },
  {
    name: 'zero-config',
    imports: ['./lazy'],
    worker: "none, so Vite's default format: 'iife'",
    engines: ['own'],
    workers: ['own.worker'],
    singleFileWorkers: true,
    mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/', 'video-fps-probe/dist/engines/'],
  },
  {
    name: 'custom',
    imports: ['./client/lazy', './worker-runtime'],
    note: 'host worker serving own',
    worker: ES,
    engines: ['own'],
    workers: ['fps.worker'],
    mustNot: ['video-fps-probe/dist/plugins/own.js', 'video-fps-probe/dist/worker/own.worker.js', 'node_modules/mp4box/', 'node_modules/mediabunny/'],
  },
  { name: 'mp4box', imports: ['./lazy', './mp4box'], worker: ES, engines: ['own', 'mp4box'], workers: ['own.worker', 'mp4box.worker'], mustNot: ['node_modules/mediabunny/'] },
  { name: 'mediabunny', imports: ['./lazy', './mediabunny'], worker: ES, engines: ['own', 'mediabunny'], workers: ['own.worker', 'mediabunny.worker'], mustNot: ['node_modules/mp4box/'] },
  { name: 'rvfc', imports: ['./lazy', './rvfc'], worker: ES, engines: ['own', 'rvfc'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/'] },
  { name: 'all', imports: ['./lazy', './mp4box', './mediabunny', './rvfc'], worker: ES, engines: ['own', 'mp4box', 'mediabunny', 'rvfc'], workers: ['own.worker', 'mp4box.worker', 'mediabunny.worker'], mustNot: [] },
  {
    name: 'standalone-url',
    imports: ['./client/lazy', './standalone/own.worker.js?url'],
    note: 'classic worker from the standalone file',
    worker: 'none needed: the file is copied as an asset',
    engines: ['own'],
    workers: ['own.worker'],
    singleFileWorkers: true,
    mustNot: ['video-fps-probe/dist/plugins/own.js', 'video-fps-probe/dist/worker/own.worker.js', 'node_modules/mp4box/', 'node_modules/mediabunny/'],
  },
  {
    name: 'iife-nosplit',
    imports: ['./lazy'],
    worker: "format: 'iife', rolldownOptions.output.codeSplitting: false",
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
  execSync('npm run build:lib', { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-dist.mjs')], { cwd: REPO_ROOT, stdio: 'inherit' });
  const out = execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const [{ filename }] = JSON.parse(out);
  const dependencies = { 'video-fps-probe': `file:./${filename}` };
  for (const name of INSTALLED) {
    const version = manifest.devDependencies[name];
    if (!version) throw new Error(`${name} is not a devDependency of ${manifest.name}`);
    dependencies[name] = version;
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'video-fps-probe-consumers', private: true, type: 'module', dependencies }, null, 2)}\n`);
  rmSync(join(dir, 'node_modules', 'video-fps-probe'), { recursive: true, force: true });
  const offline = process.env.CONSUMERS_OFFLINE === '1';
  const userconfig = offline ? mkdtempSync(join(tmpdir(), 'video-fps-probe-npmrc-')) : null;
  try {
    if (userconfig) writeFileSync(join(userconfig, '.npmrc'), '');
    const mode = userconfig ? `--offline --userconfig "${join(userconfig, '.npmrc')}"` : '--prefer-offline';
    execSync(`npm install ${mode} --no-audit --no-fund --no-package-lock`, { cwd: dir, stdio: 'inherit' });
  } finally {
    if (userconfig) rmSync(userconfig, { recursive: true, force: true });
  }
  console.log(`installed ${filename}, ${INSTALLED.map((n) => `${n}@${dependencies[n]}`).join(', ')} into ${dir}${offline ? ' from the npm cache only' : ''}`);
}

export function copyFixtures(dir, names = FIXTURES.map((f) => f.name)) {
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  cpSync(join(SOURCES, 'vite.base.ts'), join(dir, 'fixtures', 'vite.base.ts'));
  for (const name of names) {
    const root = fixtureRoot(dir, name);
    rmSync(root, { recursive: true, force: true });
    cpSync(join(SOURCES, name), root, { recursive: true });
    if (!existsSync(join(root, 'index.html'))) cpSync(join(SOURCES, 'index.html'), join(root, 'index.html'));
  }
}

export function build(dir, names = FIXTURES.map((f) => f.name)) {
  const vite = viteBin(dir);
  copyFixtures(dir, names);
  for (const name of names) {
    execFileSync(process.execPath, [vite, 'build', '--emptyOutDir'], { cwd: fixtureRoot(dir, name), stdio: 'inherit' });
    console.log(`built ${name}`);
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json', '.css': 'text/css' };

export const buildUrl = (port, name) => `http://127.0.0.1:${port}/${name}/`;
export const devUrl = (port, name) => `http://127.0.0.1:${port + 1 + FIXTURES.findIndex((f) => f.name === name)}/`;

function serveBuilds(dir, port) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const [, name, ...rest] = path.split('/');
    const fixture = FIXTURES.find((f) => f.name === name);
    if (!fixture) {
      res.writeHead(path === '/' ? 200 : 404, { 'Content-Type': 'text/plain' }).end(FIXTURES.map((f) => f.name).join('\n'));
      return;
    }
    const root = fixtureDist(dir, fixture.name);
    const file = resolve(root, rest.join('/') || 'index.html');
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done, fail) => server.once('error', fail).listen(port, '127.0.0.1', () => done(server)));
}

export async function serve(dir, port) {
  for (const { name } of FIXTURES) if (!existsSync(join(fixtureDist(dir, name), 'index.html'))) throw new Error(`${name} is not built: run node scripts/consumers.mjs build --dir ${dir}`);
  const { createServer: createViteServer } = await import(pathToFileURL(join(dir, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  for (const { name } of FIXTURES) {
    const root = fixtureRoot(dir, name);
    rmSync(join(root, 'node_modules', '.vite'), { recursive: true, force: true });
    const url = new URL(devUrl(port, name));
    const vite = await createViteServer({ root, configFile: join(root, 'vite.config.ts'), server: { host: url.hostname, port: Number(url.port), strictPort: true } });
    await vite.listen();
  }
  await serveBuilds(dir, port);
  console.log(`serving the fixture builds on ${buildUrl(port, '<fixture>')} and the dev servers from port ${port + 1}`);
}

export const CONSUMERS_PORT = Number(process.env.CONSUMERS_PORT || 4400);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { dir: { type: 'string' }, only: { type: 'string' }, port: { type: 'string' } }, allowPositionals: true, strict: true });
  const dir = consumersDir(values.dir);
  const [command] = positionals;
  if (command === 'setup') setup(dir);
  else if (command === 'build') build(dir, values.only ? values.only.split(',') : undefined);
  else if (command === 'serve') await serve(dir, values.port ? Number(values.port) : CONSUMERS_PORT);
  else {
    console.error('Usage: node scripts/consumers.mjs setup|build|serve [--dir <consumers dir>] [--only <fixture,...>] [--port <n>]');
    console.error('CONSUMERS_OFFLINE=1 isolates only the npm install step of setup: it installs from the npm cache only (npm install --offline) with an empty npmrc as --userconfig.');
    console.error("Not isolated: npm run build:lib, the npm pack --dry-run of check-dist and npm pack run with your npm config, any token included. They fetch no packages, but npm's update check can contact the registry unless update-notifier is false.");
    process.exitCode = 2;
  }
}
