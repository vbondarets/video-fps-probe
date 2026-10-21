import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KB = 1000;

export const BUDGETS = {
  main: { label: 'main (React + UI)', limit: 75 * KB },
  worker: { label: 'parser worker', limit: 12 * KB },
  rvfc: { label: 'lazy rVFC fallback', limit: 2 * KB },
  initial: { label: 'initial total (main + worker + CSS)', limit: 85 * KB },
};

const USAGE = `Usage: node scripts/size-report.mjs [distDir=dist] [--check] [--out <dir>] [--self-test]

  --check       exit 1 when a budget is exceeded or the main or worker chunk is missing
  --out <dir>   where size.md and size.json are written (default report)
  --self-test   check chunk discovery and budgets on synthetic builds and exit
`;

const kb = (n) => `${(n / KB).toFixed(2)} KB`;
const posix = (p) => p.split('\\').join('/');

export function measure(buf) {
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    }).length,
  };
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.vite' || entry.name === 'node_modules') continue;
      walk(full, base, out);
    } else if (/\.(m?js|css)$/i.test(entry.name)) {
      out.push(posix(relative(base, full)));
    }
  }
  return out.sort();
}

function resolveRef(ref, fileSet) {
  let p = ref.split(/[?#]/)[0].replace(/^[a-z]+:\/\/[^/]+/i, '');
  p = p.replace(/^(\.\.?\/)+/, '').replace(/^\/+/, '');
  const parts = p.split('/');
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join('/');
    if (fileSet.has(candidate)) return candidate;
  }
  const name = basename(p);
  for (const f of fileSet) if (basename(f) === name) return f;
  return null;
}

function resolveFrom(ref, fromFile, fileSet) {
  const sibling = posix(join(dirname(fromFile), ref.replace(/^\.\//, '')));
  const normalized = posix(sibling).replace(/^\.\//, '');
  if (fileSet.has(normalized)) return normalized;
  return resolveRef(ref, fileSet);
}

const LITERAL = /["'`]((?:\.{1,2}\/|\/)?[\w@.\-/]+?\.m?js)["'`]/g;

export function scanReferences(text, fromFile, fileSet) {
  const found = { staticImports: new Set(), dynamicImports: new Set(), workers: new Set(), loose: new Set() };
  for (const m of text.matchAll(LITERAL)) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    const target = resolveFrom(m[1], fromFile, fileSet);
    if (!target || target === fromFile) continue;
    if (/Worker\s*\(\s*(?:new\s+URL\s*\(\s*)*$/.test(before)) found.workers.add(target);
    else if (/import\s*\(\s*$/.test(before)) found.dynamicImports.add(target);
    else if (/\b(?:from|import)\s*$/.test(before) && /^\.{0,2}\//.test(m[1])) found.staticImports.add(target);
    else found.loose.add(target);
  }
  return found;
}

function htmlAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2]) : null;
}

function readHtml(distDir, fileSet) {
  const path = join(distDir, 'index.html');
  if (!existsSync(path)) return null;
  const html = readFileSync(path, 'utf8');
  const out = { scripts: [], css: [], preload: [] };
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/type\s*=\s*["']module["']/i.test(m[0])) continue;
    const src = htmlAttr(m[0], 'src');
    const file = src ? resolveRef(src, fileSet) : null;
    if (file) out.scripts.push(file);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = htmlAttr(m[0], 'rel') ?? '';
    const href = htmlAttr(m[0], 'href');
    const file = href ? resolveRef(href, fileSet) : null;
    if (!file) continue;
    if (/stylesheet/i.test(rel)) out.css.push(file);
    else if (/modulepreload/i.test(rel)) out.preload.push(file);
  }
  return out;
}

function readManifest(distDir, fileSet) {
  for (const p of [join(distDir, '.vite', 'manifest.json'), join(distDir, 'manifest.json')]) {
    if (!existsSync(p)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const entries = Object.values(json).filter((e) => e && typeof e === 'object');
    const entry = entries.find((e) => e.isEntry && /\.html$/i.test(e.src ?? '')) ?? entries.find((e) => e.isEntry);
    if (!entry || typeof entry.file !== 'string') continue;
    const byKey = (key) => {
      const e = json[key];
      return e && typeof e.file === 'string' ? resolveRef(e.file, fileSet) : null;
    };
    const closure = new Set();
    const stack = [...(entry.imports ?? [])];
    while (stack.length > 0) {
      const key = stack.pop();
      const e = json[key];
      if (!e || closure.has(key)) continue;
      closure.add(key);
      stack.push(...(e.imports ?? []));
    }
    const css = new Set((entry.css ?? []).map((f) => resolveRef(f, fileSet)).filter(Boolean));
    for (const key of closure) for (const f of json[key].css ?? []) css.add(resolveRef(f, fileSet));
    const assets = [entry, ...[...closure].map((k) => json[k])]
      .flatMap((e) => e.assets ?? [])
      .filter((f) => /\.m?js$/i.test(f))
      .map((f) => resolveRef(f, fileSet))
      .filter(Boolean);
    return {
      assets,
      main: resolveRef(entry.file, fileSet),
      shared: [...closure].map(byKey).filter(Boolean),
      css: [...css].filter(Boolean),
      dynamic: entries.filter((e) => e.isDynamicEntry && typeof e.file === 'string').map((e) => resolveRef(e.file, fileSet)).filter(Boolean),
    };
  }
  return null;
}

function closureOf(start, fileSet, texts) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const f = stack.pop();
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
    const refs = scanReferences(texts.get(f) ?? '', f, fileSet);
    for (const dep of refs.staticImports) {
      if (!seen.has(dep) && dep !== start) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return [...seen];
}

const LAZY_BY_NAME = [
  ['rvfc', /rvfc/i],
  ['mp4box', /mp4box/i],
  ['mediabunny', /mediabunny/i],
];

export function discover(distDir) {
  const files = walk(distDir);
  const fileSet = new Set(files);
  const texts = new Map();
  for (const f of files) texts.set(f, readFileSync(join(distDir, f), 'latin1'));
  const js = files.filter((f) => /\.m?js$/i.test(f));
  const cssFiles = files.filter((f) => /\.css$/i.test(f));
  const kinds = new Map();
  const notes = [];
  let method = 'heuristic';
  let main = null;
  let shared = [];
  let css = [];
  let dynamic = [];
  let manifestAssets = [];

  const manifest = readManifest(distDir, fileSet);
  const html = readHtml(distDir, fileSet);
  if (manifest?.main) {
    method = 'vite manifest';
    ({ main, shared, css, dynamic } = manifest);
    manifestAssets = manifest.assets;
  } else if (html && html.scripts.length > 0) {
    method = 'index.html';
    main = html.scripts[0];
    shared = html.preload.filter((f) => f !== main && /\.m?js$/i.test(f));
    css = html.css;
  } else {
    const candidates = js.filter((f) => !/worker/i.test(f) && !LAZY_BY_NAME.some(([, re]) => re.test(f)));
    main = candidates.find((f) => /(^|\/)index[-.]/i.test(f)) ?? candidates.sort((a, b) => texts.get(b).length - texts.get(a).length)[0] ?? null;
    css = cssFiles;
    notes.push('no manifest and no usable index.html: main chunk guessed from file names');
  }

  const mainText = main ? (texts.get(main) ?? '') : '';
  const mainRefs = main ? scanReferences(mainText, main, fileSet) : null;
  if (main && shared.length === 0) shared = closureOf(main, fileSet, texts);
  if (dynamic.length === 0 && mainRefs) dynamic = [...mainRefs.dynamicImports];

  const workers = new Set();
  let workerMethod = 'none';
  const scanForWorkers = (file) => {
    const refs = scanReferences(texts.get(file) ?? '', file, fileSet);
    for (const w of refs.workers) workers.add(w);
  };
  if (main) {
    scanForWorkers(main);
    for (const s of shared) scanForWorkers(s);
    for (const d of dynamic) scanForWorkers(d);
  }
  if (workers.size > 0) workerMethod = 'Worker() reference';
  if (workers.size === 0 && manifestAssets.length > 0) {
    for (const a of manifestAssets) workers.add(a);
    workerMethod = 'vite manifest assets';
  }
  if (workers.size === 0) {
    for (const f of js) if (/worker/i.test(basename(f)) && f !== main) workers.add(f);
    if (workers.size > 0) workerMethod = 'file name';
  }
  if (workers.size === 0) {
    for (const f of js) {
      const t = texts.get(f);
      if (f !== main && /\bonmessage\b|addEventListener\(["']message["']/.test(t) && /postMessage\(/.test(t) && !/\bdocument\./.test(t)) workers.add(f);
    }
    if (workers.size > 0) workerMethod = 'message handler heuristic';
  }

  const workerShared = new Set();
  for (const w of workers) for (const dep of closureOf(w, fileSet, texts)) if (!workers.has(dep) && dep !== main) workerShared.add(dep);

  if (main) kinds.set(main, 'main');
  for (const w of workers) kinds.set(w, 'worker');
  for (const s of [...shared, ...workerShared]) if (!kinds.has(s)) kinds.set(s, 'shared');
  for (const c of css) if (!kinds.has(c)) kinds.set(c, 'css');
  for (const f of files) {
    if (kinds.has(f)) continue;
    const lazy = LAZY_BY_NAME.find(([, re]) => re.test(basename(f)));
    if (lazy) kinds.set(f, lazy[0]);
    else if (/\.css$/i.test(f)) kinds.set(f, 'lazy-css');
    else if (dynamic.includes(f)) kinds.set(f, 'lazy');
    else kinds.set(f, 'other');
  }
  return { files, kinds, method, workerMethod, notes, main };
}

export function buildReport(distDir) {
  const { files, kinds, method, workerMethod, notes } = discover(distDir);
  const chunks = files.map((file) => ({ file, kind: kinds.get(file), ...measure(readFileSync(join(distDir, file))) }));
  const sum = (kindsWanted, key) => chunks.filter((c) => kindsWanted.includes(c.kind)).reduce((n, c) => n + c[key], 0);
  const has = (kind) => chunks.some((c) => c.kind === kind);
  const initialKinds = ['main', 'worker', 'shared', 'css'];
  const initial = {
    raw: sum(initialKinds, 'raw'),
    gzip: sum(initialKinds, 'gzip'),
    brotli: sum(initialKinds, 'brotli'),
  };
  const budget = (key, kinds, value, required, fileKinds = kinds) => {
    const present = kinds.some(has);
    const limit = BUDGETS[key].limit;
    let status = 'ok';
    if (!present) status = required ? 'missing' : 'not built';
    else if (value > limit) status = 'over';
    return {
      key,
      label: BUDGETS[key].label,
      limit,
      gzip: present ? value : null,
      status,
      files: chunks.filter((c) => fileKinds.includes(c.kind)).map((c) => c.file),
    };
  };
  const budgets = [
    budget('main', ['main'], sum(['main'], 'gzip'), true),
    budget('worker', ['worker'], sum(['worker'], 'gzip'), true),
    budget('rvfc', ['rvfc'], sum(['rvfc'], 'gzip'), false),
    budget('initial', ['main'], initial.gzip, true, initialKinds),
  ];
  const failures = budgets.filter((b) => b.status === 'over' || b.status === 'missing');
  return { distDir, method, workerMethod, notes, chunks, initial, budgets, failures: failures.map((b) => `${b.label}: ${b.status}`) };
}

export function renderMarkdown(report, label) {
  const out = [];
  out.push('# Bundle size');
  out.push('');
  out.push(
    `Production build in \`${label}\`, measured by \`scripts/size-report.mjs\`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. The initial total is the sum of the per-chunk gzip sizes of main, worker, shared chunks and CSS. Discovery: ${report.method}; worker: ${report.workerMethod}.`,
  );
  out.push('');
  for (const n of report.notes) out.push(`Note: ${n}.`, '');
  out.push('## Budgets (gzip)');
  out.push('');
  out.push('| Budget | Limit | Actual | Status | Files |');
  out.push('|---|---:|---:|---|---|');
  for (const b of report.budgets) {
    out.push(`| ${b.label} | ${kb(b.limit)} | ${b.gzip === null ? '-' : kb(b.gzip)} | ${b.status} | ${b.files.join(', ') || '-'} |`);
  }
  out.push('');
  out.push('The lazy mp4box and mediabunny comparison chunks are reported but not budgeted.');
  out.push('');
  out.push('## Chunks');
  out.push('');
  out.push('| File | Kind | Raw | gzip -9 | brotli q11 |');
  out.push('|---|---|---:|---:|---:|');
  for (const c of report.chunks) out.push(`| ${c.file} | ${c.kind} | ${kb(c.raw)} | ${kb(c.gzip)} | ${kb(c.brotli)} |`);
  out.push(`| **initial total** | main + worker + shared + CSS | ${kb(report.initial.raw)} | ${kb(report.initial.gzip)} | ${kb(report.initial.brotli)} |`);
  out.push('');
  return `${out.join('\n')}\n`;
}

function printReport(report) {
  for (const b of report.budgets) {
    console.log(`${b.label.padEnd(40)} ${(b.gzip === null ? '-' : kb(b.gzip)).padStart(10)} / ${kb(b.limit).padStart(9)}  ${b.status}`);
  }
}

function runSelfTest() {
  let total = 0;
  const failures = [];
  const expectEq = (label, actual, expected) => {
    total++;
    if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
  };
  const root = mkdtempSync(join(tmpdir(), 'size-report-'));
  const filler = (n) => randomBytes(n).toString('latin1');
  const write = (dir, rel, content) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'latin1');
  };
  const html = '<!doctype html><html><head><link rel="stylesheet" crossorigin href="./assets/index-C1.css"><script type="module" crossorigin src="./assets/index-M1.js"></script></head><body></body></html>';
  const mainText = (extra) =>
    `const w=new Worker(new URL("assets/analyze.worker-W1.js",import.meta.url),{type:"module"});const a=()=>import("./rvfc-R1.js");const b=()=>import("./mp4box-B1.js");const c=()=>import("./mediabunny-D1.js");${extra}`;
  const build = (name, sizes, { manifest, withHtml = true }) => {
    const dir = join(root, name);
    write(dir, 'assets/index-M1.js', mainText(filler(sizes.main)));
    write(dir, 'assets/analyze.worker-W1.js', `self.onmessage=e=>{postMessage(1)};${filler(sizes.worker)}`);
    write(dir, 'assets/rvfc-R1.js', filler(sizes.rvfc));
    write(dir, 'assets/mp4box-B1.js', filler(40_000));
    write(dir, 'assets/mediabunny-D1.js', filler(50_000));
    write(dir, 'assets/index-C1.css', 'body{margin:0}');
    if (withHtml) write(dir, 'index.html', html);
    if (manifest) {
      const m = {
        'index.html': { file: 'assets/index-M1.js', isEntry: true, src: 'index.html', css: ['assets/index-C1.css'], dynamicImports: ['src/rvfc.ts'] },
        'src/rvfc.ts': { file: 'assets/rvfc-R1.js', isDynamicEntry: true, src: 'src/rvfc.ts' },
      };
      write(dir, '.vite/manifest.json', JSON.stringify(m));
    }
    return dir;
  };
  try {
    const small = { main: 30_000, worker: 5_000, rvfc: 1_000 };
    for (const [label, opts] of [
      ['manifest', { manifest: true }],
      ['html', { manifest: false }],
      ['heuristic', { manifest: false, withHtml: false }],
    ]) {
      const r = buildReport(build(`ok-${label}`, small, opts));
      const kind = (f) => r.chunks.find((c) => c.file === f)?.kind;
      expectEq(`${label}: main`, kind('assets/index-M1.js'), 'main');
      expectEq(`${label}: worker`, kind('assets/analyze.worker-W1.js'), 'worker');
      expectEq(`${label}: rvfc`, kind('assets/rvfc-R1.js'), 'rvfc');
      expectEq(`${label}: mp4box`, kind('assets/mp4box-B1.js'), 'mp4box');
      expectEq(`${label}: mediabunny`, kind('assets/mediabunny-D1.js'), 'mediabunny');
      expectEq(`${label}: css`, kind('assets/index-C1.css'), 'css');
      expectEq(`${label}: no failures`, r.failures.length, 0);
      expectEq(`${label}: initial excludes lazy chunks`, r.initial.raw < 40_000 + 5_000 + 1_000 + 30_000 + 100, true);
    }
    const vite8 = (name, { manifestAssets, withRef }) => {
      const dir = join(root, name);
      const ref = withRef ? 'new Worker(new URL(new URL(`w-W1.js`,import.meta.url).href,``+import.meta.url),{type:`module`});' : '';
      write(dir, 'assets/index-M1.js', `${ref}import(\`./rvfc-R1.js\`);${filler(2000)}`);
      write(dir, 'assets/w-W1.js', `self.onmessage=t=>{postMessage(t.data)};${filler(3000)}`);
      write(dir, 'assets/rvfc-R1.js', filler(500));
      write(dir, 'index.html', html);
      const entry = { file: 'assets/index-M1.js', isEntry: true, src: 'index.html', css: ['assets/index-C1.css'] };
      if (manifestAssets) entry.assets = ['assets/w-W1.js'];
      write(dir, 'assets/index-C1.css', 'body{margin:0}');
      write(dir, '.vite/manifest.json', JSON.stringify({ 'index.html': entry }));
      return buildReport(dir);
    };
    const nested = vite8('vite8-nested-url', { manifestAssets: false, withRef: true });
    expectEq('vite 8 nested URL: worker found', nested.chunks.find((c) => c.file === 'assets/w-W1.js')?.kind, 'worker');
    expectEq('vite 8 nested URL: method', nested.workerMethod, 'Worker() reference');
    const viaAssets = vite8('vite8-manifest-assets', { manifestAssets: true, withRef: false });
    expectEq('vite 8 manifest assets: worker found', viaAssets.chunks.find((c) => c.file === 'assets/w-W1.js')?.kind, 'worker');
    expectEq('vite 8 manifest assets: method', viaAssets.workerMethod, 'vite manifest assets');
    const over = buildReport(build('over', { main: 76_000, worker: 13_000, rvfc: 3_000 }, { manifest: true }));
    const status = Object.fromEntries(over.budgets.map((b) => [b.key, b.status]));
    expectEq('over: main', status.main, 'over');
    expectEq('over: worker', status.worker, 'over');
    expectEq('over: rvfc', status.rvfc, 'over');
    expectEq('over: initial', status.initial, 'over');
    const edge = buildReport(build('edge', { main: 74_000, worker: 11_500, rvfc: 1_500 }, { manifest: true }));
    expectEq('edge: initial total over 85 KB while parts are under', edge.budgets.find((b) => b.key === 'initial').status, 'over');
    expectEq('edge: main ok', edge.budgets.find((b) => b.key === 'main').status, 'ok');
    const noWorkerDir = join(root, 'noworker');
    write(noWorkerDir, 'assets/index-M1.js', `console.log(1);${filler(1000)}`);
    write(noWorkerDir, 'index.html', html);
    const noWorker = buildReport(noWorkerDir);
    expectEq('missing worker is reported', noWorker.budgets.find((b) => b.key === 'worker').status, 'missing');
    expectEq('missing worker fails', noWorker.failures.length > 0, true);
    expectEq('rvfc absent is not a failure', noWorker.budgets.find((b) => b.key === 'rvfc').status, 'not built');
  } finally {
    rmSync(root, { recursive: true, force: true });
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
  const { values, positionals } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      out: { type: 'string' },
      'self-test': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values['self-test']) return runSelfTest();
  const arg = positionals[0];
  const distDir = arg ? resolve(arg) : join(REPO_ROOT, 'dist');
  if (!existsSync(distDir)) {
    console.error(`dist directory not found: ${distDir} (run npm run build first)`);
    return 2;
  }
  const report = buildReport(distDir);
  if (report.chunks.length === 0) {
    console.error(`no JS or CSS files under ${distDir}`);
    return 2;
  }
  const rel = relative(REPO_ROOT, distDir);
  const label = rel && !rel.startsWith('..') && !isAbsolute(rel) ? posix(rel) : basename(distDir);
  const outDir = values.out ? resolve(values.out) : join(REPO_ROOT, 'report');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'size.md'), renderMarkdown(report, label));
  const json = {
    generator: 'scripts/size-report.mjs',
    dist: label,
    unit: 'KB = 1000 bytes; gzip level 9; brotli quality 11',
    method: report.method,
    workerMethod: report.workerMethod,
    notes: report.notes,
    budgets: report.budgets,
    initial: report.initial,
    chunks: report.chunks,
  };
  writeFileSync(join(outDir, 'size.json'), `${JSON.stringify(json, null, 2)}\n`);
  printReport(report);
  console.log(`wrote ${join(outDir, 'size.md')} and size.json`);
  if (values.check && report.failures.length > 0) {
    for (const f of report.failures) console.error(`FAIL: ${f}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
