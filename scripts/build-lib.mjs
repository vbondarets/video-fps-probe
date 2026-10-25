import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationClosure } from './check-dist.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO_ROOT, 'dist');
const STANDALONE_ENTRY = join(REPO_ROOT, 'src', 'worker', 'own.worker.ts');
const STANDALONE_FILE = join(DIST, 'standalone', 'own.worker.js');

const WORKER_URL = /(new\s+URL\(\s*)(['"])([^'"]+\.worker)\.ts\2/g;
const DTS_SPECIFIER = /(['"])(\.{1,2}\/[^'"]+)\.ts\1/g;

const posix = (p) => p.split('\\').join('/');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rewrite(files, pattern, replacement) {
  let changed = 0;
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(pattern, replacement);
    if (after === before) continue;
    writeFileSync(file, after);
    changed++;
  }
  return changed;
}

async function buildStandalone() {
  const { build } = await import('rolldown');
  await build({
    input: STANDALONE_ENTRY,
    platform: 'browser',
    tsconfig: join(REPO_ROOT, 'tsconfig.lib.json'),
    transform: { target: 'es2022' },
    logLevel: 'warn',
    output: { file: STANDALONE_FILE, format: 'iife', codeSplitting: false, minify: true, comments: false },
  });
}

async function main() {
  rmSync(DIST, { recursive: true, force: true });
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(REPO_ROOT, 'tsconfig.lib.json')], { cwd: REPO_ROOT, stdio: 'inherit' });
  const files = walk(DIST);
  const js = files.filter((f) => f.endsWith('.js'));
  const dts = files.filter((f) => f.endsWith('.d.ts'));
  const urls = rewrite(js, WORKER_URL, '$1$2$3.js$2');
  const specifiers = rewrite(dts, DTS_SPECIFIER, '$1$2.js$1');
  const reached = declarationClosure(DIST, JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')));
  const unreached = dts.filter((f) => !reached.has(posix(relative(DIST, f))));
  for (const f of unreached) rmSync(f);
  await buildStandalone();
  console.log(`built ${posix(relative(REPO_ROOT, DIST))}: ${js.length} js, ${dts.length - unreached.length} d.ts, worker URLs rewritten in ${urls} files, d.ts specifiers in ${specifiers} files, ${unreached.length} d.ts no exported entry's types reach left out, ${posix(relative(REPO_ROOT, STANDALONE_FILE))}`);
}

await main();
