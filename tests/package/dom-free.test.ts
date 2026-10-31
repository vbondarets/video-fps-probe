import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/fixtures.ts';

const PACKAGE = 'video-fps-probe';
const PROJECT = join(REPO_ROOT, 'tests', 'package', 'dom-free');
const FILES = ['tsconfig.json', 'server.mts', 'server.cts'];
const NODE_TYPES = ['@types/node', 'undici-types'];

describe('a DOM-free TypeScript project for Node', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dom-free-'));
    const [{ filename }] = JSON.parse(execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, env: { ...process.env, npm_config_update_notifier: 'false' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { filename: string }[];
    execFileSync('tar', ['-xzf', filename!], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, 'node_modules'));
    renameSync(join(dir, 'package'), join(dir, 'node_modules', PACKAGE));
    for (const name of NODE_TYPES) cpSync(join(REPO_ROOT, 'node_modules', name), join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dom-free-consumer', private: true, type: 'commonjs' }));
    for (const file of FILES) cpSync(join(PROJECT, file), join(dir, file));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('uses lib ES2022, the node types only and no skipLibCheck', () => {
    const { compilerOptions } = JSON.parse(readFileSync(join(PROJECT, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    expect(compilerOptions).toMatchObject({ lib: ['ES2022'], types: ['node'], module: 'nodenext' });
    expect(compilerOptions.skipLibCheck).toBeUndefined();
  });

  it(`compiles ./header, ./url, ./check and ./presets from an ESM and a CommonJS file with TypeScript ${ts.version}`, () => {
    const config = ts.getParsedCommandLineOfConfigFile(join(dir, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
    expect(config.errors).toEqual([]);
    const program = ts.createProgram(config.fileNames, config.options);
    const problems = ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    expect(problems).toEqual([]);
    const declarations = program.getSourceFiles().map((f) => f.fileName.split('\\').join('/')).filter((f) => f.includes(`/node_modules/${PACKAGE}/`)).map((f) => f.slice(f.indexOf('/dist/') + 1));
    expect(declarations.filter((f) => f.endsWith('.d.cts'))).toEqual(expect.arrayContaining(['dist/cjs/header/index.d.cts', 'dist/cjs/url/index.d.cts', 'dist/cjs/check/index.d.cts', 'dist/cjs/presets/index.d.cts']));
    expect(declarations.filter((f) => f.endsWith('.d.ts'))).toEqual(expect.arrayContaining(['dist/header/index.d.ts', 'dist/url/index.d.ts', 'dist/check/index.d.ts', 'dist/presets/index.d.ts']));
  });
});
