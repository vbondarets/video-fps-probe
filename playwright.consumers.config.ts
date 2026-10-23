import { defineConfig, devices } from '@playwright/test';
import { CONSUMERS_PORT, consumersDir } from './scripts/consumers.mjs';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/consumers',
  testMatch: '**/*.spec.ts',
  outputDir: '.playwright/consumers-results',
  timeout: 120_000,
  expect: { timeout: 15_000 },
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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `node scripts/consumers.mjs serve --dir "${consumersDir()}" --port ${CONSUMERS_PORT}`,
    url: `http://127.0.0.1:${CONSUMERS_PORT}/`,
    reuseExistingServer: !CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
