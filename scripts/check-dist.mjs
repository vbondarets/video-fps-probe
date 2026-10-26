import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1000;

export const UNPACKED_CAP = 580 * KB;

const ALLOWED = [/^(?:index|lazy|analyze|probe)\.(?:js|d\.ts)$/, /^(?:core|engines|worker|client|api|plugins|react|check|presets|standalone)\/[\w./-]+\.(?:js|d\.ts)$/, /^presets\/sources\.json$/];
const PACK_EXTRAS = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const LITERAL_HOSTS = ['plugins/own.js', 'plugins/mp4box.js', 'plugins/mediabunny.js'];
const PEER_ENGINES = ['engines/mp4box.js', 'engines/mediabunny.js'];
const PARSER_DIRS = ['core/isobmff/', 'core/matroska/'];
const PEERS = ['mp4box', 'mediabunny'];
const PURE_ENTRIES = ['check/index.js', 'presets/index.js'];
export const SPLIT_WORKERS = {
  'worker/own-isobmff.worker.js': ['core/matroska/', 'core/rfps.js', 'core/analyze.js'],
  'worker/own-matroska.worker.js': ['core/isobmff/', 'core/analyze.js'],
};
const WORKER_CALL = /\bnew\s+(?:Worker|SharedWorker)\s*\(/g;
const WORKER_LITERAL = /^new\s+(?:Worker|SharedWorker)\s*\(\s*new\s+URL\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*,\s*import\.meta\.url\s*\)/;
const WORKER_ASSET = /^(?:worker\/[^/]+\.worker\.js|standalone\/.+)$/;
const DOM_GLOBALS = new Set(['window', 'document']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'self']);
const TS_EXTENSION = /\.(?:[cm]?ts|tsx)$/;

const posix = (p) => p.split('\\').join('/');
const kb = (n) => `${(n / KB).toFixed(2)} KB`;
const bare = (specifier) => !specifier.startsWith('.') && !specifier.startsWith('/');
const peerOf = (specifier) => PEERS.find((p) => specifier === p || specifier.startsWith(`${p}/`)) ?? null;
const isReact = (specifier) => /^react(?:-dom)?(?:\/|$)/.test(specifier);

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(posix(relative(base, full)));
  }
  return out.sort();
}

export function moduleSpecifiers(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, fileName.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, dynamic: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      found.push({ specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : null, dynamic: true });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, dynamic: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isNamePosition(id) {
  const parent = id.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && parent.name === id) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  const named = [ts.isPropertyAssignment, ts.isPropertyDeclaration, ts.isMethodDeclaration, ts.isGetAccessorDeclaration, ts.isSetAccessorDeclaration, ts.isVariableDeclaration, ts.isParameter, ts.isBindingElement, ts.isFunctionDeclaration, ts.isFunctionExpression, ts.isClassDeclaration, ts.isClassExpression];
  return named.some((is) => is(parent)) && parent.name === id;
}

const isImportMetaUrl = (node) => ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'url';
const calleeName = (node) => (ts.isIdentifier(node.expression) ? node.expression.text : null);

export function scanCode(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = { urls: [], dom: [], hazards: [] };
  const visit = (node) => {
    if (ts.isIdentifier(node) && DOM_GLOBALS.has(node.text) && !isNamePosition(node)) found.dom.push(node.text);
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text) && DOM_GLOBALS.has(node.name.text)) found.dom.push(`${node.expression.text}.${node.name.text}`);
    else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text) && ts.isStringLiteralLike(node.argumentExpression) && DOM_GLOBALS.has(node.argumentExpression.text)) found.dom.push(`${node.expression.text}['${node.argumentExpression.text}']`);
    if (ts.isNewExpression(node) && calleeName(node) === 'URL' && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
      const [arg] = node.arguments;
      found.urls.push(ts.isStringLiteralLike(arg) ? arg.text : null);
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ['require', 'eval', 'Function'].includes(calleeName(node))) found.hazards.push(`${calleeName(node)}()`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function graph(files, texts) {
  const edges = new Map();
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const list = [];
    for (const { specifier, dynamic } of moduleSpecifiers(texts.get(file), file)) {
      if (specifier === null) list.push({ target: null, specifier, dynamic });
      else if (bare(specifier)) list.push({ target: null, specifier, dynamic });
      else list.push({ target: posix(join(dirname(file), specifier)), specifier, dynamic });
    }
    edges.set(file, list);
  }
  return edges;
}

function closure(edges, start, { dynamic }) {
  const seen = new Set([start]);
  const bareSeen = new Set();
  for (const stack = [start]; stack.length > 0; ) {
    for (const edge of edges.get(stack.pop()) ?? []) {
      if (edge.dynamic && !dynamic) continue;
      if (edge.target === null) {
        if (edge.specifier !== null) bareSeen.add(edge.specifier);
        continue;
      }
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      stack.push(edge.target);
    }
  }
  return { files: seen, bare: bareSeen };
}

function packListing() {
  const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: REPO_ROOT, env: { ...process.env, npm_config_update_notifier: 'false' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const [pack] = JSON.parse(out);
  return pack;
}

function exportedEntries(manifest) {
  const entries = [];
  for (const [key, entry] of Object.entries(manifest.exports ?? {})) {
    if (key === './package.json' || key.startsWith('./standalone/')) continue;
    const target = typeof entry === 'string' ? entry : entry.default;
    entries.push({ key, file: target.replace(/^\.\/dist\//, '') });
  }
  return entries;
}

function typedEntries(manifest) {
  const targets = [manifest.types, ...Object.values(manifest.exports ?? {}).map((e) => (typeof e === 'object' && e !== null ? e.types : null)), ...Object.values(manifest.typesVersions?.['*'] ?? {}).flat()];
  return [...new Set(targets.filter((t) => typeof t === 'string' && t.endsWith('.d.ts')).map((t) => t.replace(/^(?:\.\/)?dist\//, '')))];
}

export function declarationClosure(dist, manifest) {
  const seen = new Set(typedEntries(manifest).filter((f) => existsSync(join(dist, f))));
  for (const stack = [...seen]; stack.length > 0; ) {
    const file = stack.pop();
    for (const { specifier } of moduleSpecifiers(readFileSync(join(dist, file), 'utf8'), file)) {
      if (specifier === null || bare(specifier)) continue;
      const target = posix(join(dirname(file), specifier)).replace(/\.js$/, '.d.ts');
      if (seen.has(target) || !existsSync(join(dist, target))) continue;
      seen.add(target);
      stack.push(target);
    }
  }
  return seen;
}

function ssrImport(dist, files) {
  const urls = files.map((f) => pathToFileURL(join(dist, f)).href);
  const script = `for (const url of ${JSON.stringify(urls)}) { try { await import(url); } catch (e) { console.log(url + ': ' + (e && e.message)); process.exitCode = 1; } }`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (e) {
    const lines = `${e.stdout ?? ''}`.trim().split('\n').filter(Boolean);
    return lines.length > 0 ? lines : [`${e.message}`];
  }
}

export function checkDist({ pack = true, ssr = true, repo = REPO_ROOT } = {}) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const dist = join(repo, 'dist');
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const files = walk(dist);
  if (files.length === 0) return { problems: [`${posix(relative(repo, dist))} is empty or missing: run npm run build:lib`], files, pack: null };
  const texts = new Map(files.filter((f) => /\.(?:js|d\.ts)$/.test(f)).map((f) => [f, readFileSync(join(dist, f), 'utf8')]));

  for (const f of files) if (!ALLOWED.some((re) => re.test(f))) fail(`not allowed in dist: ${f}`);

  for (const { key, file } of exportedEntries(manifest)) {
    if (!existsSync(join(dist, file))) fail(`export ${key} points at a missing file dist/${file}`);
    const types = manifest.exports[key].types?.replace(/^\.\/dist\//, '');
    if (types && !existsSync(join(dist, types))) fail(`export ${key} types point at a missing file dist/${types}`);
  }
  for (const [key, targets] of Object.entries(manifest.typesVersions?.['*'] ?? {})) {
    for (const t of targets) if (!existsSync(join(repo, t))) fail(`typesVersions ${key} points at a missing file ${t}`);
  }
  for (const [key, entry] of Object.entries(manifest.exports ?? {})) {
    if (typeof entry === 'string' && entry !== './package.json' && !existsSync(join(repo, entry))) fail(`export ${key} points at a missing file ${entry}`);
  }
  if (typedEntries(manifest).length > 0) {
    const reached = declarationClosure(dist, manifest);
    for (const f of files) if (f.endsWith('.d.ts') && !reached.has(f)) fail(`${f}: no exported entry's types reach it, so build-lib leaves it out`);
  }

  for (const [file, text] of texts) {
    for (const { specifier, dynamic } of moduleSpecifiers(text, file)) {
      if (specifier === null) {
        fail(`${file}: import() with a non-literal specifier`);
        continue;
      }
      if (TS_EXTENSION.test(specifier)) fail(`${file}: .ts specifier ${specifier}`);
      if (!bare(specifier)) {
        const target = posix(join(dirname(file), specifier));
        const resolved = file.endsWith('.d.ts') ? target.replace(/\.js$/, '.d.ts') : target;
        if (!existsSync(join(dist, resolved))) fail(`${file}: ${dynamic ? 'import()' : 'import'} ${specifier} does not resolve inside dist${resolved === target ? '' : ` (no ${resolved})`}`);
      }
      const peer = peerOf(specifier);
      if (isReact(specifier) && !file.startsWith('react/')) fail(`${file}: imports ${specifier} outside react/`);
      if (file.endsWith('.d.ts')) {
        if (peer) fail(`${file}: type import of the peer ${specifier}`);
      } else if (peer && !PEER_ENGINES.includes(file)) {
        fail(`${file}: bare peer import ${specifier} outside ${PEER_ENGINES.join(', ')}`);
      }
    }
    if (/import\.meta\.env/.test(text)) fail(`${file}: import.meta.env`);
    if (/__fpsProbe/.test(text)) fail(`${file}: __fpsProbe`);
  }

  const scans = new Map([...texts].filter(([f]) => f.endsWith('.js')).map(([f, text]) => [f, scanCode(text, f)]));
  for (const [file, scan] of scans) {
    for (const url of scan.urls) {
      if (url === null) fail(`${file}: new URL() with a non-literal specifier and import.meta.url`);
      else if (TS_EXTENSION.test(url)) fail(`${file}: new URL() of the .ts file ${url}`);
      else if (!existsSync(join(dist, dirname(file), url))) fail(`${file}: new URL() of ${url}, which does not exist in dist`);
    }
    for (const hazard of new Set(scan.hazards)) fail(`${file}: calls ${hazard}, which ESM output and peer isolation do not allow`);
  }

  const literalFiles = [];
  for (const [file, text] of texts) {
    if (!file.endsWith('.js')) continue;
    for (const m of text.matchAll(WORKER_CALL)) {
      literalFiles.push(file);
      const lit = WORKER_LITERAL.exec(text.slice(m.index));
      if (!lit) {
        fail(`${file}: new Worker() without a literal new URL('...', import.meta.url)`);
        continue;
      }
      const url = lit[1] ?? lit[2];
      if (!url.endsWith('.js')) fail(`${file}: worker URL ${url} does not end in .js`);
      if (!existsSync(join(dist, dirname(file), url))) fail(`${file}: worker URL ${url} does not exist`);
      if (!LITERAL_HOSTS.includes(file)) fail(`${file}: worker literal outside ${LITERAL_HOSTS.join(', ')}`);
    }
  }

  const edges = graph(files, texts);
  const has = (f) => texts.has(f);
  for (const root of PURE_ENTRIES.filter(has)) for (const edge of edges.get(root) ?? []) fail(`${root}: imports ${edge.specifier} at run time, a main-thread rule entry imports nothing`);
  const hygieneRoots = ['client/index.js', 'client/lazy.js', 'react/index.js', 'plugins/rvfc.js', 'worker/runtime.js', ...Object.keys(SPLIT_WORKERS), ...files.filter((f) => /^engines\/[^/]+\.js$/.test(f))].filter(has);
  for (const root of hygieneRoots) {
    const reached = closure(edges, root, { dynamic: true }).files;
    for (const host of LITERAL_HOSTS) if (reached.has(host)) fail(`literal hygiene: ${root} reaches ${host}`);
    for (const f of reached) if (literalFiles.includes(f)) fail(`literal hygiene: ${root} reaches the worker literal in ${f}`);
    for (const f of reached) {
      for (const url of scans.get(f)?.urls ?? []) {
        const target = url === null ? null : posix(join(dirname(f), url.replace(/[?#].*$/, '')));
        if (target && WORKER_ASSET.test(target)) fail(`literal hygiene: ${root} reaches new URL('${url}', import.meta.url) in ${f}, which targets ${target}`);
      }
    }
  }

  for (const [root, forbidden] of Object.entries(SPLIT_WORKERS).filter(([root]) => has(root))) {
    for (const f of closure(edges, root, { dynamic: true }).files) if (forbidden.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))) fail(`worker isolation: ${root} reaches ${f}`);
  }

  const isolationRoots = ['index.js', 'lazy.js', 'react/index.js', ...files.filter((f) => /^(?:client|plugins)\/[^/]+\.js$/.test(f))].filter(has);
  for (const root of isolationRoots) {
    const { files: reached, bare: bareSpecifiers } = closure(edges, root, { dynamic: false });
    for (const f of reached) {
      if (PARSER_DIRS.some((d) => f.startsWith(d))) fail(`peer isolation: ${root} statically reaches ${f}`);
      if (PEER_ENGINES.includes(f)) fail(`peer isolation: ${root} statically reaches ${f}`);
    }
    for (const s of bareSpecifiers) if (peerOf(s)) fail(`peer isolation: ${root} statically imports ${s}`);
  }
  for (const [file, list] of edges) {
    for (const edge of list) if (!edge.dynamic && PEER_ENGINES.includes(edge.target)) fail(`peer isolation: ${file} imports ${edge.target} statically, only import() may reach it`);
  }

  if (has('react/index.js')) {
    const first = ts.createSourceFile('react/index.js', texts.get('react/index.js'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS).statements[0];
    if (!first || !ts.isExpressionStatement(first) || !ts.isStringLiteral(first.expression) || first.expression.text !== 'use client') fail(`react/index.js: 'use client' is not the first statement`);
  }

  for (const f of files.filter((x) => /^worker\/[^/]+\.worker\.js$/.test(x) || /^standalone\/[^/]+\.js$/.test(x))) {
    const dom = [...new Set(scans.get(f)?.dom ?? [])];
    if (dom.length > 0) fail(`${f}: references ${dom.join(', ')}`);
  }

  if (ssr) {
    const entries = exportedEntries(manifest).map((e) => e.file).filter((f) => existsSync(join(dist, f)) && !/\.worker\.js$|\.json$/.test(f));
    for (const line of ssrImport(dist, entries)) fail(`SSR import: ${line}`);
  }

  let listing = null;
  if (pack) {
    listing = packListing();
    for (const { path } of listing.files) {
      if (PACK_EXTRAS.has(path)) continue;
      if (!path.startsWith('dist/') || !ALLOWED.some((re) => re.test(path.slice(5)))) fail(`not allowed in the package: ${path}`);
    }
    for (const extra of PACK_EXTRAS) if (!listing.files.some((f) => f.path === extra)) fail(`missing from the package: ${extra}`);
    if (listing.unpackedSize > UNPACKED_CAP) fail(`unpacked size is ${kb(listing.unpackedSize)}, over the ${kb(UNPACKED_CAP)} cap`);
  }
  return { problems, files, pack: listing };
}

export function runSelfTest() {
  let total = 0;
  const failures = [];
  const repo = mkdtempSync(join(tmpdir(), 'check-dist-'));
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'check-dist-self-test', exports: {} })}\n`);
  const problemsOf = (tree) => {
    rmSync(join(repo, 'dist'), { recursive: true, force: true });
    for (const [file, text] of Object.entries(tree)) {
      const path = join(repo, 'dist', file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    return checkDist({ repo, pack: false, ssr: false }).problems;
  };
  const expectProblem = (label, problems, needle, wanted) => {
    total++;
    if (problems.some((p) => p.includes(needle)) !== wanted) failures.push(`${label}: expected ${wanted ? 'a' : 'no'} problem with "${needle}", got ${problems.length > 0 ? problems.join('; ') : 'none'}`);
  };
  try {
    const x = { 'core/x.js': 'export const x = 1;\n' };
    const reexport = { 'core/a.js': "export { x } from './x.js';\n", 'core/a.d.ts': "export { x } from './x.js';\n" };
    const undeclared = problemsOf({ ...x, ...reexport });
    expectProblem('a .d.ts import of ./x.js fails when only x.js exists', undeclared, 'core/a.d.ts: import ./x.js does not resolve inside dist (no core/x.d.ts)', true);
    expectProblem('a .js import of ./x.js resolves to x.js', undeclared, 'core/a.js:', false);
    expectProblem('an import type of ./x.js fails when only x.js exists', problemsOf({ ...x, 'core/b.d.ts': "export type X = typeof import('./x.js');\n" }), 'core/b.d.ts: import ./x.js does not resolve inside dist (no core/x.d.ts)', true);
    expectProblem('a .d.ts import of ./x.js passes when x.d.ts exists', problemsOf({ ...x, 'core/x.d.ts': 'export declare const x: number;\n', ...reexport }), 'core/a.d.ts:', false);
    expectProblem('a .js import of a missing file fails', problemsOf({ 'core/a.js': "export { x } from './x.js';\n" }), 'core/a.js: import ./x.js does not resolve inside dist', true);

    const assets = { 'worker/own.worker.js': 'self.onmessage = () => {};\n', 'standalone/own.worker.js': 'self.onmessage = () => {};\n', 'core/table.js': 'export const t = 1;\n' };
    const lazyUrl = problemsOf({ ...assets, 'client/index.js': "export const load = () => import('./pool.js');\n", 'client/pool.js': "export const url = new URL('../worker/own.worker.js', import.meta.url);\n" });
    expectProblem('client/index.js reaching a new URL of a worker file through import() fails', lazyUrl, "literal hygiene: client/index.js reaches new URL('../worker/own.worker.js', import.meta.url) in client/pool.js", true);
    expectProblem('an engine with a new URL of the standalone worker fails', problemsOf({ ...assets, 'engines/rvfc.js': "export const url = new URL('../standalone/own.worker.js', import.meta.url).href;\n" }), "literal hygiene: engines/rvfc.js reaches new URL('../standalone/own.worker.js', import.meta.url)", true);
    expectProblem('worker/runtime.js with a new URL of a worker file and a query fails', problemsOf({ ...assets, 'worker/runtime.js': "export const url = new URL('./own.worker.js?worker', import.meta.url);\n" }), 'literal hygiene: worker/runtime.js reaches', true);
    expectProblem('the worker literal in plugins/own.js passes when no hygiene root reaches it', problemsOf({ ...assets, 'client/index.js': 'export const x = 1;\n', 'plugins/own.js': "export const start = () => new Worker(new URL('../worker/own.worker.js', import.meta.url), { type: 'module' });\n" }), 'literal hygiene', false);
    expectProblem('a new URL of a file outside worker/ and standalone/ passes', problemsOf({ ...assets, 'client/index.js': "export const url = new URL('../core/table.js', import.meta.url);\n" }), 'literal hygiene', false);

    const serve = { 'worker/serve.js': 'export const serve = () => {};\n', 'worker/single.js': 'export const single = () => {};\n', 'core/stats.js': 'export const s = 1;\n', 'core/segments.js': 'export const g = 1;\n', 'core/rfps.js': 'export const r = 1;\n', 'core/analyze.js': 'export const a = 1;\n' };
    const isoParser = { 'core/isobmff/index.js': "import './boxes.js';\nimport '../stats.js';\nexport const parse = () => import('../segments.js');\n", 'core/isobmff/boxes.js': 'export const b = 1;\n' };
    const mkvParser = { 'core/matroska/index.js': "import '../stats.js';\nexport const parse = () => [import('../segments.js'), import('../rfps.js')];\n" };
    const entry = (parser) => `import { serve } from './serve.js';\nimport { single } from './single.js';\nimport { parse } from '../core/${parser}/index.js';\nserve(single(parse));\n`;
    const split = { ...serve, ...isoParser, ...mkvParser, 'worker/own-isobmff.worker.js': entry('isobmff'), 'worker/own-matroska.worker.js': entry('matroska') };
    expectProblem('per-container workers that reach only their own parser pass', problemsOf(split), 'worker isolation', false);
    expectProblem('the ISO BMFF worker reaching the Matroska parser through import() fails', problemsOf({ ...split, 'worker/single.js': "export const single = () => import('../core/matroska/index.js');\n" }), 'worker isolation: worker/own-isobmff.worker.js reaches core/matroska/index.js', true);
    expectProblem('the ISO BMFF worker reaching the ffprobe estimate fails', problemsOf({ ...split, 'core/isobmff/boxes.js': "export const b = () => import('../rfps.js');\n" }), 'worker isolation: worker/own-isobmff.worker.js reaches core/rfps.js', true);
    expectProblem('the Matroska worker reaching the ISO BMFF parser fails', problemsOf({ ...split, 'worker/serve.js': "import '../core/isobmff/boxes.js';\nexport const serve = () => {};\n" }), 'worker isolation: worker/own-matroska.worker.js reaches core/isobmff/boxes.js', true);
    expectProblem('a per-container worker reaching the parser loaders of analyze.js fails', problemsOf({ ...split, 'worker/single.js': "import '../core/analyze.js';\nexport const single = () => {};\n" }), 'worker isolation: worker/own-matroska.worker.js reaches core/analyze.js', true);
    expectProblem('a per-container worker reaching a worker literal fails the literal hygiene', problemsOf({ ...split, 'plugins/own.js': "export const start = () => new Worker(new URL('../worker/own-isobmff.worker.js', import.meta.url), { type: 'module' });\n", 'worker/serve.js': "import '../plugins/own.js';\nexport const serve = () => {};\n" }), 'literal hygiene: worker/own-isobmff.worker.js reaches plugins/own.js', true);

    const react = { 'react/index.js': "'use client';\nimport { useMemo } from 'react';\nexport const x = useMemo;\n", 'react/index.d.ts': "import type { ReactNode } from 'react';\nexport type X = ReactNode;\n" };
    expectProblem('react/ importing react with use client first passes', problemsOf(react), 'react', false);
    expectProblem("react/index.js without 'use client' first fails", problemsOf({ ...react, 'react/index.js': "import { useMemo } from 'react';\n'use client';\nexport const x = useMemo;\n" }), "react/index.js: 'use client' is not the first statement", true);
    expectProblem('a module outside react/ importing react fails', problemsOf({ ...react, 'client/index.js': "import { useMemo } from 'react';\nexport const x = useMemo;\n" }), 'client/index.js: imports react outside react/', true);
    expectProblem('a module outside react/ importing react-dom/client fails', problemsOf({ ...react, 'core/x.js': "export const load = () => import('react-dom/client');\n" }), 'core/x.js: imports react-dom/client outside react/', true);
    expectProblem('check/index.js with no import passes', problemsOf({ 'check/index.js': 'export const check = () => null;\n' }), 'check/index.js', false);
    expectProblem('check/index.js importing a module at run time fails', problemsOf({ ...x, 'check/index.js': "import { x } from '../core/x.js';\nexport const check = () => x;\n" }), 'check/index.js: imports ../core/x.js at run time', true);
    expectProblem('presets/index.js importing check at run time fails', problemsOf({ 'check/index.js': 'export const check = () => null;\n', 'presets/index.js': "export { check } from '../check/index.js';\n" }), 'presets/index.js: imports ../check/index.js at run time', true);
    expectProblem('check/index.js with an import() fails', problemsOf({ ...x, 'check/index.js': "export const check = () => import('../core/x.js');\n" }), 'check/index.js: imports ../core/x.js at run time', true);
    expectProblem('a .d.ts outside react/ importing react fails', problemsOf({ ...react, 'api/x.d.ts': "export type X = import('react').ReactNode;\n" }), 'api/x.d.ts: imports react outside react/', true);

    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'check-dist-self-test', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } })}\n`);
    const typed = { 'index.js': "export { x } from './core/x.js';\n", 'index.d.ts': "export type { X } from './core/types.js';\n", 'core/x.js': 'export const x = 1;\n', 'core/types.d.ts': "export type X = import('./rational.js').R;\n", 'core/rational.d.ts': 'export type R = number;\n' };
    expectProblem('declaration files reached through export and import() types pass', problemsOf(typed), "no exported entry's types reach", false);
    expectProblem('a declaration file no exported types reach fails', problemsOf({ ...typed, 'core/stats.d.ts': 'export declare const s: number;\n' }), "core/stats.d.ts: no exported entry's types reach it", true);
    expectProblem('the closure keeps what the entry types reach', [...declarationClosure(join(repo, 'dist'), JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')))].sort(), 'core/rational.d.ts', true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`self-test FAIL ${f}`);
    console.error(`self-test: ${failures.length} of ${total} checks failed`);
    return 1;
  }
  console.log(`self-test: ${total} checks passed`);
  return 0;
}

function main() {
  const { values } = parseArgs({ options: { 'self-test': { type: 'boolean', default: false } }, strict: true });
  if (values['self-test']) return runSelfTest();
  const { problems, files, pack } = checkDist();
  for (const p of problems) console.error(`FAIL: ${p}`);
  if (pack) {
    console.log(`package: ${pack.entryCount} files, ${kb(pack.size)} packed, ${kb(pack.unpackedSize)} unpacked (cap ${kb(UNPACKED_CAP)}, headroom ${kb(UNPACKED_CAP - pack.unpackedSize)})`);
  }
  if (problems.length === 0) console.log(`dist: ${files.length} files pass every check`);
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
