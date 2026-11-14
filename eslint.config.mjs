import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // The engine deliberately swallows some errors (a scanner that fails
      // must not take the audit down), so empty catch blocks are intentional.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Narrow casts are needed at the Prisma/JSON and react-pdf boundaries.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // In-page extraction code runs in the browser, not in Node.
    files: ['packages/audit-engine/src/crawler/page-extract.ts'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', performance: 'readonly' } },
  },
);
