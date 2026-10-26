import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSCONFIGS = ['tsconfig.app.json', 'tsconfig.test.json'];
const DIST_TARGET = /^\.\/dist\/(.+)\.js$/;

const skipped = (key) => key === './package.json' || key.startsWith('./standalone/') || key.endsWith('.json');

export function sourceMap(root = REPO_ROOT) {
  const { name, exports = {} } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const map = {};
  for (const [key, entry] of Object.entries(exports)) {
    if (skipped(key)) continue;
    const target = typeof entry === 'string' ? entry : entry?.default;
    const m = DIST_TARGET.exec(target ?? '');
    if (!m) throw new Error(`package.json export ${key} does not point at ./dist/*.js (got ${JSON.stringify(target)})`);
    map[key === '.' ? name : `${name}/${key.slice(2)}`] = `./src/${m[1]}.ts`;
  }
  return map;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function srcAliases(root = REPO_ROOT) {
  return Object.entries(sourceMap(root)).map(([specifier, file]) => ({ find: new RegExp(`^${escape(specifier)}$`), replacement: join(root, file) }));
}

async function check(root) {
  const { default: ts } = await import('typescript');
  const map = sourceMap(root);
  const problems = [];
  const { exports = {} } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const keys = Object.keys(exports).filter((k) => !skipped(k));
  if (keys.length !== Object.keys(map).length) problems.push(`${keys.length} package exports but ${Object.keys(map).length} aliases`);
  for (const [specifier, file] of Object.entries(map)) if (!existsSync(join(root, file))) problems.push(`${specifier}: ${file} does not exist`);
  const expected = JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [v]])));
  for (const config of TSCONFIGS) {
    const { config: json, error } = ts.readConfigFile(join(root, config), ts.sys.readFile);
    if (error) {
      problems.push(`${config}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
      continue;
    }
    const paths = json.compilerOptions?.paths ?? {};
    const actual = JSON.stringify(Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))));
    if (actual !== expected) problems.push(`${config}: compilerOptions.paths must be ${expected}`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } }, strict: true });
  if (values.check) {
    const problems = await check(REPO_ROOT);
    for (const p of problems) console.error(`FAIL: ${p}`);
    if (problems.length === 0) console.log(`aliases match the ${Object.keys(sourceMap()).length} package exports`);
    process.exitCode = problems.length > 0 ? 1 : 0;
  } else {
    for (const [specifier, file] of Object.entries(sourceMap())) console.log(`${specifier} -> ${file}`);
  }
}
