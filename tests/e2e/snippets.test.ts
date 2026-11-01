import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, openAsBlob, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.ts';
import { warningCodesOf } from '../../src/api/codes.ts';
import { withAspect } from '../../src/aspect/index.ts';
import { check } from '../../src/check/index.ts';
import { withColor } from '../../src/color/index.ts';
import { primaryTrack } from '../../src/core/result.ts';
import type { FileResult } from '../../src/core/types.ts';
import { analyzeHeader } from '../../src/header/index.ts';
import * as presets from '../../src/presets/index.ts';
import { ANALYZE_SNIPPET, checkSnippet, COLOR_SNIPPET, ERRORS_SNIPPET, headerSnippet, LIMIT_PRESETS, urlSnippet, type SnippetPair } from '../../demo/src/ui/snippets.ts';
import { FILES_DIR, REPO_ROOT } from '../helpers/fixtures.ts';

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

type Summary = Record<string, unknown>;

describe('the Node server snippets at run time', () => {
  let dir: string;
  const fixture = (name: string): string => join(FILES_DIR, name);
  const full = async (name: string): Promise<FileResult> =>
    withAspect(withColor(await analyze(await openAsBlob(fixture(name)), { name: fixture(name), codecConfig: true }), { keepCodecConfig: true }));

  async function load<T>(id: string, code: string): Promise<T> {
    const file = join(dir, `${id}.ts`);
    writeFileSync(file, code);
    return (await import(pathToFileURL(file).href)) as T;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-snippets-run-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('read color, HDR, Dolby Vision and aspect of Matroska files as the library does, and keep errors apart', async () => {
    const { colorAndAspectOf } = await load<{ colorAndAspectOf(path: string): Promise<Summary> }>('color', COLOR_SNIPPET.node);
    for (const name of ['hdr10_hevc10.mkv', 'dv_p81.mkv', 'sar_4x3.mkv', 'hdr10_hevc10.mp4']) {
      const t = primaryTrack(await full(name));
      expect(await colorAndAspectOf(fixture(name)), name).toEqual({
        ok: true,
        colorRead: true,
        hdr: t?.color?.hdr ?? null,
        dolbyVision: t?.color?.dolbyVision ?? null,
        transfer: t?.color?.transfer ?? null,
        aspectRead: true,
        sampleAspectRatio: t?.sampleAspectRatio ?? null,
        displayWidth: t?.displayWidth ?? null,
        displayHeight: t?.displayHeight ?? null,
      });
    }
    expect(await colorAndAspectOf(fixture('hdr10_hevc10.mkv'))).toMatchObject({ hdr: 'pq', transfer: 'smpte2084' });
    expect((await colorAndAspectOf(fixture('dv_p81.mkv'))).dolbyVision).toMatchObject({ profile: 8 });
    const broken = await full('corrupt_trunc_no_moov.mp4');
    expect(broken.errorCode).not.toBeNull();
    expect(await colorAndAspectOf(fixture('corrupt_trunc_no_moov.mp4'))).toEqual({ ok: false, code: broken.errorCode, message: broken.error });
  });

  it('give the frame rate of a Matroska file as the library does', async () => {
    const { frameRateOf } = await load<{ frameRateOf(path: string): Promise<Summary> }>('analyze', ANALYZE_SNIPPET.node);
    const t = primaryTrack(await full('h264_vfr_remux.mkv'));
    expect(await frameRateOf(fixture('h264_vfr_remux.mkv'))).toEqual({
      ok: true,
      fps: t?.avgFps?.value ?? null,
      frames: t?.presentedFrames ?? t?.frames ?? null,
      variable: t?.isVfr ?? null,
      medianFrameInterval: t?.medianFrameInterval ?? null,
      enabled: t?.enabled ?? null,
    });
  });

  it('read the header of an MP4 file and answer unsupported-container for Matroska', async () => {
    const limits = LIMIT_PRESETS.find((p) => p.id === 'defaults')!.limits;
    const { readHeader } = await load<{ readHeader(path: string): Promise<Summary> }>('header', headerSnippet({ limits, fragmentedDuration: 'index', color: true, aspect: true }).node);
    const head = await analyzeHeader(await openAsBlob(fixture('hdr10_hevc10.mp4')), { limits, color: true, aspect: true });
    expect(await readHeader(fixture('hdr10_hevc10.mp4'))).toEqual({ ok: true, reads: head.io.reads, bytesRequested: head.io.bytesRequested, layout: head.layout?.kind ?? null, hdr: 'pq' });
    expect(await readHeader(fixture('hdr10_hevc10.mkv'))).toMatchObject({ ok: false, code: 'unsupported-container', kind: 'file' });
  });

  it('judge a Matroska file with a preset as check does', async () => {
    const { checkUpload } = await load<{ checkUpload(path: string): Promise<unknown> }>('check', checkSnippet('veoExtend', { sizeBasis: 'display', hdr: 'reject' }).node);
    const want = check(await full('hdr10_hevc10.mkv'), { ...presets.veoExtend.rules, sizeBasis: 'display', hdr: 'reject' });
    expect(want.verdict).toBe('fail');
    expect(await checkUpload(fixture('hdr10_hevc10.mkv'))).toEqual(want);
  });

  it('triage a result by its codes', async () => {
    const { triage } = await load<{ triage(result: FileResult): Summary }>('errors', ERRORS_SNIPPET.node);
    const junk = await full('mov_trailing_junk.mov');
    expect(triage(junk)).toEqual({ status: 'ok', warnings: warningCodesOf(junk) });
    expect(triage(await full('corrupt_trunc_no_moov.mp4'))).toMatchObject({ status: 'reject', cacheable: true });
    expect(triage({ ...junk, engine: 'rvfc', error: 'tab not visible: keep it in the foreground', errorCode: 'engine-failed' })).toEqual({ status: 'reject', code: 'engine-failed', cacheable: false });
  });
});
