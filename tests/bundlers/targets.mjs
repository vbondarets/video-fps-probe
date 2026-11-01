export const BUNDLERS_PORT = Number(process.env.BUNDLERS_PORT || 4600);
export const UPSTREAM_OFFSET = 100;
export const DEV_OFFSET = 200;
export const FIRST_MP4_LIMIT = 48_000;
export const SERVER_FILE = 'hdr10_hevc10.mp4';
export const PARSER_MARKERS = { isobmff: 'duplicate track_ID values', matroska: 'Segment has an unknown size' };
export const CLIENT_MARKER = 'the app may have been redeployed';
export const FORBIDDEN_IN_ZERO_CONFIG = /video-fps-probe|worker|mp4box|mediabunny|optimizeDeps|conditionNames|copy|standalone|packageExports/i;
export const CONFIG_NAME = /(?:^|\/)(?:[^/]*\.config\.[^/]+|\.[^/]*rc[^/]*|\.env[^/]*|browserslist|bunfig\.toml|angular\.json|[jt]sconfig[^/]*\.json|deno\.jsonc?|pnpm-workspace\.yaml|package\.json)$/i;

const OWN = ['own'];
const ALL = ['own', 'mp4box', 'mediabunny', 'rvfc'];
const PAGE = [{ name: 'app', path: '/', engines: OWN }];
const VITE_APPS = [
  { name: 'default', path: '/default/', engines: OWN },
  { name: 'all', path: '/all/', engines: ALL },
];
const WORKER_404 = {
  analyze: { code: 'worker-failed', reason: 'load' },
  missing: { isobmff: '/worker/own-isobmff.worker.js', matroska: '/worker/own-matroska.worker.js' },
};
const RUNNERS = [
  { loader: 'import', file: 'server-run.mjs' },
  { loader: 'require', file: 'server-run.cjs' },
];
const ESM = ['dist/index.js', 'dist/header/index.js', 'dist/url/index.js', 'dist/color/index.js', 'dist/aspect/index.js', 'dist/check/index.js', 'dist/presets/index.js'];
const CJS = ['dist/cjs/index.cjs', 'dist/cjs/header.cjs', 'dist/cjs/url.cjs', 'dist/cjs/color.cjs', 'dist/cjs/aspect.cjs', 'dist/cjs/check.cjs', 'dist/cjs/presets.cjs'];
const ONE_INSTANCE = { resolved: { import: ESM, require: ESM }, sharedWithImport: Array(7).fill(true) };
const CJS_COPY = { resolved: { import: ESM, require: CJS }, sharedWithImport: Array(7).fill(false) };

export const TARGETS = [
  {
    name: 'webpack',
    tool: 'webpack',
    pm: 'npm',
    shared: ['template.html', 'main.js'],
    configs: ['webpack.config.js'],
    build: [{ bin: 'webpack-cli', args: ['build'] }],
    out: 'dist',
    apps: PAGE,
    split: true,
    dev: { bin: 'webpack-cli', args: ['serve', '--mode', 'development', '--host', '127.0.0.1', '--port', '{port}'] },
  },
  {
    name: 'rspack',
    tool: '@rspack/core',
    pm: 'npm',
    shared: ['template.html', 'main.js'],
    configs: ['rspack.config.mjs'],
    build: [{ bin: '@rspack/cli', args: ['build'] }],
    out: 'dist',
    apps: PAGE,
    split: true,
    dev: { bin: '@rspack/cli', args: ['serve', '--mode', 'development', '--host', '127.0.0.1', '--port', '{port}'] },
  },
  {
    name: 'next-webpack',
    tool: 'next',
    pm: 'npm',
    shared: ['server-run-core.mjs'],
    configs: [],
    sources: ['app/layout.js', 'app/page.js', 'app/api/server-run/route.js'],
    build: [{ bin: 'next', args: ['build', '--webpack'] }],
    start: { bin: 'next', args: ['start', '-H', '127.0.0.1', '-p', '{port}'] },
    out: '.next/static',
    apps: PAGE,
    split: true,
    route: '/api/server-run',
    serverOut: '.next/server',
    serverLoads: 'bundled',
    dev: { bin: 'next', args: ['dev', '--webpack', '-H', '127.0.0.1', '-p', '{port}'] },
  },
  {
    name: 'next-turbopack',
    tool: 'next',
    pm: 'npm',
    shared: ['server-run-core.mjs'],
    configs: [],
    sources: ['app/layout.js', 'app/page.js', 'app/api/server-run/route.js'],
    build: [{ bin: 'next', args: ['build'] }],
    start: { bin: 'next', args: ['start', '-H', '127.0.0.1', '-p', '{port}'] },
    out: '.next/static',
    apps: PAGE,
    split: true,
    route: '/api/server-run',
    serverOut: '.next/server',
    serverLoads: 'bundled',
    dev: { bin: 'next', args: ['dev', '-H', '127.0.0.1', '-p', '{port}'] },
  },
  {
    name: 'angular',
    tool: '@angular/build',
    pm: 'npm',
    shared: [],
    configs: ['angular.json', 'tsconfig.json', 'tsconfig.app.json'],
    sources: ['src/app.ts', 'src/index.html', 'src/main.ts'],
    build: [{ bin: '@angular/cli', args: ['build'] }],
    out: 'dist/browser',
    apps: PAGE,
    split: true,
    fails: WORKER_404,
    dev: { bin: '@angular/cli', args: ['serve', '--host', '127.0.0.1', '--port', '{port}'] },
  },
  {
    name: 'angular-configured',
    group: 'angular',
    tool: '@angular/build',
    pm: 'npm',
    shared: [],
    configs: ['angular.json', 'tsconfig.json', 'tsconfig.app.json'],
    sources: ['src/app.ts', 'src/index.html', 'src/main.ts'],
    snippets: ['angular.json#projects.app.architect.build.options.assets', 'src/main.ts'],
    build: [{ bin: '@angular/cli', args: ['build'] }],
    out: 'dist/browser',
    apps: PAGE,
    split: true,
    dev: { bin: '@angular/cli', args: ['serve', '--host', '127.0.0.1', '--port', '{port}'] },
  },
  {
    name: 'sveltekit',
    tool: '@sveltejs/kit',
    pm: 'npm',
    shared: ['server-run-core.mjs'],
    configs: ['vite.config.js'],
    sources: ['src/app.html', 'src/routes/+page.svelte', 'src/routes/api/server-run/+server.js'],
    build: [{ bin: 'vite', args: ['build'] }],
    start: { node: ['build'], env: { PORT: '{port}', HOST: '127.0.0.1' } },
    out: 'build/client',
    apps: PAGE,
    split: true,
    route: '/api/server-run',
    serverOut: 'build/server',
    serverLoads: 'external',
    dev: { bin: 'vite', args: ['dev', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'] },
  },
  {
    name: 'nuxt',
    tool: 'nuxt',
    pm: 'npm',
    shared: ['server-run-core.mjs'],
    configs: ['nuxt.config.js'],
    sources: ['app/app.vue', 'server/api/server-run.get.js'],
    build: [{ bin: 'nuxt', args: ['build'] }],
    start: { node: ['.output/server/index.mjs'], env: { PORT: '{port}', HOST: '127.0.0.1' } },
    out: '.output/public',
    apps: PAGE,
    split: true,
    route: '/api/server-run',
    serverOut: '.output/server',
    serverLoads: 'external',
    dev: { bin: 'nuxt', args: ['dev', '--host', '127.0.0.1', '--port', '{port}'] },
  },
  {
    name: 'parcel',
    tool: 'parcel',
    pm: 'npm',
    shared: ['index.html', 'main.js'],
    configs: [],
    build: [{ bin: 'parcel', args: ['build', 'index.html', '--dist-dir', 'dist'] }],
    out: 'dist',
    apps: PAGE,
    split: true,
    fails: { build: ["Failed to resolve 'video-fps-probe/lazy' from './main.js'", "Cannot load file './lazy' from module 'video-fps-probe'"] },
  },
  {
    name: 'parcel-configured',
    group: 'parcel',
    tool: 'parcel',
    pm: 'npm',
    shared: ['index.html', 'main.js'],
    configs: [],
    snippets: ['package.json#@parcel/resolver-default,@parcel/bundler-default'],
    build: [{ bin: 'parcel', args: ['build', 'index.html', '--dist-dir', 'dist'] }],
    out: 'dist',
    apps: PAGE,
    split: true,
    dev: { bin: 'parcel', args: ['serve', 'index.html', '--host', '127.0.0.1', '--port', '{port}'] },
  },
  {
    name: 'bun-build',
    tool: 'bun',
    pm: 'bun',
    shared: ['index.html', 'main.js', 'server-run-core.mjs', 'server-run.mjs', 'server-run.cjs'],
    configs: [],
    build: [{ runtime: 'bun', args: ['build', './index.html', '--splitting', '--minify', '--outdir', 'dist'] }],
    out: 'dist',
    apps: PAGE,
    split: false,
    fails: WORKER_404,
    runners: RUNNERS,
    ...CJS_COPY,
  },
  {
    name: 'bun-build-configured',
    group: 'bun-build',
    tool: 'bun',
    pm: 'bun',
    shared: ['index.html', 'server-run-core.mjs', 'server-run.mjs', 'server-run.cjs'],
    configs: [],
    sources: ['main.js'],
    snippets: ['main.js'],
    build: [{ runtime: 'bun', args: ['build', './index.html', '--splitting', '--minify', '--outdir', 'dist'] }],
    out: 'dist',
    apps: PAGE,
    split: false,
    runners: RUNNERS,
    ...CJS_COPY,
  },
  {
    name: 'deno',
    tool: 'deno',
    pm: 'deno',
    shared: ['server-run-core.mjs', 'server-run.mjs', 'server-run.cjs'],
    configs: ['deno.json#-imports'],
    build: [],
    runners: RUNNERS,
    ...ONE_INSTANCE,
  },
  ...['pnpm-strict', 'pnpm-hoisted', 'yarn-pnp', 'bun-install'].map((name) => ({
    name,
    tool: name.split('-')[0],
    pm: name.split('-')[0],
    shared: ['server-run-core.mjs', 'server-run.mjs', 'server-run.cjs'],
    consumers: ['default', 'all'],
    configs: name === 'pnpm-hoisted' ? ['pnpm-workspace.yaml'] : name === 'yarn-pnp' ? ['.yarnrc.yml'] : [],
    build: VITE_APPS.map((app) => ({ bin: 'vite', args: ['build', '--emptyOutDir'], cwd: app.name })),
    out: '{app}/dist',
    apps: VITE_APPS,
    split: true,
    runners: RUNNERS,
    ...(name === 'yarn-pnp' ? CJS_COPY : ONE_INSTANCE),
    peerWarnings: true,
  })),
].map((target, index) => ({ group: target.name, ...target, port: BUNDLERS_PORT + 1 + index }));

export const GROUPS = [...new Set(TARGETS.map((t) => t.group))];

export function targetsOf(only) {
  if (!only) return TARGETS;
  const names = only.split(',').filter(Boolean);
  for (const name of names) if (!TARGETS.some((t) => t.name === name || t.group === name)) throw new Error(`unknown bundler target or group ${name}; known: ${GROUPS.join(', ')}`);
  return TARGETS.filter((t) => names.includes(t.name) || names.includes(t.group));
}

export const hasPage = (target) => Array.isArray(target.apps) && target.apps.length > 0;
export const appUrl = (target, app, dev = false) => `http://127.0.0.1:${target.port + (dev ? DEV_OFFSET : 0)}${app.path}`;
