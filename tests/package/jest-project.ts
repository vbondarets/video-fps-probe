import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, openAsBlob, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../../src/check/index.ts';
import { analyzeHeader, errorClass, type HeaderResult } from '../../src/header/index.ts';
import { analyze } from '../../src/index.ts';
import { klingO1ReferenceVideo } from '../../src/presets/index.ts';
import { FILES_DIR, REPO_ROOT } from '../helpers/fixtures.ts';

const NPM_ENV = { ...process.env, npm_config_update_notifier: 'false' };

export interface JestProject {
  readonly name: string;
  readonly dir: string;
  readonly bin: string;
  readonly jest: string;
}

export function jestProject(name: string): JestProject {
  const dir = join(REPO_ROOT, 'tests', 'package', name);
  const { dependencies } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  return { name, dir, bin: join(dir, 'node_modules', 'jest', 'bin', 'jest.js'), jest: dependencies.jest! };
}

function installedJest(project: JestProject): string | null {
  const manifest = join(project.dir, 'node_modules', 'jest', 'package.json');
  return existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version : null;
}

function install(project: JestProject): string {
  const home = mkdtempSync(join(tmpdir(), `${project.name}-npmrc-`));
  writeFileSync(join(home, '.npmrc'), '');
  try {
    execSync(`npm ci --offline --no-audit --no-fund --userconfig "${join(home, '.npmrc')}"`, { cwd: project.dir, env: NPM_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (e) {
    const lines = String((e as { stderr?: string }).stderr || e).trim().split('\n');
    return (lines.find((line) => line.startsWith('npm error')) ?? lines[0])!;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function jestOrReason(project: JestProject): string | null {
  if (installedJest(project) === project.jest) return null;
  const failure = install(project);
  return installedJest(project) === project.jest ? null : `Jest ${project.jest} is not installed in tests/package/${project.name} and the npm cache lacks it${failure ? ` (${failure})` : ''}: run npm ci --prefix tests/package/${project.name}`;
}

export function installTarball(project: JestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), `${project.name}-`));
  const installed = join(project.dir, 'node_modules', 'video-fps-probe');
  const [{ filename }] = JSON.parse(execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, env: NPM_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { filename: string }[];
  execFileSync('tar', ['-xzf', filename!], { cwd: dir, stdio: 'ignore' });
  rmSync(installed, { recursive: true, force: true });
  renameSync(join(dir, 'package'), installed);
  return () => {
    rmSync(installed, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  };
}

export function runJest(project: JestProject, env: Record<string, string>): unknown {
  const out = join(mkdtempSync(join(tmpdir(), `${project.name}-out-`)), 'out.json');
  try {
    execFileSync(process.execPath, [project.bin, '--ci', '--no-cache', '--runInBand'], { cwd: project.dir, env: { ...process.env, ...env, JEST_OUT: out }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
}

export const SERVER_ENTRIES = ['video-fps-probe', 'video-fps-probe/header', 'video-fps-probe/url', 'video-fps-probe/check', 'video-fps-probe/presets'];
export const JEST_FIXTURE = join(FILES_DIR, 'cfr_h264_30.mp4');

export async function expectedRun(): Promise<Record<string, unknown>> {
  const name = 'cfr_h264_30.mp4';
  const blob = await openAsBlob(JEST_FIXTURE);
  const result = await analyze(blob, { name });
  const header = await analyzeHeader(blob, { name });
  const withoutMs = (r: HeaderResult) => ({ ...r, io: { ...r.io, ms: 0 } });
  return JSON.parse(
    JSON.stringify({
      result: { ...result, io: null },
      header: withoutMs(header),
      ranged: withoutMs(header),
      calls: header.io.reads,
      report: check(result, klingO1ReferenceVideo.rules),
      refused: { name: 'RangeSourceError', code: 'unexpected-status', status: 200, instance: true },
      guards: [true, true, errorClass('time-limit')],
    }),
  ) as Record<string, unknown>;
}

export const relativeToPackage = (paths: unknown): string[] => (paths as string[]).map((p) => p.split('\\').join('/').replace(/^.*\/node_modules\/video-fps-probe\//, ''));
