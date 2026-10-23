import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO_ROOT, 'dist');
const KB = 1000;

export const UNPACKED_CAP = 400 * KB;
export const README_CAP = 90 * KB;

const ALLOWED = [/^(?:index|lazy|analyze|probe)\.(?:js|d\.ts)$/, /^(?:core|engines|worker|client|api|plugins|react|standalone)\/[\w./-]+\.(?:js|d\.ts)$/];
const PACK_EXTRAS = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const LITERAL_HOSTS = ['plugins/own.js', 'plugins/mp4box.js', 'plugins/mediabunny.js'];
const PEER_ENGINES = ['engines/mp4box.js', 'engines/mediabunny.js'];
const PARSER_DIRS = ['core/isobmff/', 'core/matroska/'];
const PEERS = ['mp4box', 'mediabunny'];
const WORKER_CALL = /\bnew\s+(?:Worker|SharedWorker)\s*\(/g;
const WORKER_LITERAL = /^new\s+(?:Worker|SharedWorker)\s*\(\s*new\s+URL\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*,\s*import\.meta\.url\s*\)/;
const DOM_GLOBALS = new Set(['window', 'document']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'self']);
const TS_EXTENSION = /\.(?:[cm]?ts|tsx)$/;

const posix = (p) => p.split('\\').join('/');
const kb = (n) => `${(n / KB).toFixed(2)} KB`;
const bare = (specifier) => !specifier.startsWith('.') && !specifier.startsWith('/');
const peerOf = (specifier) => PEERS.find((p) => specifier === p || specifier.startsWith(`${p}/`)) ?? null;

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
  const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

function ssrImport(files) {
  const urls = files.map((f) => pathToFileURL(join(DIST, f)).href);
  const script = `for (const url of ${JSON.stringify(urls)}) { try { await import(url); } catch (e) { console.log(url + ': ' + (e && e.message)); process.exitCode = 1; } }`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (e) {
    const lines = `${e.stdout ?? ''}`.trim().split('\n').filter(Boolean);
    return lines.length > 0 ? lines : [`${e.message}`];
  }
}

export function checkDist({ pack = true, ssr = true } = {}) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const files = walk(DIST);
  if (files.length === 0) return { problems: [`${posix(relative(REPO_ROOT, DIST))} is empty or missing: run npm run build:lib`], files, pack: null };
  const texts = new Map(files.filter((f) => /\.(?:js|d\.ts)$/.test(f)).map((f) => [f, readFileSync(join(DIST, f), 'utf8')]));

  for (const f of files) if (!ALLOWED.some((re) => re.test(f))) fail(`not allowed in dist: ${f}`);

  for (const { key, file } of exportedEntries(manifest)) {
    if (!existsSync(join(DIST, file))) fail(`export ${key} points at a missing file dist/${file}`);
    const types = manifest.exports[key].types?.replace(/^\.\/dist\//, '');
    if (types && !existsSync(join(DIST, types))) fail(`export ${key} types point at a missing file dist/${types}`);
  }
  for (const [key, targets] of Object.entries(manifest.typesVersions?.['*'] ?? {})) {
    for (const t of targets) if (!existsSync(join(REPO_ROOT, t))) fail(`typesVersions ${key} points at a missing file ${t}`);
  }
  for (const [key, entry] of Object.entries(manifest.exports ?? {})) {
    if (typeof entry === 'string' && entry !== './package.json' && !existsSync(join(REPO_ROOT, entry))) fail(`export ${key} points at a missing file ${entry}`);
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
        const exists = existsSync(join(DIST, target)) || (file.endsWith('.d.ts') && existsSync(join(DIST, target.replace(/\.js$/, '.d.ts'))));
        if (!exists) fail(`${file}: ${dynamic ? 'import()' : 'import'} ${specifier} does not resolve inside dist`);
      }
      const peer = peerOf(specifier);
      if (file.endsWith('.d.ts')) {
        if (peer) fail(`${file}: type import of the peer ${specifier}`);
        if ((specifier === 'react' || specifier.startsWith('react/')) && !file.startsWith('react/')) fail(`${file}: imports react outside react/`);
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
      else if (!existsSync(join(DIST, dirname(file), url))) fail(`${file}: new URL() of ${url}, which does not exist in dist`);
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
      if (!existsSync(join(DIST, dirname(file), url))) fail(`${file}: worker URL ${url} does not exist`);
      if (!LITERAL_HOSTS.includes(file)) fail(`${file}: worker literal outside ${LITERAL_HOSTS.join(', ')}`);
    }
  }

  const edges = graph(files, texts);
  const has = (f) => texts.has(f);
  const hygieneRoots = ['client/index.js', 'client/lazy.js', 'react/index.js', 'plugins/rvfc.js', 'worker/runtime.js', ...files.filter((f) => /^engines\/[^/]+\.js$/.test(f))].filter(has);
  for (const root of hygieneRoots) {
    const reached = closure(edges, root, { dynamic: true }).files;
    for (const host of LITERAL_HOSTS) if (reached.has(host)) fail(`literal hygiene: ${root} reaches ${host}`);
    for (const f of reached) if (literalFiles.includes(f)) fail(`literal hygiene: ${root} reaches the worker literal in ${f}`);
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
    const entries = exportedEntries(manifest).map((e) => e.file).filter((f) => existsSync(join(DIST, f)) && !/\.worker\.js$/.test(f));
    for (const line of ssrImport(entries)) fail(`SSR import: ${line}`);
  }

  let listing = null;
  if (pack) {
    listing = packListing();
    let readme = 0;
    for (const { path, size } of listing.files) {
      if (path === 'README.md') readme = size;
      if (PACK_EXTRAS.has(path)) continue;
      if (!path.startsWith('dist/') || !ALLOWED.some((re) => re.test(path.slice(5)))) fail(`not allowed in the package: ${path}`);
    }
    for (const extra of PACK_EXTRAS) if (!listing.files.some((f) => f.path === extra)) fail(`missing from the package: ${extra}`);
    const rest = listing.unpackedSize - readme;
    if (rest > UNPACKED_CAP) fail(`unpacked size without README.md is ${kb(rest)}, over the ${kb(UNPACKED_CAP)} cap`);
    if (readme > README_CAP) fail(`README.md is ${kb(readme)}, over the ${kb(README_CAP)} cap`);
    listing.readme = readme;
  }
  return { problems, files, pack: listing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, files, pack } = checkDist();
  for (const p of problems) console.error(`FAIL: ${p}`);
  if (pack) {
    console.log(`package: ${pack.entryCount} files, ${kb(pack.size)} packed, ${kb(pack.unpackedSize)} unpacked (${kb(pack.unpackedSize - pack.readme)} without README.md, cap ${kb(UNPACKED_CAP)}; README.md ${kb(pack.readme)}, cap ${kb(README_CAP)})`);
  }
  if (problems.length === 0) console.log(`dist: ${files.length} files pass every check`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
