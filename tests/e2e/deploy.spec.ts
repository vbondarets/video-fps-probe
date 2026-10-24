import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { fixtureFile, openApp, waitSettled, type ProbeWindow } from './support.ts';

const MP4 = 'cfr_h264_30.mp4';
const WEBM = 'cfr_vp9_30.webm';
const NOT_LOADED = 'Worker could not be loaded: ';
const MODULE_LOAD_FAILURE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
const WORKER_LOAD_FAILURE = 'worker script failed to load or parse; the app may have been redeployed';
const BANNER = 'A new version of this page was deployed. Reload to continue.';

async function dropFour(page: Page): Promise<void> {
  const mp4 = await readFile(fixtureFile(MP4));
  const file = (name: string, buffer: Buffer, mimeType: string) => ({ name, buffer, mimeType });
  const before = await page.locator('article.card').count();
  await page
    .getByTestId('file-input')
    .setInputFiles([file(MP4, mp4, 'video/mp4'), file('same-name.mp4', mp4, 'video/mp4'), file('same-name.mp4', mp4, 'video/mp4'), file(WEBM, await readFile(fixtureFile(WEBM)), 'video/webm')]);
  await waitSettled(page, before + 4);
}

async function redeploy(page: Page, gone: string, newBuild: boolean): Promise<string[]> {
  const requests: string[] = [];
  await page.context().route(gone, (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>404</h1>' });
  });
  if (newBuild) {
    await page.context().route(page.url(), async (route) => {
      const response = await route.fetch();
      return route.fulfill({ response, body: (await response.text()).replace(/index-[\w-]{8}\.js/, 'index-N3wBu1ld.js') });
    });
  }
  return requests;
}

test.describe('a tab opened before a redeploy', () => {
  test('shows one reload banner instead of an error per file when a new build replaced the probe client chunk, and works after the reload', async ({ page }) => {
    await openApp(page);
    const requests = await redeploy(page, '**/assets/probe-*.js', true);
    await dropFour(page);
    await expect(page.getByRole('alert')).toContainText(BANNER);
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.locator('article.card .err')).toHaveCount(0);
    await expect(page.locator('article.card', { hasText: 'Not analyzed.' })).toHaveCount(4);
    await expect(page.getByRole('status').first()).toHaveText('4 files. Read 0 B of 0 B in 0.00 ms total.');
    expect(requests.length).toBeGreaterThan(0);
    await page.context().unrouteAll({ behavior: 'wait' });
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload' }).click()]);
    await page.waitForFunction(() => (window as ProbeWindow).__fpsProbe !== undefined);
    await expect(page.locator('article.card')).toHaveCount(0);
    await dropFour(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('article.card .err')).toHaveCount(0);
    await expect(page.locator('article.card dl.grid')).toHaveCount(4);
  });

  test('shows the reload banner when a new build replaced the worker script', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'the load classification relies on the error event of a missing worker script, verified in Chromium and WebKit only');
    await openApp(page);
    const requests = await redeploy(page, '**/assets/probe.worker-*.js', true);
    await dropFour(page);
    await expect(page.getByRole('alert')).toContainText(BANNER);
    await expect(page.locator('article.card .err')).toHaveCount(0);
    await expect(page.locator('article.card', { hasText: 'Not analyzed.' })).toHaveCount(4);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(2);
  });

  test('names the import error on every file and shows no banner when the probe client chunk is missing but the page is unchanged', async ({ page }) => {
    await openApp(page);
    const requests = await redeploy(page, '**/assets/probe-*.js', false);
    await dropFour(page);
    const errors = page.locator('article.card .err');
    await expect(errors).toHaveCount(4);
    for (const text of await errors.allInnerTexts()) {
      expect(text.startsWith(NOT_LOADED)).toBe(true);
      expect(text).toMatch(MODULE_LOAD_FAILURE);
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('status').first()).toHaveText('4 files. Read 0 B of 0 B in 0.00 ms total.');
    expect(requests.length).toBeGreaterThan(0);
    await page.context().unrouteAll({ behavior: 'wait' });
    await openApp(page);
    await dropFour(page);
    await expect(page.locator('article.card .err')).toHaveCount(0);
    await expect(page.locator('article.card dl.grid')).toHaveCount(4);
  });

  test('names a worker script that failed to load, fetches it at most once per pool slot, and retries on the next drop', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'the load classification relies on the error event of a missing worker script, verified in Chromium and WebKit only');
    await openApp(page);
    const requests = await redeploy(page, '**/assets/probe.worker-*.js', false);
    await dropFour(page);
    await expect(page.locator('article.card p.err')).toHaveText(Array(4).fill(`${NOT_LOADED}${WORKER_LOAD_FAILURE}`));
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(2);
    await page.context().unrouteAll({ behavior: 'wait' });
    await dropFour(page);
    await expect(page.locator('article.card dl.grid')).toHaveCount(4);
    await expect(page.locator('article.card p.err')).toHaveCount(4);
  });
});
