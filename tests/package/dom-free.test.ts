import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/fixtures.ts';

const PACKAGE = 'video-fps-probe';
const PROJECT = join(REPO_ROOT, 'tests', 'package', 'dom-free');
const FILES = ['tsconfig.json', 'server.mts', 'server.cts', 'server.ts'];
const NODE_TYPES = ['@types/node', 'undici-types'];
const ENTRIES = ['header', 'url', 'check', 'presets'];
const VARIANTS = [
  { name: 'node16', compilerOptions: { module: 'node16', moduleResolution: 'node16' }, files: ['server.mts', 'server.cts'], cts: true },
  { name: 'commonjs and node10', compilerOptions: { module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0' }, files: ['server.ts'], cts: false },
  { name: 'esnext and bundler', compilerOptions: { module: 'esnext', moduleResolution: 'bundler' }, files: ['server.ts'], cts: false },
  { name: 'preserve and bundler', compilerOptions: { module: 'preserve', moduleResolution: 'bundler' }, files: ['server.ts'], cts: false },
];

function compile(dir: string, config: string): { problems: string[]; declarations: string[] } {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(dir, config), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  expect(parsed.errors).toEqual([]);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const problems = ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  const declarations = program.getSourceFiles().map((f) => f.fileName.split('\\').join('/')).filter((f) => f.includes(`/node_modules/${PACKAGE}/`)).map((f) => f.slice(f.indexOf('/dist/') + 1));
  return { problems, declarations };
}

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
    const { problems, declarations } = compile(dir, 'tsconfig.json');
    expect(problems).toEqual([]);
    expect(declarations.filter((f) => f.endsWith('.d.cts'))).toEqual(expect.arrayContaining(ENTRIES.map((e) => `dist/cjs/${e}/index.d.cts`)));
    expect(declarations.filter((f) => f.endsWith('.d.ts'))).toEqual(expect.arrayContaining(ENTRIES.map((e) => `dist/${e}/index.d.ts`)));
  });

  it.each(VARIANTS)(`compiles the same entries under $name with TypeScript ${ts.version}, without skipLibCheck`, ({ name, compilerOptions, files, cts }) => {
    const config = `tsconfig.${name.replace(/ /g, '-')}.json`;
    writeFileSync(join(dir, config), JSON.stringify({ extends: './tsconfig.json', compilerOptions, files }));
    const { problems, declarations } = compile(dir, config);
    expect(problems).toEqual([]);
    expect(declarations.filter((f) => f.endsWith('.d.ts'))).toEqual(expect.arrayContaining(ENTRIES.map((e) => `dist/${e}/index.d.ts`)));
    expect(declarations.filter((f) => f.endsWith('.d.cts'))).toEqual(cts ? expect.arrayContaining(ENTRIES.map((e) => `dist/cjs/${e}/index.d.cts`)) : []);
  });
});
