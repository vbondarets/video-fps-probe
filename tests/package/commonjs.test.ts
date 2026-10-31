import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, openAsBlob, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../../src/check/index.ts';
import { analyze } from '../../src/index.ts';
import { klingO1ReferenceVideo } from '../../src/presets/index.ts';
import sources from '../../src/presets/sources.json' with { type: 'json' };
import { FILES_DIR, REPO_ROOT } from '../helpers/fixtures.ts';

const PACKAGE = 'video-fps-probe';
const FIXTURE = join(FILES_DIR, 'cfr_h264_30.mp4');
const NODE_TYPES = ['@types/node', 'undici-types'];

const CONSUMER_CJS = `'use strict';
const { openAsBlob } = require('node:fs');
const { analyze, ProbeError } = require('video-fps-probe');
const { check } = require('video-fps-probe/check');
const { klingO1ReferenceVideo } = require('video-fps-probe/presets');
const sources = require('video-fps-probe/presets/sources.json');

(async () => {
  const result = await analyze(await openAsBlob(process.argv[2]), { name: 'cfr_h264_30.mp4' });
  const report = check(result, klingO1ReferenceVideo.rules);
  process.stdout.write(JSON.stringify({ probeError: typeof ProbeError, result: { ...result, io: null }, report, source: sources.klingO1ReferenceVideo }));
})();
`;

const CONSUMER_TS = `import { openAsBlob } from 'node:fs';
import { analyze, ProbeError, type ProbeResult } from 'video-fps-probe';
import { check, type CheckReport } from 'video-fps-probe/check';
import { klingO1ReferenceVideo } from 'video-fps-probe/presets';
import sources from 'video-fps-probe/presets/sources.json';

async function main(path: string): Promise<void> {
  const result: ProbeResult = await analyze(await openAsBlob(path), { name: 'cfr_h264_30.mp4' });
  const report: CheckReport = check(result, klingO1ReferenceVideo.rules);
  process.stdout.write(JSON.stringify({ probeError: typeof ProbeError, result: { ...result, io: null }, report, source: sources.klingO1ReferenceVideo }));
}

void main(process.argv[2]!);
`;

const CONSUMER_020 = `import { klingO1ReferenceVideo, type ProviderPreset } from 'video-fps-probe/presets';

const preset: ProviderPreset = klingO1ReferenceVideo;
const url: string = klingO1ReferenceVideo.sourceUrl;
process.stdout.write(JSON.stringify({ url, again: preset.sourceUrl }));
`;

const TS59 = '5.9.3';
const TS59_DIR = join(REPO_ROOT, 'tests', 'package', 'ts59');

function loadTs59(): typeof ts | null {
  try {
    const compiler = createRequire(import.meta.url)(join(TS59_DIR, 'node_modules', 'typescript')) as typeof ts;
    return compiler.version === TS59 ? compiler : null;
  } catch {
    return null;
  }
}

function installTs59(): string {
  const home = mkdtempSync(join(tmpdir(), 'ts59-npmrc-'));
  writeFileSync(join(home, '.npmrc'), '');
  try {
    execSync(`npm ci --offline --no-audit --no-fund --userconfig "${join(home, '.npmrc')}"`, { cwd: TS59_DIR, env: { ...process.env, npm_config_update_notifier: 'false' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (e) {
    return String((e as { stderr?: string }).stderr || e).trim().split('\n')[0]!;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function ts59(): typeof ts | string {
  const installed = loadTs59();
  if (installed) return installed;
  const failure = installTs59();
  return loadTs59() ?? `TypeScript ${TS59} is not installed in tests/package/ts59 and the npm cache lacks it${failure ? ` (${failure})` : ''}: run npm ci --prefix tests/package/ts59`;
}

const TS59_OR_REASON = ts59();
const SKIPPED_TS59 = typeof TS59_OR_REASON === 'string' ? TS59_OR_REASON : null;
if (SKIPPED_TS59 && process.env.CI) throw new Error(SKIPPED_TS59);
if (SKIPPED_TS59) console.warn(`skipping the TypeScript ${TS59} cases of the CommonJS package test: ${SKIPPED_TS59}`);
const COMPILERS = typeof TS59_OR_REASON === 'string' ? [ts] : [ts, TS59_OR_REASON];

const nestLike = (compiler: typeof ts): ts.CompilerOptions => ({
  module: compiler.ModuleKind.CommonJS,
  moduleResolution: compiler.ModuleResolutionKind.Node10,
  ...(compiler.versionMajorMinor === '6.0' && { ignoreDeprecations: '6.0' }),
  target: compiler.ScriptTarget.ES2023,
  types: ['node'],
  strictNullChecks: true,
  skipLibCheck: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  allowSyntheticDefaultImports: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
});

const runNode = (dir: string, file: string, flags: string[] = []): unknown =>
  JSON.parse(execFileSync(process.execPath, [...flags, file, FIXTURE], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

const SERVER_ENTRIES = ['', '/header', '/url', '/check', '/presets'].map((e) => `${PACKAGE}${e}`);
const ESM_FILES = ['dist/index.js', 'dist/header/index.js', 'dist/url/index.js', 'dist/check/index.js', 'dist/presets/index.js'];
const CJS_FILES = ['dist/cjs/index.cjs', 'dist/cjs/header.cjs', 'dist/cjs/url.cjs', 'dist/cjs/check.cjs', 'dist/cjs/presets.cjs'];

const RESOLVE_MJS = `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const entries = ${JSON.stringify(SERVER_ENTRIES)};
const tail = (p) => p.split('\\\\').join('/').replace(/^.*\\/node_modules\\/${PACKAGE}\\//, '');
const out = [];
for (const e of entries) out.push({ required: tail(require.resolve(e)), imported: tail(decodeURIComponent(new URL(import.meta.resolve(e)).pathname)), one: require(e) === (await import(e)) });
process.stdout.write(JSON.stringify(out));
`;

const CONSUMER_ABSOLUTE = CONSUMER_CJS.replace(/require\('video-fps-probe(\/[a-z]+)?'\)/g, (_, sub: string | undefined) => `require(require('node:path').join(__dirname, 'node_modules', '${PACKAGE}', 'dist', 'cjs', '${sub ? sub.slice(1) : 'index'}.cjs'))`);

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
    expected = JSON.parse(JSON.stringify({ probeError: 'function', result: { ...result, io: null }, report: check(result, klingO1ReferenceVideo.rules), source: sources.klingO1ReferenceVideo }));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(`require() loads the ESM entries on Node ${process.versions.node} and gives the results of the source`, () => {
    writeFileSync(join(dir, 'consumer.cjs'), CONSUMER_CJS);
    expect(runNode(dir, 'consumer.cjs')).toEqual(expected);
    expect(expected).toMatchObject({ result: { error: null, videoTracks: [{ avgFps: { num: 30, den: 1 }, frames: 90 }] }, report: { verdict: 'fail' } });
  });

  it.each(COMPILERS.map((compiler) => [compiler.version, compiler] as const))('a TypeScript %s project with module commonjs and moduleResolution node10, as a NestJS 11 one, compiles and runs', (version, compiler) => {
    const source = join(dir, 'consumer.ts');
    writeFileSync(source, CONSUMER_TS);
    const program = compiler.createProgram([source], { ...nestLike(compiler), outDir: join(dir, `out-${version}`) });
    const problems = compiler.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}TS${d.code} ${compiler.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    expect(problems).toEqual([]);
    expect(program.emit().emitSkipped).toBe(false);
    expect(runNode(dir, join(`out-${version}`, 'consumer.js'))).toEqual(expected);
  });

  it.each(COMPILERS.map((compiler) => [compiler.version, compiler] as const))('a 0.2.0 consumer that reads preset.sourceUrl compiles with TypeScript %s, sees it deprecated and gets the page of presets/sources.json', (version, compiler) => {
    const source = join(dir, 'consumer-020.ts');
    writeFileSync(source, CONSUMER_020);
    const program = compiler.createProgram([source], { ...nestLike(compiler), outDir: join(dir, `out-020-${version}`) });
    expect(compiler.getPreEmitDiagnostics(program).map((d) => compiler.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual([]);
    const checker = program.getTypeChecker();
    const tags: string[] = [];
    const visit = (node: ts.Node): void => {
      if (compiler.isPropertyAccessExpression(node) && node.name.text === 'sourceUrl') {
        for (const tag of checker.getSymbolAtLocation(node.name)?.getJsDocTags(checker) ?? []) tags.push(`@${tag.name} ${compiler.displayPartsToString(tag.text)}`);
      }
      compiler.forEachChild(node, visit);
    };
    visit(program.getSourceFile(source)!);
    expect(tags).toEqual(Array(2).fill('@deprecated Use video-fps-probe/presets/sources.json; sourceUrl will be removed in the next major.'));
    expect(program.emit().emitSkipped).toBe(false);
    expect(runNode(dir, join(`out-020-${version}`, 'consumer-020.js'))).toEqual({ url: sources.klingO1ReferenceVideo, again: sources.klingO1ReferenceVideo });
  });

  it(`require.resolve of every server entry lands on its ESM file on Node ${process.versions.node}, as one instance with import`, () => {
    writeFileSync(join(dir, 'resolve.mjs'), RESOLVE_MJS);
    expect(runNode(dir, 'resolve.mjs')).toEqual(ESM_FILES.map((f) => ({ required: f, imported: f, one: true })));
  });

  it('with --no-experimental-require-module require resolves every server entry to its .cjs file and gives the results of the source', () => {
    expect(runNode(dir, 'resolve.mjs', ['--no-experimental-require-module'])).toEqual(ESM_FILES.map((f, i) => ({ required: CJS_FILES[i], imported: f, one: false })));
    writeFileSync(join(dir, 'consumer.cjs'), CONSUMER_CJS);
    expect(runNode(dir, 'consumer.cjs', ['--no-experimental-require-module'])).toEqual(expected);
  });

  it('the .cjs files required by their absolute path give the results of the source', () => {
    writeFileSync(join(dir, 'consumer-absolute.cjs'), CONSUMER_ABSOLUTE);
    expect(CONSUMER_ABSOLUTE).toContain(`'dist', 'cjs', 'index.cjs'`);
    expect(runNode(dir, 'consumer-absolute.cjs')).toEqual(expected);
  });

  it.skipIf(SKIPPED_TS59 !== null)(`covers TypeScript 6.0.3, the one of the repo, and ${TS59} from tests/package/ts59`, () => {
    expect(COMPILERS.map((compiler) => compiler.version)).toEqual(['6.0.3', TS59]);
  });
});
