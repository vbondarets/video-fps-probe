import { execFileSync, execSync } from 'node:child_process';
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(REPO_ROOT, 'tests', 'consumers', 'fixtures');
const INSTALLED = ['vite', 'mp4box', 'mediabunny', 'react', 'react-dom'];
const REACT_18 = '18.3.1';
const REACT_18_OVERRIDES = { 'js-tokens': '4.0.0', 'loose-envify': '1.4.0', scheduler: '0.23.2' };
export const REACT_18_PINS = { react: REACT_18, 'react-dom': REACT_18, ...REACT_18_OVERRIDES };
const SHARED = ['vite.base.ts', 'react-app.ts'];
const DEV_DEPENDENCIES = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).devDependencies;
const NPM_ENV = { ...process.env, npm_config_update_notifier: 'false' };

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
  { name: 'react', imports: ['./lazy', './react'], note: `React ${DEV_DEPENDENCIES.react}`, worker: ES, engines: ['own'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/', 'video-fps-probe/dist/engines/'] },
  { name: 'react18', imports: ['./lazy', './react'], note: `React ${REACT_18}`, worker: ES, engines: ['own'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/', 'video-fps-probe/dist/engines/'] },
  { name: 'check', imports: ['./lazy', './check'], worker: ES, engines: ['own'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/', 'video-fps-probe/dist/engines/'] },
  { name: 'preset', imports: ['./lazy', './check', './presets'], note: 'klingO1ReferenceVideo', worker: ES, engines: ['own'], workers: ['own.worker'], mustNot: ['node_modules/mp4box/', 'node_modules/mediabunny/', 'video-fps-probe/dist/engines/'] },
];

function lockPath(packages, from, name) {
  for (let base = from; ; ) {
    const path = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[path]) return path;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

export function lockedOverrides(direct = INSTALLED) {
  const { packages } = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const pinned = new Map();
  const seen = new Set();
  for (const stack = direct.map((name) => [lockPath(packages, '', name), name]); stack.length > 0; ) {
    const [path, name] = stack.pop();
    if (!path) throw new Error(`package-lock.json does not resolve ${name}`);
    if (seen.has(path)) continue;
    seen.add(path);
    const { version, dependencies = {}, optionalDependencies = {} } = packages[path];
    if (pinned.has(name) && pinned.get(name) !== version) throw new Error(`package-lock.json resolves ${name} to ${pinned.get(name)} and ${version}; the consumer overrides pin one version per name`);
    pinned.set(name, version);
    for (const dep of Object.keys(dependencies)) stack.push([lockPath(packages, path, dep), dep]);
    for (const dep of Object.keys(optionalDependencies)) {
      const at = lockPath(packages, path, dep);
      if (at) stack.push([at, dep]);
    }
  }
  for (const name of direct) pinned.delete(name);
  return Object.fromEntries([...pinned].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function installedCopies(root) {
  const copies = [];
  const walk = (modules) => {
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const scope = join(modules, entry.name);
      const packages = entry.name.startsWith('@') ? readdirSync(scope, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(scope, e.name)) : [scope];
      for (const path of packages) {
        const manifest = join(path, 'package.json');
        if (existsSync(manifest)) {
          const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'));
          copies.push({ name, version, path });
        }
        walk(join(path, 'node_modules'));
      }
    }
  };
  walk(join(root, 'node_modules'));
  return copies;
}

export function pinDrift(dir) {
  const direct = Object.fromEntries(INSTALLED.map((name) => [name, DEV_DEPENDENCIES[name]]));
  const problems = [];
  for (const [root, pins, required] of [
    [dir, { ...lockedOverrides(), ...direct }, []],
    [join(dir, 'react18'), REACT_18_PINS, Object.keys(REACT_18_PINS)],
  ]) {
    const copies = installedCopies(root);
    for (const { name, version, path } of copies) {
      if (Object.hasOwn(pins, name) && pins[name] !== version) problems.push(`consumers: ${name} ${version} is installed at ${relative(dir, path)}, the pin is ${pins[name]}; run npm run consumers:setup`);
    }
    for (const name of required) {
      if (!copies.some((c) => c.name === name)) problems.push(`consumers: ${name} is not installed in ${relative(dir, join(root, 'node_modules')) || 'node_modules'}, the pin is ${pins[name]}; run npm run consumers:setup`);
    }
  }
  return problems;
}

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
  execSync('npm run build:lib', { cwd: REPO_ROOT, env: NPM_ENV, stdio: 'inherit' });
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-dist.mjs')], { cwd: REPO_ROOT, stdio: 'inherit' });
  const out = execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, env: NPM_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const [{ filename }] = JSON.parse(out);
  const dependencies = { 'video-fps-probe': `file:./${filename}` };
  for (const name of INSTALLED) {
    const version = manifest.devDependencies[name];
    if (!version) throw new Error(`${name} is not a devDependency of ${manifest.name}`);
    dependencies[name] = version;
  }
  const overrides = lockedOverrides();
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'video-fps-probe-consumers', private: true, type: 'module', dependencies, overrides }, null, 2)}\n`);
  rmSync(join(dir, 'node_modules', 'video-fps-probe'), { recursive: true, force: true });
  const offline = process.env.CONSUMERS_OFFLINE === '1';
  const userconfig = offline ? mkdtempSync(join(tmpdir(), 'video-fps-probe-npmrc-')) : null;
  try {
    if (userconfig) writeFileSync(join(userconfig, '.npmrc'), '');
    const mode = userconfig ? `--offline --userconfig "${join(userconfig, '.npmrc')}"` : '--prefer-offline';
    execSync(`npm install ${mode} --strict-peer-deps --no-audit --no-fund --no-package-lock`, { cwd: dir, env: NPM_ENV, stdio: 'inherit' });
    const react18 = join(dir, 'react18');
    mkdirSync(react18, { recursive: true });
    writeFileSync(join(react18, 'package.json'), `${JSON.stringify({ name: 'video-fps-probe-consumers-react18', private: true, dependencies: { react: REACT_18, 'react-dom': REACT_18, 'video-fps-probe': `file:../${filename}` }, overrides: REACT_18_OVERRIDES }, null, 2)}\n`);
    rmSync(installedPackage(react18), { recursive: true, force: true });
    execSync(`npm install ${mode} --strict-peer-deps --no-audit --no-fund --no-package-lock`, { cwd: react18, env: NPM_ENV, stdio: 'inherit' });
  } finally {
    if (userconfig) rmSync(userconfig, { recursive: true, force: true });
  }
  console.log(`installed ${filename}, ${INSTALLED.map((n) => `${n}@${dependencies[n]}`).join(', ')} with ${Object.keys(overrides).length} transitive packages at their package-lock.json versions (rolldown@${overrides.rolldown}) into ${dir}, and ${filename} with react@${REACT_18} and react-dom@${REACT_18} into ${join(dir, 'react18')}${offline ? ' from the npm cache only' : ''}`);
}

export function copyFixtures(dir, names = FIXTURES.map((f) => f.name)) {
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  for (const file of SHARED) cpSync(join(SOURCES, file), join(dir, 'fixtures', file));
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
    console.error('CONSUMERS_OFFLINE=1 isolates only the npm install steps of setup (the tarball with Vite and the peers, and the tarball with React 18 for the react18 fixture; both run with --strict-peer-deps, so a peer range of the package that React 19 or 18 does not satisfy fails the install): they install from the npm cache only (npm install --offline) with an empty npmrc as --userconfig.');
    console.error("Not isolated: npm run build:lib, the npm pack --dry-run of check-dist and npm pack run with your npm config, any token included. They fetch no packages and the script runs them with npm_config_update_notifier=false, so npm's update check does not contact the registry. An outer npm run consumers:setup is not covered: set update-notifier=false for it.");
    process.exitCode = 2;
  }
}
