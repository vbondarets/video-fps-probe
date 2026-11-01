import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { baselineDir, bundlersDir, measureDir, tarballInfo, targetDir, toolEnv, versions } from '../../scripts/bundlers.mjs';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { SERVER_FILE, TARGETS, type BundlerRunner, type BundlerTarget } from './targets.mjs';

interface ServerOutput {
  loader: 'import' | 'require' | 'framework';
  resolved?: string[];
  sharedWithImport?: boolean[];
  run: unknown;
}

const DIR = bundlersDir();
const FILE = join(FILES_DIR, SERVER_FILE);
const WIN = process.platform === 'win32';

export const relativeToPackage = (path: string): string => {
  const normal = decodeURIComponent(path).split('\\').join('/');
  const at = normal.lastIndexOf('/video-fps-probe/');
  return at === -1 ? normal : normal.slice(at + '/video-fps-probe/'.length);
};

function spawned(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const shell = WIN && command !== process.execPath && !/\.exe$/i.test(command);
  const quoted = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a}"`);
  const child = spawn(shell ? [command, ...args].map(quoted).join(' ') : command, shell ? [] : args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  return new Promise((done, fail) => child.once('error', fail).once('close', (status) => done({ status, stdout, stderr })));
}

async function exec(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ServerOutput> {
  const r = await spawned(command, args, cwd, env);
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${r.status} in ${cwd}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{"loader"'))) as ServerOutput;
}

let baseline: Promise<ServerOutput> | null = null;
function nodeBaseline(): Promise<ServerOutput> {
  baseline ??= exec(process.execPath, ['server-run.mjs', FILE], baselineDir(DIR), toolEnv(DIR));
  return baseline;
}

function runnerCommand(target: BundlerTarget, runner: BundlerRunner): { command: string; args: string[] } {
  const { runtimes } = versions();
  if (target.pm === 'bun' && target.name !== 'bun-install') return { command: 'bun', args: ['run', runner.file, FILE] };
  if (target.pm === 'pnpm') return { command: 'npm', args: ['exec', '--yes', `--package=pnpm@${runtimes.pnpm}`, '--', 'pnpm', 'exec', 'node', runner.file, FILE] };
  if (target.pm === 'yarn') return { command: 'npm', args: ['exec', '--yes', `--package=@yarnpkg/cli-dist@${runtimes.yarn}`, '--', 'yarn', 'node', runner.file, FILE] };
  return { command: process.execPath, args: [runner.file, FILE] };
}

const RUNS_IN: Record<string, string> = {
  'bun-build': 'Bun, `bun run`',
  'bun-build-configured': 'Bun, `bun run`',
  deno: 'Deno, npm specifiers',
  'pnpm-strict': 'Node, `pnpm exec node`',
  'pnpm-hoisted': 'Node, `pnpm exec node`',
  'yarn-pnp': 'Node, `yarn node` (PnP)',
  'bun-install': 'Node, on the bun install',
};

async function miniRegistry(): Promise<{ server: Server; url: string }> {
  const info = tarballInfo(DIR);
  const bytes = readFileSync(join(DIR, info.file!));
  const manifest = JSON.parse(spawnSync('tar', ['-xOzf', info.file!, 'package/package.json'], { cwd: DIR, encoding: 'utf8' }).stdout) as Record<string, unknown>;
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const shasum = createHash('sha1').update(bytes).digest('hex');
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (path === '/video-fps-probe') {
      const version = { ...manifest, dist: { tarball: `${base}/video-fps-probe/-/video-fps-probe-${info.version}.tgz`, integrity, shasum } };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'video-fps-probe', 'dist-tags': { latest: info.version }, versions: { [info.version]: version } }));
    } else if (path === `/video-fps-probe/-/video-fps-probe-${info.version}.tgz`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }).end(bytes);
    } else res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
}

function record(target: BundlerTarget, runner: string, runs: Array<{ loader: string; resolved: string[] | null; sharedWithImport: boolean[] | null }>): void {
  const dir = measureDir(DIR, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'server.json'), `${JSON.stringify({ target: target.name, runner, file: SERVER_FILE, runs }, null, 2)}\n`);
}

for (const target of TARGETS.filter((t) => t.route)) {
  test(`${target.name}: the seven server entries in the framework route give the Node results @${target.group}`, async () => {
    const reply = await fetch(`http://127.0.0.1:${target.port}${target.route}?file=${encodeURIComponent(SERVER_FILE)}`);
    expect(reply.status).toBe(200);
    const out = (await reply.json()) as ServerOutput;
    expect(out.loader).toBe('framework');
    expect(out.run).toEqual((await nodeBaseline()).run);
    const built = JSON.parse(readFileSync(join(measureDir(DIR, target), 'build.json'), 'utf8')) as { server: { bundled: boolean; external: boolean } };
    expect(built.server.bundled !== built.server.external, `the server build either bundles the package or imports it from node_modules: ${JSON.stringify(built.server)}`).toBe(true);
    expect(built.server.bundled ? 'bundled' : 'external', 'how the server build loads the package').toBe(target.serverLoads);
    record(target, 'the framework route on the production server', [{ loader: built.server.bundled ? 'bundled' : 'external', resolved: null, sharedWithImport: null }]);
  });
}

for (const target of TARGETS.filter((t) => t.runners)) {
  test(`${target.name}: the seven server entries by import and by require give the Node results @${target.group}`, async () => {
    const root = targetDir(DIR, target);
    const runs: Array<{ loader: string; resolved: string[] | null; sharedWithImport: boolean[] | null }> = [];
    let registry: { server: Server; url: string } | null = null;
    let denoDir: string | null = null;
    try {
      let env = toolEnv(DIR);
      if (target.pm === 'deno') {
        denoDir = mkdtempSync(join(tmpdir(), 'video-fps-probe-deno-'));
        const registryMode = tarballInfo(DIR).file === null;
        if (!registryMode) registry = await miniRegistry();
        env = { ...env, DENO_DIR: denoDir, DENO_NO_UPDATE_CHECK: '1', ...(registry ? { NPM_CONFIG_REGISTRY: registry.url } : {}) };
        rmSync(join(root, 'node_modules'), { recursive: true, force: true });
        const install = await spawned('deno', ['install'], root, env);
        expect(install.status, `deno install\n${install.stdout}\n${install.stderr}`).toBe(0);
      }
      for (const runner of target.runners!) {
        const { command, args } =
          target.pm === 'deno' ? { command: 'deno', args: ['run', `--allow-read=${root},${FILES_DIR}`, '--allow-net=127.0.0.1', runner.file, FILE] } : runnerCommand(target, runner);
        const out = await exec(command, args, root, env);
        expect(out.loader).toBe(runner.loader);
        expect(out.run, `${runner.file} gives the Node results`).toEqual((await nodeBaseline()).run);
        const resolved = out.resolved!.map(relativeToPackage);
        if (target.resolved?.[runner.loader]) expect(resolved, `${runner.file} resolves the entries to`).toEqual(target.resolved[runner.loader]);
        if (runner.loader === 'require' && target.sharedWithImport) expect(out.sharedWithImport, 'require() returns the module import returns').toEqual(target.sharedWithImport);
        runs.push({ loader: runner.loader, resolved, sharedWithImport: out.sharedWithImport ?? null });
      }
    } finally {
      registry?.server.close();
      if (denoDir) rmSync(denoDir, { recursive: true, force: true });
    }
    record(target, RUNS_IN[target.name] ?? target.pm, runs);
  });
}
