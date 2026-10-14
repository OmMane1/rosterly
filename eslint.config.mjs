import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'react/no-danger': 'error',
    },
  },
  {
    // Layer rule (CLAUDE.md): browser and shared code must never pull in server modules.
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/client/**/*.{ts,tsx}', 'lib/shared/**/*.{ts,tsx}'],
    ignores: ['app/api/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@/lib/server', '@/lib/server/*', '**/lib/server', '**/lib/server/*'], message: 'UI and shared code must not import lib/server.' },
          ],
        },
      ],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts', 'supabase/**', 'data/**']),
]);
