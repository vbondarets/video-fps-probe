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
    why: 'User-facing goal, unchanged. React and ReactDOM are about 67.5 KB gzip of it. Measured 73.86 KB at gzip -9 when the limit was reviewed, so there is little room: new UI code has to be lazy. The Vite build log prints a larger figure for the same chunk (its own gzip settings), which can exceed 75 KB; the budget is checked against the level 9 numbers of this script only.',
  },
  worker: {
    label: 'worker entry (core + glue)',
    limit: 5 * KB,
    required: true,
    entry: 'probe.worker',
    why: 'Sniffing, reader, options, the worker runtime and the code the lazy parsers and comparison engines share: the demo custom worker, which serves own, mp4box and mediabunny. Both own parsers are lazy chunks, and the timeline statistics are the shared statistics chunk. Budgeted by entry name: only the probe.worker file counts, and any other worker file fails as unbudgeted, so the demo ships exactly one worker. Re-set when the demo worker entry was renamed from analyze.worker to probe.worker (measured 4.19 KB), and re-checked after the worker runtime started requesting the statistics chunk with every lazy engine source: measured 4.22 KB; limit is measured plus 10 percent, rounded up to 0.5 KB (4.64 to 5 KB). That stays well under the 8.5 KB a consumer custom worker gets, so a regression of about 0.8 KB fails here instead of hiding in that headroom.',
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
  'parser-shared': {
    label: 'shared statistics chunk',
    limit: 5 * KB,
    required: false,
    why: 'Timeline statistics shared by both own parsers and the comparison engines. The worker requests the chunk in parallel with the first parser, so it is part of every first analysis row. Measured 4.29 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Counts every chunk the parsers share. Not required: when the statistics are part of the worker entry, the worker budget catches them.',
  },
  rvfc: {
    label: 'lazy rVFC fallback',
    limit: 2.5 * KB,
    required: false,
    why: 'Loaded on demand from the main chunk. Measured 1.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB.',
  },
  segments: {
    label: 'lazy rate profile core (segments)',
    limit: 2 * KB,
    required: false,
    why: 'Segmentation, anomalies, uneven flag and sparkline buckets. Fetched by the worker only for a timeline with unequal frame rates (VFR), after the parser chunk. Measured 1.79 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into another one, that chunk budget catches the growth.',
  },
  client: {
    label: 'lazy probe client',
    limit: 3.5 * KB,
    required: false,
    why: 'The probe client fetched by the main chunk on the first file, before the worker starts: the demo probe (probe-*) with createProbeClient, its engine routing, the worker pool and the rVFC descriptor. The fallback chain, compare and the in-thread runner are separate lazy chunks that the first analysis does not load. Counted in every first analysis row. Re-set when the demo moved from the module worker pool (1.04 KB) to the library probe client: measured 2.73 KB; limit is measured plus 10 percent, rounded up to 0.5 KB, which is also the consumer client chunk budget. Not required: without a client chunk the client is part of the main chunk.',
  },
  rateProfile: {
    label: 'lazy rate profile panel (UI)',
    limit: 1.5 * KB,
    required: false,
    why: 'Sparkline and segment table, fetched by the main chunk (React.lazy) when a result card has a rate profile. Measured 0.94 KB when set; limit is measured plus 10 percent, rounded up to 0.5 KB. Not required: when the chunk is merged into the main chunk, the main budget catches the growth.',
  },
  initial: {
    label: 'initial (main + CSS + worker entry)',
    limit: 85 * KB,
    required: true,
    why: 'User-facing goal, unchanged: the page, its styles and the worker entry, before any file is analysed. Nothing else loads without a user action: the device info chunk (footer line and JSON export) is fetched on idle after the first result, or by the first export, so it is in neither the initial row nor the first analysis rows. Measured 82.05 KB when set.',
  },
  firstMp4: {
    label: 'first MP4 analysis (initial + client + ISO BMFF + shared chunks)',
    limit: 100 * KB,
    required: true,
    why: 'User-facing promise: page plus first MP4 or MOV result stays under 100 KB gzip. Measured 93.99 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 3.5 + 5 + 13.5 = 107 KB) add up to more than the promise and this can trip while every component is within its own limit.',
  },
  firstVfrMp4: {
    label: 'first VFR MP4 analysis (initial + client + ISO BMFF + segments + shared chunks)',
    limit: 102 * KB,
    required: false,
    why: 'User-facing promise: page plus the first MP4 or MOV result with unequal frame rates, which also fetches the rate profile chunk, stays under 100 KB gzip. Accepted by the owner on 2026-10-23 for the demo only: with the library probe client this row does not fit the promise without dropping designed features, so the limit is the measurement rounded up to 0.5 KB. The size promise of the package itself is the consumer size matrix, not this demo row. Measured 101.23 KB: main 74.11, CSS 1.81, worker entry 4.22, probe client 2.74, statistics 4.29, ISO BMFF 12.22 and segments 1.84. Before the package work it measured 97.84 KB: the probe client (engine routing, the worker pool, the rVFC descriptor and the fallback, compare and in-thread hooks) adds 2.74 KB while the main chunk lost 0.65 KB with the old module worker pool, and the statistics split out of the worker entry plus the versioned worker runtime add 1.15 KB. Dropping the module preload polyfill and moving the rVFC checks into its lazy chunk took 0.32 KB back. The first MP4 and first Matroska rows keep the 100 KB promise. With the lazy probe client and the shared statistics chunk, the component limits (85 + 3.5 + 5 + 13.5 + 2 = 109 KB) add up to more than this limit, so it can trip while every component is within its own limit. Raised from 101.5 KB to 102.0 KB on 2026-10-24 by the same rule, for the 0.1.1 fix of a tab left open across a redeploy: the load reason on the probe errors, the pool that waits for a live worker, and the reload banner with its deploy check in the main chunk add 0.59 KB to the 101.23 KB of 0.1.0, and moving the sample file loader out of the main chunk took 0.15 KB back. Measured 101.67 KB. Not required: without a segments chunk the code lives elsewhere and the first MP4 analysis covers it.',
  },
  firstMkv: {
    label: 'first Matroska analysis (initial + client + Matroska + shared chunks)',
    limit: 100 * KB,
    required: true,
    why: 'User-facing promise: page plus first MKV or WebM result stays under 100 KB gzip. Measured 92.78 KB when set. Counts the lazy probe client and the shared statistics chunk too, so the component limits (85 + 3.5 + 5 + 12 = 105.5 KB) add up to more than the promise and this can trip while every component is within its own limit.',
  },
};

const USAGE = `Usage: node scripts/size-report.mjs [distDir=demo/dist] [--check] [--out <dir>] [--self-test]

  --check       exit 1 when a budget is exceeded, a required chunk (main, worker entry, either parser) is missing,
                a worker file has no budget, or a parser or engine chunk waits for a chunk that is neither loaded
                nor requested together with it
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
  ['client', /^(?:probe|pool)-/i],
  ['client-compare', /^compare-/],
  ['client-fallback', /^fallback-/],
  ['client-inline', /^inline-/],
  ['inline-own', /^runtime[-.]/i],
  ['rvfc', /rvfc/i],
  ['mp4box', /mp4box/i],
  ['mediabunny', /mediabunny/i],
  ['isobmff', /^isobmff[-.]/i],
  ['matroska', /^matroska[-.]/i],
  ['segments', /^segments[-.]/i],
  ['rateProfile', /^rateprofile[-.]/i],
  ['deviceInfo', /^deviceinfo[-.]/i],
  ['samples', /^samples[-.]/i],
];
const ENGINE_KINDS = new Set(['mp4box', 'mediabunny', 'engine-shared']);
const CLIENT_LAZY_KINDS = new Set(['client-compare', 'client-fallback', 'client-inline', 'rvfc', 'client-shared']);
const WORKER_ONLY_KINDS = new Set(['isobmff', 'matroska', 'segments', 'mp4box', 'mediabunny']);
const PARSER_KINDS = new Set(['isobmff', 'matroska', 'segments', 'parser-shared']);
const PATH_ENTRIES = ['isobmff', 'matroska', 'segments'];
const CHAIN_KINDS = new Set(['isobmff', 'matroska', 'segments', 'mp4box', 'mediabunny']);
const WORKER_BUDGETS = Object.entries(BUDGETS).filter(([, b]) => b.entry);

export function workerBudgetOf(file) {
  const name = basename(file);
  return WORKER_BUDGETS.find(([, b]) => name.startsWith(`${b.entry}-`) || name.startsWith(`${b.entry}.`))?.[0] ?? null;
}

const IMPORT_GROUP = /Promise\.all\(\s*\[([^\]]*)\]\s*\)/g;
const IMPORT_CALL = /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

export function importGroups(text, fromFile, fileSet) {
  const groups = [];
  for (const m of text.matchAll(IMPORT_GROUP)) {
    const group = new Set();
    for (const call of m[1].matchAll(IMPORT_CALL)) {
      const target = resolveFrom(call[1], fromFile, fileSet);
      if (target && target !== fromFile) group.add(target);
    }
    if (group.size > 1) groups.push(group);
  }
  return groups;
}

const SOURCE_CALL = /[\w$]\(\)/;

export function companionImports(text, fromFile, fileSet) {
  const found = new Set();
  for (const m of text.matchAll(IMPORT_GROUP)) {
    const calls = [...m[1].matchAll(IMPORT_CALL)];
    if (calls.length !== 1 || !SOURCE_CALL.test(m[1].replace(IMPORT_CALL, ''))) continue;
    const target = resolveFrom(calls[0][1], fromFile, fileSet);
    if (target && target !== fromFile) found.add(target);
  }
  return found;
}

export function requestChains({ files, kinds, workers, texts }) {
  const fileSet = new Set(files);
  const problems = new Set();
  const closures = new Map();
  const closure = (f) => {
    if (!closures.has(f)) closures.set(f, closureOf(f, fileSet, texts));
    return closures.get(f);
  };
  const visited = new Set();
  const visit = (file, loaded, companions) => {
    const key = `${file}|${[...loaded].sort().join(',')}`;
    if (visited.has(key)) return;
    visited.add(key);
    const text = texts.get(file) ?? '';
    const groups = importGroups(text, file, fileSet);
    for (const target of scanReferences(text, file, fileSet).dynamicImports) {
      if (workers.has(target) || loaded.has(target)) continue;
      const requested = new Set([target]);
      for (const g of groups) if (g.has(target)) for (const f of g) requested.add(f);
      const kind = kinds.get(target);
      if (kind === 'mp4box' || kind === 'mediabunny') for (const f of companions) requested.add(f);
      if (CHAIN_KINDS.has(kind)) {
        const direct = scanReferences(texts.get(target) ?? '', target, fileSet).staticImports;
        for (const dep of closure(target)) {
          if (loaded.has(dep) || requested.has(dep)) continue;
          if (ENGINE_KINDS.has(kind) && kinds.get(dep) === 'engine-shared' && direct.has(dep)) continue;
          problems.add(`request chain: ${target} (${kind}) waits for ${dep}, which ${file} does not request in parallel`);
        }
      }
      const next = new Set(loaded);
      for (const f of requested) for (const g of [f, ...closure(f)]) next.add(g);
      for (const f of next) if (!loaded.has(f)) visit(f, next, companions);
    }
  };
  for (const w of workers) {
    const loaded = new Set([w, ...closure(w)]);
    const companions = new Set([...loaded].flatMap((f) => [...companionImports(texts.get(f) ?? '', f, fileSet)]));
    for (const f of loaded) visit(f, loaded, companions);
  }
  return [...problems];
}

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
  const workerSide = new Set();
  for (const stack = [...workers]; stack.length > 0; ) {
    const f = stack.pop();
    if (workerSide.has(f)) continue;
    workerSide.add(f);
    const refs = scanReferences(texts.get(f) ?? '', f, fileSet);
    stack.push(...refs.staticImports, ...refs.dynamicImports);
  }

  if (main) kinds.set(main, 'main');
  for (const w of workers) kinds.set(w, 'worker');
  for (const s of [...shared, ...workerShared]) if (!kinds.has(s)) kinds.set(s, 'shared');
  for (const c of css) if (!kinds.has(c)) kinds.set(c, 'css');
  for (const f of files) {
    if (kinds.has(f)) continue;
    const named = LAZY_BY_NAME.find(([, re]) => re.test(basename(f)))?.[0];
    const inThread = workers.size > 0 && !workerSide.has(f) && (named === 'inline-own' || WORKER_ONLY_KINDS.has(named));
    if (inThread) kinds.set(f, 'inline-own');
    else if (named && named !== 'inline-own') kinds.set(f, named);
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
    [new Set(['inline-own']), 'inline-own'],
    [new Set([...CLIENT_LAZY_KINDS, 'inline-own']), 'client-shared'],
    [ENGINE_KINDS, 'engine-shared'],
    [PARSER_KINDS, 'parser-shared'],
    [new Set([...PARSER_KINDS, ...ENGINE_KINDS]), 'parser-shared'],
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
  const entryDeps = new Map();
  for (const f of js) if (PATH_ENTRIES.includes(kinds.get(f)) || kinds.get(f) === 'client') entryDeps.set(f, closureOf(f, fileSet, texts));
  const chains = requestChains({ files, kinds, workers, texts });
  return { files, kinds, method, workerMethod, notes, main, entryDeps, workers: [...workers], chains };
}

export function buildReport(distDir) {
  const { files, kinds, method, workerMethod, notes, entryDeps, workers, chains } = discover(distDir);
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
  const afterChunks = (wanted) => {
    const entries = ofKind(wanted);
    const clients = ofKind(['client']);
    const extra = new Set([...entries, ...clients].map((c) => c.file));
    for (const p of [...entries, ...clients]) for (const dep of entryDeps.get(p.file) ?? []) extra.add(dep);
    for (const c of initialChunks) extra.delete(c.file);
    const list = [...initialChunks, ...[...extra].map((f) => byFile.get(f)).filter(Boolean)];
    return { present: has('main') && wanted.every(has), total: totalOf(list) };
  };
  const firstMp4 = afterChunks(['isobmff']);
  const firstVfrMp4 = afterChunks(['isobmff', 'segments']);
  const firstMkv = afterChunks(['matroska']);
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
  const workerBudget = (key) => {
    const list = workers.filter((f) => workerBudgetOf(f) === key).map((f) => byFile.get(f));
    return evaluate(key, list.length > 0, totalOf(list).gzip, list.map((c) => c.file));
  };
  const budgets = [
    ofKindBudget('main', 'main'),
    ...WORKER_BUDGETS.map(([key]) => workerBudget(key)),
    ofKindBudget('isobmff', 'isobmff'),
    ofKindBudget('matroska', 'matroska'),
    ofKindBudget('parser-shared', 'parser-shared'),
    ofKindBudget('client', 'client'),
    ofKindBudget('rvfc', 'rvfc'),
    ofKindBudget('segments', 'segments'),
    ofKindBudget('rateProfile', 'rateProfile'),
    evaluate('initial', has('main'), initial.gzip, initial.files),
    evaluate('firstMp4', firstMp4.present, firstMp4.total.gzip, firstMp4.total.files),
    evaluate('firstVfrMp4', firstVfrMp4.present, firstVfrMp4.total.gzip, firstVfrMp4.total.files),
    evaluate('firstMkv', firstMkv.present, firstMkv.total.gzip, firstMkv.total.files),
  ];
  const failures = budgets.filter((b) => b.status === 'over' || b.status === 'missing').map((b) => `${b.label}: ${b.status}`);
  for (const w of workers) if (!workerBudgetOf(w)) failures.push(`unbudgeted worker ${w}`);
  failures.push(...chains);
  const composites = { initial, firstMp4: firstMp4.total, firstVfrMp4: firstVfrMp4.total, firstMatroska: firstMkv.total };
  return { distDir, method, workerMethod, notes, chunks, initial, composites, budgets, chains, failures };
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
  out.push(
    `Request chain check: every static dependency of a parser or engine chunk is already loaded when it is requested, or requested together with it in one Promise.all. The worker runtime requests the statistics chunk together with every lazy engine source (one Promise.all of the source call and that chunk), so it counts as requested with each mp4box and mediabunny chunk. The one exception: an engine chunk may wait for the chunk the engines share when it imports that chunk directly, so the mp4box and mediabunny paths have one extra sequential request. ${report.chains.length === 0 ? 'No problems.' : report.chains.join('; ')}`,
  );
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
  const vfrBuilt = report.budgets.find((b) => b.key === 'firstVfrMp4')?.gzip != null;
  const rows = [
    ['initial', 'main + CSS + worker entry', report.composites.initial],
    ['first MP4 analysis', 'initial + client chunk + ISO BMFF chunk + shared chunks', report.composites.firstMp4],
    ...(vfrBuilt ? [['first VFR MP4 analysis', 'initial + client chunk + ISO BMFF chunk + segments chunk + shared chunks', report.composites.firstVfrMp4]] : []),
    ['first Matroska analysis', 'initial + client chunk + Matroska chunk + shared chunks', report.composites.firstMatroska],
  ];
  for (const [name, what, t] of rows) out.push(`| **${name}** | ${what} | ${kb(t.raw)} | ${kb(t.gzip)} | ${kb(t.brotli)} |`);
  out.push('');
  return `${out.join('\n')}\n`;
}

function printReport(report) {
  const width = Math.max(...report.budgets.map((b) => b.label.length));
  for (const b of report.budgets) {
    console.log(`${b.label.padEnd(width)} ${(b.gzip === null ? '-' : kb(b.gzip)).padStart(10)} / ${kb(b.limit).padStart(9)}  ${b.status}`);
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
    `const w=new Worker(new URL("assets/probe.worker-W1.js",import.meta.url),{type:"module"});const a=()=>import("./rvfc-R1.js");const b=()=>import("./RateProfile-P1.js");const h=()=>import("./deviceInfo-V1.js");${extra}`;
  const load = (file, groups) => {
    const calls = [file, ...(groups[file] ?? [])].map((f) => `import(\`./${f}\`)`);
    return calls.length > 1 ? `Promise.all([${calls.join(',')}])` : calls[0];
  };
  const workerText = (extra, groups = {}, loose = []) =>
    `self.onmessage=e=>{postMessage(1)};${['isobmff-I1.js', 'matroska-K1.js', 'mp4box-B1.js', 'mediabunny-D1.js', 'segments-G1.js'].map((f, i) => `const l${i}=()=>${load(f, groups)};`).join('')}${loose.map((f) => `import(\`./${f}\`);`).join('')}${extra}`;
  const sizesOf = (over = {}) => ({
    main: 30_000,
    worker: 3_500,
    rvfc: 1_000,
    isobmff: 8_000,
    matroska: 7_000,
    segments: 1_000,
    rateProfile: 700,
    css: 100,
    isobmffShared: 0,
    segmentsShared: 0,
    client: 0,
    ...over,
  });
  const build = (name, overrides, { manifest = true, withHtml = true, parallel = true, extraWorker = false } = {}) => {
    const sizes = sizesOf(overrides);
    const dir = join(root, name);
    const groups = {};
    if (parallel && sizes.isobmffShared > 0) groups['isobmff-I1.js'] = ['shared-P1.js'];
    if (parallel && sizes.segmentsShared > 0) groups['segments-G1.js'] = ['common-S1.js'];
    const client = sizes.client > 0 ? 'const l=()=>import("./probe-L1.js");' : '';
    const other = extraWorker ? 'const o=new Worker(new URL("assets/other.worker-O1.js",import.meta.url),{type:"module"});' : '';
    write(dir, 'assets/index-M1.js', mainText(`${client}${other}${filler(sizes.main)}`));
    write(dir, 'assets/probe.worker-W1.js', workerText(filler(sizes.worker), groups));
    if (client) write(dir, 'assets/probe-L1.js', `import{a as e}from"./index-M1.js";${filler(sizes.client)}`);
    if (other) write(dir, 'assets/other.worker-O1.js', `self.onmessage=e=>{postMessage(1)};${filler(1_000)}`);
    const shared = sizes.isobmffShared > 0;
    write(dir, 'assets/isobmff-I1.js', `import{a as e}from"./probe.worker-W1.js";${shared ? 'import{b as f}from"./shared-P1.js";' : ''}${filler(sizes.isobmff)}`);
    if (shared) write(dir, 'assets/shared-P1.js', filler(sizes.isobmffShared));
    if (sizes.matroska > 0) write(dir, 'assets/matroska-K1.js', `import{a as e}from"./probe.worker-W1.js";${filler(sizes.matroska)}`);
    write(dir, 'assets/rvfc-R1.js', filler(sizes.rvfc));
    const segmentsShared = sizes.segmentsShared > 0;
    if (sizes.segments > 0) {
      write(dir, 'assets/segments-G1.js', `import{a as e}from"./probe.worker-W1.js";${segmentsShared ? 'import{c as f}from"./common-S1.js";' : ''}${filler(sizes.segments)}`);
    }
    if (segmentsShared) write(dir, 'assets/common-S1.js', filler(sizes.segmentsShared));
    if (sizes.rateProfile > 0) write(dir, 'assets/RateProfile-P1.js', `import{a as e}from"./index-M1.js";${filler(sizes.rateProfile)}`);
    write(dir, 'assets/deviceInfo-V1.js', filler(2_000));
    write(dir, 'assets/mp4box-B1.js', `import{a as e}from"./counting-C1.js";${filler(40_000)}`);
    write(dir, 'assets/mediabunny-D1.js', `import{a as e}from"./counting-C1.js";${filler(50_000)}`);
    write(dir, 'assets/counting-C1.js', filler(3_000));
    write(dir, 'assets/index-C1.css', filler(sizes.css));
    if (withHtml) write(dir, 'index.html', html);
    if (manifest) {
      const m = {
        'index.html': { file: 'assets/index-M1.js', isEntry: true, src: 'index.html', css: ['assets/index-C1.css'], dynamicImports: ['src/rvfc.ts', 'src/ui/RateProfile.tsx', 'src/ui/deviceInfo.ts'] },
        'src/rvfc.ts': { file: 'assets/rvfc-R1.js', isDynamicEntry: true, src: 'src/rvfc.ts' },
        'src/ui/RateProfile.tsx': { file: 'assets/RateProfile-P1.js', isDynamicEntry: true, src: 'src/ui/RateProfile.tsx' },
        'src/ui/deviceInfo.ts': { file: 'assets/deviceInfo-V1.js', isDynamicEntry: true, src: 'src/ui/deviceInfo.ts' },
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
      const r = buildReport(build(`ok-${label}`, { isobmffShared: 2_000, segmentsShared: 1_500 }, opts));
      const kind = (f) => r.chunks.find((c) => c.file === f)?.kind;
      expectEq(`${label}: main`, kind('assets/index-M1.js'), 'main');
      expectEq(`${label}: worker`, kind('assets/probe.worker-W1.js'), 'worker');
      expectEq(`${label}: isobmff`, kind('assets/isobmff-I1.js'), 'isobmff');
      expectEq(`${label}: matroska`, kind('assets/matroska-K1.js'), 'matroska');
      expectEq(`${label}: parser shared chunk`, kind('assets/shared-P1.js'), 'parser-shared');
      expectEq(`${label}: rvfc`, kind('assets/rvfc-R1.js'), 'rvfc');
      expectEq(`${label}: segments`, kind('assets/segments-G1.js'), 'segments');
      expectEq(`${label}: segments shared chunk`, kind('assets/common-S1.js'), 'parser-shared');
      expectEq(`${label}: rate profile panel`, kind('assets/RateProfile-P1.js'), 'rateProfile');
      expectEq(`${label}: device info is not budgeted`, kind('assets/deviceInfo-V1.js'), 'deviceInfo');
      expectEq(`${label}: no budget for device info`, r.budgets.some((b) => b.key === 'deviceInfo'), false);
      expectEq(`${label}: mp4box`, kind('assets/mp4box-B1.js'), 'mp4box');
      expectEq(`${label}: mediabunny`, kind('assets/mediabunny-D1.js'), 'mediabunny');
      expectEq(`${label}: engine shared chunk`, kind('assets/counting-C1.js'), 'engine-shared');
      expectEq(`${label}: css`, kind('assets/index-C1.css'), 'css');
      expectEq(`${label}: no failures`, r.failures.length, 0);
      expectEq(`${label}: initial excludes lazy chunks`, r.composites.initial.files.length, 3);
      expectEq(`${label}: initial has no device info`, r.composites.initial.files.includes('assets/deviceInfo-V1.js'), false);
      expectEq(`${label}: first MP4 has no device info (fetched after the first result)`, r.composites.firstMp4.files.includes('assets/deviceInfo-V1.js'), false);
      expectEq(`${label}: first MP4 adds the parser and its shared chunk`, r.composites.firstMp4.files.length, 5);
      expectEq(`${label}: first MP4 has no Matroska`, r.composites.firstMp4.files.includes('assets/matroska-K1.js'), false);
      expectEq(`${label}: first MP4 has no segments`, r.composites.firstMp4.files.includes('assets/segments-G1.js'), false);
      expectEq(`${label}: first VFR MP4 adds the parser, the segments chunk and their shared chunks`, r.composites.firstVfrMp4.files.length, 7);
      expectEq(`${label}: first VFR MP4 has the segments chunk`, r.composites.firstVfrMp4.files.includes('assets/segments-G1.js'), true);
      expectEq(`${label}: first VFR MP4 has no Matroska`, r.composites.firstVfrMp4.files.includes('assets/matroska-K1.js'), false);
      expectEq(`${label}: first VFR MP4 has no rate profile panel`, r.composites.firstVfrMp4.files.includes('assets/RateProfile-P1.js'), false);
      expectEq(`${label}: first Matroska has no segments`, r.composites.firstMatroska.files.includes('assets/segments-G1.js'), false);
      expectEq(`${label}: first Matroska adds only its parser`, r.composites.firstMatroska.files.length, 4);
      const gz = (files) => files.reduce((n, f) => n + r.chunks.find((c) => c.file === f).gzip, 0);
      expectEq(`${label}: first MP4 total is the sum of its chunks`, r.composites.firstMp4.gzip, gz(r.composites.firstMp4.files));
      expectEq(`${label}: first MP4 is initial plus parser plus shared`, r.composites.firstMp4.gzip, r.composites.initial.gzip + gz(['assets/isobmff-I1.js', 'assets/shared-P1.js']));
      expectEq(
        `${label}: first VFR MP4 is first MP4 plus segments plus its shared chunk`,
        r.composites.firstVfrMp4.gzip,
        r.composites.firstMp4.gzip + gz(['assets/segments-G1.js', 'assets/common-S1.js']),
      );
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
        segments: limit('segments') + 1_000,
        rateProfile: limit('rateProfile') + 1_000,
        isobmff: limit('isobmff') + 3_000,
        matroska: limit('matroska') + 3_000,
        isobmffShared: limit('parser-shared') + 1_000,
        css: 3_000,
      }),
    );
    for (const key of ['main', 'worker', 'isobmff', 'matroska', 'parser-shared', 'rvfc', 'segments', 'rateProfile', 'initial', 'firstMp4', 'firstVfrMp4', 'firstMkv']) expectEq(`over: ${key}`, statusOf(over, key), 'over');
    const fit = buildReport(
      build('fit', {
        main: limit('main') - 1_500,
        worker: limit('worker') - 1_500,
        isobmff: limit('isobmff') - 1_500,
        matroska: limit('matroska') - 1_500,
        rvfc: limit('rvfc') - 700,
        segments: limit('segments') - 700,
        rateProfile: limit('rateProfile') - 500,
        isobmffShared: limit('parser-shared') - 700,
      }),
    );
    expectEq('fit: no failures', fit.failures.length, 0);
    for (const key of ['parser-shared', 'segments', 'rateProfile', 'firstVfrMp4']) expectEq(`fit: ${key}`, statusOf(fit, key), 'ok');
    const edgeInitial = buildReport(build('edge-initial', { main: limit('main') - 800, worker: limit('worker') - 800, css: 7_500 }));
    expectEq('edge: initial over while main and worker are ok', statusOf(edgeInitial, 'initial'), 'over');
    expectEq('edge: main ok', statusOf(edgeInitial, 'main'), 'ok');
    expectEq('edge: worker ok', statusOf(edgeInitial, 'worker'), 'ok');
    const edgeShared = buildReport(build('edge-shared', { main: limit('main') - 500, worker: limit('worker') - 500, isobmff: limit('isobmff') - 500, isobmffShared: 4_500, css: 3_600 }));
    expectEq('edge: parser shared chunk counts toward the first MP4 analysis', statusOf(edgeShared, 'firstMp4'), 'over');
    expectEq('edge: parser budget still ok', statusOf(edgeShared, 'isobmff'), 'ok');
    expectEq('edge: shared chunk budget still ok', statusOf(edgeShared, 'parser-shared'), 'ok');
    expectEq('edge: initial still ok', statusOf(edgeShared, 'initial'), 'ok');
    expectEq('edge: first Matroska unaffected', statusOf(edgeShared, 'firstMkv'), 'ok');
    const edgeVfr = buildReport(
      build('edge-vfr', { main: limit('main') - 1_500, worker: limit('worker') - 500, isobmff: limit('isobmff') - 500, segments: limit('segments') - 300, segmentsShared: 4_500, css: 6_000 }),
    );
    expectEq('edge: segments shared chunk counts toward the first VFR MP4 analysis', statusOf(edgeVfr, 'firstVfrMp4'), 'over');
    expectEq('edge: segments budget still ok', statusOf(edgeVfr, 'segments'), 'ok');
    expectEq('edge: segments shared chunk within the shared chunk budget', statusOf(edgeVfr, 'parser-shared'), 'ok');
    expectEq('edge: first MP4 unaffected by the segments chunk', statusOf(edgeVfr, 'firstMp4'), 'ok');
    expectEq('edge: initial unaffected by the segments chunk', statusOf(edgeVfr, 'initial'), 'ok');
    expectEq('edge: first Matroska unaffected by the segments chunk', statusOf(edgeVfr, 'firstMkv'), 'ok');
    expectEq('edge: segments shared chunk is classified', edgeVfr.chunks.find((c) => c.file === 'assets/common-S1.js')?.kind, 'parser-shared');
    expectEq('edge: only the first VFR MP4 analysis fails', edgeVfr.failures.length, 1);
    const noSegments = buildReport(build('no-segments', { segments: 0 }));
    expectEq('absent segments chunk is not a failure', statusOf(noSegments, 'segments'), 'not built');
    expectEq('absent segments chunk leaves the first VFR MP4 analysis not built', statusOf(noSegments, 'firstVfrMp4'), 'not built');
    expectEq('absent segments chunk: no failures', noSegments.failures.length, 0);
    expectEq('absent segments chunk: first MP4 unaffected', statusOf(noSegments, 'firstMp4'), 'ok');
    expectEq('absent shared chunk is not a failure', statusOf(noSegments, 'parser-shared'), 'not built');
    const noPanel = buildReport(build('no-panel', { rateProfile: 0 }));
    expectEq('absent rate profile panel is not a failure', statusOf(noPanel, 'rateProfile'), 'not built');
    expectEq('absent rate profile panel: no failures', noPanel.failures.length, 0);
    const noMkv = buildReport(build('no-matroska', { matroska: 0 }));
    expectEq('missing parser chunk is reported', statusOf(noMkv, 'matroska'), 'missing');
    expectEq('missing parser makes the first analysis missing', statusOf(noMkv, 'firstMkv'), 'missing');
    expectEq('missing parser fails', noMkv.failures.length, 2);
    expectEq('missing Matroska parser leaves the first VFR MP4 analysis ok', statusOf(noMkv, 'firstVfrMp4'), 'ok');
    expectEq('other parser unaffected', statusOf(noMkv, 'firstMp4'), 'ok');
    const clientDir = build('client', { client: 1_000 });
    for (const f of ['compare-X1.js', 'fallback-F1.js', 'inline-N1.js']) write(clientDir, `assets/${f}`, `import{a as e}from"./probe-L1.js";${filler(300)}`);
    write(clientDir, 'assets/probe-L1.js', `import{a as e}from"./index-M1.js";import{r as h}from"./result-H1.js";${filler(1_000)}`);
    write(clientDir, 'assets/result-H1.js', filler(400));
    write(clientDir, 'assets/builders-B1.js', filler(300));
    for (const f of ['compare-X1.js', 'fallback-F1.js']) write(clientDir, `assets/${f}`, `import{a as e}from"./probe-L1.js";import{b as g}from"./builders-B1.js";${filler(300)}`);
    const withClient = buildReport(clientDir);
    expectEq('client: kind', withClient.chunks.find((c) => c.file === 'assets/probe-L1.js')?.kind, 'client');
    for (const [f, kind] of [
      ['compare-X1.js', 'client-compare'],
      ['fallback-F1.js', 'client-fallback'],
      ['inline-N1.js', 'client-inline'],
    ]) {
      expectEq(`client: lazy part ${f}`, withClient.chunks.find((c) => c.file === `assets/${f}`)?.kind, kind);
    }
    expectEq('client: a chunk only the lazy client parts share', withClient.chunks.find((c) => c.file === 'assets/builders-B1.js')?.kind, 'client-shared');
    expectEq('client: the chunk the lazy client parts share is not in the first MP4 analysis', withClient.composites.firstMp4.files.includes('assets/builders-B1.js'), false);
    expectEq('client: a static dependency of the client is part of the first MP4 analysis', withClient.composites.firstMp4.files.includes('assets/result-H1.js'), true);
    expectEq('client: a static dependency of the client is part of the first Matroska analysis', withClient.composites.firstMatroska.files.includes('assets/result-H1.js'), true);
    expectEq('client: a static dependency of the client is not part of initial', withClient.composites.initial.files.includes('assets/result-H1.js'), false);
    expectEq('client: lazy parts are not in the first MP4 analysis', withClient.composites.firstMp4.files.some((f) => /(compare|fallback|inline)-/.test(f)), false);
    expectEq('client: budget ok', statusOf(withClient, 'client'), 'ok');
    expectEq('client: not part of initial', withClient.composites.initial.files.includes('assets/probe-L1.js'), false);
    expectEq('client: part of the first MP4 analysis', withClient.composites.firstMp4.files.includes('assets/probe-L1.js'), true);
    expectEq('client: part of the first Matroska analysis', withClient.composites.firstMatroska.files.includes('assets/probe-L1.js'), true);
    expectEq('client: no failures', withClient.failures.length, 0);
    expectEq('client absent is not a failure', statusOf(buildReport(build('no-client', {})), 'client'), 'not built');
    const poolDir = build('pool-client', {});
    write(poolDir, 'assets/pool-Q1.js', `import{a as e}from"./index-M1.js";${filler(500)}`);
    write(poolDir, 'assets/index-M1.js', mainText(`const q=()=>import("./pool-Q1.js");${filler(1_000)}`));
    expectEq('client: a pool chunk is a client chunk', buildReport(poolDir).chunks.find((c) => c.file === 'assets/pool-Q1.js')?.kind, 'client');
    const overClient = buildReport(build('client-over', { client: limit('client') + 1_000 }));
    expectEq('client over is a failure', statusOf(overClient, 'client'), 'over');
    const twoWorkers = buildReport(build('two-workers', {}, { extraWorker: true }));
    expectEq('extra worker: classified as a worker', twoWorkers.chunks.find((c) => c.file === 'assets/other.worker-O1.js')?.kind, 'worker');
    expectEq('extra worker: not summed into the worker budget', twoWorkers.budgets.find((b) => b.key === 'worker').files.join(','), 'assets/probe.worker-W1.js');
    expectEq('extra worker: fails as unbudgeted', twoWorkers.failures.includes('unbudgeted worker assets/other.worker-O1.js'), true);
    expectEq('extra worker: only that failure', twoWorkers.failures.length, 1);
    const serial = buildReport(build('serial-shared', { isobmffShared: 2_000, segmentsShared: 1_500 }, { parallel: false }));
    const chainsOf = (r, chunk) => r.chains.filter((c) => c.startsWith(`request chain: ${chunk} `));
    expectEq('serial: parser waiting for an unrequested shared chunk fails', chainsOf(serial, 'assets/isobmff-I1.js').length, 1);
    expectEq('serial: segments waiting for an unrequested shared chunk fails', chainsOf(serial, 'assets/segments-G1.js').length, 1);
    expectEq('serial: chain problems are failures', serial.failures.filter((f) => f.startsWith('request chain:')).length, 2);
    expectEq('serial: budgets unaffected', serial.budgets.every((b) => b.status !== 'over' && b.status !== 'missing'), true);
    expectEq('parallel: no chain problems when the worker requests the shared chunks', buildReport(build('parallel-shared', { isobmffShared: 2_000, segmentsShared: 1_500 })).chains.length, 0);
    expectEq('engines: the chunk the engines share may follow the engine', serial.chains.some((c) => c.includes('counting-C1.js')), false);
    const engineCore = join(root, 'engine-core');
    write(engineCore, 'assets/index-M1.js', mainText(filler(1_000)));
    write(engineCore, 'assets/probe.worker-W1.js', workerText(filler(1_000)));
    write(engineCore, 'assets/isobmff-I1.js', `import{a as e}from"./probe.worker-W1.js";import{b as f}from"./core-X1.js";${filler(1_000)}`);
    write(engineCore, 'assets/matroska-K1.js', `import{a as e}from"./probe.worker-W1.js";${filler(1_000)}`);
    write(engineCore, 'assets/mp4box-B1.js', `import{a as e}from"./core-X1.js";${filler(1_000)}`);
    write(engineCore, 'assets/mediabunny-D1.js', `import{a as e}from"./probe.worker-W1.js";${filler(1_000)}`);
    write(engineCore, 'assets/core-X1.js', filler(1_000));
    write(engineCore, 'index.html', html);
    const engineChain = buildReport(engineCore);
    expectEq('a chunk shared by a parser and an engine is parser-shared', engineChain.chunks.find((c) => c.file === 'assets/core-X1.js')?.kind, 'parser-shared');
    expectEq('engines: a chunk shared with a parser is a chain problem for the engine', chainsOf(engineChain, 'assets/mp4box-B1.js').length, 1);
    expectEq('engines: and for the parser', chainsOf(engineChain, 'assets/isobmff-I1.js').length, 1);
    const looseDir = build('loose-shared', { isobmffShared: 2_000 }, { parallel: false });
    write(looseDir, 'assets/probe.worker-W1.js', workerText(filler(5_000), {}, ['shared-P1.js']));
    expectEq('loose: a shared chunk the worker imports on its own does not count as parallel', chainsOf(buildReport(looseDir), 'assets/isobmff-I1.js').length, 1);
    const siblingDir = build('sibling-shared', { isobmffShared: 2_000 }, { parallel: false });
    write(siblingDir, 'assets/probe.worker-W1.js', workerText(filler(5_000), { 'matroska-K1.js': ['shared-P1.js'] }));
    const sibling = buildReport(siblingDir);
    expectEq('sibling: a shared chunk requested with another parser is a chain problem', chainsOf(sibling, 'assets/isobmff-I1.js').length, 1);
    expectEq('sibling: and none for the parser it is requested with', chainsOf(sibling, 'assets/matroska-K1.js').length, 0);
    const engineStats = (name, groups) => {
      const dir = build(name, { isobmffShared: 2_000 }, { parallel: false });
      write(dir, 'assets/probe.worker-W1.js', workerText(filler(5_000), groups));
      write(dir, 'assets/mp4box-B1.js', `import{a as e}from"./counting-C1.js";import{b as f}from"./shared-P1.js";${filler(40_000)}`);
      return buildReport(dir);
    };
    const engineWaits = engineStats('engine-waits', { 'isobmff-I1.js': ['shared-P1.js'] });
    expectEq('engines: a parser-shared chunk requested only with a parser is a chain problem for the engine', chainsOf(engineWaits, 'assets/mp4box-B1.js').length, 1);
    expectEq('engines: and none for that parser', chainsOf(engineWaits, 'assets/isobmff-I1.js').length, 0);
    const engineParallel = engineStats('engine-parallel', { 'isobmff-I1.js': ['shared-P1.js'], 'mp4box-B1.js': ['shared-P1.js'] });
    expectEq('engines: no chain problem when the engine is requested with that chunk', engineParallel.chains.length, 0);
    const companionDir = build('engine-companion', { isobmffShared: 2_000 }, { parallel: false });
    write(companionDir, 'assets/probe.worker-W1.js', workerText(`const s=e=>Promise.all([e(),import(\`./shared-P1.js\`)]);${filler(5_000)}`));
    write(companionDir, 'assets/mp4box-B1.js', `import{a as e}from"./counting-C1.js";import{b as f}from"./shared-P1.js";${filler(40_000)}`);
    const companion = buildReport(companionDir);
    expectEq('runtime: a chunk requested with every engine source call counts as requested with each engine chunk', chainsOf(companion, 'assets/mp4box-B1.js').length, 0);
    expectEq('runtime: but not with a parser chunk', chainsOf(companion, 'assets/isobmff-I1.js').length, 1);
    const twoImports = build('engine-two-imports', { isobmffShared: 2_000 }, { parallel: false });
    write(twoImports, 'assets/probe.worker-W1.js', workerText(`const s=()=>Promise.all([import(\`./deviceInfo-V1.js\`),import(\`./shared-P1.js\`)]);${filler(5_000)}`));
    write(twoImports, 'assets/mp4box-B1.js', `import{a as e}from"./counting-C1.js";import{b as f}from"./shared-P1.js";${filler(40_000)}`);
    expectEq('runtime: a group of two chunk imports without a source call is no companion', chainsOf(buildReport(twoImports), 'assets/mp4box-B1.js').length, 1);
    const inThreadDir = build('in-thread-own', { client: 1_500 });
    write(inThreadDir, 'assets/probe-L1.js', `import{a as e}from"./index-M1.js";const i=()=>import("./inline-N1.js");const o=()=>import("./runtime-R2.js");${filler(1_500)}`);
    write(inThreadDir, 'assets/inline-N1.js', `import{s as e}from"./sniff-N2.js";${filler(1_000)}`);
    write(inThreadDir, 'assets/runtime-R2.js', `import{s as e}from"./sniff-N2.js";const a=()=>Promise.all([import(\`./isobmff-I2.js\`),import(\`./stats-S2.js\`)]);const b=()=>Promise.all([import(\`./matroska-K2.js\`),import(\`./stats-S2.js\`)]);${filler(2_000)}`);
    write(inThreadDir, 'assets/isobmff-I2.js', `import{a as e}from"./runtime-R2.js";import{b as f}from"./stats-S2.js";const s=()=>import(\`./segments-G2.js\`);${filler(8_000)}`);
    write(inThreadDir, 'assets/matroska-K2.js', `import{a as e}from"./runtime-R2.js";import{b as f}from"./stats-S2.js";${filler(7_000)}`);
    write(inThreadDir, 'assets/segments-G2.js', `import{b as f}from"./stats-S2.js";${filler(1_000)}`);
    write(inThreadDir, 'assets/stats-S2.js', filler(3_000));
    write(inThreadDir, 'assets/sniff-N2.js', filler(800));
    const inThread = buildReport(inThreadDir);
    const inThreadKind = (f) => inThread.chunks.find((c) => c.file === f)?.kind;
    for (const f of ['runtime-R2', 'isobmff-I2', 'matroska-K2', 'segments-G2', 'stats-S2']) expectEq(`in-thread own: ${f} is a main-thread copy`, inThreadKind(`assets/${f}.js`), 'inline-own');
    expectEq('in-thread own: the chunk it shares with the in-thread runner is client-shared', inThreadKind('assets/sniff-N2.js'), 'client-shared');
    expectEq('in-thread own: the worker parsers keep their kinds', [inThreadKind('assets/isobmff-I1.js'), inThreadKind('assets/matroska-K1.js'), inThreadKind('assets/segments-G1.js')].join(','), 'isobmff,matroska,segments');
    expectEq('in-thread own: the parser budgets count only the worker parsers', ['isobmff', 'matroska', 'segments'].map((k) => inThread.budgets.find((b) => b.key === k).files.join(',')).join(';'), 'assets/isobmff-I1.js;assets/matroska-K1.js;assets/segments-G1.js');
    expectEq('in-thread own: no main-thread copy in the first analysis rows', [inThread.composites.firstMp4, inThread.composites.firstVfrMp4, inThread.composites.firstMatroska].some((c) => c.files.some((f) => /-(?:R2|I2|K2|G2|S2|N2)\.js$/.test(f))), false);
    expectEq('in-thread own: no failures', inThread.failures.join('; '), '');
    const deepDir = build('engine-deep', {});
    write(deepDir, 'assets/counting-C1.js', `import{a as e}from"./deep-E1.js";${filler(3_000)}`);
    write(deepDir, 'assets/deep-E1.js', filler(1_000));
    const deep = buildReport(deepDir);
    expectEq('engines: a chunk behind the engine-shared chunk is classified engine-shared', deep.chunks.find((c) => c.file === 'assets/deep-E1.js')?.kind, 'engine-shared');
    expectEq('engines: only one extra level, a chunk behind the engine-shared chunk is a chain problem', chainsOf(deep, 'assets/mp4box-B1.js').length, 1);
    expectEq('engines: for both engines', deep.chains.filter((c) => c.includes('waits for assets/deep-E1.js')).length, 2);
    const nestedBuild = (name, segmentsImports) => {
      const dir = build(name, { isobmffShared: 2_000 }, { parallel: false });
      write(dir, 'assets/probe.worker-W1.js', `self.onmessage=e=>{postMessage(1)};const a=()=>Promise.all([import(\`./isobmff-I1.js\`),import(\`./shared-P1.js\`)]);const b=()=>import(\`./matroska-K1.js\`);${filler(5_000)}`);
      write(dir, 'assets/shared-P1.js', `const s=()=>import(\`./segments-G1.js\`);${filler(2_000)}`);
      write(dir, 'assets/segments-G1.js', `${segmentsImports}${filler(1_000)}`);
      write(dir, 'assets/common-S1.js', filler(1_000));
      return buildReport(dir);
    };
    expectEq('nested: a chunk imported by a loaded shared chunk may use what is already loaded', nestedBuild('nested-ok', 'import{b as f}from"./shared-P1.js";').chains.length, 0);
    const nestedWaits = nestedBuild('nested-waits', 'import{b as f}from"./shared-P1.js";import{c as g}from"./common-S1.js";');
    expectEq('nested: and fails for a chunk nobody requests with it', nestedWaits.chains.join('; '), 'request chain: assets/segments-G1.js (segments) waits for assets/common-S1.js, which assets/shared-P1.js does not request in parallel');
    const noWorkerDir = join(root, 'noworker');
    write(noWorkerDir, 'assets/index-M1.js', `console.log(1);${filler(1000)}`);
    write(noWorkerDir, 'index.html', html);
    const noWorker = buildReport(noWorkerDir);
    expectEq('missing worker is reported', statusOf(noWorker, 'worker'), 'missing');
    expectEq('missing worker fails', noWorker.failures.length > 0, true);
    expectEq('rvfc absent is not a failure', statusOf(noWorker, 'rvfc'), 'not built');
    expectEq('segments absent is not a failure', statusOf(noWorker, 'segments'), 'not built');
    expectEq('first VFR MP4 analysis absent is not a failure', statusOf(noWorker, 'firstVfrMp4'), 'not built');
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
  const distDir = arg ? resolve(arg) : join(REPO_ROOT, 'demo', 'dist');
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
