import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, openAsBlob, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../../src/check/index.ts';
import { analyze } from '../../src/index.ts';
import { klingO1ReferenceVideo } from '../../src/presets/index.ts';
import { FILES_DIR, REPO_ROOT } from '../helpers/fixtures.ts';

const JEST_DIR = join(REPO_ROOT, 'tests', 'package', 'jest-cjs');
const INSTALLED = join(JEST_DIR, 'node_modules', 'video-fps-probe');
const JEST_BIN = join(JEST_DIR, 'node_modules', 'jest', 'bin', 'jest.js');
const PINNED = (JSON.parse(readFileSync(join(JEST_DIR, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies;
const NPM_ENV = { ...process.env, npm_config_update_notifier: 'false' };

function installedJest(): string | null {
  const manifest = join(JEST_DIR, 'node_modules', 'jest', 'package.json');
  return existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version : null;
}

function installJest(): string {
  const home = mkdtempSync(join(tmpdir(), 'jest-cjs-npmrc-'));
  writeFileSync(join(home, '.npmrc'), '');
  try {
    execSync(`npm ci --offline --no-audit --no-fund --userconfig "${join(home, '.npmrc')}"`, { cwd: JEST_DIR, env: NPM_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (e) {
    const lines = String((e as { stderr?: string }).stderr || e).trim().split('\n');
    return (lines.find((line) => line.startsWith('npm error')) ?? lines[0])!;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function jestOrReason(): string | null {
  if (installedJest() === PINNED.jest) return null;
  const failure = installJest();
  return installedJest() === PINNED.jest ? null : `Jest ${PINNED.jest} is not installed in tests/package/jest-cjs and the npm cache lacks it${failure ? ` (${failure})` : ''}: run npm ci --prefix tests/package/jest-cjs`;
}

const SKIPPED = jestOrReason();
if (SKIPPED && process.env.CI) throw new Error(SKIPPED);
if (SKIPPED) console.warn(`skipping the Jest package test: ${SKIPPED}`);

describe.skipIf(SKIPPED !== null)('the packed tarball under Jest from a CommonJS project', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jest-cjs-'));
    const [{ filename }] = JSON.parse(execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, env: NPM_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { filename: string }[];
    execFileSync('tar', ['-xzf', filename!], { cwd: dir, stdio: 'ignore' });
    rmSync(INSTALLED, { recursive: true, force: true });
    renameSync(join(dir, 'package'), INSTALLED);
  });

  afterAll(() => {
    rmSync(INSTALLED, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(`babel-jest with transformIgnorePatterns and the import.meta, dynamic import and CommonJS plugins runs analyze and check with a preset on Node ${process.versions.node}`, async () => {
    const out = join(dir, 'out.json');
    execFileSync(process.execPath, [JEST_BIN, '--ci', '--no-cache', '--runInBand'], { cwd: JEST_DIR, env: { ...process.env, JEST_CJS_OUT: out }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await analyze(await openAsBlob(join(FILES_DIR, 'cfr_h264_30.mp4')), { name: 'cfr_h264_30.mp4' });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(JSON.parse(JSON.stringify({ result: { ...result, io: null }, report: check(result, klingO1ReferenceVideo.rules) })));
  });
});
