import { fileURLToPath } from 'node:url';
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
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
