import { expect, test, type BrowserContext } from '@playwright/test';
import { CONSUMERS_PORT } from '../../scripts/consumers.mjs';
import { NoiseCollector, NoiseGuard, type BrowserName, type Noise, type NoiseKind } from '../helpers/clean-console.ts';

type Channel = 'page console warning' | 'module worker console warning' | 'classic worker console warning' | 'page throw' | 'page rejection' | '404 script';

const ORIGIN = `http://127.0.0.1:${CONSUMERS_PORT}`;

const PAGES: Record<Channel, { body: string; kind: NoiseKind; noise: RegExp }> = {
  'page console warning': { body: "<script>console.warn('planted page warning');</script>", kind: 'console', noise: /^console warning in page .*: planted page warning/ },
  'module worker console warning': { body: "<script>const w = new Worker('/__guard/worker.js', { type: 'module' }); w.onmessage = () => { document.title = 'ready'; };</script>", kind: 'console', noise: /^console warning in worker .*\/__guard\/worker\.js: planted worker warning/ },
  'classic worker console warning': { body: "<script>const w = new Worker('/__guard/worker.js'); w.onmessage = () => { document.title = 'ready'; };</script>", kind: 'console', noise: /^console warning in worker .*\/__guard\/worker\.js: planted worker warning/ },
  'page throw': { body: "<script>setTimeout(() => { throw new Error('planted throw'); });</script>", kind: 'page', noise: /^page error Error: planted throw$/ },
  'page rejection': { body: "<script>Promise.reject(new Error('planted rejection'));</script>", kind: 'page', noise: /planted rejection/ },
  '404 script': { body: '<script src="/__guard/missing.js"></script>', kind: 'request', noise: /^request 404 GET http:\/\/127\.0\.0\.1:\d+\/__guard\/missing\.js$/ },
};

const WORKER = "console.warn('planted worker warning');\npostMessage('ready');\n";
const READY: Partial<Record<Channel, true>> = { 'module worker console warning': true, 'classic worker console warning': true };

async function serve(context: BrowserContext, channel: Channel): Promise<void> {
  await context.route('**/__guard/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/__guard/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><title>guard</title></head><body>${PAGES[channel].body}</body></html>` });
    if (path === '/__guard/worker.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: WORKER });
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  });
}

async function plant(context: BrowserContext, channel: Channel): Promise<Noise[]> {
  const collector = new NoiseCollector();
  await collector.attachContext(context);
  await serve(context, channel);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/__guard/index.html`);
  if (READY[channel]) await expect(page).toHaveTitle('ready');
  await page.waitForTimeout(250);
  return collector.finish();
}

for (const channel of Object.keys(PAGES) as Channel[]) {
  test(`the clean console guard reports a planted ${channel}`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const noise = await plant(context, channel);
      const { kind, noise: pattern } = PAGES[channel];
      expect(noise.filter((n) => n.kind === kind && pattern.test(n.text)).map((n) => n.text), JSON.stringify(noise)).not.toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('the clean console guard reports nothing for a quiet page, a quiet worker and a console.log outside the package', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.route('**/__guard/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/__guard/worker.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: "console.log('a log line of the app');\npostMessage('ready');\n" });
      return route.fulfill({ status: 200, contentType: 'text/html', body: "<!doctype html><title>guard</title><script>console.log('a log line of the app'); console.info('info'); new Worker('/__guard/worker.js', { type: 'module' }).onmessage = () => { document.title = 'ready'; };</script>" });
    });
    const collector = new NoiseCollector();
    await collector.attachContext(context);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/__guard/index.html`);
    await expect(page).toHaveTitle('ready');
    await page.waitForTimeout(250);
    expect(await collector.finish()).toEqual([]);
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
