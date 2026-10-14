import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      // lib/server modules start with `import 'server-only'`, which throws outside React Server
      // Components; tests run them in plain Node, so it resolves to the package's own empty module.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // .env.local (written by make setup) supplies DATABASE_URL and the Supabase keys.
    env: loadEnv('test', process.cwd(), ''),
    // One shared database: files run one at a time so quota/billing tests never interleave.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
