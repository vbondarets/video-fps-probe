# Demo

**[vbondarets.github.io/video-fps-probe](https://vbondarets.github.io/video-fps-probe/)**: drop your own files or press "Try sample files". Everything runs in the page; nothing is uploaded.

The demo is a React app that shows every value the package computes, compares the engines on the same file, and exports the results as JSON. It is not part of the npm package: the package's `files` list holds only `dist/` and the changelog, so the demo never changes what a host installs or ships.

<p>
  <img src="../docs/screenshots/app-light.png" width="280" alt="Results for eight files, light theme">
  <img src="../docs/screenshots/app-dark.png" width="280" alt="The same results, dark theme">
  <img src="../docs/screenshots/app-mobile.png" width="220" alt="A result card at 390 px with the Compare panel open: the table scrolls inside the card">
</p>
<p>
  <img src="../docs/screenshots/compare-vfr.png" width="546" alt="A VFR file with its rate profile (uneven badge, sparkline, summary) and the Compare panel: own parser, mp4box.js, mediabunny and requestVideoFrameCallback">
</p>

## What it shows

Each file gets a card with:

- **Average FPS**: presented frames over the presentation span, so it agrees with the Frames and Duration on the same card, next to the exact `avg_frame_rate` rational ffprobe would print when that can be reproduced. The two differ only when the stored durations do not tile the timeline (an edit list that trims a VFR file, a lost or overlapping fragment, a held first frame). The JSON export keeps every rate as an exact rational.
- **Nominal FPS**: the exact rate when every frame interval is equal, a standard rate (such as 30000/1001) when CFR timestamps jitter by a tick or by 1 ms, the declared Matroska rate, or the dominant rate of a VFR track with its share of frames. When the rate profile calls the track uneven, the cell says "varies" instead. ffprobe's `r_frame_rate` is shown next to it when it can be reproduced.
- **Minimum and maximum FPS** from the longest and shortest frame interval.
- **Frame timing**: CFR, CFR with 1 ms quantized timestamps (Matroska, and MP4 remuxed from Matroska), "no VFR in sample" after a Matroska probe, or VFR with the share of intervals that differ from the median (left out for an uneven track). A freeze or gap count badge appears next to it when the profile finds stalls in an otherwise steady track.
- A **rate profile** for timelines whose frame intervals are not all equal: steady and variable segments, rate changes, freezes, gaps and bursts, an `uneven` badge and a sparkline of the frame rate over time ([rate profile](../docs/benchmarks.md#rate-profile)).
- Frame count (presented frames, plus stored samples when an edit list hides some), duration, codec, dimensions, rotation and duplicate timestamps.
- Bytes read, number of reads and analysis time. For Matroska also the scan depth (header, probe or exact) and a "Scan all frames" button.
- A provenance mark on each value (header, exact, sampled, estimated, computed) and warnings in plain words.
- All video tracks of the file, primary track first.
- A **Compare engines** panel that runs the same file through mp4box.js and mediabunny and, on request, a playback estimate with `requestVideoFrameCallback`.

Many files can be dropped at once (two workers, cancel per file). The toolbar sets the Matroska scan mode and downloads or copies all results as JSON. The export carries the build (`app.build`, the hashed entry chunk of the page) and an `environment` block (browser, OS, CPU threads, screen, time zone) so results from different devices and deploys can be compared; the footer shows the same device line. Light and dark themes follow the system, and the layout works at phone width (360 px with the Compare panel open is an e2e check).

## Running it

From the repository root (Node 22.12 or newer, `npm ci` once):

```
npm run dev            # Vite dev server for demo/, with the library from src/
npm run build:demo     # tsc -b, then vite build to demo/dist/
npm run preview        # serve demo/dist/ with vite preview
npm run size           # chunk sizes and budgets of demo/dist/, writes report/size.*
npm run test:e2e       # build to .playwright/dist and run tests/e2e in Chromium, Firefox and WebKit
```

All of them use `demo/vite.config.ts`, whose root is this folder. `npm run size -- --check` exits 1 when a budget is exceeded; CI runs it. The budgets and their reasons are in [report/size.md](../report/size.md); they apply to the demo only.

## How it uses the package

The demo imports the library by package name, as a host app would:

- `ui/store.ts` holds `lazyProbeFrom(() => import('./probe.ts').then((m) => m.probe))` from `video-fps-probe/client/lazy`, so the page load carries only the stub.
- `ui/probe.ts` calls `createProbeClient` from `video-fps-probe/client` with a custom worker, `engines: [rvfc()]`, `workers: 2` (drag and drop of many files) and `idleTimeoutMs: 0`.
- `ui/probe.worker.ts` is that worker: `serveProbeWorker` from `video-fps-probe/worker-runtime` serving own, and mp4box and mediabunny through `import()` of `video-fps-probe/engines/*`. The build therefore has exactly one worker file.
- The other modules import only types from `video-fps-probe`.

`scripts/src-aliases.mjs` maps every package entry to its file in `src/`, derived from the `exports` map of `package.json`. `demo/vite.config.ts` uses the map as `resolve.alias`, `tsconfig.app.json` mirrors it as `paths`, and vitest uses it too; `npm run check:aliases` fails when they drift. So the demo always runs the library source of the same commit, through the same entry points a consumer uses. `demo/package.json` keeps the demo modules out of the root `sideEffects` list.

The same setup, installed from the packed tarball instead of the source, is measured and tested by the consumer fixtures in `tests/consumers/fixtures/` ([bundlers.md](../docs/bundlers.md)).

## Deploying to GitHub Pages

The demo is deployed from `main`; there is no separate demo branch. [pages.yml](../.github/workflows/pages.yml) runs `npm run build:demo` on every push to `main` (and on a manual run), with `VITE_BUILD_TIME` and `VITE_COMMIT` set so the JSON export names the build (they go into `index.html` as meta tags, not into the chunks, so a deploy without code changes keeps every chunk name), and deploys `demo/dist/` through the GitHub Pages actions. The `github-pages` environment allows deployments from `main` only. [ci.yml](../.github/workflows/ci.yml) runs the same demo build, its size budgets and the e2e suite in Chromium, Firefox and WebKit on every push to `main` and every pull request against it. To roll back, re-run an earlier Pages workflow run: it builds and deploys that run's commit again.

First-time setup (done once for this repository):

1. Create the public repository on GitHub and push `main`.
2. In the repository, open **Settings > Pages** and set **Source** to **GitHub Actions**. Without this the first deploy job fails, because `actions/configure-pages` does not switch Pages on by itself.
3. Wait for the **Pages** workflow to finish (the Actions tab), then open https://vbondarets.github.io/video-fps-probe/ and press "Try sample files".
4. Run the e2e suite against the live demo and keep the result:

   ```
   E2E_BASE_URL=https://vbondarets.github.io/video-fps-probe/ npx playwright test
   ```

5. Check the **CI** workflow run: its e2e job runs the suite in Chromium, Firefox and WebKit on Ubuntu.

## Testing on your devices

The [demo](https://vbondarets.github.io/video-fps-probe/) runs fully in the page, so any device with a browser can test it; nothing is uploaded.

1. Open the demo on macOS (Safari and Chrome), an iPhone (Safari) and an Android phone (Chrome). Press "Try sample files" once: six results without an error mean the page works on that device.
2. Pick these files, recorded fresh where possible:
   - an iPhone camera video (HEVC in MOV), also 60 fps and slow motion if available;
   - an iOS screen recording;
   - an Android camera video (MP4);
   - an Android or OBS screen recording (variable frame rate);
   - a WebM from a browser recorder (any MediaRecorder-based recorder, for example a web meeting or screen recorder);
   - a long video (10 minutes or more).
3. For each file check: a result and no error, a time in milliseconds, frames and average FPS that look right, and for screen recordings an `uneven` badge only where the rate really changes (open the rate profile under the card).
4. Press **Copy JSON** (or **Download JSON**) and send the text back. It carries the results plus an `environment` block (browser, OS, CPU threads, screen) and the Matroska scan mode, so the devices can be compared.
5. Compare with ffprobe on a Mac (`brew install ffmpeg`), on the same files:

   ```
   ffprobe -version | head -1
   ffprobe -v error -show_streams -show_format -count_frames -count_packets -show_optional_fields always -of json IMG_0001.MOV > IMG_0001.MOV.ffprobe.json
   ```

   This is the probe the fixture references use. Compare `avg_frame_rate` with the ffprobe string under Average FPS, `nb_frames` (MP4, MOV) or `nb_read_packets` (WebM, MKV) with Frames, and `r_frame_rate` with the `r` value under Nominal FPS. The references here are pinned to ffprobe 8.1.1; a newer ffprobe can differ on edge cases, so send its version line too.

On iPhone, Safari may hand the page a converted copy when a video is picked from Photos. If `size` in the JSON differs from the file on the Mac, pick the file through Files instead, or set the format to Current in the Photos picker options, and note which one you used ([report/average-user.md](../report/average-user.md)).
