import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { fixtureFile, openApp, waitSettled } from './support.ts';

const MP4 = 'cfr_h264_30.mp4';
const WEBM = 'cfr_vp9_30.webm';
const MODULE_LOAD_FAILURE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
const WORKER_LOAD_FAILURE = 'worker script failed to load; the app may have been redeployed';

async function dropFour(page: Page): Promise<void> {
  const mp4 = await readFile(fixtureFile(MP4));
  const file = (name: string, buffer: Buffer, mimeType: string) => ({ name, buffer, mimeType });
  const before = await page.locator('article.card').count();
  await page
    .getByTestId('file-input')
    .setInputFiles([file(MP4, mp4, 'video/mp4'), file('same-name.mp4', mp4, 'video/mp4'), file('same-name.mp4', mp4, 'video/mp4'), file(WEBM, await readFile(fixtureFile(WEBM)), 'video/webm')]);
  await waitSettled(page, before + 4);
}

async function redeploy(page: Page, gone: string): Promise<string[]> {
  const requests: string[] = [];
  await page.context().route(gone, (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>404</h1>' });
  });
  return requests;
}

test.describe('a tab opened before a redeploy', () => {
  test('rejects every file with the import error when the probe client chunk is gone, and works after a reload', async ({ page }) => {
    await openApp(page);
    const requests = await redeploy(page, '**/assets/probe-*.js');
    await dropFour(page);
    const errors = page.locator('article.card .err');
    await expect(errors).toHaveCount(4);
    for (const text of await errors.allInnerTexts()) expect(text).toMatch(MODULE_LOAD_FAILURE);
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
    const requests = await redeploy(page, '**/assets/probe.worker-*.js');
    await dropFour(page);
    await expect(page.locator('article.card p.err')).toHaveText(Array(4).fill(WORKER_LOAD_FAILURE));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(2);
    await page.context().unrouteAll({ behavior: 'wait' });
    await dropFour(page);
    await expect(page.locator('article.card dl.grid')).toHaveCount(4);
    await expect(page.locator('article.card p.err')).toHaveCount(4);
  });
});
