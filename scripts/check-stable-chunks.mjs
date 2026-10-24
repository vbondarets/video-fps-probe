import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITE = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const CONFIG = 'demo/vite.config.ts';
const STAMPS = [
  { VITE_BUILD_TIME: '2001-02-03T04:05:06.000Z', VITE_COMMIT: '1111111111111111111111111111111111111111' },
  { VITE_BUILD_TIME: '2099-12-31T23:59:59.000Z', VITE_COMMIT: 'ffffffffffffffffffffffffffffffffffffffff' },
];
const STAMP_META = /<meta name="build-(?:time|commit)" content="[^"]*"\s*\/?>\s*/g;
const CHECKED = /\.(?:js|css)$/;

const USAGE = `Usage: node scripts/check-stable-chunks.mjs

Builds the demo twice into the OS temp directory, with different VITE_BUILD_TIME and VITE_COMMIT,
and exits 1 unless both builds emit the same file names with the same contents. Only the build
stamp meta tags of index.html may differ. A stamp that reaches a hashed chunk renames every chunk
that imports it, so a deploy without code changes would break the lazy loads of open tabs.
`;

const posix = (p) => p.split('\\').join('/');

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(posix(relative(base, full)));
  }
  return out.sort();
}

function build(outDir, stamp) {
  execFileSync(process.execPath, [VITE, 'build', '--config', CONFIG, '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...stamp },
    stdio: 'inherit',
  });
}

function compareBuilds(dirs, stamps = STAMPS) {
  const problems = [];
  const [a, b] = dirs.map((dir) => walk(dir));
  const missing = a.filter((f) => !b.includes(f));
  const extra = b.filter((f) => !a.includes(f));
  if (missing.length + extra.length > 0) {
    problems.push(`file names differ between the two build stamps: only in the first ${JSON.stringify(missing)}, only in the second ${JSON.stringify(extra)}`);
  }
  if (!a.some((f) => CHECKED.test(f))) problems.push(`no JS or CSS file in ${dirs[0]}`);
  for (const file of a.filter((f) => b.includes(f) && f !== 'index.html')) {
    if (!readFileSync(join(dirs[0], file)).equals(readFileSync(join(dirs[1], file)))) problems.push(`${file} has the same name but other contents`);
  }
  const html = dirs.map((dir) => (existsSync(join(dir, 'index.html')) ? readFileSync(join(dir, 'index.html'), 'utf8') : null));
  if (html.some((text) => text === null)) problems.push('index.html is missing');
  else {
    stamps.forEach((stamp, i) => {
      for (const value of Object.values(stamp)) if (!html[i].includes(`content="${value}"`)) problems.push(`index.html of build ${i + 1} lacks the build stamp ${value}`);
    });
    if (html[0].replace(STAMP_META, '') !== html[1].replace(STAMP_META, '')) problems.push('index.html differs beyond the build stamp meta tags');
  }
  return { files: a.length, problems };
}

function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'video-fps-probe-stable-'));
  try {
    const dirs = STAMPS.map((stamp, i) => {
      const dir = join(root, `build-${i + 1}`);
      build(dir, stamp);
      return dir;
    });
    const { files, problems } = compareBuilds(dirs);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL: ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${files} files: the same names and contents under two build stamps; index.html differs only in the stamp meta tags`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
