import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const PORT = Number(process.env.E2E_PORT || 4317);
const DIST = '.playwright/dist';
const REMOTE = process.env.E2E_BASE_URL?.trim();
const baseURL = REMOTE ? (REMOTE.endsWith('/') ? REMOTE : `${REMOTE}/`) : `http://127.0.0.1:${PORT}/`;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: '.playwright/results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: [['list'], ['html', { outputFolder: '.playwright/report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: REMOTE
    ? undefined
    : {
        command: `npx vite build --outDir ${DIST} --logLevel warn && npx vite preview --outDir ${DIST} --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: baseURL,
        reuseExistingServer: !CI,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
