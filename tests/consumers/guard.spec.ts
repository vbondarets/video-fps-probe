import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { NoiseCollector, NoiseGuard, runGuarded, test as guarded, watch, type BrowserName, type Noise, type NoiseKind } from '../helpers/clean-console.ts';

const PAGE = '/__guard/index.html';
const WORKER = '/__guard/worker.js';
const READY = "postMessage('ready');";
const APP_LOG = "console.log('a log line of the app');";
const PACKAGE_LOG = "console.log('planted package log');";

interface Plant {
  body: string;
  files?: Record<string, string>;
  abort?: string;
  kind: NoiseKind | readonly NoiseKind[];
  noise: RegExp;
  ready?: true;
  everyWorker?: true;
}

const startWorker = (url: string, type: 'module' | 'classic' = 'module') => `<script>const w = new Worker('${url}', { type: '${type}' }); w.onmessage = () => { document.title = 'ready'; };</script>`;
const moduleScript = (url: string) => `<script type="module" src="${url}"></script>`;

function vlq(value: number): string {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    const digit = rest & 31;
    rest >>>= 5;
    out += digits[rest > 0 ? digit | 32 : digit];
  } while (rest > 0);
  return out;
}

const SOURCE_MAP = JSON.stringify({ version: 3, sources: ['../src/app.ts', '../../node_modules/video-fps-probe/dist/client/index.js'], names: [], mappings: `AAAA,${vlq(APP_LOG.length)}CAAA` });

const PLANTS: Record<string, Plant> = {
  'page console warning': { body: "<script>console.warn('planted page warning');</script>", kind: 'console', noise: /^console warning in page .*: planted page warning/ },
  'page console error': { body: "<script>console.error('planted page error');</script>", kind: 'console', noise: /^console error in page .*: planted page error/ },
  'page console assert': { body: "<script>console.assert(false, 'planted assert');</script>", kind: 'console', noise: /^console assert in page .*planted assert/ },
  'module worker console warning': { body: startWorker(WORKER), files: { [WORKER]: `console.warn('planted worker warning');\n${READY}` }, kind: 'console', noise: /^console warning in worker .*\/__guard\/worker\.js: planted worker warning/, ready: true },
  'classic worker console warning': { body: startWorker(WORKER, 'classic'), files: { [WORKER]: `console.warn('planted worker warning');\n${READY}` }, kind: 'console', noise: /^console warning in worker .*\/__guard\/worker\.js: planted worker warning/, ready: true },
  'worker console error': { body: startWorker(WORKER), files: { [WORKER]: `console.error('planted worker error');\n${READY}` }, kind: 'console', noise: /^console error in worker .*\/__guard\/worker\.js: planted worker error/, ready: true },
  'package worker console log': { body: startWorker('/__guard/assets/probe.worker-Ab12.js'), files: { '/__guard/assets/probe.worker-Ab12.js': `${PACKAGE_LOG}\n${READY}` }, kind: 'console', noise: /^console log in worker .*\/assets\/probe\.worker-Ab12\.js: planted package log/, ready: true },
  'console log of a chunk a package worker imports': { body: startWorker('/__guard/assets/own.worker-Ab12.js'), files: { '/__guard/assets/own.worker-Ab12.js': `import './isobmff-Cd34.js';\n${READY}`, '/__guard/assets/isobmff-Cd34.js': PACKAGE_LOG }, kind: 'console', noise: /^console log in worker .*\/assets\/own\.worker-Ab12\.js: planted package log \(.*\/assets\/isobmff-Cd34\.js:/, ready: true },
  'console log of a numbered worker chunk where every worker is the package': { body: startWorker('/__guard/112.js'), files: { '/__guard/112.js': `${PACKAGE_LOG}\n${READY}` }, kind: 'console', noise: /^console log in worker .*\/__guard\/112\.js: planted package log/, ready: true, everyWorker: true },
  'console log of a package entry that Vite pre-bundles': { body: moduleScript('/node_modules/.vite/deps/video-fps-probe_header.js'), files: { '/node_modules/.vite/deps/video-fps-probe_header.js': PACKAGE_LOG }, kind: 'console', noise: /^console log in page .*: planted package log \(.*\/node_modules\/\.vite\/deps\/video-fps-probe_header\.js:/ },
  'console log that a chunk sourcemap maps to the package': { body: moduleScript('/__guard/assets/index-Ef56.js'), files: { '/__guard/assets/index-Ef56.js': `${APP_LOG}${PACKAGE_LOG}`, '/__guard/assets/index-Ef56.js.map': SOURCE_MAP }, kind: 'console', noise: /^console log in page .*: planted package log \(.*\/assets\/index-Ef56\.js:0 from http:\/\/127\.0\.0\.1:\d+\/node_modules\/video-fps-probe\/dist\/client\/index\.js\)$/ },
  'page throw': { body: "<script>setTimeout(() => { throw new Error('planted throw'); });</script>", kind: 'page', noise: /^page error Error: planted throw$/ },
  'page rejection': { body: "<script>Promise.reject(new Error('planted rejection'));</script>", kind: 'page', noise: /^unhandled rejection in http:\/\/127\.0\.0\.1:\d+\/__guard\/index\.html: Error: planted rejection$/ },
  'page rejection without a string form': { body: '<script>Promise.reject(Object.create(null));</script>', kind: 'page', noise: /^unhandled rejection in http:\/\/127\.0\.0\.1:\d+\/__guard\/index\.html: a reason without a string form \(\[object Object\]\)$/ },
  'worker throw': { body: startWorker(WORKER), files: { [WORKER]: "setTimeout(() => { throw new Error('planted worker throw'); });\n" }, kind: 'page', noise: /^page error Error: planted worker throw$/ },
  'worker rejection': { body: startWorker(WORKER), files: { [WORKER]: "Promise.reject(new Error('planted worker rejection'));\n" }, kind: ['page', 'console'], noise: /^(?:page error|console error in worker .*\/__guard\/worker\.js: Unhandled Promise Rejection:) Error: planted worker rejection$/ },
  '404 script': { body: '<script src="/__guard/missing.js"></script>', kind: 'request', noise: /^request 404 GET http:\/\/127\.0\.0\.1:\d+\/__guard\/missing\.js$/ },
  'failed script': { body: '<script src="/__guard/aborted.js"></script>', abort: '/__guard/aborted.js', kind: 'request', noise: /^request failed GET http:\/\/127\.0\.0\.1:\d+\/__guard\/aborted\.js: / },
  '404 fetch': { body: "<script>fetch('/__guard/missing.json').catch(() => undefined);</script>", kind: 'request', noise: /^request 404 GET http:\/\/127\.0\.0\.1:\d+\/__guard\/missing\.json$/ },
  '404 fetch of a worker': { body: startWorker(WORKER), files: { [WORKER]: `fetch('/__guard/missing.json').catch(() => undefined).then(() => { ${READY} });` }, kind: 'request', noise: /^request 404 GET http:\/\/127\.0\.0\.1:\d+\/__guard\/missing\.json$/, ready: true },
};

const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };

async function open(page: Page, plant: Pick<Plant, 'body' | 'files' | 'abort'>): Promise<void> {
  const files: Record<string, string> = { [PAGE]: `<!doctype html><html><head><title>guard</title></head><body>${plant.body}</body></html>`, ...plant.files };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === plant.abort) return void req.socket.destroy();
    const body = files[path];
    if (body === undefined) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[/\.\w+$/.exec(path)?.[0] ?? ''] ?? 'text/plain', 'Cache-Control': 'no-store' }).end(body);
  });
  await new Promise<void>((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', () => done()));
  page.context().once('close', () => {
    server.closeAllConnections();
    server.close();
  });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}${PAGE}`);
}

async function plantIn(page: Page, plant: Plant, collector: NoiseCollector): Promise<Noise[]> {
  await collector.attachContext(page.context());
  await open(page, plant);
  if (plant.ready) await expect(page).toHaveTitle('ready');
  await page.waitForTimeout(250);
  return collector.finish();
}

for (const [channel, plant] of Object.entries(PLANTS)) {
  test(`the clean console guard reports a planted ${channel}`, async ({ browser }) => {
    const page = await browser.newPage();
    try {
      const collector = new NoiseCollector();
      if (plant.everyWorker) collector.everyWorkerIsPackage();
      await collector.attachContext(page.context());
      await open(page, plant);
      const kinds: readonly NoiseKind[] = [plant.kind].flat();
      const seen = () => collector.noise.filter((n) => kinds.includes(n.kind) && plant.noise.test(n.text)).map((n) => n.text);
      await expect(() => expect(seen(), JSON.stringify(collector.noise)).not.toEqual([])).toPass({ timeout: 10_000 });
      await collector.finish();
    } finally {
      await page.context().close();
    }
  });
}

test('the clean console guard reports nothing for a quiet page, a quiet worker and a console.log outside the package', async ({ browser }) => {
  const page = await browser.newPage();
  try {
    const plant: Plant = {
      body: `<script>console.log('a log line of the app'); console.info('info');</script>${startWorker(WORKER)}${moduleScript('/__guard/assets/index-Ef56.js')}`,
      files: { [WORKER]: `${APP_LOG}\n${READY}`, '/__guard/assets/index-Ef56.js': APP_LOG, '/__guard/assets/index-Ef56.js.map': SOURCE_MAP },
      kind: 'console',
      noise: /./,
      ready: true,
    };
    expect(await plantIn(page, plant, new NoiseCollector())).toEqual([]);
  } finally {
    await page.context().close();
  }
});

test('the clean console guard reports a rejection of a page that the test closes before the end', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const collector = new NoiseCollector();
    await collector.attachContext(context);
    const page = await context.newPage();
    await open(page, PLANTS['page rejection']!);
    await expect.poll(() => collector.noise.map((n) => n.text)).toContainEqual(expect.stringMatching(PLANTS['page rejection']!.noise));
    await page.close();
    expect((await collector.finish()).filter((n) => PLANTS['page rejection']!.noise.test(n.text))).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('an allowance passes only the noise it names, in its browsers, and fails when it goes unused', async ({ browserName }) => {
  const browser = browserName as BrowserName;
  const other: BrowserName = browser === 'chromium' ? 'webkit' : 'chromium';
  const run = async (noise: Noise[], ...allowances: Parameters<NoiseGuard['allow']>[0][]): Promise<string[]> => {
    const guard = new NoiseGuard(browser);
    for (const n of noise) guard.collector.add(n.kind, n.text);
    for (const a of allowances) guard.allow(a);
    return guard.verify();
  };
  const missing: Noise = { kind: 'request', text: 'request 404 GET http://127.0.0.1:1/assets/x.js' };
  const failed: Noise = { kind: 'console', text: 'console error in page http://127.0.0.1:1/: Failed to load resource' };
  const thrown: Noise = { kind: 'page', text: 'page error Error: x' };
  expect(await run([missing, failed], { browsers: [browser], request: /\/assets\/x\.js$/, console: /Failed to load resource/, reason: 'planted' })).toEqual([]);
  expect(await run([missing], { browsers: [other], request: /\/assets\/x\.js$/, reason: 'another browser' })).toEqual([missing.text]);
  expect(await run([], { browsers: [other], request: /\/assets\/x\.js$/, reason: 'another browser' })).toEqual([]);
  expect(await run([missing], { browsers: [browser], request: /\/assets\/x\.js$/, console: /Failed to load resource/, reason: 'no console noise' })).toEqual([`unused console allowance in ${browser}: /Failed to load resource/ (no console noise)`]);
  expect(await run([failed], { browsers: [browser], request: /Failed to load resource/, reason: 'wrong kind' })).toEqual([failed.text, `unused request allowance in ${browser}: /Failed to load resource/ (wrong kind)`]);
  expect(await run([thrown], { browsers: [browser], console: /x/, request: /x/, reason: 'page errors are never allowed' })).toEqual([thrown.text, `unused console allowance in ${browser}: /x/ (page errors are never allowed)`, `unused request allowance in ${browser}: /x/ (page errors are never allowed)`]);
  expect(() => new NoiseGuard(browser).allow({ browsers: [browser], console: /x/, reason: ' ' })).toThrow('allowNoise needs a reason');
});

test('watch refuses a page outside a guarded test without a collector', async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await expect(watch(page)).rejects.toThrow('watch(page) outside a guarded test needs a NoiseCollector');
  } finally {
    await page.context().close();
  }
});

test('a guarded run fails with the noise of a page that watch covers', async ({ browser, browserName }) => {
  const page = await browser.newPage();
  try {
    const run = runGuarded(browserName as BrowserName, async () => {
      await watch(page);
      await open(page, PLANTS['module worker console warning']!);
      await expect(page).toHaveTitle('ready');
    });
    await expect(run).rejects.toThrow(/^the console, the page and the network were not clean:\n {2}console warning in worker .*\/__guard\/worker\.js: planted worker warning/);
  } finally {
    await page.context().close();
  }
});

test('a guarded run fails with an unused allowance and passes a quiet page or a skipped test', async ({ browser, browserName }) => {
  const name = browserName as BrowserName;
  await expect(runGuarded(name, async (guard) => guard.allow({ browsers: [name], console: /never logged/, reason: 'unused on purpose' }))).rejects.toThrow(`unused console allowance in ${name}: /never logged/ (unused on purpose)`);
  await expect(runGuarded(name, async (guard) => guard.collector.add('page', 'planted problem'), () => true)).resolves.toBeUndefined();
  const page = await browser.newPage();
  try {
    await expect(
      runGuarded(name, async (guard) => {
        await guard.collector.attachContext(page.context());
        await open(page, { body: '' });
        await expect(page).toHaveTitle('guard');
      }),
    ).resolves.toBeUndefined();
  } finally {
    await page.context().close();
  }
});

guarded('the guard fixture fails a test with noise', async ({ noiseGuard }) => {
  guarded.fail();
  noiseGuard.collector.add('page', 'planted problem');
});

guarded('the guard fixture fails a test whose allowance goes unused', async ({ allowNoise }) => {
  guarded.fail();
  allowNoise({ browsers: ['chromium', 'firefox', 'webkit'], console: /never logged/, reason: 'unused on purpose, so the test fails' });
});

guarded('the page fixture is guarded', async ({ page, allowNoise }) => {
  allowNoise({ browsers: ['chromium', 'firefox', 'webkit'], console: PLANTS['module worker console warning']!.noise, reason: 'planted, so the guard has to see it' });
  await open(page, PLANTS['module worker console warning']!);
  await expect(page).toHaveTitle('ready');
});

guarded('a page of context.newPage() is guarded', async ({ context, allowNoise }) => {
  allowNoise({ browsers: ['chromium', 'firefox', 'webkit'], console: PLANTS['page console error']!.noise, reason: 'planted, so the guard has to see it' });
  const page = await context.newPage();
  await open(page, PLANTS['page console error']!);
  await page.waitForTimeout(250);
});

guarded('a page of browser.newPage() that watch covers is guarded', async ({ browser, allowNoise }) => {
  allowNoise({ browsers: ['chromium', 'firefox', 'webkit'], console: PLANTS['page console warning']!.noise, reason: 'planted, so the guard has to see it' });
  const page = await browser.newPage();
  try {
    await watch(page);
    await open(page, PLANTS['page console warning']!);
    await page.waitForTimeout(250);
  } finally {
    await page.context().close();
  }
});

guarded('the guard passes a quiet page', async ({ page }) => {
  await open(page, { body: '' });
  await expect(page).toHaveTitle('guard');
});
