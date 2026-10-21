import { existsSync, readdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { FileResult, MatroskaMode } from '../../src/core/types.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';
import { addFixtures, chunk, committedFixtures, contract, fixtureFile, nodeAnalyze, openApp, probeResults, withoutTiming } from './support.ts';

const ALL = committedFixtures();
const MATROSKA = ALL.filter((name) => /\.(mkv|webm)$/i.test(name));
const BATCH = 26;

const PLAN: [MatroskaMode, string[]][] = [
  ['exact', ALL],
  ['header', MATROSKA],
];

test('every committed manifest fixture is on disk', () => {
  expect(ALL.length).toBeGreaterThan(0);
  expect(ALL.filter((name) => !existsSync(fixtureFile(name)))).toEqual([]);
  expect(ALL.length).toBe(readdirSync(FILES_DIR).length);
});

for (const [mode, names] of PLAN) {
  test.describe(`browser parser equals Node, Matroska mode ${mode}`, () => {
    let page: Page;
    let results = new Map<string, FileResult>();
    const pageErrors: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(240_000);
      page = await browser.newPage();
      page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
      await openApp(page, mode);
      for (const batch of chunk(names, BATCH)) await addFixtures(page, batch);
      results = new Map((await probeResults(page)).map((r) => [r.name, r]));
    });

    test.afterAll(async () => {
      await page?.close();
    });

    for (const name of names) {
      test(name, async () => {
        const got = results.get(name);
        const card = got ? '' : await page.locator('article.card', { has: page.getByRole('heading', { name, exact: true }) }).innerText();
        expect(got, `no result in the page for ${name}: ${card}`).toBeDefined();
        const want = await nodeAnalyze(name, mode);
        expect(contract(got!), 'contract fields').toEqual(contract(want));
        expect(withoutTiming(got!), 'whole result except io.ms').toEqual(withoutTiming(want));
      });
    }

    test('no uncaught page errors', () => {
      expect(pageErrors).toEqual([]);
    });
  });
}
