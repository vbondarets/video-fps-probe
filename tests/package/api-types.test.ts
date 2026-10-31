import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/fixtures.ts';

const PACKAGE = 'video-fps-probe';
const DOC = readFileSync(join(REPO_ROOT, 'docs', 'api.md'), 'utf8');
const EVERY_TYPE = 'every type on this page';
const PROSE_TYPES = ['VideoTrackResult', 'RateProfile', 'Provenance', 'TrackField'];
const REACT_TYPES = ['@types/react', 'csstype'];
const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  types: [],
  strict: true,
  noEmit: true,
  skipDefaultLibCheck: true,
};

const backticked = (text: string): string[] => [...text.matchAll(/`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`/g)].map((m) => m[1]!);

function codeBlockNames(): { types: Set<string>; imports: Map<string, string[]> } {
  const types = new Set<string>();
  const typeParameters = new Set<string>();
  const imports = new Map<string, string[]>();
  for (const [, code] of DOC.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const visit = (node: ts.Node): void => {
      if (ts.isTypeParameterDeclaration(node)) typeParameters.add(node.name.text);
      else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) types.add(node.typeName.text);
      else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) types.add(node.expression.text);
      else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) && node.name) types.add(node.name.text);
      else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(PACKAGE) && !node.moduleSpecifier.text.includes('?')) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) imports.set(node.moduleSpecifier.text, [...(imports.get(node.moduleSpecifier.text) ?? []), ...bindings.elements.map((e) => (e.propertyName ?? e.name).text)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('block.ts', code!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  for (const name of typeParameters) types.delete(name);
  return { types, imports };
}

function globalTypes(dir: string): { names: Set<string>; program: ts.Program } {
  const file = join(dir, 'globals.ts');
  writeFileSync(file, 'export {};\n');
  const program = ts.createProgram([file], OPTIONS);
  const names = program.getTypeChecker().getSymbolsInScope(program.getSourceFile(file)!, ts.SymbolFlags.Type | ts.SymbolFlags.Value);
  return { names: new Set(names.map((s) => s.name)), program };
}

function expectedImports(globals: Set<string>): Map<string, Set<string>> {
  const { types, imports } = codeBlockNames();
  for (const name of PROSE_TYPES) types.add(name);
  const docTypes = [...types].filter((name) => !globals.has(name));
  const expected = new Map<string, Set<string>>();
  const add = (entry: string, names: Iterable<string>) => expected.set(entry, new Set([...(expected.get(entry) ?? []), ...names]));
  for (const [, entry, cell] of DOC.matchAll(/^\| `(video-fps-probe[^`]*)` \| ([^|]*) \|/gm)) {
    const [listed, except] = cell!.split(EVERY_TYPE);
    add(entry!, backticked(listed!));
    if (except !== undefined) {
      const excluded = new Set(backticked(except));
      add(entry!, docTypes.filter((name) => !excluded.has(name)));
    }
  }
  for (const [entry, names] of imports) add(entry, names);
  for (const [entry, names] of expected) if (names.size === 0) expected.delete(entry);
  return expected;
}

describe('the types and values docs/api.md names', () => {
  let dir: string;
  let globals: ReturnType<typeof globalTypes>;
  let expected: Map<string, Set<string>>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-types-'));
    const [{ filename }] = JSON.parse(execSync(`npm pack --ignore-scripts --json --pack-destination "${dir}"`, { cwd: REPO_ROOT, env: { ...process.env, npm_config_update_notifier: 'false' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { filename: string }[];
    execFileSync('tar', ['-xzf', filename!], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, 'node_modules'));
    renameSync(join(dir, 'package'), join(dir, 'node_modules', PACKAGE));
    for (const name of REACT_TYPES) cpSync(join(REPO_ROOT, 'node_modules', name), join(dir, 'node_modules', name), { recursive: true });
    globals = globalTypes(dir);
    expected = expectedImports(globals.names);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('are read from the entries table and the code blocks', () => {
    expect(PROSE_TYPES.filter((name) => !new RegExp(`\\b${name}\\b`).test(DOC))).toEqual([]);
    expect([...expected.keys()].sort()).toEqual([PACKAGE, ...['aspect', 'check', 'client', 'client/lazy', 'color', 'engines/mediabunny', 'engines/mp4box', 'header', 'lazy', 'mediabunny', 'mp4box', 'presets', 'react', 'rvfc', 'url', 'worker-runtime'].map((e) => `${PACKAGE}/${e}`)]);
    expect([...expected.get(`${PACKAGE}/presets`)!].sort()).toEqual(['PresetSourceKind', 'ProviderPreset', 'klingMotionControl', 'klingO1ReferenceVideo', 'runwayAleph2', 'seedance2ReferenceVideo', 'veoExtend', 'wan26ReferenceToVideoFal']);
    expect([...expected.get(`${PACKAGE}/check`)!].sort()).toEqual(['AspectRatioRule', 'CheckExpected', 'CheckReport', 'CheckRules', 'CheckSeverity', 'CheckVerdict', 'CheckViolation', 'FpsRule', 'FpsSource', 'FrameSizeRule', 'RangeRule', 'RatePolicy', 'RatioValue', 'SuggestedFps', 'check']);
    expect(['check', 'CheckRules', 'CheckReport', 'RatioValue', 'ProviderPreset', 'PresetSourceKind'].filter((name) => expected.get(PACKAGE)!.has(name) || expected.get(`${PACKAGE}/client`)!.has(name))).toEqual([]);
    expect([...expected.get(`${PACKAGE}/react`)!].sort()).toEqual(['UseVideoFpsOptions', 'VideoFpsProvider', 'VideoFpsProviderProps', 'VideoFpsState', 'VideoFpsSummary', 'usePrewarmVideoFps', 'useVideoFps', 'useVideoFpsProbe']);
    expect(['VideoFpsProviderProps', 'UseVideoFpsOptions', 'VideoFpsState'].filter((name) => expected.get(PACKAGE)!.has(name) || expected.get(`${PACKAGE}/client`)!.has(name))).toEqual([]);
    expect([...expected.get(PACKAGE)!]).toEqual(expect.arrayContaining(['createProbe', 'analyze', 'Mp4boxNative', 'MediabunnyNative', 'RvfcDetails', 'VideoTrackResult', 'InThreadOptions', 'BlobLike']));
    expect([...expected.get(`${PACKAGE}/client`)!]).toEqual(expect.arrayContaining(['createProbeClient', 'Mp4boxNative', 'BlobLike']));
    expect(expected.get(`${PACKAGE}/client`)!.has('InThreadOptions')).toBe(false);
    expect([...expected.get(`${PACKAGE}/header`)!]).toEqual(expect.arrayContaining(['analyzeHeader', 'HEADER_DEFAULT_LIMITS', 'HeaderOptions', 'HeaderLimits', 'HeaderResult', 'FileResult', 'BlobLike', 'isTimeoutError']));
    expect(['HeaderOptions', 'HeaderLimits', 'HeaderResult'].filter((name) => expected.get(PACKAGE)!.has(name) || expected.get(`${PACKAGE}/client`)!.has(name))).toEqual([]);
    expect([...expected.get(`${PACKAGE}/url`)!].sort()).toEqual(['BlobLike', 'BlobSlice', 'HttpRangeInit', 'OpenRangeSourceInit', 'RangeFetcher', 'RangeReply', 'RangeRequest', 'RangeSource', 'RangeSourceError', 'RangeSourceErrorCode', 'RangeSourceErrorOptions', 'RangeSourceInit', 'httpRange', 'openRangeSource', 'rangeSource', 'readCapped']);
    expect(['RangeSource', 'RangeFetcher', 'RangeReply', 'RangeSourceError', 'HttpRangeInit'].filter((name) => expected.get(PACKAGE)!.has(name) || expected.get(`${PACKAGE}/client`)!.has(name))).toEqual([]);
    expect(expected.get(PACKAGE)!.has('Promise')).toBe(false);
  });

  it('resolve from the packed tarball, each from the entry the doc names', () => {
    const files = [...expected].map(([entry, names], i) => {
      const file = join(dir, `check-${i}.ts`);
      writeFileSync(file, `import type { ${[...names].sort().join(', ')} } from '${entry}';\n`);
      return file;
    });
    const program = ts.createProgram(files, OPTIONS, undefined, globals.program);
    const problems = ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    expect(problems).toEqual([]);
  });
});
