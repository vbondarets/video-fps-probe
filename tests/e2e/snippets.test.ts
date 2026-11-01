import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as presets from '../../src/presets/index.ts';
import { ANALYZE_SNIPPET, checkSnippet, COLOR_SNIPPET, ERRORS_SNIPPET, headerSnippet, LIMIT_PRESETS, urlSnippet, type SnippetPair } from '../../demo/src/ui/snippets.ts';
import { REPO_ROOT } from '../helpers/fixtures.ts';

const PACKAGE = 'video-fps-probe';
const DTS_SPECIFIER = /(['"])(\.{1,2}\/[^'"]+)\.ts\1/g;
const TYPE_ROOTS = [join(REPO_ROOT, 'node_modules', '@types')];
const COMMON: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, noUnusedLocals: true, skipDefaultLibCheck: true, typeRoots: TYPE_ROOTS };
const BROWSER: ts.CompilerOptions = { ...COMMON, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'], types: [] };
const NODE: ts.CompilerOptions = { ...COMMON, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ['lib.es2022.d.ts'], types: ['node'] };

function shownSnippets(): Map<string, SnippetPair> {
  const shown = new Map<string, SnippetPair>([
    ['analyze', ANALYZE_SNIPPET],
    ['color', COLOR_SNIPPET],
    ['errors', ERRORS_SNIPPET],
    ['url-header', urlSnippet('header')],
    ['url-full', urlSnippet('full')],
  ]);
  for (const p of LIMIT_PRESETS) {
    for (const fragmentedDuration of ['index', 'header'] as const) {
      shown.set(`header-${p.id}-${fragmentedDuration}`, headerSnippet({ limits: p.limits, fragmentedDuration, color: true, aspect: true }));
    }
  }
  shown.set('header-empty', headerSnippet({ limits: {}, fragmentedDuration: 'index', color: false, aspect: false }));
  shown.set('header-infinity', headerSnippet({ limits: { maxBytes: Infinity, maxMs: Infinity }, fragmentedDuration: 'index', color: true, aspect: false }));
  for (const preset of [null, ...Object.keys(presets)]) {
    for (const sizeBasis of [undefined, 'stored', 'display'] as const) {
      for (const hdr of [undefined, 'allow', 'warn', 'reject'] as const) {
        shown.set(`check-${preset ?? 'custom'}-${sizeBasis ?? 'none'}-${hdr ?? 'none'}`, checkSnippet(preset, { sizeBasis, hdr }));
      }
    }
  }
  return shown;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function publishedTypes(dir: string): void {
  const root = join(dir, 'node_modules', PACKAGE);
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(REPO_ROOT, 'package.json'), join(root, 'package.json'));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(REPO_ROOT, 'tsconfig.lib.json'), '--emitDeclarationOnly', '--outDir', dist], { cwd: REPO_ROOT, stdio: 'pipe' });
  for (const file of walk(dist).filter((f) => f.endsWith('.d.ts'))) writeFileSync(file, readFileSync(file, 'utf8').replace(DTS_SPECIFIER, '$1$2.js$1'));
}

function diagnose(dir: string, files: string[], options: ts.CompilerOptions): string[] {
  const program = ts.createProgram(files, options);
  return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

describe('the code snippets the demo shows', () => {
  let dir: string;
  const shown = shownSnippets();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-snippets-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo-snippets', private: true, type: 'module' }));
    publishedTypes(dir);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('cover every block with a browser and a Node server variant', () => {
    expect(shown.size).toBeGreaterThan(60);
    for (const [id, pair] of shown) {
      expect(pair.browser, id).toMatch(/from 'video-fps-probe(\/[a-z]+)?';/);
      expect(pair.node, id).toMatch(/from 'video-fps-probe(\/[a-z]+)?';/);
      expect(`${pair.browser}${pair.node}`, id).not.toMatch(/[–—]/);
    }
  });

  it('type-check in the browser against the published types, with the DOM library', () => {
    const files = [...shown].map(([id, pair]) => {
      const file = join(dir, `browser-${id}.ts`);
      writeFileSync(file, pair.browser);
      return file;
    });
    expect(diagnose(dir, files, BROWSER)).toEqual([]);
  });

  it('type-check on a Node server against the published types, without the DOM library', () => {
    const write = (id: string, pair: SnippetPair) => {
      const file = join(dir, `node-${id}.ts`);
      writeFileSync(file, pair.node);
      return file;
    };
    const root = [...shown].filter(([, pair]) => pair.node.includes(`from '${PACKAGE}';`));
    const server = [...shown].filter(([, pair]) => !pair.node.includes(`from '${PACKAGE}';`));
    expect(server.length).toBeGreaterThan(0);
    expect(diagnose(dir, server.map(([id, pair]) => write(id, pair)), NODE)).toEqual([]);
    expect(diagnose(dir, root.map(([id, pair]) => write(id, pair)), { ...NODE, skipLibCheck: true })).toEqual([]);
  });
});
