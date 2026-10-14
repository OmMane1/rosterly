// The UI smoke (`npm run test:ui`, PLAN.md M11) runs a phone-sized Chromium against a running app
// (`make dev`, or E2E_BASE_URL). First run on a new machine: `npx playwright install chromium`.
import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// The throwaway tenant needs DATABASE_URL and the Supabase keys that make setup writes; values
// already in the environment win over .env.local.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: (process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    trace: 'retain-on-failure',
  },
});
