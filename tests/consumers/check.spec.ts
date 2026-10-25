import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { CONSUMERS_PORT, buildUrl, consumersDir, devUrl, installedPackage } from '../../scripts/consumers.mjs';
import type { CheckReport, CheckRules } from '../../src/check/index.ts';
import type { FileResult, ProbeResult } from '../../src/index.ts';
import { FILES_DIR } from '../helpers/fixtures.ts';

interface ConsumerProbe {
  analyze(file: Blob): Promise<ProbeResult>;
}

type Check = (result: FileResult | null, rules: CheckRules) => CheckReport;

const DIST = pathToFileURL(join(installedPackage(consumersDir()), 'dist')).href;
const RULES: CheckRules = { fps: { min: 24, max: 60 }, duration: { max: 30 }, display: { maxLongSide: 3840 }, containers: ['mp4', 'mov'], vfr: 'warn', uneven: 'reject' };
const FILES = ['cfr_h264_23.976.mp4', 'cfr_h264_59.94.mp4', 'cfr_vp9_29.97.webm', 'vfr_two_phase_5_200.mp4'];

async function nodeReport(name: string): Promise<CheckReport> {
  const { analyze } = (await import(`${DIST}/index.js`)) as { analyze(input: Blob, options?: { name?: string }): Promise<ProbeResult> };
  const { check } = (await import(`${DIST}/check/index.js`)) as { check: Check };
  return check(await analyze(await openAsBlob(join(FILES_DIR, name)), { name }), RULES);
}

for (const mode of ['build', 'dev'] as const) {
  test(`check under vite ${mode} judges a browser result like Node from the same tarball`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await page.goto(mode === 'build' ? buildUrl(CONSUMERS_PORT, 'check') : devUrl(CONSUMERS_PORT, 'check'));
    await page.waitForFunction(() => window.__check !== undefined && window.__probe !== undefined);
    const verdicts: string[] = [];
    for (const name of FILES) {
      await page.locator('#file').setInputFiles(join(FILES_DIR, name));
      const actual = await page.evaluate(async (rules) => {
        const file = document.querySelector<HTMLInputElement>('#file')?.files?.[0];
        if (!file) throw new Error('no file picked');
        const { check } = window.__check as { check: Check };
        return { report: check(await (window.__probe as ConsumerProbe).analyze(file), rules), missing: check(null, rules).verdict };
      }, RULES);
      expect(actual.report, name).toEqual(await nodeReport(name));
      expect(actual.missing).toBe('unknown');
      verdicts.push(actual.report.verdict);
    }
    expect(verdicts).toEqual(['fail', 'pass', 'fail', 'fail']);
    expect(pageErrors).toEqual([]);
  });
}
