import { openAsBlob, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { CONSUMERS_PORT, buildUrl, consumersDir, devUrl, fixtureDist, installedPackage } from '../../scripts/consumers.mjs';
import type { CheckReport, CheckRules } from '../../src/check/index.ts';
import type { FileResult, ProbeResult } from '../../src/index.ts';
import type { ProviderPreset } from '../../src/presets/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

interface ConsumerProbe {
  analyze(file: Blob): Promise<ProbeResult>;
}

type Check = (result: FileResult | null, rules: CheckRules) => CheckReport;

const DIST = pathToFileURL(join(installedPackage(consumersDir()), 'dist')).href;
const RULES: CheckRules = { fps: { min: 24, max: 60 }, duration: { max: 30 }, display: { maxLongSide: 3840 }, containers: ['mp4', 'mov'], vfr: 'warn', uneven: 'reject' };
const FILES = ['cfr_h264_23.976.mp4', 'cfr_h264_59.94.mp4', 'cfr_vp9_29.97.webm', 'vfr_two_phase_5_200.mp4'];
const FIXTURES = [
  { name: 'check', verdicts: ['fail', 'pass', 'fail', 'fail'] },
  { name: 'preset', verdicts: ['fail', 'fail', 'fail', 'fail'] },
] as const;

const presets = async (): Promise<Record<string, ProviderPreset>> => (await import(`${DIST}/presets/index.js`)) as Record<string, ProviderPreset>;

async function nodeReport(name: string, rules: CheckRules): Promise<CheckReport> {
  const { analyze } = (await import(`${DIST}/index.js`)) as { analyze(input: Blob, options?: { name?: string }): Promise<ProbeResult> };
  const { check } = (await import(`${DIST}/check/index.js`)) as { check: Check };
  return check(await analyze(await openAsBlob(join(FILES_DIR, name)), { name }), rules);
}

test('the preset build bundles the imported preset only', async () => {
  const assets = join(fixtureDist(consumersDir(), 'preset'), 'assets');
  const code = readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
  const all = Object.values(await presets());
  expect(all.length).toBe(6);
  expect(all.filter((p) => code.includes(p.sourceUrl)).map((p) => p.name)).toEqual(['Kling O1 reference video']);
});

for (const fixture of FIXTURES) {
  for (const mode of ['build', 'dev'] as const) {
    test(`${fixture.name} under vite ${mode} judges a browser result like Node from the same tarball`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
      await page.goto(mode === 'build' ? buildUrl(CONSUMERS_PORT, fixture.name) : devUrl(CONSUMERS_PORT, fixture.name));
      await page.waitForFunction(() => window.__check !== undefined && window.__probe !== undefined);
      const preset = await page.evaluate(() => (window.__check as { preset?: ProviderPreset }).preset ?? null);
      if (fixture.name === 'preset') expect(preset).toEqual((await presets()).klingO1ReferenceVideo);
      const rules = preset?.rules ?? RULES;
      const verdicts: string[] = [];
      for (const name of FILES) {
        await page.locator('#file').setInputFiles(join(FILES_DIR, name));
        const actual = await page.evaluate(async (rules) => {
          const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
          if (!file) throw new Error('no file picked');
          const { check } = window.__check as { check: Check };
          return { report: check(await (window.__probe as ConsumerProbe).analyze(file), rules), missing: check(null, rules).verdict };
        }, rules);
        expect(actual.report, name).toEqual(await nodeReport(name, rules));
        expect(actual.missing).toBe('unknown');
        verdicts.push(actual.report.verdict);
      }
      expect(verdicts).toEqual(fixture.verdicts);
      expect(pageErrors).toEqual([]);
    });
  }
}
