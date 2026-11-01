import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { BUNDLERS_PORT, DEV_OFFSET, FIRST_MP4_LIMIT, FORBIDDEN_IN_ZERO_CONFIG, GROUPS, PARSER_MARKERS, TARGETS, UPSTREAM_OFFSET, hasPage, targetsOf } from '../tests/bundlers/targets.mjs';
import { MIME, packTarball, staticFile } from './consumers.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLERS = join(REPO_ROOT, 'tests', 'bundlers');
const FIXTURES = join(BUNDLERS, 'fixtures');
const SHARED = join(BUNDLERS, 'shared');
const CONSUMER_FIXTURES = join(REPO_ROOT, 'tests', 'consumers', 'fixtures');
const FILES_DIR = join(REPO_ROOT, 'fixtures', 'files');
const VERSIONS_PATH = join(BUNDLERS, 'versions.json');
const REPORT_JSON = join(REPO_ROOT, 'report', 'bundlers.json');
const REPORT_MD = join(REPO_ROOT, 'report', 'bundlers.md');
const DOCS = join(REPO_ROOT, 'docs', 'bundlers.md');
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const TABLE_START = '<!-- tables:bundlers:start -->';
const TABLE_END = '<!-- tables:bundlers:end -->';
const SNIPPET = /<!-- snippet: (\S+) -->\n+```\w*\n([\s\S]*?)```/g;
const DEAD_REGISTRY = 'http://127.0.0.1:9/';
const TARBALL = 'video-fps-probe.tgz';
const LOCKFILES = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' };
const PACKAGE = 'video-fps-probe';
const OFFLINE = process.env.BUNDLERS_OFFLINE === '1';
const WIN = process.platform === 'win32';

export const versions = () => JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
export const bundlersDir = (arg) => resolve(arg ?? process.env.BUNDLERS_DIR ?? join(tmpdir(), 'video-fps-probe-bundlers'));
export const targetDir = (dir, target) => join(dir, target.name);
export const baselineDir = (dir) => join(dir, '_baseline');
export const measureDir = (dir, target) => join(dir, 'measure', target.name);
export const tarballInfo = (dir) => JSON.parse(readFileSync(join(dir, 'tarball.json'), 'utf8'));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function emptyNpmrc(dir) {
  const path = join(dir, '.npmrc-empty');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, '');
  return path;
}

export function toolEnv(dir, extra = {}) {
  const env = {
    ...process.env,
    npm_config_userconfig: emptyNpmrc(dir),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    NUXT_TELEMETRY_DISABLED: '1',
    NG_CLI_ANALYTICS: 'false',
    YARN_ENABLE_TELEMETRY: '0',
    ...extra,
  };
  const cache = process.env.BUNDLERS_CACHE;
  if (cache) Object.assign(env, { npm_config_cache: join(cache, 'npm'), YARN_GLOBAL_FOLDER: join(cache, 'yarn'), BUN_INSTALL_CACHE_DIR: join(cache, 'bun') });
  if (OFFLINE) Object.assign(env, { npm_config_registry: DEAD_REGISTRY, npm_config_prefer_offline: 'true', YARN_NPM_REGISTRY_SERVER: DEAD_REGISTRY, BUN_CONFIG_REGISTRY: DEAD_REGISTRY });
  return env;
}

function quote(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`;
}

function run(command, args, { cwd, env, log, allowFailure = false }) {
  const shell = WIN && !/\.exe$/i.test(command) && command !== process.execPath;
  const line = [command, ...args].map(quote).join(' ');
  console.log(`$ ${line}  (in ${cwd})`);
  const r = spawnSync(shell ? line : command, shell ? [] : args, { cwd, env, shell, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
  if (log) {
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, `$ ${line}\n${output}`, { flag: 'a' });
  }
  process.stdout.write(output.length > 20000 ? `${output.slice(0, 4000)}\n...\n${output.slice(-12000)}` : output);
  if (r.status !== 0 && !allowFailure) throw new Error(`${line} exited with ${r.status ?? r.signal} in ${cwd}`);
  return { status: r.status, output };
}

function storeDir() {
  return process.env.BUNDLERS_CACHE ? ['--store-dir', join(process.env.BUNDLERS_CACHE, 'pnpm-store')] : [];
}

function pinOf(name, latest) {
  return latest ? 'latest' : versions().runtimes[name];
}

function packageManager(pm, latest = false) {
  if (pm === 'npm') return { command: 'npm', prefix: [] };
  if (pm === 'pnpm') return { command: 'npm', prefix: ['exec', '--yes', `--package=pnpm@${pinOf('pnpm', latest)}`, '--', 'pnpm'] };
  if (pm === 'yarn') return { command: 'npm', prefix: ['exec', '--yes', `--package=@yarnpkg/cli-dist@${pinOf('yarn', latest)}`, '--', 'yarn'] };
  if (pm === 'bun' || pm === 'deno') return { command: pm, prefix: [] };
  throw new Error(`unknown package manager ${pm}`);
}

function pm(target, args, options, latest = false) {
  const { command, prefix } = packageManager(target.pm, latest);
  return run(command, [...prefix, ...args], options);
}

export function runtimeVersion(name) {
  const r = spawnSync(WIN ? `${name} --version` : name, WIN ? [] : ['--version'], { encoding: 'utf8', shell: WIN });
  if (r.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
}

function checkRuntime(name, latest) {
  const found = runtimeVersion(name);
  if (!found) throw new Error(`${name} is not on PATH: install ${name} ${versions().runtimes[name]} (CI uses the official setup action)`);
  if (!latest && found !== versions().runtimes[name]) throw new Error(`${name} ${found} is on PATH, the pin in tests/bundlers/versions.json is ${versions().runtimes[name]}`);
  return found;
}

function binOf(dir, pkg) {
  const manifest = readJson(join(dir, 'node_modules', pkg, 'package.json'));
  const bins = typeof manifest.bin === 'string' ? { [basename(pkg)]: manifest.bin } : manifest.bin;
  const [name, path] = Object.entries(bins)[0];
  return { name, path: join(dir, 'node_modules', pkg, path) };
}

function command(target, dir, step, port) {
  const fill = (args) => args.map((a) => a.replaceAll('{port}', String(port ?? '')));
  if (step.runtime) return { command: step.runtime, args: fill(step.args) };
  if (step.node) return { command: process.execPath, args: fill(step.node) };
  if (target.pm === 'npm') return { command: process.execPath, args: [binOf(dir, step.bin).path, ...fill(step.args)] };
  const name = step.bin === 'vite' ? 'vite' : basename(step.bin);
  const { command: c, prefix } = packageManager(target.pm);
  if (target.pm === 'pnpm') return { command: c, args: [...prefix, 'exec', name, ...fill(step.args)] };
  if (target.pm === 'yarn') return { command: c, args: [...prefix, name, ...fill(step.args)] };
  return { command: c, args: ['x', name, ...fill(step.args)] };
}

function copyFixture(dir, target) {
  const root = targetDir(dir, target);
  const keep = existsSync(join(root, 'node_modules'));
  if (existsSync(root)) for (const entry of readdirSync(root)) if (entry !== 'node_modules') rmSync(join(root, entry), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(FIXTURES, target.name), root, { recursive: true });
  for (const file of target.shared) cpSync(join(SHARED, file), join(root, file));
  if (target.consumers) {
    cpSync(join(CONSUMER_FIXTURES, 'vite.base.ts'), join(root, 'vite.base.ts'));
    for (const name of target.consumers) {
      cpSync(join(CONSUMER_FIXTURES, name), join(root, name), { recursive: true });
      cpSync(join(CONSUMER_FIXTURES, 'index.html'), join(root, name, 'index.html'));
    }
  }
  return { root, keep };
}

function lockLines(text) {
  const lines = [];
  const stack = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const line = raw.trim();
    lines.push({ path: [...stack.map((s) => s.key), line].join(' > '), line });
    const key = /^("[^"]*"|[^:]+):/.exec(line);
    if (key) stack.push({ indent, key: key[1] });
  }
  return lines;
}

function multiset(lines) {
  const counts = new Map();
  for (const l of lines) counts.set(l.path, (counts.get(l.path) ?? 0) + 1);
  return counts;
}

function stripNpmLock(lock) {
  const copy = structuredClone(lock);
  for (const key of Object.keys(copy.packages ?? {})) if (key === `node_modules/${PACKAGE}` || key.endsWith(`/node_modules/${PACKAGE}`) || key.includes(`node_modules/${PACKAGE}/`)) delete copy.packages[key];
  const root = copy.packages?.[''] ?? {};
  for (const field of ['dependencies', 'devDependencies']) {
    if (root[field]) delete root[field][PACKAGE];
    if (root[field] && Object.keys(root[field]).length === 0) delete root[field];
  }
  return copy;
}

function parseBunLock(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

function stripBunLock(lock) {
  const copy = structuredClone(lock);
  for (const key of Object.keys(copy.packages ?? {})) if (key === PACKAGE) delete copy.packages[key];
  for (const ws of Object.values(copy.workspaces ?? {})) {
    for (const field of ['dependencies', 'devDependencies']) {
      if (ws[field]) delete ws[field][PACKAGE];
      if (ws[field] && Object.keys(ws[field]).length === 0) delete ws[field];
    }
  }
  return copy;
}

export function lockfileChanges(pmName, before, after) {
  if (before === null) return [];
  if (pmName === 'npm') {
    const a = stripNpmLock(JSON.parse(before));
    const b = stripNpmLock(JSON.parse(after));
    const keys = new Set([...Object.keys(a.packages ?? {}), ...Object.keys(b.packages ?? {})]);
    const changed = [...keys].filter((k) => !isDeepStrictEqual(a.packages?.[k], b.packages?.[k]));
    const { packages: _a, ...restA } = a;
    const { packages: _b, ...restB } = b;
    if (!isDeepStrictEqual(restA, restB)) changed.push('(lockfile header)');
    return changed;
  }
  if (pmName === 'bun') {
    const a = stripBunLock(parseBunLock(before));
    const b = stripBunLock(parseBunLock(after));
    return isDeepStrictEqual(a, b) ? [] : Object.keys({ ...a.packages, ...b.packages }).filter((k) => !isDeepStrictEqual(a.packages?.[k], b.packages?.[k])).concat(isDeepStrictEqual({ ...a, packages: 0 }, { ...b, packages: 0 }) ? [] : ['(lockfile header)']);
  }
  const a = multiset(lockLines(before));
  const b = multiset(lockLines(after));
  const changed = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(path) ?? 0) === (b.get(path) ?? 0)) continue;
    if (path.includes(PACKAGE)) continue;
    changed.push(path);
  }
  return changed;
}

const PEER_WARNING = {
  npm: /npm warn.*(peer|ERESOLVE).*video-fps-probe|video-fps-probe.*npm warn.*peer/i,
  pnpm: /(missing|unmet|issues with) peer.*|video-fps-probe.*peer/i,
  yarn: /YN0002|YN0060|YN0086/,
  bun: /incorrect peer dependency|peer dependency/i,
};

export function peerWarnings(pmName, output) {
  return output
    .split('\n')
    .filter((line) => PEER_WARNING[pmName]?.test(line) && (pmName !== 'pnpm' || line.includes(PACKAGE) || /missing peer/i.test(line)));
}

function latestVersion(name, env, cwd) {
  const r = run('npm', ['view', `${name}@latest`, 'version', '--json', '--prefer-online'], { cwd, env });
  return JSON.parse(r.output.trim().split('\n').filter((l) => l.startsWith('"') || /^\d/.test(l)).at(-1) ?? 'null');
}

function writeLatestManifest(root, target, env) {
  const manifestPath = join(root, 'package.json');
  const manifest = readJson(manifestPath);
  const resolved = {};
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      resolved[name] = latestVersion(name, env, root);
      manifest[field][name] = resolved[name];
    }
  }
  delete manifest.packageManager;
  writeJson(manifestPath, manifest);
  const lockfile = LOCKFILES[target.pm];
  if (lockfile) rmSync(join(root, lockfile), { force: true });
  return resolved;
}

function frozenInstall(target, root, env, log, latest) {
  const lockfile = LOCKFILES[target.pm];
  const locked = lockfile && existsSync(join(root, lockfile));
  const offline = OFFLINE ? ['--offline'] : [];
  if (target.pm === 'npm') return pm(target, [locked && !latest ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], { cwd: root, env, log });
  if (target.pm === 'pnpm') return pm(target, ['install', latest ? '--no-frozen-lockfile' : '--frozen-lockfile', '--ignore-scripts', ...storeDir(), ...(OFFLINE ? ['--offline'] : ['--prefer-offline'])], { cwd: root, env, log }, latest);
  if (target.pm === 'yarn') return pm(target, ['install', ...(latest ? [] : ['--immutable'])], { cwd: root, env: { ...env, ...(latest ? { YARN_ENABLE_IMMUTABLE_INSTALLS: '0' } : {}) }, log }, latest);
  if (target.pm === 'bun') return locked ? pm(target, ['install', ...(latest ? [] : ['--frozen-lockfile']), '--ignore-scripts'], { cwd: root, env, log }) : { status: 0, output: '' };
  return { status: 0, output: '' };
}

function addPackage(target, root, env, log, spec, latest) {
  const offline = OFFLINE ? ['--offline'] : [];
  if (target.pm === 'npm') return pm(target, ['install', spec, '--ignore-scripts', '--no-audit', '--no-fund', ...offline], { cwd: root, env, log });
  if (target.pm === 'pnpm') return pm(target, ['add', spec, '--ignore-scripts', ...storeDir(), ...(OFFLINE ? ['--offline'] : ['--prefer-offline'])], { cwd: root, env, log }, latest);
  if (target.pm === 'yarn') return pm(target, ['add', spec.startsWith('./') ? `${PACKAGE}@file:${spec}` : spec], { cwd: root, env: { ...env, YARN_ENABLE_IMMUTABLE_INSTALLS: '0' }, log }, latest);
  if (target.pm === 'bun') return pm(target, ['add', spec, '--ignore-scripts'], { cwd: root, env, log });
  return { status: 0, output: '' };
}

function installBaseline(dir, env, spec) {
  const root = baselineDir(dir);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeJson(join(root, 'package.json'), { name: 'video-fps-probe-bundlers-baseline', private: true, type: 'module' });
  for (const file of ['server-run-core.mjs', 'server-run.mjs', 'server-run.cjs']) cpSync(join(SHARED, file), join(root, file));
  run('npm', ['install', spec, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', ...(OFFLINE || !spec.startsWith('video-fps-probe@') ? ['--offline'] : [])], { cwd: root, env, log: join(dir, 'logs', '_baseline.log') });
  for (const peer of ['mp4box', 'mediabunny']) cpSync(join(REPO_ROOT, 'node_modules', peer), join(root, 'node_modules', peer), { recursive: true });
}

function prepareTarball(dir, tarball) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, TARBALL);
  if (tarball) cpSync(resolve(tarball), target);
  else {
    const filename = packTarball(dir);
    cpSync(join(dir, filename), target);
    rmSync(join(dir, filename));
  }
  const listing = spawnSync('tar', ['-xOzf', TARBALL, 'package/package.json'], { cwd: dir, encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`cannot read package/package.json from ${target}: ${listing.stderr}`);
  const { version } = JSON.parse(listing.stdout);
  writeJson(join(dir, 'tarball.json'), { file: TARBALL, version, source: tarball ? resolve(tarball) : 'npm pack' });
  return version;
}

export function setup(dir, targets, { tarball, latest = false, registry = false } = {}) {
  if (OFFLINE && (latest || registry)) throw new Error('--latest and --registry read the registry, so they cannot run with BUNDLERS_OFFLINE=1');
  mkdirSync(dir, { recursive: true });
  const env = toolEnv(dir);
  let spec = `./${TARBALL}`;
  if (registry) {
    const version = latestVersion(PACKAGE, env, dir);
    writeJson(join(dir, 'tarball.json'), { file: null, version, source: `the registry, ${PACKAGE}@latest` });
    spec = `${PACKAGE}@${version}`;
  } else prepareTarball(dir, tarball);
  installBaseline(dir, env, registry ? spec : join(dir, TARBALL));
  for (const runtime of new Set(targets.map((t) => t.pm).filter((p) => p === 'bun' || p === 'deno'))) checkRuntime(runtime, latest);
  for (const target of targets) {
    const started = Date.now();
    const { root } = copyFixture(dir, target);
    const log = join(dir, 'logs', `${target.name}-setup.log`);
    rmSync(log, { force: true });
    if (!registry) cpSync(join(dir, TARBALL), join(root, TARBALL));
    const resolvedLatest = latest ? writeLatestManifest(root, target, env) : null;
    if (target.pm === 'deno') {
      writeJson(join(measureDir(dir, target), 'setup.json'), { target: target.name, latest: resolvedLatest, peerWarnings: [], lockfileChanges: [] });
      console.log(`set up ${target.name}: Deno fetches the package from the mini registry when it runs`);
      continue;
    }
    if (target.pm === 'npm' || target.pm === 'bun') rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    frozenInstall(target, root, env, log, latest);
    const lockfile = LOCKFILES[target.pm];
    const before = !latest && existsSync(join(root, lockfile)) ? readFileSync(join(root, lockfile), 'utf8') : null;
    const added = addPackage(target, root, env, log, spec, latest);
    const after = existsSync(join(root, lockfile)) ? readFileSync(join(root, lockfile), 'utf8') : null;
    const changes = before === null || after === null ? [] : lockfileChanges(target.pm, before, after);
    if (changes.length > 0) throw new Error(`${target.name}: adding ${spec} changed lockfile entries other than ${PACKAGE}: ${changes.slice(0, 20).join(', ')}`);
    const warnings = target.peerWarnings ? peerWarnings(target.pm, added.output) : [];
    writeJson(join(measureDir(dir, target), 'setup.json'), { target: target.name, latest: resolvedLatest, peerWarnings: warnings, lockfileChanges: changes });
    console.log(`set up ${target.name} with ${target.pm} in ${((Date.now() - started) / 1000).toFixed(1)} s${warnings.length ? `, ${warnings.length} peer warning(s)` : ''}`);
  }
}

const JS = /\.(m?js|cjs)$/;

function walk(root, base = root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, base, out);
    else out.push(relative(base, path).split('\\').join('/'));
  }
  return out;
}

function emitted(root) {
  const files = walk(root).filter((f) => JS.test(f));
  const gzip = files.reduce((n, f) => n + gzipSync(readFileSync(join(root, f)), { level: 9 }).length, 0);
  return { files: files.length, gzip };
}

function serverBuild(root) {
  const files = walk(root).filter((f) => JS.test(f));
  const own = files.filter((f) => !f.includes('node_modules/'));
  const text = (f) => readFileSync(join(root, f), 'latin1');
  return {
    bundled: own.some((f) => text(f).includes(PARSER_MARKERS.isobmff)),
    external: files.some((f) => f.includes(`node_modules/${PACKAGE}/`)) || own.some((f) => /["'`]video-fps-probe\/header["'`]/.test(text(f))),
  };
}

const outDirs = (target, root) => (target.out ? target.apps.map((app) => ({ app: app.name, path: join(root, target.out.replaceAll('{app}', app.name)) })) : []);

export function build(dir, targets) {
  for (const target of targets) {
    const root = targetDir(dir, target);
    if (!existsSync(root)) throw new Error(`${target.name} is not set up: run node scripts/bundlers.mjs setup --only ${target.group}`);
    const env = toolEnv(dir, { NODE_ENV: 'production' });
    const log = join(dir, 'logs', `${target.name}-build.log`);
    rmSync(log, { force: true });
    const started = Date.now();
    let failed = null;
    for (const step of target.build) {
      const { command: c, args } = command(target, root, step);
      const r = run(c, args, { cwd: join(root, step.cwd ?? ''), env, log, allowFailure: !!target.fails?.build });
      if (r.status !== 0) {
        failed = r.output;
        break;
      }
    }
    const ms = Date.now() - started;
    const outputs = failed === null ? outDirs(target, root).map(({ app, path }) => ({ app, ...emitted(path) })) : [];
    const server = failed === null && target.serverOut ? serverBuild(join(root, target.serverOut)) : null;
    writeJson(join(measureDir(dir, target), 'build.json'), { target: target.name, status: failed === null ? 'built' : 'failed', output: failed, ms, emitted: outputs, server });
    console.log(`${failed === null ? 'built' : 'build failed (expected by the target table)'}: ${target.name} in ${(ms / 1000).toFixed(1)} s`);
  }
}

function holds(body) {
  const text = body.toString('latin1');
  return Object.entries(PARSER_MARKERS)
    .filter(([, marker]) => text.includes(marker))
    .map(([family]) => family);
}

function tokenOf(req) {
  return /(?:^|;\s*)bundlers=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
}

function front(port, handle, upgradeTo) {
  const log = [];
  let seq = 0;
  const record = (req, status, type, body) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const js = /javascript|ecmascript/.test(type ?? '') || JS.test(path);
    log.push({ seq: seq++, token: tokenOf(req), method: req.method, path, status, js, bytes: body?.length ?? 0, gzip: js && body ? gzipSync(body, { level: 9 }).length : 0, holds: js && body ? holds(body) : [] });
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/__bundlers/log') {
      const token = url.searchParams.get('token');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(log.filter((e) => e.token === token)));
      return;
    }
    handle(req, res, record);
  });
  if (upgradeTo) {
    server.on('upgrade', (req, socket, head) => {
      const upstream = connect(upgradeTo, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
  }
  return new Promise((done, fail) => server.once('error', fail).listen(port, '127.0.0.1', () => done(server)));
}

function staticHandler(roots) {
  return (req, res, record) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const root = roots.find((r) => path.startsWith(r.prefix));
    const rel = root ? path.slice(root.prefix.length) : null;
    const file = root ? staticFile(root.dir, rel.endsWith('/') || rel === '' ? `${rel}index.html` : rel) : null;
    if (!file) {
      record(req, 404, 'text/plain', null);
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const body = readFileSync(file);
    const type = MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
    record(req, 200, type, body);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': body.length }).end(body);
  };
}

function proxyHandler(upstreamPort) {
  return (req, res, record) => {
    const headers = { ...req.headers, 'accept-encoding': 'identity' };
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
    const upstream = httpRequest({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, (reply) => {
      const type = reply.headers['content-type'] ?? '';
      const out = { ...reply.headers, 'cache-control': 'no-store' };
      delete out.etag;
      delete out['last-modified'];
      if (type.includes('text/event-stream')) {
        record(req, reply.statusCode, type, null);
        res.writeHead(reply.statusCode ?? 502, out);
        reply.pipe(res);
        return;
      }
      const chunks = [];
      reply.on('data', (c) => chunks.push(c));
      reply.on('end', () => {
        const body = Buffer.concat(chunks);
        record(req, reply.statusCode, type, body);
        delete out['transfer-encoding'];
        out['content-length'] = String(body.length);
        res.writeHead(reply.statusCode ?? 502, out).end(body);
      });
    });
    upstream.on('error', (e) => {
      record(req, 502, 'text/plain', null);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(String(e));
    });
    req.pipe(upstream);
  };
}

async function waitFor(url, ms, child) {
  const until = Date.now() + ms;
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`${url}: the server exited with ${child.exitCode} before it answered`);
    try {
      const reply = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await reply.arrayBuffer();
      if (reply.status < 500) return;
    } catch {}
    if (Date.now() > until) throw new Error(`${url} did not answer within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function startUpstream(dir, target, step, port, extraEnv = {}) {
  const root = targetDir(dir, target);
  const { command: c, args } = command(target, root, step, port);
  const fill = (v) => v.replaceAll('{port}', String(port));
  const env = toolEnv(dir, { BUNDLERS_FILES_DIR: FILES_DIR, ...extraEnv, ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, fill(v)])) });
  const log = join(dir, 'logs', `${target.name}-serve-${port}.log`);
  mkdirSync(dirname(log), { recursive: true });
  const shell = WIN && c !== process.execPath && !/\.exe$/i.test(c);
  const child = spawn(shell ? [c, ...args].map(quote).join(' ') : c, shell ? [] : args, { cwd: root, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (chunk) => writeFileSync(log, chunk, { flag: 'a' });
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  process.on('exit', () => child.exitCode === null && child.kill());
  return child;
}

export async function serve(dir, targets, { dev = false } = {}) {
  const served = [];
  const pending = [];
  for (const target of targets.filter(hasPage)) {
    const root = targetDir(dir, target);
    const port = target.port + (dev ? DEV_OFFSET : 0);
    const upstream = port + UPSTREAM_OFFSET;
    if (dev) {
      if (!target.dev || !existsSync(root)) continue;
      const child = startUpstream(dir, target, target.dev, upstream, { NODE_ENV: 'development' });
      pending.push(waitFor(`http://127.0.0.1:${upstream}/`, 240_000, child));
      await front(port, proxyHandler(upstream), upstream);
      served.push({ target: target.name, port, mode: 'dev' });
      continue;
    }
    const built = join(measureDir(dir, target), 'build.json');
    if (!existsSync(built) || readJson(built).status !== 'built') continue;
    if (target.start) {
      const child = startUpstream(dir, target, target.start, upstream, { NODE_ENV: 'production' });
      pending.push(waitFor(`http://127.0.0.1:${upstream}/`, 120_000, child));
      await front(port, proxyHandler(upstream), null);
    } else {
      const roots = target.apps.map((app) => ({ prefix: app.path, dir: join(root, target.out.replaceAll('{app}', app.name)) }));
      await front(port, staticHandler(roots), null);
    }
    served.push({ target: target.name, port, mode: 'build' });
  }
  await Promise.all(pending);
  const hub = createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(served)));
  await new Promise((done, fail) => hub.once('error', fail).listen(BUNDLERS_PORT + (dev ? DEV_OFFSET : 0), '127.0.0.1', done));
  console.log(`serving ${served.map((s) => `${s.target} on ${s.port}`).join(', ') || 'no target'}`);
}

function lockfileFor(target) {
  const lockfile = LOCKFILES[target.pm];
  if (!lockfile) return null;
  const manifest = readJson(join(FIXTURES, target.name, 'package.json'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.keys(deps).length === 0 ? null : lockfile;
}

function configText(target, entry) {
  const [file, keys] = entry.split('#');
  const text = readFileSync(join(FIXTURES, target.name, file), 'utf8');
  if (!keys) return text;
  const json = JSON.parse(text);
  return JSON.stringify(Object.fromEntries(keys.split(',').map((k) => [k, json[k]])));
}

export function checkPins() {
  const { runtimes, packages } = versions();
  const problems = [];
  const used = new Set();
  const fixtureDirs = readdirSync(FIXTURES).filter((d) => statSync(join(FIXTURES, d)).isDirectory());
  for (const d of fixtureDirs) if (!TARGETS.some((t) => t.name === d)) problems.push(`tests/bundlers/fixtures/${d} is not a target in tests/bundlers/targets.mjs`);
  for (const target of TARGETS) {
    const dir = join(FIXTURES, target.name);
    if (!existsSync(dir)) {
      problems.push(`${target.name}: tests/bundlers/fixtures/${target.name} is missing`);
      continue;
    }
    if (target.pm === 'deno') {
      const deno = readJson(join(dir, 'deno.json'));
      for (const [k, v] of Object.entries(deno.imports ?? {})) if (!/^npm:\/?video-fps-probe\/?$/.test(v)) problems.push(`${target.name}: deno.json maps ${k} to ${v}, only the package itself is allowed`);
    } else {
      const manifest = readJson(join(dir, 'package.json'));
      if (manifest.dependencies?.[PACKAGE] || manifest.devDependencies?.[PACKAGE]) problems.push(`${target.name}: package.json lists ${PACKAGE}, setup adds it`);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, version] of Object.entries(manifest[field] ?? {})) {
          used.add(name);
          if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`${target.name}: ${name} is ${version}, not an exact version`);
          else if (packages[name] !== version) problems.push(`${target.name}: ${name} is ${version}, versions.json pins ${packages[name] ?? 'nothing'}`);
        }
      }
      if (manifest.packageManager) {
        const [name, version] = manifest.packageManager.split('@');
        if (runtimes[name] !== version) problems.push(`${target.name}: packageManager is ${manifest.packageManager}, versions.json pins ${name} ${runtimes[name]}`);
      }
      const lockfile = lockfileFor(target);
      if (lockfile && !existsSync(join(dir, lockfile))) problems.push(`${target.name}: ${lockfile} is missing`);
      if (lockfile === 'package-lock.json' && existsSync(join(dir, lockfile))) {
        const lock = readJson(join(dir, lockfile));
        for (const field of ['dependencies', 'devDependencies']) {
          for (const [name, version] of Object.entries(manifest[field] ?? {})) {
            const locked = lock.packages?.[`node_modules/${name}`]?.version;
            if (locked !== version) problems.push(`${target.name}: package-lock.json resolves ${name} to ${locked ?? 'nothing'}, the pin is ${version}`);
          }
        }
        if (Object.keys(lock.packages ?? {}).some((k) => k.endsWith(`node_modules/${PACKAGE}`))) problems.push(`${target.name}: package-lock.json holds ${PACKAGE}, setup adds it`);
      }
      for (const other of Object.values(LOCKFILES)) if (other !== lockfile && existsSync(join(dir, other))) problems.push(`${target.name}: ${other} does not belong to a ${target.pm} target`);
      if (!target.snippets) {
        const { name: _n, dependencies: _d, devDependencies: _dd, ...rest } = manifest;
        if (FORBIDDEN_IN_ZERO_CONFIG.test(JSON.stringify(rest))) problems.push(`${target.name}: package.json of a zero-config target sets ${FORBIDDEN_IN_ZERO_CONFIG.exec(JSON.stringify(rest))[0]}`);
      }
    }
    if (!target.snippets) {
      for (const entry of target.configs) {
        const text = configText(target, entry);
        const hit = FORBIDDEN_IN_ZERO_CONFIG.exec(text);
        if (hit) problems.push(`${target.name}: the zero-config file ${entry} contains ${hit[0]}`);
      }
    }
  }
  for (const name of Object.keys(packages)) if (!used.has(name)) problems.push(`versions.json pins ${name}, which no fixture uses`);
  for (const [name, version] of Object.entries(runtimes)) if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`versions.json pins ${name} to ${version}, not an exact version`);
  const ci = readFileSync(CI_WORKFLOW, 'utf8');
  if (!ci.includes(`bun-version: ${runtimes.bun}`)) problems.push(`.github/workflows/ci.yml does not set bun-version: ${runtimes.bun}`);
  if (!ci.includes(`deno-version: ${runtimes.deno}`)) problems.push(`.github/workflows/ci.yml does not set deno-version: ${runtimes.deno}`);
  for (const group of GROUPS) if (!new RegExp(`^\\s+- ${group}$`, 'm').test(ci)) problems.push(`.github/workflows/ci.yml has no bundlers matrix leg for ${group}`);
  return problems;
}

const kb = (bytes) => (bytes === null || bytes === undefined ? 'n/a' : `${(bytes / 1000).toFixed(2)} KB`);

function toolVersion(target) {
  const v = versions();
  return target.latest?.[target.tool] ?? v.runtimes[target.tool] ?? v.packages[target.tool];
}

function snippetsOf(target) {
  return (target.snippets ?? []).map((s) => s.split('#')[0]);
}

export function collect(measured) {
  const targets = [];
  const problems = [];
  for (const target of TARGETS) {
    const dir = join(measured, target.name);
    const read = (file) => (existsSync(join(dir, file)) ? readJson(join(dir, file)) : null);
    const buildInfo = read('build.json');
    const server = read('server.json');
    const apps = [];
    for (const app of target.apps ?? []) {
      const runs = ['chromium', 'firefox', 'webkit'].map((browser) => read(`${app.name}-${browser}.json`)).filter(Boolean);
      if (runs.length === 0) {
        problems.push(`${target.name} ${app.name}: no smoke measurement in ${dir}`);
        continue;
      }
      const [first] = runs;
      for (const r of runs.slice(1)) {
        for (const key of ['status', 'workers', 'split']) if (!isDeepStrictEqual(r[key], first[key])) problems.push(`${target.name} ${app.name}: ${key} is ${JSON.stringify(first[key])} in ${first.browser} and ${JSON.stringify(r[key])} in ${r.browser}`);
      }
      const sized = runs.find((r) => r.browser === 'chromium') ?? first;
      apps.push({ app: app.name, status: first.status, workers: first.workers, split: first.split, beforeAnalyze: sized.beforeAnalyze, firstMp4: sized.firstMp4, firstWebm: sized.firstWebm, failure: first.failure ?? null });
    }
    if (target.runners || target.route) {
      if (!server) problems.push(`${target.name}: no server measurement in ${dir}`);
    }
    if (!hasPage(target) && !server) continue;
    targets.push({
      latest: read('setup.json')?.latest ?? null,
      name: target.name,
      group: target.group,
      tool: target.tool,
      pm: target.pm,
      config: target.snippets ? snippetsOf(target) : [],
      build: buildInfo ? { status: buildInfo.status, emitted: buildInfo.emitted } : null,
      apps,
      server: server ?? null,
    });
  }
  return { targets, problems };
}

const TOOL_NAMES = { webpack: 'webpack', '@rspack/core': 'Rspack', next: 'Next.js', '@angular/build': 'Angular', '@sveltejs/kit': 'SvelteKit', nuxt: 'Nuxt', parcel: 'Parcel', bun: 'Bun', deno: 'Deno', pnpm: 'pnpm', yarn: 'Yarn' };

function toolLabel(t) {
  const name = `${TOOL_NAMES[t.tool] ?? t.tool} ${t.toolVersion}`;
  const bundler = t.name === 'next-webpack' ? 'webpack' : t.name === 'next-turbopack' ? 'Turbopack' : t.pm !== 'npm' && t.apps.length > 1 ? `Vite ${versions().packages.vite}` : null;
  return bundler ? `${name}, ${bundler}` : name;
}

function statusOf(t) {
  if (t.build?.status === 'failed') return 'fails without configuration: the build does not resolve the package exports';
  if (t.apps.some((a) => a.status === 'expected-failure')) return 'fails without configuration: the prebuilt worker is not emitted (404)';
  return t.config.length ? 'verified with configuration' : 'verified';
}

export function reportFrom(measured) {
  const { targets, problems } = collect(measured);
  const v = versions();
  return {
    report: {
      unit: 'gzip -9 bytes of the JavaScript the static server or the proxy in front of the framework server sent, KB = 1000 bytes, measured in Chromium. Framework runtimes dominate the totals, so the sizes are informational, except that a first MP4 above the limit fails',
      limits: { firstMp4Lazy: FIRST_MP4_LIMIT },
      runtimes: v.runtimes,
      targets: targets.map(({ latest, ...t }) => ({ ...t, status: statusOf(t), toolVersion: toolVersion({ ...t, latest }), ...(latest ? { latest } : {}) })),
    },
    problems,
  };
}

function row(t, a) {
  const status = t.status;
  const name = a && t.apps.length > 1 ? `${t.name} (${a.app})` : t.name;
  const cfg = t.config.length ? t.config.map((c) => `\`${c}\``).join(', ') : 'none';
  const tool = toolLabel(t);
  if (!a) return `| ${name} | ${tool} | ${t.pm} | ${cfg} | ${status} | n/a | n/a | n/a | n/a | n/a | n/a |`;
  const emitted = t.build?.emitted?.find((e) => e.app === a.app);
  const ok = a.status === 'pass';
  return `| ${name} | ${tool} | ${t.pm} | ${cfg} | ${status} | ${ok ? kb(a.beforeAnalyze?.gzip) : 'n/a'} | ${ok ? kb(a.firstMp4?.gzip) : 'n/a'} | ${ok ? kb(a.firstWebm?.gzip) : 'n/a'} | ${emitted ? `${kb(emitted.gzip)} in ${emitted.files} files` : 'n/a'} | ${ok ? a.workers : 'n/a'} | ${ok ? (a.split ? 'yes' : 'no') : 'n/a'} |`;
}

function serverRow(t) {
  const s = t.server;
  if (!s) return null;
  const build = (r) => (r.resolved.every((p) => p.startsWith('dist/cjs/')) ? 'the CommonJS copy' : r.resolved.every((p) => !p.startsWith('dist/cjs/')) ? 'the ESM build' : 'a mix of both builds');
  const instance = (r) => (r.sharedWithImport === null ? '' : r.sharedWithImport.every(Boolean) ? ', one instance' : ', a second instance');
  const loaders = (s.runs ?? []).map((r) => (r.resolved ? `\`${r.loader}\`: ${build(r)}${instance(r)}` : r.loader === 'bundled' ? 'bundled into the server build' : 'imported from node_modules by the server build at run time'));
  return `| ${t.name} | ${s.runner} | ${loaders.join(', ')} | equal to Node |`;
}

export function renderTables(report) {
  const lines = [
    `Measured on production builds of the fixtures in \`tests/bundlers/fixtures/\`, installed from the packed tarball (gzip -9 of the JavaScript the server sent, KB = 1000 bytes, measured in Chromium, with the same checks in Firefox and WebKit). Framework runtimes dominate the totals, so the sizes are informational. A first MP4 above ${kb(FIRST_MP4_LIMIT)} fails CI, as does any change of a status, a worker count or the split.`,
    '',
    '| Target | Tool | Package manager | Configuration | Status | JS before the first analyze | First MP4, lazy | First WebM, lazy | Emitted JS | Workers | Split |',
    '|---|---|---|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const t of report.targets) {
    if (t.apps.length === 0) lines.push(row(t, null));
    for (const a of t.apps) lines.push(row(t, a));
  }
  const servers = report.targets.map(serverRow).filter(Boolean);
  if (servers.length) {
    lines.push('', 'The seven server entries on one MP4, in the framework route or the runtime, against Node `import` from the same tarball:', '', '| Target | Runs in | Resolves to | Result |', '|---|---|---|---|', ...servers);
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report) {
  return `# Bundler matrix\n\nGenerated by \`node scripts/bundlers.mjs report --write\` from the smoke measurements. Do not edit by hand.\n\n${renderTables(report)}`;
}

function docsWithTables(docs, tables) {
  const start = docs.indexOf(TABLE_START);
  const end = docs.indexOf(TABLE_END);
  if (start === -1 || end === -1 || end < start) throw new Error(`docs/bundlers.md has no ${TABLE_START} ... ${TABLE_END} block`);
  return `${docs.slice(0, start + TABLE_START.length)}\n\n${tables}\n${docs.slice(end)}`;
}

export function compareReports(committed, measured) {
  const problems = [];
  const names = (r) => r.targets.map((t) => t.name);
  if (!isDeepStrictEqual(names(committed), names(measured))) problems.push(`the target set changed: committed ${names(committed).join(', ')}, measured ${names(measured).join(', ')}`);
  for (const m of measured.targets) {
    const c = committed.targets.find((t) => t.name === m.name);
    for (const a of m.apps) {
      if (a.status === 'pass' && a.firstMp4 && a.firstMp4.gzip > FIRST_MP4_LIMIT) problems.push(`${m.name} ${a.app}: the first MP4 loads ${kb(a.firstMp4.gzip)} of JavaScript, above the ${kb(FIRST_MP4_LIMIT)} limit`);
    }
    if (!c) continue;
    if (c.status !== m.status) problems.push(`${m.name}: the status changed from ${c.status} to ${m.status}`);
    if (c.build?.status !== m.build?.status) problems.push(`${m.name}: the build changed from ${c.build?.status} to ${m.build?.status}`);
    for (const a of m.apps) {
      const ca = c.apps.find((x) => x.app === a.app);
      if (!ca) {
        problems.push(`${m.name} ${a.app}: not in the committed report`);
        continue;
      }
      for (const key of ['status', 'workers', 'split']) if (!isDeepStrictEqual(ca[key], a[key])) problems.push(`${m.name} ${a.app}: ${key} changed from ${JSON.stringify(ca[key])} to ${JSON.stringify(a[key])}`);
    }
    if (!isDeepStrictEqual(c.server?.runs?.map((r) => [r.loader, r.resolved]), m.server?.runs?.map((r) => [r.loader, r.resolved]))) problems.push(`${m.name}: the server entries resolve differently`);
  }
  return problems;
}

export function report(measured, { write = false, out = null } = {}) {
  const { report: measuredReport, problems } = reportFrom(measured);
  if (out) {
    writeJson(join(out, 'bundlers.json'), measuredReport);
    writeFileSync(join(out, 'bundlers.md'), renderMarkdown(measuredReport));
  }
  if (write) {
    if (problems.length) throw new Error(`cannot write the report:\n${problems.join('\n')}`);
    writeJson(REPORT_JSON, measuredReport);
    writeFileSync(REPORT_MD, renderMarkdown(measuredReport));
    writeFileSync(DOCS, docsWithTables(readFileSync(DOCS, 'utf8'), renderTables(measuredReport)));
    console.log(`wrote report/bundlers.json, report/bundlers.md and the table in docs/bundlers.md for ${measuredReport.targets.length} targets`);
    return [];
  }
  const committed = readJson(REPORT_JSON);
  return [...problems, ...compareReports(committed, measuredReport)];
}

function selfTest() {
  const committed = readJson(REPORT_JSON);
  const planted = structuredClone(committed);
  const app = planted.targets.flatMap((t) => t.apps).find((a) => a.status === 'pass');
  if (!app) return ['the committed report has no passing app to plant a first MP4 in'];
  app.firstMp4 = { files: 1, gzip: 50_000 };
  const caught = compareReports(committed, planted);
  const problems = [];
  if (!caught.some((p) => p.includes('above the'))) problems.push('a planted 50 KB first MP4 did not fail the check');
  const flipped = structuredClone(committed);
  flipped.targets[0].status = 'build fails';
  if (!compareReports(committed, flipped).some((p) => p.includes('status changed'))) problems.push('a changed status did not fail the check');
  const workers = structuredClone(committed);
  const w = workers.targets.flatMap((t) => t.apps).find((a) => a.status === 'pass');
  w.workers += 1;
  if (!compareReports(committed, workers).some((p) => p.includes('workers changed'))) problems.push('a changed worker count did not fail the check');
  const dropped = { ...committed, targets: committed.targets.slice(1) };
  if (!compareReports(committed, dropped).some((p) => p.includes('target set changed'))) problems.push('a dropped target did not fail the check');
  return problems;
}

function snippetSource(spec) {
  const [path, key] = spec.split('#');
  const text = readFileSync(join(FIXTURES, path), 'utf8');
  if (!key) return text;
  const json = JSON.parse(text);
  const picked = {};
  for (const path of key.split(',')) {
    const keys = path.split('.');
    picked[keys.at(-1)] = keys.reduce((value, k) => value?.[k], json);
  }
  return `${JSON.stringify(picked, null, 2)}\n`;
}

export function checkDocs() {
  const problems = [];
  const docs = readFileSync(DOCS, 'utf8');
  const committed = readJson(REPORT_JSON);
  const v = versions();
  for (const t of committed.targets) {
    const pinned = v.runtimes[t.tool] ?? v.packages[t.tool];
    if (t.toolVersion !== pinned) problems.push(`report/bundlers.json has ${t.tool} ${t.toolVersion} for ${t.name}, versions.json pins ${pinned}: run the matrix and report --write`);
  }
  try {
    if (docsWithTables(docs, renderTables(committed)) !== docs) problems.push('the table in docs/bundlers.md differs from report/bundlers.json: run node scripts/bundlers.mjs report --write');
  } catch (e) {
    problems.push(e.message);
  }
  const seen = new Set();
  for (const [, spec, body] of docs.matchAll(SNIPPET)) {
    seen.add(spec);
    if (!existsSync(join(FIXTURES, spec.split('#')[0]))) {
      problems.push(`docs/bundlers.md has a snippet of tests/bundlers/fixtures/${spec}, which does not exist`);
      continue;
    }
    if (snippetSource(spec) !== body) problems.push(`the snippet of ${spec} in docs/bundlers.md differs from tests/bundlers/fixtures/${spec.split('#')[0]}`);
  }
  for (const target of TARGETS) for (const s of target.snippets ?? []) if (!seen.has(`${target.name}/${s}`)) problems.push(`docs/bundlers.md has no snippet of ${target.name}/${s} (<!-- snippet: ${target.name}/${s} --> before a code block)`);
  for (const [name, version] of Object.entries(v.runtimes)) if (!docs.includes(`${name === 'yarn' ? 'Yarn' : name === 'bun' ? 'Bun' : name === 'deno' ? 'Deno' : name} ${version}`)) problems.push(`docs/bundlers.md does not name ${name} ${version}`);
  return problems;
}

const USAGE = `Usage: node scripts/bundlers.mjs <command> [options]

Commands:
  setup        copies each fixture of tests/bundlers/fixtures to the bundlers directory, runs a frozen
               install of its toolchain (npm ci, pnpm install --frozen-lockfile, yarn install --immutable,
               bun install --frozen-lockfile), adds the package with the package manager's own add command
               and fails when that changed a lockfile entry other than ${PACKAGE}
  build        builds each target and records the build outcome and the emitted JavaScript
  serve        serves every built target on its own port from ${BUNDLERS_PORT + 1}, static files or a proxy in
               front of the framework server that logs what it sends, and a hub on ${BUNDLERS_PORT}
  report       --write writes report/bundlers.{json,md} and the table in docs/bundlers.md from the
               measurements, --check (the default) compares the measurements with the committed report,
               --self-test plants failures in the committed report
  check-pins   checks exact versions, lockfiles and the zero-config rule of the fixtures
  check-docs   checks the versions, the generated table and every snippet of docs/bundlers.md

Options:
  --dir <dir>        the bundlers directory (default: BUNDLERS_DIR, else the system temp directory)
  --only <names>     comma-separated targets or groups (${GROUPS.join(', ')})
  --tarball <file>   setup installs this tarball instead of running npm pack
  --latest           setup installs the latest version of every fixture dependency, without lockfiles
  --registry         setup installs ${PACKAGE}@latest from the registry instead of a tarball
  --dev              serve starts the dev servers instead of the builds, from port ${BUNDLERS_PORT + DEV_OFFSET + 1}
  --measured <dir>   report reads the measurements from here (default: <dir>/measure)
  --out <dir>        report also writes the measured report there

BUNDLERS_OFFLINE=1 points every registry setting at ${DEAD_REGISTRY} and adds --offline where the package
manager has it, so setup succeeds from a warm cache and fails naming the first package it lacks.
BUNDLERS_CACHE=<dir> keeps the npm cache, the pnpm store, the Yarn global folder and the Bun cache there.
Every package manager runs with an empty npmrc as its user config.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    options: {
      dir: { type: 'string' },
      only: { type: 'string' },
      tarball: { type: 'string' },
      latest: { type: 'boolean', default: false },
      registry: { type: 'boolean', default: false },
      dev: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
      measured: { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const dir = bundlersDir(values.dir);
  const [cmd] = positionals;
  const fail = (problems, ok) => {
    if (problems.length) {
      for (const p of problems) console.error(`bundlers: ${p}`);
      process.exitCode = 1;
    } else console.log(ok);
  };
  if (cmd === 'setup') setup(dir, targetsOf(values.only), { tarball: values.tarball, latest: values.latest, registry: values.registry });
  else if (cmd === 'build') build(dir, targetsOf(values.only));
  else if (cmd === 'serve') await serve(dir, targetsOf(values.only), { dev: values.dev });
  else if (cmd === 'report' && values['self-test']) fail(selfTest(), 'the report check catches a planted 50 KB first MP4, a changed status, a changed worker count and a dropped target');
  else if (cmd === 'report') fail(report(resolve(values.measured ?? join(dir, 'measure')), { write: values.write, out: values.out ? resolve(values.out) : null }), values.write ? 'report written' : 'the measured matrix matches report/bundlers.json');
  else if (cmd === 'check-pins') fail(checkPins(), `${TARGETS.length} targets pin exact versions, every lockfile is present and no zero-config file configures the package`);
  else if (cmd === 'check-docs') fail(checkDocs(), 'docs/bundlers.md matches versions.json, report/bundlers.json and every fixture snippet');
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}
