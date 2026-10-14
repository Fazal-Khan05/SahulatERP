import { defineConfig } from '@playwright/test';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

// Browser pass of the SQA pack (docs/qa/cases). Runs against the disposable QA tenant only.
export default defineConfig({
  testDir: './tests/qa-browser',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  // Parallel runs set QA_BASE_URL (their own server) and QA_PW_JSON (their own results file).
  reporter: [['line'], ['json', { outputFile: process.env.QA_PW_JSON || 'reports/qa-run/playwright.json' }]],
  use: { baseURL: process.env.QA_BASE_URL || 'http://127.0.0.1:3000', channel: 'chrome', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: process.env.QA_BASE_URL || 'http://127.0.0.1:3000', reuseExistingServer: true, timeout: 120_000 },
});
