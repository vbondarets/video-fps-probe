import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDocs, compareReports, docVersionProblems, fixtureFileProblems, latestManifest, lockfileChanges, peerCheckIssues, peerWarnings, versions, zeroConfigManifestProblems, zeroConfigSourceProblems } from '../../scripts/bundlers.mjs';
import { CONFIG_NAME, FORBIDDEN_IN_ZERO_CONFIG, GROUPS, TARGETS, targetsOf } from '../bundlers/targets.mjs';

const FIXTURES = join(import.meta.dirname, '..', 'bundlers', 'fixtures');

const npmLock = (extra: Record<string, unknown> = {}, rootDeps: Record<string, string> | null = null) =>
  JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', ...(rootDeps ? { dependencies: rootDeps } : {}), devDependencies: { webpack: '5.112.2' } },
      'node_modules/webpack': { version: '5.112.2', dev: true },
      ...extra,
    },
  });

const PNPM_BEFORE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      vite:
        specifier: 8.3.5
        version: 8.3.5

packages:

  vite@8.3.5:
    resolution: {integrity: sha512-a}
`;

const PNPM_AFTER = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      video-fps-probe:
        specifier: file:video-fps-probe.tgz
        version: file:video-fps-probe.tgz
      vite:
        specifier: 8.3.5
        version: 8.3.5

packages:

  video-fps-probe@file:video-fps-probe.tgz:
    resolution: {integrity: sha512-b, tarball: file:video-fps-probe.tgz}
    version: 0.4.1

  vite@8.3.5:
    resolution: {integrity: sha512-a}
`;

describe('the lockfile check of bundlers setup', () => {
  it('accepts an npm lockfile that only gained the package and an empty dependencies object', () => {
    const after = npmLock({ 'node_modules/video-fps-probe': { version: '0.4.1', resolved: 'file:video-fps-probe.tgz' } }, { 'video-fps-probe': 'file:video-fps-probe.tgz' });
    expect(lockfileChanges('npm', npmLock(), after)).toEqual([]);
  });

  it('names an npm entry that adding the package moved', () => {
    const after = npmLock({ 'node_modules/webpack': { version: '5.112.3', dev: true }, 'node_modules/video-fps-probe': { version: '0.4.1' } });
    expect(lockfileChanges('npm', npmLock(), after)).toEqual(['node_modules/webpack']);
  });

  it('accepts a pnpm lockfile that only gained the package and names a moved entry', () => {
    expect(lockfileChanges('pnpm', PNPM_BEFORE, PNPM_AFTER)).toEqual([]);
    const moved = PNPM_AFTER.replace('sha512-a}', 'sha512-c}');
    expect(lockfileChanges('pnpm', PNPM_BEFORE, moved)).toEqual(["packages > vite@8.3.5 > resolution: {integrity: sha512-a}", "packages > vite@8.3.5 > resolution: {integrity: sha512-c}"]);
  });

  it('names a moved entry in the yarn root workspace, whose key starts with the package name', () => {
    const before = '"vite@npm:8.3.5":\n  version: 8.3.5\n\n"video-fps-probe-bundlers-yarn-pnp@workspace:.":\n  version: 0.0.0-use.local\n  dependencies:\n    vite: "npm:8.3.5"\n';
    const after = `${before.replace('  dependencies:\n', '  dependencies:\n    video-fps-probe: "file:./video-fps-probe.tgz"\n')}\n"video-fps-probe@file:./video-fps-probe.tgz::locator=video-fps-probe-bundlers-yarn-pnp%40workspace%3A.":\n  version: 0.4.1\n  checksum: 10c0/abc\n`;
    expect(lockfileChanges('yarn', before, after)).toEqual([]);
    expect(lockfileChanges('yarn', before, after.replace('vite: "npm:8.3.5"', 'vite: "npm:8.3.4"'))).toEqual(['"video-fps-probe-bundlers-yarn-pnp@workspace:." > dependencies > vite: "npm:8.3.5"', '"video-fps-probe-bundlers-yarn-pnp@workspace:." > dependencies > vite: "npm:8.3.4"']);
  });

  it('reads the text bun.lock with trailing commas', () => {
    const before = '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "dependencies": {\n        "vite": "8.3.5",\n      },\n    },\n  },\n  "packages": {\n    "vite": ["vite@8.3.5", "", {}, "sha512-a"],\n  }\n}\n';
    const after = before.replace('"vite": "8.3.5",', '"video-fps-probe": "./video-fps-probe.tgz",\n        "vite": "8.3.5",').replace('"packages": {', '"packages": {\n    "video-fps-probe": ["video-fps-probe@./video-fps-probe.tgz", {}, "sha512-b"],');
    expect(lockfileChanges('bun', before, after)).toEqual([]);
    expect(lockfileChanges('bun', before, after.replace('sha512-a', 'sha512-c'))).toEqual(['vite']);
  });
});

const PNPM_ADD = '✓ Lockfile passes supply-chain policies (verified 10s ago)\nPackages: +1\n[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.\n\ndependencies:\n+ video-fps-probe 0.4.0\n\nDone in 224ms using pnpm v12.16.1\n';
const pnpmPeers = (bad: Record<string, unknown>, missing: Record<string, unknown> = {}) => JSON.stringify({ '.': { bad, missing, conflicts: [], intersections: {} } }, null, 2);
const unmet = (parent: string, wantedRange: string, foundVersion: string) => [{ parents: [{ name: parent, version: '0.4.0' }], optional: true, wantedRange, foundVersion, resolvedFrom: [] }];
const YARN_EXPLAIN = [
  'p0bc138 → ✓ peer-yarn@workspace:. doesn\'t provide @types/mediabunny to video-fps-probe@file:./video-fps-probe.tgz#./video-fps-probe.tgz::hash=4c4ca4&locator=peer-yarn%40workspace%3A. [50740]',
  'p2155c6 → ✘ peer-yarn@workspace:. provides mediabunny@npm:1.61.0 to video-fps-probe@file:./video-fps-probe.tgz#./video-fps-probe.tgz::hash=4c4ca4&locator=peer-yarn%40workspace%3A. [50740]',
  'p9a1b2c → ✘ peer-yarn@workspace:. doesn\'t provide react to @vitejs/plugin-react@npm:5.0.0 [1a2b3]',
].join('\n');

describe('the peer warning scan', () => {
  it('keeps the Yarn peer codes that name the package, not the PnP notice, the YN0086 summary or the fixture workspace', () => {
    const output = [
      '➤ YN0092: │ ESM support for PnP uses the experimental loader API and is therefore experimental',
      '➤ YN0060: │ mp4box is listed by your project with version 2.3.0 (pc23d70), which doesn\'t satisfy what video-fps-probe requests (^2.4.1).',
      '➤ YN0086: │ Some peer dependencies are incorrectly met by your project; run yarn explain peer-requirements <hash> for details, where <hash> is the six-letter p-prefixed code.',
      '➤ YN0002: │ video-fps-probe-bundlers-yarn-pnp@workspace:. doesn\'t provide react (p4f4d37), requested by @vitejs/plugin-react.',
    ].join('\n');
    expect(peerWarnings('yarn', output)).toEqual(['➤ YN0060: │ mp4box is listed by your project with version 2.3.0 (pc23d70), which doesn\'t satisfy what video-fps-probe requests (^2.4.1).']);
  });

  it('leaves pnpm 12 to pnpm peers check, since its add prints only a summary line', () => {
    expect(peerWarnings('pnpm', PNPM_ADD)).toEqual([]);
  });

  it('reads the JSON of pnpm peers check: an unmet or missing peer of the package, not of another package', () => {
    expect(peerCheckIssues('pnpm', pnpmPeers({}), 0)).toEqual([]);
    const report = pnpmPeers({ mp4box: unmet('video-fps-probe', '^2.4.1', '2.3.0'), react: unmet('@vitejs/plugin-react', '^19.0.0', '18.3.1') }, { mediabunny: [{ parents: [{ name: 'video-fps-probe', version: '0.4.0' }], optional: false, wantedRange: '^1.62.0' }] });
    expect(peerCheckIssues('pnpm', report, 1)).toEqual(['unmet peer mp4box@^2.4.1 of video-fps-probe in .: found 2.3.0', 'missing peer mediabunny@^1.62.0 of video-fps-probe in .']);
    expect(() => peerCheckIssues('pnpm', 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL', 1)).toThrow('pnpm peers check --json exited with 1 and printed no JSON report');
  });

  it('reads yarn explain peer-requirements: a failed requirement of the package, and fails when the package is not listed', () => {
    expect(peerCheckIssues('yarn', YARN_EXPLAIN, 0)).toEqual([YARN_EXPLAIN.split('\n')[1]]);
    expect(peerCheckIssues('yarn', YARN_EXPLAIN.split('\n')[0]!, 0)).toEqual([]);
    expect(() => peerCheckIssues('yarn', YARN_EXPLAIN.split('\n')[2]!, 0)).toThrow('yarn explain peer-requirements exited with 0 and listed no peer requirement of video-fps-probe');
  });

  it('keeps the Bun peer warnings that name the package or one of its peers', () => {
    expect(peerWarnings('bun', 'warn: incorrect peer dependency "mp4box@2.4.1"\nwarn: incorrect peer dependency "typescript@6.0.3"\n')).toEqual(['warn: incorrect peer dependency "mp4box@2.4.1"']);
  });
});

describe('the report check', () => {
  const report = {
    targets: [
      { name: 'webpack', status: 'verified', build: { status: 'built' }, apps: [{ app: 'app', status: 'pass', workers: 2, split: true, firstMp4: { files: 3, gzip: 24_000 } }], server: null },
      { name: 'parcel', status: 'build fails', build: { status: 'failed' }, apps: [{ app: 'app', status: 'expected-failure', workers: null, split: null, firstMp4: null }], server: null },
    ],
  };

  it('passes an identical measurement and fails a first MP4 above 48 KB', () => {
    expect(compareReports(report, report)).toEqual([]);
    const planted = structuredClone(report);
    planted.targets[0]!.apps[0]!.firstMp4 = { files: 3, gzip: 50_000 };
    expect(compareReports(report, planted)).toEqual(['webpack app: the first MP4 loads 50,000 bytes of JavaScript, gzip, above the 48,000-byte limit']);
    planted.targets[0]!.apps[0]!.firstMp4 = { files: 3, gzip: 48_000 };
    expect(compareReports(report, planted)).toEqual([]);
    planted.targets[0]!.apps[0]!.firstMp4 = { files: 3, gzip: 48_001 };
    expect(compareReports(report, planted)).toEqual(['webpack app: the first MP4 loads 48,001 bytes of JavaScript, gzip, above the 48,000-byte limit']);
  });

  it('fails a changed status, worker count, split or target set', () => {
    const changed = structuredClone(report);
    changed.targets[1]!.status = 'verified';
    changed.targets[0]!.apps[0]!.workers = 3;
    changed.targets[0]!.apps[0]!.split = false;
    expect(compareReports(report, changed)).toEqual(['webpack app: workers changed from 2 to 3', 'webpack app: split changed from true to false', 'parcel: the status changed from build fails to verified']);
    expect(compareReports(report, { targets: report.targets.slice(0, 1) })[0]).toBe('the target set changed: committed webpack, parcel, measured webpack');
  });
});

describe('the latest manifest of the weekly canary', () => {
  it('covers every fixture folder, the deno one without a package.json included', () => {
    for (const target of TARGETS) {
      const { manifest, resolved } = latestManifest(join(FIXTURES, target.name), target, (name, kind) => `${kind}:${name}`);
      if (target.pm === 'deno') {
        expect(manifest, target.name).toBeNull();
        expect(resolved, target.name).toEqual({ deno: 'runtime:deno' });
        continue;
      }
      const deps = { ...(manifest!.dependencies as Record<string, string>), ...(manifest!.devDependencies as Record<string, string>) };
      for (const [name, version] of Object.entries(deps)) expect(version, `${target.name} ${name}`).toBe(`package:${name}`);
      expect(manifest!.packageManager, target.name).toBeUndefined();
      if (target.pm === 'bun') expect(resolved.bun, target.name).toBe('runtime:bun');
    }
  });
});

describe('the version check of docs/bundlers.md', () => {
  const v = versions();
  const pinned = `webpack ${v.packages.webpack}, Rspack ${v.packages['@rspack/core']}, Next.js ${v.packages.next}, Angular ${v.packages['@angular/build']}, SvelteKit ${v.packages['@sveltejs/kit']}, Nuxt ${v.packages.nuxt}, Parcel ${v.packages.parcel}, Bun ${v.runtimes.bun}, Deno ${v.runtimes.deno}, pnpm ${v.runtimes.pnpm}, Yarn ${v.runtimes.yarn} and Vite ${v.packages.vite}.`;

  it('passes the pins and a version named after since', () => {
    expect(docVersionProblems(`${pinned} It works since Vite 8.0.0.`, v)).toEqual([]);
    expect(checkDocs()).toEqual([]);
  });

  it('fails a stale tool version anywhere in the text and a pin the text never names', () => {
    expect(docVersionProblems(`${pinned} verified in CI: webpack 5.999.0. Parcel 2.99.0 fails.`, v)).toEqual([
      `docs/bundlers.md names webpack 5.999.0, the pin in tests/bundlers/versions.json is ${v.packages.webpack}`,
      `docs/bundlers.md names Parcel 2.99.0, the pin in tests/bundlers/versions.json is ${v.packages.parcel}`,
    ]);
    expect(docVersionProblems(pinned.replace(`Nuxt ${v.packages.nuxt}`, 'Nuxt'), v)).toEqual([`docs/bundlers.md does not name Nuxt ${v.packages.nuxt}, the pin in tests/bundlers/versions.json`]);
    expect(docVersionProblems(`${pinned} html-webpack-plugin 5.6.8.`, v)).toEqual([]);
    expect(docVersionProblems(`${pinned} Webpack 5.99.0 and \`npm i -D webpack@5.99.0\`. Next.js v16.3.0, then Next.js 16.4. Since Next.js 16.0.0 and Next.js ${v.packages.next}.`, v)).toEqual([
      `docs/bundlers.md names Webpack 5.99.0, the pin in tests/bundlers/versions.json is ${v.packages.webpack}`,
      `docs/bundlers.md names webpack@5.99.0, the pin in tests/bundlers/versions.json is ${v.packages.webpack}`,
      `docs/bundlers.md names Next.js v16.3.0, the pin in tests/bundlers/versions.json is ${v.packages.next}`,
      `docs/bundlers.md names Next.js 16.4, the pin in tests/bundlers/versions.json is ${v.packages.next}`,
    ]);
  });
});

describe('the target table', () => {
  it('has 14 groups, one CI leg each, and unique ports', () => {
    expect(GROUPS).toHaveLength(14);
    expect(new Set(TARGETS.map((t) => t.port)).size).toBe(TARGETS.length);
    expect(targetsOf('parcel').map((t) => t.name)).toEqual(['parcel', 'parcel-configured']);
    expect(() => targetsOf('esbuild')).toThrow('unknown bundler target or group esbuild');
  });

  it('pairs every zero-config failure with a configured fixture of the same group', () => {
    for (const t of TARGETS.filter((t) => t.fails)) expect(TARGETS.some((c) => c.group === t.group && c.snippets && !c.fails), t.name).toBe(true);
  });

  it('checks every file of a fixture, not only the listed configs', () => {
    const next = TARGETS.find((t) => t.name === 'next-webpack')!;
    const files = ['package.json', 'package-lock.json', ...next.sources!].map((path) => ({ path, text: "import { lazyProbe } from 'video-fps-probe/lazy';" }));
    expect(fixtureFileProblems(next, files)).toEqual([]);
    const planted = [...files, { path: 'next.config.mjs', text: "export default { webpack: (c) => { c.resolve.conditionNames = ['import']; return c; } };" }];
    expect(fixtureFileProblems(next, planted)).toEqual(['next-webpack: next.config.mjs is neither a config nor an app source of the target in tests/bundlers/targets.mjs']);
    const svelte = TARGETS.find((t) => t.name === 'sveltekit')!;
    const svelteFiles = ['package.json', 'vite.config.js', ...svelte.sources!].map((path) => ({ path, text: path === 'vite.config.js' ? "export default { optimizeDeps: { exclude: ['x'] } };" : '' }));
    expect(fixtureFileProblems(svelte, svelteFiles)).toEqual(['sveltekit: the zero-config file vite.config.js contains optimizeDeps']);
    expect(fixtureFileProblems({ ...next, sources: [...next.sources!, 'next.config.mjs'] }, planted)).toEqual(['next-webpack: next.config.mjs is listed as an app source, but tools read a file of that name as configuration', 'next-webpack: the zero-config source next.config.mjs contains conditionNames']);
    for (const name of ['svelte.config.js', '.parcelrc', 'bunfig.toml', 'tsconfig.app.json', 'jsconfig.json', '.env.production', 'app/next.config.ts']) expect(CONFIG_NAME.test(name), name).toBe(true);
    expect(CONFIG_NAME.test('app/page.js')).toBe(false);
  });

  it('scans every key of deno.json but imports, the sources and the shared files, and the package.json keys of a zero-config target', () => {
    const deno = TARGETS.find((t) => t.name === 'deno')!;
    const denoJson = (extra: Record<string, unknown>) => [{ path: 'deno.json', text: JSON.stringify({ imports: { 'video-fps-probe': 'npm:video-fps-probe', 'video-fps-probe/': 'npm:/video-fps-probe/' }, nodeModulesDir: 'auto', lock: false, ...extra }) }];
    expect(fixtureFileProblems(deno, denoJson({}))).toEqual([]);
    expect(fixtureFileProblems(deno, denoJson({ compilerOptions: { lib: ['deno.worker'] }, scopes: { './': { 'video-fps-probe/lazy': 'npm:video-fps-probe/standalone/own.worker.js' } } }))).toEqual(['deno: the zero-config file deno.json#-imports contains worker']);
    const next = TARGETS.find((t) => t.name === 'next-webpack')!;
    const page = (text: string) => ['package.json', ...next.sources!].map((path) => ({ path, text: path === 'app/page.js' ? text : '' }));
    expect(fixtureFileProblems(next, page("import { lazyProbe } from 'video-fps-probe/lazy';\nimport * as header from 'video-fps-probe/header';\nexport const metadata = { title: 'video-fps-probe bundler fixture' };"))).toEqual([]);
    expect(fixtureFileProblems(next, page("import { lazyProbe } from 'video-fps-probe/standalone/own.worker.js';"))).toEqual(['next-webpack: the zero-config source app/page.js names video-fps-probe/standalone/own.worker.js, which is not video-fps-probe, video-fps-probe/lazy or a server entry']);
    expect(fixtureFileProblems(next, page("new Worker(new URL('../node_modules/video-fps-probe/dist/x.js', import.meta.url));"))).toEqual(['next-webpack: the zero-config source app/page.js contains Worker']);
    const configured = TARGETS.find((t) => t.name === 'angular-configured')!;
    expect(fixtureFileProblems(configured, ['package.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json', ...configured.sources!].map((path) => ({ path, text: "import 'video-fps-probe/client/lazy';" })))).toEqual([]);
    const strict = TARGETS.find((t) => t.name === 'pnpm-strict')!;
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'pnpm-strict', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(zeroConfigManifestProblems(strict, manifest)).toEqual([]);
    expect(zeroConfigManifestProblems(strict, { ...manifest, pnpm: { nodeLinker: 'hoisted', publicHoistPattern: ['*'] } })).toEqual(['pnpm-strict: package.json of a zero-config target sets pnpm, only name, private, type, dependencies, devDependencies, packageManager are allowed']);
    expect(zeroConfigSourceProblems(strict, 'tests/bundlers/shared/server-run-core.mjs', readFileSync(join(FIXTURES, '..', 'shared', 'server-run-core.mjs'), 'utf8'))).toEqual([]);
  });

  it('flags the tokens a zero-config file may not contain', () => {
    for (const text of ['packageExports: true', "optimizeDeps: { exclude: ['x'] }", 'new Worker(url)', 'copy-webpack-plugin', "conditionNames: ['module']"]) expect(FORBIDDEN_IN_ZERO_CONFIG.test(text), text).toBe(true);
    expect(FORBIDDEN_IN_ZERO_CONFIG.test("plugins: [new HtmlWebpackPlugin({ template: './template.html' })]")).toBe(false);
  });
});
