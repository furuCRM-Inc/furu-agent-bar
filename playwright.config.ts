import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  testDir: './tests/e2e/specs',
  globalSetup: './tests/e2e/setup/globalSetup.ts',

  use: {
    baseURL:       process.env.SF_INSTANCE_URL,
    storageState:  'tests/e2e/.auth/sfState.json',
    screenshot:    'only-on-failure',
    video:         'retain-on-failure',
    trace:         'on-first-retry',
    actionTimeout: 45_000,
    navigationTimeout: 90_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  timeout:   200_000,
  retries:   1,
  workers:   1,   // Salesforce org DML tests must run serially to avoid conflicts
});
