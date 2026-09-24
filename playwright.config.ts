import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

const AUTH_EN    = 'tests/e2e/.auth/sfState.en.json';
const AUTH_JA    = 'tests/e2e/.auth/sfState.ja.json';
const AUTH_ADMIN = 'tests/e2e/.auth/sfAdminState.json';

for (const key of ['SF_ADMIN_ACCESS_TOKEN', 'SF_EN_USERNAME', 'SF_EN_PASSWORD', 'SF_JA_USERNAME', 'SF_JA_PASSWORD']) {
  if (!process.env[key]) throw new Error(`${key} must be set in .env`);
}

export default defineConfig({
  testDir: './tests/e2e/specs',
  globalSetup: './tests/e2e/setup/globalSetup.ts',

  use: {
    baseURL:           process.env.SF_INSTANCE_URL,
    screenshot:        'only-on-failure',
    video:             'retain-on-failure',
    trace:             'on-first-retry',
    actionTimeout:     45_000,
    navigationTimeout: 90_000,
  },

  projects: [
    // English user (FlashBar_User perm set, locale=en_US) — ECA Client Credentials
    {
      name: 'en-user',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_EN },
      testIgnore: ['**/06.adminPanel.spec.ts'],
    },

    // Japanese user (FlashBar_User perm set, locale=ja) — ECA Client Credentials
    {
      name: 'ja-user',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_JA },
      testIgnore: ['**/06.adminPanel.spec.ts'],
    },

    // Admin — only 06.adminPanel.spec.ts
    {
      name: 'admin',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_ADMIN },
      testMatch: ['**/06.adminPanel.spec.ts'],
    },
  ],

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  timeout: 200_000,
  retries:  1,
  workers:  1,  // Salesforce org DML tests must run serially to avoid conflicts
});
