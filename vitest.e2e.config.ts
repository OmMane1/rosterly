import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    // .env.local (written by make setup) supplies DATABASE_URL and the Supabase keys for the
    // throwaway tenants; the app under test runs separately (make dev).
    env: loadEnv('test', process.cwd(), ''),
    fileParallelism: false,
    // The suite prints its latency measurements; the default reporter always shows them (Vitest's
    // agent reporter hides the logs of passing tests).
    reporters: ['default'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
