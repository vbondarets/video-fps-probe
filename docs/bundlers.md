# Bundlers

How the package ships its workers, what each bundler needs, and what is verified. [api.md](api.md) describes the options used here.

## How the workers are shipped

- The default flavor (`video-fps-probe`, `video-fps-probe/lazy`) contains two worker references in the standard form, one per container family of the own engine: `new Worker(new URL('../worker/own-isobmff.worker.js', import.meta.url), { type: 'module' })` and the same for `own-matroska.worker.js`. The `mp4box` and `mediabunny` descriptors each contain one. Bundlers that understand this form copy each worker, build it, and split what it loads with `import()` into lazy chunks.
- The default flavor reads the first 4 bytes of a file on the main thread to pick the own worker of its container family, so a first file loads only that worker. Each worker holds its parser and the statistics; the rate profile core and, for Matroska, the ffprobe frame rate estimate are lazy chunks.
- A bundler emits the worker for every such reference in the module graph, even code that never runs. That is why the client flavor (`video-fps-probe/client`, `video-fps-probe/client/lazy`) has no reference at all: a host that brings its own worker does not ship the unused prebuilt one.
- For bundlers that do not understand the form, `video-fps-probe/standalone/own.worker.js` is the own worker as one classic script with no imports, and `own-isobmff.worker.js` and `own-matroska.worker.js` are the two per-container workers as classic scripts, for `byContainer` ([api](api.md#standalone-worker)).

## Status

A row marked verified is built on every push in CI from the packed tarball, installed with the named package manager from a committed lockfile, and its smoke test passes in Chromium, Firefox and WebKit. The weekly canary installs the latest version of every tool without lockfiles and the published package from the registry, and runs the dev servers.

| Tool | Status | What to set |
|---|---|---|
| Vite 8 | **verified in CI**: Vite 8.3.5, `vite build` and `vite dev` with npm, and `vite build` with pnpm 12.16.1 (isolated and hoisted), Yarn 4.18.1 Plug'n'Play and Bun 1.4.4 installs | `worker: { format: 'es' }` (recommended), `optimizeDeps.include` for registered peers in dev |
| Vite 5 to 7 | not verified | also `optimizeDeps: { exclude: ['video-fps-probe'] }` |
| webpack 5 | **verified in CI**: webpack 5.112.2 with npm, `webpack serve` in the weekly canary | nothing |
| Rspack | **verified in CI**: Rspack 2.3.0 with npm, `rspack serve` in the weekly canary | nothing |
| Next.js | **verified in CI**: Next.js 16.4.3, `next build --webpack` and `next build` (Turbopack) served by `next start`, the server entries in a route handler, `next dev` in the weekly canary | create the probe in a `'use client'` module |
| Angular CLI | **verified with configuration**: Angular 22.2.5, application builder, `ng serve` in the weekly canary. Without it the prebuilt workers are missing from the output of `ng build` | the standalone workers as assets ([Angular](#angular)) |
| SvelteKit | **verified in CI**: SvelteKit 3.1.1 with adapter-node, the server entries in a `+server.js` route, `vite dev` in the weekly canary | nothing |
| Nuxt | **verified in CI**: Nuxt 4.6.3, `nuxt build` served by the Nitro node server, the server entries in `server/api`, `nuxt dev` in the weekly canary | nothing |
| Parcel 2 | **verified with configuration**: Parcel 2.16.4, `parcel serve` in the weekly canary. Without it the build does not resolve the subpath exports | two Parcel options in `package.json` ([Parcel](#parcel)) |
| Bun bundler | **verified with configuration**: Bun 1.4.4, `bun build ./index.html --splitting`. Without it the prebuilt workers are missing from the output | the standalone workers as file imports ([Bun](#esbuild-and-bun)) |
| Bun runtime | **verified in CI**: Bun 1.4.4, the server entries by `import` and `require()` | nothing |
| Deno | **verified in CI**: Deno 2.9.6, the server entries by `import` and `require()` from npm specifiers, with read and loopback network permissions only | nothing ([Deno](#deno)) |
| esbuild | leaves the worker reference as is, so the prebuilt worker is missing from the output | the standalone worker or a custom worker |

The Vite rows also run the consumer smoke test (`npm run test:consumers`): every fixture of `tests/consumers/fixtures/` gives the same results in the browser as Node `analyze` from the same tarball, under `vite build` and `vite dev`, and the dev page must not reload when an engine first runs.

The seven server entries, `video-fps-probe`, `video-fps-probe/header`, `video-fps-probe/url`, `video-fps-probe/color`, `video-fps-probe/aspect`, `video-fps-probe/check` and `video-fps-probe/presets`, also carry a CommonJS copy in `dist/cjs` under a `require` condition. Their `module-sync` and `module` conditions come before `require`, so a bundler that matches the `module` condition, as Vite, webpack, Rspack and esbuild do by default, resolves the ESM build for `import` and for `require()` alike. The size matrix fails a Vite build of any consumer fixture that holds a file of `dist/cjs`. The CommonJS copy is meant for Node and Jest: a configuration that matches `require` but neither `module` nor `module-sync`, such as custom condition names, gets it, and a browser build cannot run it, because it requires `url` and its root entry has no worker reference a bundler can follow. The `url-entry` fixture runs `analyzeHeader` over a `rangeSource`, and over `httpRange` with `openRangeSource` against a ranged URL, in the page, and gives the Node results under `vite build` and `vite dev`.

## Bundler matrix

`tests/bundlers` builds one small app per tool from `tests/bundlers/fixtures/`, with exact versions in `tests/bundlers/versions.json` and a lockfile per fixture (`node scripts/bundlers.mjs setup`, `build`, then `npx playwright test -c playwright.bundlers.config.ts`). In each browser the smoke test checks the engines of the probe, that no worker starts before the first analyze and that the first analyze loads a lazy chunk (informational for `bun build`), that four files give the own results of Node `analyze` from the same tarball, that an MP4 starts one own worker with the ISO BMFF parser only and a WebM one with the Matroska parser only, and that the page has no page error, no console warning or error and no failed same-origin request. The `all` page of the package manager rows also runs mp4box and mediabunny. A target that fails without configuration keeps a zero-config fixture that asserts its exact failure, so a tool release that fixes it fails CI and changes this page, and a configured fixture with the snippet of its section below passes every check.

<!-- tables:bundlers:start -->

Measured on production builds of the fixtures in `tests/bundlers/fixtures/`, installed from the packed tarball (gzip -9 of the JavaScript the server sent, KB = 1000 bytes, measured in Chromium, with the same checks in Firefox and WebKit). Framework runtimes dominate the totals, so the sizes are informational. A first MP4 above 48.00 KB fails CI, as does any change of a status, a worker count or the split.

| Target | Tool | Package manager | Configuration | Status | JS before the first analyze | First MP4, lazy | First WebM, lazy | Emitted JS | Workers | Split |
|---|---|---|---|---|---:|---:|---:|---:|---:|---|
| webpack | webpack 5.112.2 | npm | none | verified | 2.05 KB | 25.32 KB | 25.01 KB | 73.57 KB in 15 files | 2 | yes |
| rspack | Rspack 2.3.0 | npm | none | verified | 2.00 KB | 24.99 KB | 24.63 KB | 72.37 KB in 15 files | 2 | yes |
| next-webpack | Next.js 16.4.3, webpack | npm | none | verified | 134.21 KB | 25.08 KB | 25.17 KB | 357.88 KB in 35 files | 2 | yes |
| next-turbopack | Next.js 16.4.3, Turbopack | npm | none | verified | 135.69 KB | 29.13 KB | 28.22 KB | 276.96 KB in 33 files | 2 | yes |
| angular | Angular 22.2.5 | npm | none | fails without configuration: the prebuilt worker is not emitted (404) | n/a | n/a | n/a | 77.57 KB in 17 files | n/a | n/a |
| angular-configured | Angular 22.2.5 | npm | `angular.json`, `src/main.ts` | verified with configuration | 31.35 KB | 24.98 KB | 27.29 KB | 122.84 KB in 18 files | 2 | yes |
| sveltekit | SvelteKit 3.1.1 | npm | none | verified | 32.32 KB | 24.92 KB | 27.22 KB | 122.86 KB in 26 files | 2 | yes |
| nuxt | Nuxt 4.6.3 | npm | none | verified | 158.32 KB | 24.88 KB | 27.18 KB | 145.21 KB in 18 files | 2 | yes |
| parcel | Parcel 2.16.4 | npm | none | fails without configuration: the build does not resolve the package exports | n/a | n/a | n/a | n/a | n/a | n/a |
| parcel-configured | Parcel 2.16.4 | npm | `package.json` | verified with configuration | 0.98 KB | 25.69 KB | 25.58 KB | 120.38 KB in 16 files | 2 | yes |
| bun-build | Bun 1.4.4 | bun | none | fails without configuration: the prebuilt worker is not emitted (404) | n/a | n/a | n/a | 47.77 KB in 19 files | n/a | n/a |
| bun-build-configured | Bun 1.4.4 | bun | `main.js` | verified with configuration | 1.45 KB | 25.07 KB | 27.38 KB | 93.10 KB in 20 files | 2 | yes |
| deno | Deno 2.9.6 | deno | none | verified | n/a | n/a | n/a | n/a | n/a | n/a |
| pnpm-strict (default) | pnpm 12.16.1, Vite 8.3.5 | pnpm | none | verified | 1.39 KB | 23.13 KB | 22.16 KB | 91.77 KB in 18 files | 2 | yes |
| pnpm-strict (all) | pnpm 12.16.1, Vite 8.3.5 | pnpm | none | verified | 1.91 KB | 23.18 KB | 22.20 KB | 368.83 KB in 39 files | 2 | yes |
| pnpm-hoisted (default) | pnpm 12.16.1, Vite 8.3.5 | pnpm | none | verified | 1.39 KB | 23.13 KB | 22.16 KB | 91.77 KB in 18 files | 2 | yes |
| pnpm-hoisted (all) | pnpm 12.16.1, Vite 8.3.5 | pnpm | none | verified | 1.91 KB | 23.18 KB | 22.20 KB | 368.83 KB in 39 files | 2 | yes |
| yarn-pnp (default) | Yarn 4.18.1, Vite 8.3.5 | yarn | none | verified | 1.39 KB | 23.13 KB | 22.16 KB | 91.77 KB in 18 files | 2 | yes |
| yarn-pnp (all) | Yarn 4.18.1, Vite 8.3.5 | yarn | none | verified | 1.91 KB | 23.18 KB | 22.20 KB | 368.83 KB in 39 files | 2 | yes |
| bun-install (default) | Bun 1.4.4, Vite 8.3.5 | bun | none | verified | 1.39 KB | 23.13 KB | 22.16 KB | 91.77 KB in 18 files | 2 | yes |
| bun-install (all) | Bun 1.4.4, Vite 8.3.5 | bun | none | verified | 1.91 KB | 23.18 KB | 22.20 KB | 368.83 KB in 39 files | 2 | yes |

The seven server entries on one MP4, in the framework route or the runtime, against Node `import` from the same tarball:

| Target | Runs in | Resolves to | Result |
|---|---|---|---|
| next-webpack | the framework route on the production server | bundled into the server build | equal to Node |
| next-turbopack | the framework route on the production server | bundled into the server build | equal to Node |
| sveltekit | the framework route on the production server | imported from node_modules by the server build at run time | equal to Node |
| nuxt | the framework route on the production server | imported from node_modules by the server build at run time | equal to Node |
| bun-build | Bun, `bun run` | `import`: the ESM build, `require`: the CommonJS copy, a second instance | equal to Node |
| bun-build-configured | Bun, `bun run` | `import`: the ESM build, `require`: the CommonJS copy, a second instance | equal to Node |
| deno | Deno, npm specifiers | `import`: the ESM build, `require`: the ESM build, one instance | equal to Node |
| pnpm-strict | Node, `pnpm exec node` | `import`: the ESM build, `require`: the ESM build, one instance | equal to Node |
| pnpm-hoisted | Node, `pnpm exec node` | `import`: the ESM build, `require`: the ESM build, one instance | equal to Node |
| yarn-pnp | Node, `yarn node` (PnP) | `import`: the ESM build, `require`: the CommonJS copy, a second instance | equal to Node |
| bun-install | Node, on the bun install | `import`: the ESM build, `require`: the ESM build, one instance | equal to Node |

<!-- tables:bundlers:end -->

## Vite 8

<!-- tables:vite:start -->

Measured with Vite 8.3.5 on production builds installed from the packed tarball (gzip -9, KB = 1000 bytes, with the fixtures in `tests/consumers/fixtures/`):

| Fixture | Imports | Vite worker option | Critical path | First MP4, lazy | First MKV, lazy | All own paths, lazy | Worker files |
|---|---|---|---:|---:|---:|---:|---|
| default | `video-fps-probe/lazy` | format: 'es' | **0.67 KB** | 23.13 KB | 25.76 KB | 49.23 KB | own-isobmff.worker (1 lazy chunk), own-matroska.worker (2 lazy chunks) |
| zero-config | `video-fps-probe/lazy` | none, so Vite's default format: 'iife' | **0.66 KB** | 24.91 KB | 27.21 KB | 48.85 KB | own-isobmff.worker (0 lazy chunks), own-matroska.worker (0 lazy chunks) |
| iife-nosplit | `video-fps-probe/lazy` | format: 'iife', rolldownOptions.output.codeSplitting: false | **0.66 KB** | 24.91 KB | 27.21 KB | 48.85 KB | own-isobmff.worker (0 lazy chunks), own-matroska.worker (0 lazy chunks) |
| custom | `video-fps-probe/client/lazy` + `video-fps-probe/worker-runtime` | format: 'es' | **0.67 KB** | 24.01 KB | 26.91 KB | 41.35 KB | fps.worker (5 lazy chunks) |
| standalone-url | `video-fps-probe/client/lazy` + `video-fps-probe/standalone/own.worker.js?url` | none needed: the file is copied as an asset | **0.70 KB** | 39.42 KB | 39.42 KB | 39.42 KB | own.worker (0 lazy chunks) |
| standalone-split-url | `video-fps-probe/client/lazy` + `video-fps-probe/standalone/own-isobmff.worker.js?url` + `video-fps-probe/standalone/own-matroska.worker.js?url` | none needed: the files are copied as assets | **0.73 KB** | 24.93 KB | 27.25 KB | 48.83 KB | own-isobmff.worker (0 lazy chunks), own-matroska.worker (0 lazy chunks) |

The default flavor runs own on one worker per container family, picked by the first four bytes of the file. With format 'es' each worker holds its parser and the statistics, and keeps the rate profile core and, for Matroska, the ffprobe frame rate estimate as lazy chunks, while with 'iife' each is one file. A custom worker built from `video-fps-probe/worker-runtime` keeps the 0.2.0 layout: a small entry that loads one parser per container. In Vite 8.3.5 the zero-config and iife-nosplit own workers are byte-identical: with format 'iife' Vite already inlines the worker's dynamic imports, so `codeSplitting: false` changes nothing for this package. Everything the default build emits outside the entry chunk is 90.35 KB, because it also holds the main-thread copies of the runtime and parsers ([SSR](#ssr-and-the-lazy-main-thread-chunks)). The full matrix, engines included, is in [benchmarks.md](benchmarks.md#package-size).

<!-- tables:vite:end -->

**Recommended: `worker.format: 'es'`.** Vite builds workers as `'iife'` by default, and an iife worker cannot split, so without the option each own worker is one file that also inlines the rate profile core and, for Matroska, the ffprobe frame rate estimate. Module workers run on the whole browser floor of the package (Chrome and Edge 94, Firefox 114, Safari 15.4). The option applies to every worker of the host app.

```js
// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
});
```

**Keeping the default `'iife'`** works without any option (the zero-config row). Setting `worker.rolldownOptions.output.codeSplitting: false` as well (the iife-nosplit row) states the single-file worker explicitly; it reaches every worker build of the host, because Vite passes `worker.rolldownOptions.output` to them.

**Dev server with peers.** When you register `mp4box()` or `mediabunny()`, add the peer to `optimizeDeps.include`, so Vite pre-bundles it at startup instead of discovering it on the first engine run, re-optimizing and reloading the page. The mp4box and mediabunny consumer fixtures set it, and the smoke test asserts that their dev page does not reload:

```js
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { include: ['mp4box', 'mediabunny'] }, // only the peers you register
});
```

The package itself needs no `optimizeDeps` entry in Vite 8: worker URLs inside pre-bundled dependencies work since Vite 8.0.0 (vitejs/vite#21434). One exception: with `createProbeClient` imported statically and a host worker built from `video-fps-probe/worker-runtime`, Vite discovers `video-fps-probe/worker-runtime` when the worker first starts and reloads the page, so add it to `optimizeDeps.include`, as the custom-eager consumer fixture does. With `lazyProbeClient` (the custom fixture) the page does not reload.

## Vite 5 to 7

Not verified. Their dev server pre-bundles dependencies without rewriting the worker URLs inside them, so exclude the package from pre-bundling:

```js
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['video-fps-probe'] },
});
```

## webpack 5 and Rspack

Both build `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })` without configuration, including the worker's own `import()` chunks, so the default flavor and the engine descriptors work as they are. They emit each own worker as a classic worker that loads its chunks with `importScripts`, whatever `type` the reference names, which runs on every browser the package supports. The bundler matrix builds webpack 5.112.2 with html-webpack-plugin and Rspack 2.3.0 with its HTML plugin, with no option that names the package or a worker.

## Parcel

Parcel 2.16.4 fails without configuration. It reads the `exports` map of a package only with `packageExports` on, so `import { lazyProbe } from 'video-fps-probe/lazy'` stops the build with `Failed to resolve 'video-fps-probe/lazy'` and `Cannot load file './lazy' from module 'video-fps-probe'`. With `packageExports` alone the build succeeds, but Parcel moves the code the two own workers share into a bundle that each classic worker loads with `importScripts`, and that bundle runs a module before the bundle that registers it is loaded, so the first analyze rejects with `ProbeError('worker-failed')` and `Cannot find module`. `maxParallelRequests: 1` turns those shared bundles off. Both options go in the `package.json` of the app (the `parcel-configured` fixture):

<!-- snippet: parcel-configured/package.json#@parcel/resolver-default,@parcel/bundler-default -->

```json
{
  "@parcel/resolver-default": {
    "packageExports": true
  },
  "@parcel/bundler-default": {
    "maxParallelRequests": 1
  }
}
```

`maxParallelRequests` applies to every bundle of the app: Parcel then repeats shared code in each bundle that needs it instead of splitting it out.

## Next.js

- Create and call the probe in a `'use client'` module, in an effect: there is no `window` while a page renders on the server. Importing the package there is safe.
- Next.js 16.4.3 builds the prebuilt workers without configuration with both bundlers, `next build --webpack` and `next build`, which uses Turbopack.
- The server entries work in a route handler on the Node runtime, where Next.js bundles them into the server build. The `next-webpack` and `next-turbopack` fixtures run all seven in `app/api/server-run/route.js` and get the results of Node.

## Angular

The application builder of Angular 22.2.5 leaves `new URL('../worker/own-isobmff.worker.js', import.meta.url)` inside node_modules as it is, so the worker file is missing from the output: the first analyze asks for `/worker/own-isobmff.worker.js`, gets a 404 and rejects with `ProbeError('worker-failed')`, `reason: 'load'`. `ng serve` serves the workers without configuration, so only the build needs it. Copy the two [standalone workers](#esbuild-and-bun) into the output as assets, under `projects.<name>.architect.build.options` in `angular.json`:

<!-- snippet: angular-configured/angular.json#projects.app.architect.build.options.assets -->

```json
{
  "assets": [
    {
      "glob": "own-*.worker.js",
      "input": "node_modules/video-fps-probe/dist/standalone",
      "output": "/"
    }
  ]
}
```

and start them through the client flavor (the `angular-configured` fixture):

<!-- snippet: angular-configured/src/main.ts -->

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import { App } from './app';

declare global {
  interface Window {
    __probe?: unknown;
  }
}

bootstrapApplication(App).then(() => {
  window.__probe = lazyProbeClient({
    worker: {
      create: () => new Worker('/own-isobmff.worker.js'),
      engines: ['own'],
      byContainer: { matroska: () => new Worker('/own-matroska.worker.js') },
    },
  });
});
```

## SvelteKit

SvelteKit 3.1.1 with adapter-node builds the prebuilt workers without configuration. Create the probe in `onMount`. The server entries work in a `+server.js` route: the server build leaves the package to Node, which imports it from node_modules at run time. `vite dev` is Vite 8, so the [Vite 8](#vite-8) notes apply to it.

## Nuxt

Nuxt 4.6.3 builds the prebuilt workers without configuration. Create the probe in `onMounted`. The server entries work in `server/api`: Nitro copies the files of the package that the server imports into `.output/server/node_modules` and imports them at run time.

## esbuild and Bun

esbuild does not bundle a worker from `new URL(..., import.meta.url)`, and neither does `bun build` of Bun 1.4.4: both leave the reference as it is, so the prebuilt worker is missing from the output and the first analyze rejects with `ProbeError('worker-failed')`, `reason: 'load'`. Use the client flavor with a worker you provide.

**Standalone worker.** Copy `node_modules/video-fps-probe/dist/standalone/own.worker.js` into your output (a copy step or a static folder) and start it as a classic worker:

```ts
import { lazyProbeClient } from 'video-fps-probe/client/lazy';

export const probe = lazyProbeClient({
  worker: { create: () => new Worker('/assets/own.worker.js'), engines: ['own'] },
});
```

**Two standalone workers.** To load only the worker of the file's container family, as the default flavor does, copy `own-isobmff.worker.js` and `own-matroska.worker.js` from the same folder instead and register the Matroska one with `byContainer`:

```ts
export const probe = lazyProbeClient({
  worker: {
    create: () => new Worker('/assets/own-isobmff.worker.js'),
    engines: ['own'],
    byContainer: { matroska: () => new Worker('/assets/own-matroska.worker.js') },
  },
});
```

**With `bun build`**, a file import copies the two standalone files into the output and gives their URLs, so no copy step is needed (the `bun-build-configured` fixture):

<!-- snippet: bun-build-configured/main.js -->

```js
import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import isobmffWorkerUrl from 'video-fps-probe/standalone/own-isobmff.worker.js' with { type: 'file' };
import matroskaWorkerUrl from 'video-fps-probe/standalone/own-matroska.worker.js' with { type: 'file' };

window.__probe = lazyProbeClient({
  worker: {
    create: () => new Worker(isobmffWorkerUrl),
    engines: ['own'],
    byContainer: { matroska: () => new Worker(matroskaWorkerUrl) },
  },
});
```

**Custom worker.** Or bundle a [custom worker](#custom-combined-worker) as a separate entry point (format `esm`, code splitting on) and point `create` at the emitted file with `{ type: 'module' }`. This is the way to add mp4box or mediabunny without the bundler's worker support.

**Bun runtime.** The server entries run in Bun 1.4.4 without configuration. `import` takes the ESM build. `require()` takes the CommonJS copy, because it skips `module-sync` and `module`, so a process that does both holds two instances ([CommonJS](api.md#commonjs)).

## Deno

Deno 2.9.6 runs the server entries from npm specifiers without configuration. The `deno` fixture maps them in `deno.json`, `"video-fps-probe": "npm:video-fps-probe"` and `"video-fps-probe/": "npm:/video-fps-probe/"`, sets `"nodeModulesDir": "auto"` so that `require()` finds the package, and runs with `--allow-read` for its folder and the media files and `--allow-net=127.0.0.1` only, so the package needs no environment, system or wider network permission. `import` and `require()` both take the ESM build, one instance. CI serves the packed tarball from a local registry through `NPM_CONFIG_REGISTRY`, with a fresh `DENO_DIR` per run, because Deno caches npm packages by version.

## Package managers

The package has no dependencies and its peers are optional, so every package manager installs it as it is. CI builds the `default` and `all` consumer fixtures with Vite 8.3.5 under:

- pnpm 12.16.1 with its default isolated node_modules, where the workers of `all` reach mp4box and mediabunny through the peers the app installs, and with `nodeLinker: hoisted`,
- Yarn 4.18.1 with Plug'n'Play: Vite reads the worker files from the zip cache, and no package needs `unplugged`,
- Bun 1.4.4, `bun install`.

Each install adds the tarball with the package manager's own add command, and CI fails when that changes a lockfile entry of another package or prints a peer warning for this one. Node runs the server entries through `pnpm exec node`, through `yarn node` and on the bun install. Under Yarn Plug'n'Play, `require()` takes the CommonJS copy, because its resolver skips `module-sync` and `module`.

## Custom combined worker

One worker that serves several engines, built by your bundler from your source, so the build has exactly one worker file. The demo uses this setup.

```ts
// src/fps.worker.ts
import { ownEngine, serveProbeWorker } from 'video-fps-probe/worker-runtime';

serveProbeWorker({
  own: ownEngine,
  mp4box: () => import('video-fps-probe/engines/mp4box'), // optional; needs the mp4box peer
});
```

```ts
// src/probe.ts
import { lazyProbeClient } from 'video-fps-probe/client/lazy';

export const probe = lazyProbeClient({
  worker: {
    create: () => new Worker(new URL('./fps.worker.ts', import.meta.url), { type: 'module' }),
    engines: ['own', 'mp4box'],
  },
});
```

- List in `worker.engines` only what `serveProbeWorker` serves: a listed engine the worker does not serve rejects with `ProbeError('unknown-engine')`.
- The engine modules load with `import()` on their first job, so an engine you list costs nothing until it runs.
- `rvfc()` can still be passed as a descriptor (`engines: [rvfc()]`): it runs on the main thread.
- The custom fixture of the size matrix is this setup with own only (the custom row above).

## Content Security Policy

- The prebuilt and custom workers are same-origin script files. A policy must allow them with `worker-src 'self'`, or through the directives `worker-src` falls back to (`child-src`, `script-src`, `default-src`) when it is absent.
- The parser and engine chunks are same-origin scripts too, loaded with `import()`.
- The package uses no `eval`, no `new Function` and no WebAssembly.
- The blob trampoline below additionally needs `worker-src blob:`, and `script-src` (or `script-src-elem`) must allow the CDN origin: the blob worker inherits the page's policy, and its `importScripts` call is checked against it.

## Scripts on a CDN origin

A worker must be same-origin with the page: `new Worker('https://cdn.example.com/...')` throws a `SecurityError`. When your bundles are served from another origin, either serve the worker files from the page origin, or start the standalone classic worker through a same-origin blob:

```ts
import { lazyProbeClient } from 'video-fps-probe/client/lazy';
import ownWorkerUrl from 'video-fps-probe/standalone/own.worker.js?url';

const viaBlob = (): Worker => {
  const src = new URL(ownWorkerUrl, location.href).href;
  return new Worker(URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(src)});`], { type: 'text/javascript' })));
};

export const probe = lazyProbeClient({ worker: { create: viaBlob, engines: ['own'] } });
```

- Only the classic standalone files work this way: a module worker cannot call `importScripts`, and the chunk imports of the prebuilt workers would resolve against the blob URL.
- The two per-container files work the same way: build one trampoline per file and pass the Matroska one as `byContainer: { matroska: () => viaBlob(matroskaWorkerUrl) }`, with `viaBlob` taking the URL.
- `importScripts` fetches the file in no-cors mode, so the CDN needs no CORS headers. Only a cross-origin isolated page (`Cross-Origin-Embedder-Policy: require-corp`) needs the CDN to send `Cross-Origin-Resource-Policy: cross-origin`.
- Under a Content Security Policy, `worker-src` must allow `blob:` and `script-src` the CDN origin ([above](#content-security-policy)).
- This recipe is documented, not tested in CI.

## Deploy skew

Bundlers name the worker files and every lazy chunk by a content hash, and many hosts (GitHub Pages among them) replace the whole site on every deploy. A tab opened before a deploy keeps running the old page, which still asks for the old names. Those files are gone, so the first file analysed after the deploy fails to load the probe code:

- The probe client of a lazy stub, the worker script, a chunk the worker loads for an engine, or a main-thread chunk of the probe: `ProbeError('worker-failed')` with `reason: 'load'` ([Errors](api.md#errors)), and `tryAnalyze` resolves `null`. For a main-thread chunk the message is the browser's dynamic-import error, which is also the `cause`. A worker script that returns 404 has the message `worker script failed to load or parse; the app may have been redeployed`, followed by the browser's error when it gives one (a 404 page parsed as a classic worker is a `SyntaxError`).

The own workers of the default flavor hold their parsers, so a missing own worker file is a `reason: 'load'` for the jobs of its container family only: after a deploy, MKV jobs can fail while MP4 jobs, whose worker already runs, keep working, and the next call retries. A worker that started before the deploy keeps serving its jobs, but a chunk it has not loaded yet is gone too: in a custom worker that serves own, a missing parser chunk comes back as `result.error` with the import error's message (the demo runs its deploy check on that message too), a library engine as `reason: 'load'`. With the blob trampoline of the [CDN recipe](#scripts-on-a-cdn-origin), a missing standalone file is an uncaught `NetworkError` inside the worker before its first reply, so it reports as `reason: 'load'` with the browser's `importScripts` message after the load message.

What helps, from the most to the least robust; they combine:

- **Keep the old assets for a while.** Upload the new hashed files next to the old ones and delete files older than a day or so, instead of replacing the directory. A stale tab then keeps loading the files it knows. Hosts that swap the whole site at once, such as GitHub Pages, cannot do this.
- **Reload on the error.** Treat `e.reason === 'load'` as a possible new deploy: fetch the page's HTML with `cache: 'no-store'`, compare its entry script with the running one, and offer a reload when they differ. The [demo](../demo/README.md#deploying-to-github-pages) does this and shows one banner instead of an error per file. Vite also dispatches `vite:preloadError` on `window` when a dynamic import of the host's own code fails.
- **Load early.** Call `prewarm()` when the upload dialog opens or on the first interaction, so the probe client and the ISO BMFF worker of own load before the user picks files (`containers: ['isobmff', 'matroska']` starts both own workers). This narrows the window, but a tab that stays open across a deploy without using the probe still loads everything afterwards.

## SSR and the lazy main-thread chunks

- Every entry except the standalone worker files imports in Node without side effects; `check-dist` imports each one in plain Node on every `npm pack` and in CI.
- Without a `Worker` global (SSR, Node) a probe runs its engines inline, in the calling thread. So both flavors also contain lazy chunks with the worker runtime and the parsers for that thread, and the root `analyze()` uses them too.
- A browser with a `Worker` global downloads those chunks only for `worker: 'inline'` or a root `analyze()` call. They are part of what a build emits (the Vite 8 note above), not of what a page loads.
