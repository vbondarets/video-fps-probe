import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, openAsBlob, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../../src/check/index.ts';
import { analyze } from '../../src/index.ts';
import { klingO1ReferenceVideo } from '../../src/presets/index.ts';
import { FILES_DIR, REPO_ROOT } from '../helpers/fixtures.ts';

const PACKAGE = 'video-fps-probe';
const FIXTURE = join(FILES_DIR, 'cfr_h264_30.mp4');
const NODE_TYPES = ['@types/node', 'undici-types'];

const CONSUMER_CJS = `'use strict';
const { openAsBlob } = require('node:fs');
const { analyze, ProbeError } = require('video-fps-probe');
const { check } = require('video-fps-probe/check');
const { klingO1ReferenceVideo } = require('video-fps-probe/presets');

(async () => {
  const result = await analyze(await openAsBlob(process.argv[2]), { name: 'cfr_h264_30.mp4' });
  const report = check(result, klingO1ReferenceVideo.rules);
  process.stdout.write(JSON.stringify({ probeError: typeof ProbeError, result: { ...result, io: null }, report }));
})();
`;

const CONSUMER_TS = `import { openAsBlob } from 'node:fs';
import { analyze, ProbeError, type ProbeResult } from 'video-fps-probe';
import { check, type CheckReport } from 'video-fps-probe/check';
import { klingO1ReferenceVideo } from 'video-fps-probe/presets';

async function main(path: string): Promise<void> {
  const result: ProbeResult = await analyze(await openAsBlob(path), { name: 'cfr_h264_30.mp4' });
  const report: CheckReport = check(result, klingO1ReferenceVideo.rules);
  process.stdout.write(JSON.stringify({ probeError: typeof ProbeError, result: { ...result, io: null }, report }));
}

void main(process.argv[2]!);
`;

const NEST_LIKE: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  ignoreDeprecations: '6.0',
  target: ts.ScriptTarget.ES2023,
  types: ['node'],
  strictNullChecks: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
};

const runNode = (dir: string, file: string): unknown =>
  JSON.parse(execFileSync(process.execPath, [file, FIXTURE], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

describe('the packed tarball from CommonJS', () => {
  let dir: string;
  let expected: unknown;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'commonjs-'));
    const [{ filename }] = JSON.parse(execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, env: { ...process.env, npm_config_update_notifier: 'false' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { filename: string }[];
    execFileSync('tar', ['-xzf', filename!], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, 'node_modules'));
    renameSync(join(dir, 'package'), join(dir, 'node_modules', PACKAGE));
    for (const name of NODE_TYPES) cpSync(join(REPO_ROOT, 'node_modules', name), join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'commonjs-consumer', private: true, type: 'commonjs' }));
    const result = await analyze(await openAsBlob(FIXTURE), { name: 'cfr_h264_30.mp4' });
    expected = JSON.parse(JSON.stringify({ probeError: 'function', result: { ...result, io: null }, report: check(result, klingO1ReferenceVideo.rules) }));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(`require() loads the ESM entries on Node ${process.versions.node} and gives the results of the source`, () => {
    writeFileSync(join(dir, 'consumer.cjs'), CONSUMER_CJS);
    expect(runNode(dir, 'consumer.cjs')).toEqual(expected);
    expect(expected).toMatchObject({ result: { error: null, videoTracks: [{ avgFps: { num: 30, den: 1 }, frames: 90 }] }, report: { verdict: 'fail' } });
  });

  it('a TypeScript project with module commonjs and moduleResolution node10, as a NestJS 11 one, compiles and runs', () => {
    const source = join(dir, 'consumer.ts');
    writeFileSync(source, CONSUMER_TS);
    const program = ts.createProgram([source], { ...NEST_LIKE, outDir: join(dir, 'out') });
    const problems = ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    expect(problems).toEqual([]);
    expect(program.emit().emitSkipped).toBe(false);
    expect(runNode(dir, join('out', 'consumer.js'))).toEqual(expected);
  });
});
