import { defineConfig, devices } from '@playwright/test';
import { bundlersDir } from './scripts/bundlers.mjs';
import { BUNDLERS_PORT, DEV_OFFSET } from './tests/bundlers/targets.mjs';

const CI = !!process.env.CI;
const DEV = process.env.BUNDLERS_DEV === '1';
const ONLY = process.env.BUNDLERS_ONLY ? ` --only ${process.env.BUNDLERS_ONLY}` : '';
const browser = { testMatch: 'smoke.spec.ts' };

export default defineConfig({
  testDir: 'tests/bundlers',
  outputDir: '.playwright/bundlers-results',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  failOnFlakyTests: true,
  workers: CI ? 2 : undefined,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', ...browser, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', ...browser, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', ...browser, use: { ...devices['Desktop Safari'] } },
    { name: 'server', testMatch: 'server.spec.ts' },
  ],
  webServer: {
    command: `node scripts/bundlers.mjs serve --dir "${bundlersDir()}"${ONLY}${DEV ? ' --dev' : ''}`,
    url: `http://127.0.0.1:${BUNDLERS_PORT + (DEV ? DEV_OFFSET : 0)}/`,
    reuseExistingServer: !CI,
    timeout: DEV ? 300_000 : 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
