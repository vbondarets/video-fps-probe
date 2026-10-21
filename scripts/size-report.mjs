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
  main: {
    label: 'main (React + UI)',
    limit: 75 * KB,
    required: true,
    why: 'User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed (the Vite build log prints 74.79 KB for the same chunk; both fit), so there is little room: new UI code has to be lazy.',
  },
  worker: {
    label: 'worker entry (core + glue)',
    limit: 7.5 * KB,
    required: true,
    why: 'Sniffing, reader, options, timeline statistics, message glue and the code the lazy parsers and comparison engines share. Both own parsers are lazy chunks. Measured 6.56 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.',
  },
  isobmff: {
    label: 'ISO BMFF parser chunk',
    limit: 13.5 * KB,
    required: true,
    why: 'Own MP4 and MOV parser, fetched by the worker only when a file sniffs as ISO BMFF. Measured 11.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.',
  },
  matroska: {
    label: 'Matroska parser chunk',
    limit: 12 * KB,
    required: true,
    why: 'Own Matroska and WebM parser, fetched by the worker only when a file sniffs as EBML. Measured 10.73 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.',
  },
  rvfc: {
    label: 'lazy rVFC fallback',
    limit: 2.5 * KB,
    required: false,
    why: 'Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.',
  },
  initial: {
    label: 'initial (main + CSS + worker entry)',
    limit: 85 * KB,
    required: true,
    why: 'User-facing goal, unchanged: the page, its styles and the worker entry, before any file is analysed. Measured 82.05 KB when set.',
  },
  firstMp4: {
    label: 'first MP4 analysis (initial + ISO BMFF chunk)',
    limit: 100 * KB,
    required: true,
    why: 'User-facing promise: page plus first MP4 or MOV result stays under 100 KB gzip. Measured 93.99 KB when set. The component limits add up to 98.5 KB, so this only trips when something outside the budgeted chunks, such as a new shared chunk, joins the path.',
  },
  firstMkv: {
    label: 'first Matroska analysis (initial + Matroska chunk)',
    limit: 100 * KB,
    required: true,
    why: 'User-facing promise: page plus first MKV or WebM result stays under 100 KB gzip. Measured 92.78 KB when set. The component limits add up to 97 KB, so this only trips when something outside the budgeted chunks joins the path.',
  },
};

const USAGE = `Usage: node scripts/size-report.mjs [distDir=dist] [--check] [--out <dir>] [--self-test]

  --check       exit 1 when a budget is exceeded or a required chunk (main, worker entry, either parser) is missing
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
  ['isobmff', /^isobmff[-.]/i],
  ['matroska', /^matroska[-.]/i],
];
const ENGINE_KINDS = new Set(['mp4box', 'mediabunny', 'engine-shared']);
const PARSER_KINDS = new Set(['isobmff', 'matroska', 'parser-shared']);
const PARSER_ENTRIES = ['isobmff', 'matroska'];

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
  const importers = new Map();
  for (const f of js) {
    for (const dep of scanReferences(texts.get(f), f, fileSet).staticImports) {
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep).add(f);
    }
  }
  const groups = [
    [ENGINE_KINDS, 'engine-shared'],
    [PARSER_KINDS, 'parser-shared'],
  ];
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of js) {
      if (kinds.get(f) !== 'other') continue;
      const from = importers.get(f);
      const group = from && groups.find(([members]) => [...from].every((i) => members.has(kinds.get(i))));
      if (group) {
        kinds.set(f, group[1]);
        changed = true;
      }
    }
  }
  const parserDeps = new Map();
  for (const f of js) if (PARSER_ENTRIES.includes(kinds.get(f))) parserDeps.set(f, closureOf(f, fileSet, texts));
  return { files, kinds, method, workerMethod, notes, main, parserDeps };
}

export function buildReport(distDir) {
  const { files, kinds, method, workerMethod, notes, parserDeps } = discover(distDir);
  const chunks = files.map((file) => ({ file, kind: kinds.get(file), ...measure(readFileSync(join(distDir, file))) }));
  const byFile = new Map(chunks.map((c) => [c.file, c]));
  const ofKind = (wanted) => chunks.filter((c) => wanted.includes(c.kind));
  const totalOf = (list) => ({
    files: list.map((c) => c.file),
    raw: list.reduce((n, c) => n + c.raw, 0),
    gzip: list.reduce((n, c) => n + c.gzip, 0),
    brotli: list.reduce((n, c) => n + c.brotli, 0),
  });
  const has = (kind) => chunks.some((c) => c.kind === kind);
  const initialChunks = ofKind(['main', 'worker', 'shared', 'css']);
  const initial = totalOf(initialChunks);
  const afterParser = (kind) => {
    const parsers = ofKind([kind]);
    const extra = new Set(parsers.map((c) => c.file));
    for (const p of parsers) for (const dep of parserDeps.get(p.file) ?? []) extra.add(dep);
    for (const c of initialChunks) extra.delete(c.file);
    const list = [...initialChunks, ...[...extra].map((f) => byFile.get(f)).filter(Boolean)];
    return { present: has('main') && parsers.length > 0, total: totalOf(list) };
  };
  const firstMp4 = afterParser('isobmff');
  const firstMkv = afterParser('matroska');
  const evaluate = (key, present, value, fileList) => {
    const { label, limit, required, why } = BUDGETS[key];
    let status = 'ok';
    if (!present) status = required ? 'missing' : 'not built';
    else if (value > limit) status = 'over';
    return { key, label, limit, gzip: present ? value : null, headroom: present ? limit - value : null, status, files: fileList, why };
  };
  const ofKindBudget = (key, kind) => {
    const list = ofKind([kind]);
    return evaluate(key, list.length > 0, totalOf(list).gzip, list.map((c) => c.file));
  };
  const budgets = [
    ofKindBudget('main', 'main'),
    ofKindBudget('worker', 'worker'),
    ofKindBudget('isobmff', 'isobmff'),
    ofKindBudget('matroska', 'matroska'),
    ofKindBudget('rvfc', 'rvfc'),
    evaluate('initial', has('main'), initial.gzip, initial.files),
    evaluate('firstMp4', firstMp4.present, firstMp4.total.gzip, firstMp4.total.files),
    evaluate('firstMkv', firstMkv.present, firstMkv.total.gzip, firstMkv.total.files),
  ];
  const failures = budgets.filter((b) => b.status === 'over' || b.status === 'missing');
  const composites = { initial, firstMp4: firstMp4.total, firstMatroska: firstMkv.total };
  return { distDir, method, workerMethod, notes, chunks, initial, composites, budgets, failures: failures.map((b) => `${b.label}: ${b.status}`) };
}

export function renderMarkdown(report, label) {
  const out = [];
  out.push('# Bundle size');
  out.push('');
  out.push(
    `Production build in \`${label}\`, measured by \`scripts/size-report.mjs\`. KB means 1000 bytes. gzip is zlib level 9 and brotli is quality 11, per chunk. Composite rows (initial, first analysis) are sums of the per-chunk sizes. Discovery: ${report.method}; worker: ${report.workerMethod}.`,
  );
  out.push('');
  for (const n of report.notes) out.push(`Note: ${n}.`, '');
  out.push('## Budgets (gzip)');
  out.push('');
  out.push('| Budget | Limit | Actual | Headroom | Status | Files |');
  out.push('|---|---:|---:|---:|---|---|');
  for (const b of report.budgets) {
    out.push(`| ${b.label} | ${kb(b.limit)} | ${b.gzip === null ? '-' : kb(b.gzip)} | ${b.headroom === null ? '-' : kb(b.headroom)} | ${b.status} | ${b.files.join(', ') || '-'} |`);
  }
  out.push('');
  out.push('The lazy mp4box and mediabunny comparison chunks (and the chunk they share) are reported but not budgeted.');
  out.push('');
  out.push('## Why these limits');
  out.push('');
  for (const b of report.budgets) out.push(`- **${b.label}** (${kb(b.limit)}): ${b.why}`);
  out.push('');
  out.push('## Chunks');
  out.push('');
  out.push('| File | Kind | Raw | gzip -9 | brotli q11 |');
  out.push('|---|---|---:|---:|---:|');
  for (const c of report.chunks) out.push(`| ${c.file} | ${c.kind} | ${kb(c.raw)} | ${kb(c.gzip)} | ${kb(c.brotli)} |`);
  const rows = [
    ['initial', 'main + CSS + worker entry', report.composites.initial],
    ['first MP4 analysis', 'initial + ISO BMFF chunk', report.composites.firstMp4],
    ['first Matroska analysis', 'initial + Matroska chunk', report.composites.firstMatroska],
  ];
  for (const [name, what, t] of rows) out.push(`| **${name}** | ${what} | ${kb(t.raw)} | ${kb(t.gzip)} | ${kb(t.brotli)} |`);
  out.push('');
  return `${out.join('\n')}\n`;
}

function printReport(report) {
  for (const b of report.budgets) {
    console.log(`${b.label.padEnd(52)} ${(b.gzip === null ? '-' : kb(b.gzip)).padStart(10)} / ${kb(b.limit).padStart(9)}  ${b.status}`);
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
  const limit = (key) => BUDGETS[key].limit;
  const html = '<!doctype html><html><head><link rel="stylesheet" crossorigin href="./assets/index-C1.css"><script type="module" crossorigin src="./assets/index-M1.js"></script></head><body></body></html>';
  const mainText = (extra) =>
    `const w=new Worker(new URL("assets/analyze.worker-W1.js",import.meta.url),{type:"module"});const a=()=>import("./rvfc-R1.js");${extra}`;
  const workerText = (extra) =>
    `self.onmessage=e=>{postMessage(1)};const a=()=>import(\`./isobmff-I1.js\`);const b=()=>import(\`./matroska-K1.js\`);const c=()=>import(\`./mp4box-B1.js\`);const d=()=>import(\`./mediabunny-D1.js\`);${extra}`;
  const sizesOf = (over = {}) => ({ main: 30_000, worker: 5_000, rvfc: 1_000, isobmff: 8_000, matroska: 7_000, css: 100, isobmffShared: 0, ...over });
  const build = (name, overrides, { manifest = true, withHtml = true } = {}) => {
    const sizes = sizesOf(overrides);
    const dir = join(root, name);
    write(dir, 'assets/index-M1.js', mainText(filler(sizes.main)));
    write(dir, 'assets/analyze.worker-W1.js', workerText(filler(sizes.worker)));
    const shared = sizes.isobmffShared > 0;
    write(dir, 'assets/isobmff-I1.js', `import{a as e}from"./analyze.worker-W1.js";${shared ? 'import{b as f}from"./shared-P1.js";' : ''}${filler(sizes.isobmff)}`);
    if (shared) write(dir, 'assets/shared-P1.js', filler(sizes.isobmffShared));
    if (sizes.matroska > 0) write(dir, 'assets/matroska-K1.js', `import{a as e}from"./analyze.worker-W1.js";${filler(sizes.matroska)}`);
    write(dir, 'assets/rvfc-R1.js', filler(sizes.rvfc));
    write(dir, 'assets/mp4box-B1.js', `import{a as e}from"./counting-C1.js";${filler(40_000)}`);
    write(dir, 'assets/mediabunny-D1.js', `import{a as e}from"./counting-C1.js";${filler(50_000)}`);
    write(dir, 'assets/counting-C1.js', filler(3_000));
    write(dir, 'assets/index-C1.css', filler(sizes.css));
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
  const statusOf = (report, key) => report.budgets.find((b) => b.key === key).status;
  try {
    for (const [label, opts] of [
      ['manifest', { manifest: true }],
      ['html', { manifest: false }],
      ['heuristic', { manifest: false, withHtml: false }],
    ]) {
      const r = buildReport(build(`ok-${label}`, { isobmffShared: 2_000 }, opts));
      const kind = (f) => r.chunks.find((c) => c.file === f)?.kind;
      expectEq(`${label}: main`, kind('assets/index-M1.js'), 'main');
      expectEq(`${label}: worker`, kind('assets/analyze.worker-W1.js'), 'worker');
      expectEq(`${label}: isobmff`, kind('assets/isobmff-I1.js'), 'isobmff');
      expectEq(`${label}: matroska`, kind('assets/matroska-K1.js'), 'matroska');
      expectEq(`${label}: parser shared chunk`, kind('assets/shared-P1.js'), 'parser-shared');
      expectEq(`${label}: rvfc`, kind('assets/rvfc-R1.js'), 'rvfc');
      expectEq(`${label}: mp4box`, kind('assets/mp4box-B1.js'), 'mp4box');
      expectEq(`${label}: mediabunny`, kind('assets/mediabunny-D1.js'), 'mediabunny');
      expectEq(`${label}: engine shared chunk`, kind('assets/counting-C1.js'), 'engine-shared');
      expectEq(`${label}: css`, kind('assets/index-C1.css'), 'css');
      expectEq(`${label}: no failures`, r.failures.length, 0);
      expectEq(`${label}: initial excludes lazy chunks`, r.composites.initial.files.length, 3);
      expectEq(`${label}: first MP4 adds the parser and its shared chunk`, r.composites.firstMp4.files.length, 5);
      expectEq(`${label}: first MP4 has no Matroska`, r.composites.firstMp4.files.includes('assets/matroska-K1.js'), false);
      expectEq(`${label}: first Matroska adds only its parser`, r.composites.firstMatroska.files.length, 4);
      const gz = (files) => files.reduce((n, f) => n + r.chunks.find((c) => c.file === f).gzip, 0);
      expectEq(`${label}: first MP4 total is the sum of its chunks`, r.composites.firstMp4.gzip, gz(r.composites.firstMp4.files));
      expectEq(`${label}: first MP4 is initial plus parser plus shared`, r.composites.firstMp4.gzip, r.composites.initial.gzip + gz(['assets/isobmff-I1.js', 'assets/shared-P1.js']));
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
    const over = buildReport(
      build('over', {
        main: limit('main') + 2_000,
        worker: limit('worker') + 1_000,
        rvfc: limit('rvfc') + 1_000,
        isobmff: limit('isobmff') + 3_000,
        matroska: limit('matroska') + 3_000,
      }),
    );
    for (const key of ['main', 'worker', 'isobmff', 'matroska', 'rvfc', 'initial', 'firstMp4', 'firstMkv']) expectEq(`over: ${key}`, statusOf(over, key), 'over');
    const fit = buildReport(
      build('fit', {
        main: limit('main') - 1_500,
        worker: limit('worker') - 1_500,
        isobmff: limit('isobmff') - 1_500,
        matroska: limit('matroska') - 1_500,
        rvfc: limit('rvfc') - 700,
      }),
    );
    expectEq('fit: no failures', fit.failures.length, 0);
    const edgeInitial = buildReport(build('edge-initial', { main: limit('main') - 800, worker: limit('worker') - 800, css: 4_500 }));
    expectEq('edge: initial over while main and worker are ok', statusOf(edgeInitial, 'initial'), 'over');
    expectEq('edge: main ok', statusOf(edgeInitial, 'main'), 'ok');
    expectEq('edge: worker ok', statusOf(edgeInitial, 'worker'), 'ok');
    const edgeShared = buildReport(build('edge-shared', { main: limit('main') - 1_500, isobmff: limit('isobmff') - 500, isobmffShared: 14_000 }));
    expectEq('edge: parser shared chunk counts toward the first MP4 analysis', statusOf(edgeShared, 'firstMp4'), 'over');
    expectEq('edge: parser budget still ok', statusOf(edgeShared, 'isobmff'), 'ok');
    expectEq('edge: initial still ok', statusOf(edgeShared, 'initial'), 'ok');
    expectEq('edge: first Matroska unaffected', statusOf(edgeShared, 'firstMkv'), 'ok');
    const noMkv = buildReport(build('no-matroska', { matroska: 0 }));
    expectEq('missing parser chunk is reported', statusOf(noMkv, 'matroska'), 'missing');
    expectEq('missing parser makes the first analysis missing', statusOf(noMkv, 'firstMkv'), 'missing');
    expectEq('missing parser fails', noMkv.failures.length, 2);
    expectEq('other parser unaffected', statusOf(noMkv, 'firstMp4'), 'ok');
    const noWorkerDir = join(root, 'noworker');
    write(noWorkerDir, 'assets/index-M1.js', `console.log(1);${filler(1000)}`);
    write(noWorkerDir, 'index.html', html);
    const noWorker = buildReport(noWorkerDir);
    expectEq('missing worker is reported', statusOf(noWorker, 'worker'), 'missing');
    expectEq('missing worker fails', noWorker.failures.length > 0, true);
    expectEq('rvfc absent is not a failure', statusOf(noWorker, 'rvfc'), 'not built');
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
    composites: report.composites,
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
