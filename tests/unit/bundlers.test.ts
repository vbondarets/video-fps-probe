import { describe, expect, it } from 'vitest';
import { compareReports, fixtureFileProblems, lockfileChanges, peerWarnings } from '../../scripts/bundlers.mjs';
import { CONFIG_NAME, FORBIDDEN_IN_ZERO_CONFIG, GROUPS, TARGETS, targetsOf } from '../bundlers/targets.mjs';

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

  it('reads the text bun.lock with trailing commas', () => {
    const before = '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "dependencies": {\n        "vite": "8.3.5",\n      },\n    },\n  },\n  "packages": {\n    "vite": ["vite@8.3.5", "", {}, "sha512-a"],\n  }\n}\n';
    const after = before.replace('"vite": "8.3.5",', '"video-fps-probe": "./video-fps-probe.tgz",\n        "vite": "8.3.5",').replace('"packages": {', '"packages": {\n    "video-fps-probe": ["video-fps-probe@./video-fps-probe.tgz", {}, "sha512-b"],');
    expect(lockfileChanges('bun', before, after)).toEqual([]);
    expect(lockfileChanges('bun', before, after.replace('sha512-a', 'sha512-c'))).toEqual(['vite']);
  });
});

describe('the peer warning scan', () => {
  it('finds the Yarn peer codes and ignores the PnP loader notice', () => {
    expect(peerWarnings('yarn', '➤ YN0092: │ ESM support for PnP uses the experimental loader API\n➤ YN0002: │ app does not provide mp4box (p1), requested by video-fps-probe')).toEqual(['➤ YN0002: │ app does not provide mp4box (p1), requested by video-fps-probe']);
  });

  it('finds a pnpm missing peer and ignores unrelated output', () => {
    expect(peerWarnings('pnpm', ' WARN  Issues with peer dependencies found\n└─┬ video-fps-probe 0.4.1\n  └── ✕ missing peer mp4box@^2.4.1\nDone in 1s')).toEqual(["  └── ✕ missing peer mp4box@^2.4.1"]);
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
    expect(compareReports(report, planted)).toEqual(['webpack app: the first MP4 loads 50.00 KB of JavaScript, above the 48.00 KB limit']);
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
    expect(fixtureFileProblems({ ...next, sources: [...next.sources!, 'next.config.mjs'] }, planted)).toEqual(['next-webpack: next.config.mjs is listed as an app source, but tools read a file of that name as configuration']);
    for (const name of ['svelte.config.js', '.parcelrc', 'bunfig.toml', 'tsconfig.app.json', 'jsconfig.json', '.env.production', 'app/next.config.ts']) expect(CONFIG_NAME.test(name), name).toBe(true);
    expect(CONFIG_NAME.test('app/page.js')).toBe(false);
  });

  it('flags the tokens a zero-config file may not contain', () => {
    for (const text of ['packageExports: true', "optimizeDeps: { exclude: ['x'] }", 'new Worker(url)', 'copy-webpack-plugin', "conditionNames: ['module']"]) expect(FORBIDDEN_IN_ZERO_CONFIG.test(text), text).toBe(true);
    expect(FORBIDDEN_IN_ZERO_CONFIG.test("plugins: [new HtmlWebpackPlugin({ template: './template.html' })]")).toBe(false);
  });
});
