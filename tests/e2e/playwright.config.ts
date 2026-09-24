import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);

/**
 * CareerPilot Interview end-to-end suite. `support/global-setup.ts` starts the
 * compiled API and worker plus both SPAs (see README.md). Tests share one
 * stack and one database, so they run one at a time; every test creates its
 * own users and never depends on another test's data.
 */
export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    [CI ? 'github' : 'list'],
    ['html', { outputFolder: './playwright-report', open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
