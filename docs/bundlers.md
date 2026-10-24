# Bundlers

How the package ships its workers, what each bundler needs, and what is verified. [api.md](api.md) describes the options used here.

## How the workers are shipped

- The default flavor (`video-fps-probe`, `video-fps-probe/lazy`) and the `mp4box` and `mediabunny` descriptors each contain one worker reference in the standard form: `new Worker(new URL('../worker/own.worker.js', import.meta.url), { type: 'module' })`. Bundlers that understand this form copy the worker, build it, and split the parsers it loads with `import()` into lazy chunks.
- A bundler emits the worker for every such reference in the module graph, even code that never runs. That is why the client flavor (`video-fps-probe/client`, `video-fps-probe/client/lazy`) has no reference at all: a host that brings its own worker does not ship the unused prebuilt one.
- For bundlers that do not understand the form, `video-fps-probe/standalone/own.worker.js` is the own worker as one classic script with no imports.

## Status

| Bundler | Status | What to set |
|---|---|---|
| Vite 8 | **verified in CI**: `vite build` and `vite dev`, Chromium, Firefox and WebKit, installed from the packed tarball | `worker: { format: 'es' }` (recommended); `optimizeDeps.include` for registered peers in dev |
| Vite 5 to 7 | not verified; the 0.3.0 bundler matrix verifies Vite 6 | also `optimizeDeps: { exclude: ['video-fps-probe'] }` |
| webpack 5, Rspack | expected to work without configuration (they build `new Worker(new URL(...))` natively); not verified until the 0.3.0 matrix | nothing |
| Parcel 2 | expected to work without configuration (same form); not in the planned matrix, so it stays unverified | nothing |
| Next.js | webpack builds expected to work; Turbopack unverified until the 0.3.0 matrix (Next.js 16, both bundlers) | use the probe from `'use client'` modules |
| esbuild | leaves the worker reference as is, so the prebuilt worker is missing from the output | the standalone worker or a custom worker |
| Bun | not verified; treat it like esbuild | the standalone worker or a custom worker |

Verified means the consumer smoke test (`npm run test:consumers`): every fixture of `tests/consumers/fixtures/` gives the same results in the browser as Node `analyze` from the same tarball, under `vite build` and `vite dev`, and the dev page must not reload when an engine first runs.

## Vite 8

<!-- tables:vite:start -->

Measured with Vite 8.3.5 on production builds installed from the packed tarball (gzip -9, KB = 1000 bytes; the fixtures are in `tests/consumers/fixtures/`):

| Fixture | Imports | Vite worker option | Critical path | First MP4, lazy | All own paths, lazy | Worker files |
|---|---|---|---:|---:|---:|---|
| default | `video-fps-probe/lazy` | format: 'es' | **0.67 KB** | 23.60 KB | 39.71 KB | own.worker (5 lazy chunks) |
| zero-config | `video-fps-probe/lazy` | none, so Vite's default format: 'iife' | **0.67 KB** | 37.93 KB | 37.93 KB | own.worker (0 lazy chunks) |
| iife-nosplit | `video-fps-probe/lazy` | format: 'iife', rolldownOptions.output.codeSplitting: false | **0.67 KB** | 37.93 KB | 37.93 KB | own.worker (0 lazy chunks) |
| custom | `video-fps-probe/client/lazy` + `video-fps-probe/worker-runtime` | format: 'es' | **0.67 KB** | 23.49 KB | 39.60 KB | fps.worker (5 lazy chunks) |
| standalone-url | `video-fps-probe/client/lazy` + `video-fps-probe/standalone/own.worker.js?url` | none needed: the file is copied as an asset | **0.70 KB** | 37.75 KB | 37.75 KB | own.worker (0 lazy chunks) |

With format 'es' the own worker entry stays small and loads one parser per container; with 'iife' it is one file with both parsers. In Vite 8.3.5 the zero-config and iife-nosplit own workers are byte-identical: with format 'iife' Vite already inlines the worker's dynamic imports, so `codeSplitting: false` changes nothing for this package. Everything the default build emits outside the entry chunk is 79.18 KB, because it also holds the main-thread copies of the runtime and parsers ([SSR](#ssr-and-the-lazy-main-thread-chunks)). The full matrix, engines included, is in [benchmarks.md](benchmarks.md#package-size).

<!-- tables:vite:end -->

**Recommended: `worker.format: 'es'`.** Vite builds workers as `'iife'` by default, and an iife worker cannot split, so without the option the own worker is one file with both parsers. Module workers run on the whole browser floor of the package (Chrome and Edge 94, Firefox 114, Safari 15.4). The option applies to every worker of the host app.

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

The package itself needs no `optimizeDeps` entry in Vite 8: worker URLs inside pre-bundled dependencies work since Vite 8.0.0 (vitejs/vite#21434).

## Vite 5 to 7

Not verified yet; the 0.3.0 bundler matrix covers Vite 6. Their dev server pre-bundles dependencies without rewriting the worker URLs inside them, so exclude the package from pre-bundling:

```js
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['video-fps-probe'] },
});
```

## webpack 5, Rspack and Parcel

They build `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })` without configuration, including the worker's own `import()` chunks, so the default flavor and the engine descriptors should work as they are. None of them is verified yet. The 0.3.0 bundler matrix adds webpack 5 and Rspack to CI (with Vite 6, Next.js 16 on Turbopack and webpack, a pnpm install and a Yarn PnP install); Parcel is not in it. If a worker does not load, use the [custom worker](#custom-combined-worker) or the [standalone worker](#esbuild-and-bun).

## Next.js

- Create and call the probe in a `'use client'` module. Importing the package on the server is safe, but a probe used during server rendering has no `Worker` and runs inline in Node.
- With webpack (`next build --webpack`) the webpack 5 notes above apply.
- Turbopack, the default bundler of current Next.js, is not verified until the 0.3.0 matrix. If the worker does not load there, build with `--webpack`, or use the standalone worker through the client flavor.

## esbuild and Bun

esbuild does not bundle a worker from `new URL(..., import.meta.url)`, so the prebuilt worker would be missing from the output. Bun's bundler is not verified; the same setup avoids the question. Use the client flavor with a worker you provide.

**Standalone worker.** Copy `node_modules/video-fps-probe/dist/standalone/own.worker.js` into your output (a copy step or a static folder) and start it as a classic worker:

```ts
import { lazyProbeClient } from 'video-fps-probe/client/lazy';

export const probe = lazyProbeClient({
  worker: { create: () => new Worker('/assets/own.worker.js'), engines: ['own'] },
});
```

**Custom worker.** Or bundle a [custom worker](#custom-combined-worker) as a separate entry point (format `esm`, code splitting on) and point `create` at the emitted file with `{ type: 'module' }`. This is the way to add mp4box or mediabunny without the bundler's worker support.

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

- Only the classic standalone file works this way: a module worker cannot call `importScripts`, and the chunk imports of the prebuilt workers would resolve against the blob URL.
- `importScripts` fetches the file in no-cors mode, so the CDN needs no CORS headers. Only a cross-origin isolated page (`Cross-Origin-Embedder-Policy: require-corp`) needs the CDN to send `Cross-Origin-Resource-Policy: cross-origin`.
- Under a Content Security Policy, `worker-src` must allow `blob:` and `script-src` the CDN origin ([above](#content-security-policy)).
- This recipe is documented, not tested in CI.

## Deploy skew

Bundlers name the worker files and every lazy chunk by a content hash, and many hosts (GitHub Pages among them) replace the whole site on every deploy. A tab opened before a deploy keeps running the old page, which still asks for the old names. Those files are gone, so the first file analysed after the deploy fails to load the probe code:

- The probe client of a lazy stub, the worker script, a chunk the worker loads for an engine, or a main-thread chunk of the probe: `ProbeError('worker-failed')` with `reason: 'load'` ([Errors](api.md#errors)), and `tryAnalyze` resolves `null`. For a main-thread chunk the message is the browser's dynamic-import error, which is also the `cause`. A worker script that returns 404 has the message `worker script failed to load or parse; the app may have been redeployed`, followed by the browser's error when it gives one (a 404 page parsed as a classic worker is a `SyntaxError`).

A worker that started before the deploy keeps serving its jobs, but a parser or engine chunk it has not loaded yet is gone too: own reports that as `result.error` with the import error's message (the demo runs its deploy check on that message too), a library engine as `reason: 'load'`. With the blob trampoline of the [CDN recipe](#scripts-on-a-cdn-origin), a missing standalone file is an uncaught `NetworkError` inside the worker before its first reply, so it reports as `reason: 'load'` with the browser's `importScripts` message after the load message.

What helps, from the most to the least robust; they combine:

- **Keep the old assets for a while.** Upload the new hashed files next to the old ones and delete files older than a day or so, instead of replacing the directory. A stale tab then keeps loading the files it knows. Hosts that swap the whole site at once, such as GitHub Pages, cannot do this.
- **Reload on the error.** Treat `e.reason === 'load'` as a possible new deploy: fetch the page's HTML with `cache: 'no-store'`, compare its entry script with the running one, and offer a reload when they differ. The [demo](../demo/README.md#deploying-to-github-pages) does this and shows one banner instead of an error per file. Vite also dispatches `vite:preloadError` on `window` when a dynamic import of the host's own code fails.
- **Load early.** Call `prewarm()` when the upload dialog opens or on the first interaction, so the probe client, the worker and the MP4 parser load before the user picks files. This narrows the window, but a tab that stays open across a deploy without using the probe still loads everything afterwards.

## SSR and the lazy main-thread chunks

- Every entry except the standalone worker file imports in Node without side effects; `check-dist` imports each one in plain Node on every `npm pack` and in CI.
- Without a `Worker` global (SSR, Node) a probe runs its engines inline, in the calling thread. So both flavors also contain lazy chunks with the worker runtime and the parsers for that thread, and the root `analyze()` uses them too.
- A browser with a `Worker` global downloads those chunks only for `worker: 'inline'` or a root `analyze()` call. They are part of what a build emits (the Vite 8 note above), not of what a page loads.
