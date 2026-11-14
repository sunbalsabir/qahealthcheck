import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // The full pipeline test runs nine scanners over a mock crawl.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@qualovix/shared': resolve('./packages/shared/src/index.ts'),
      '@qualovix/audit-engine': resolve('./packages/audit-engine/src/index.ts'),
      '@qualovix/scanners': resolve('./packages/scanners/src/index.ts'),
      '@qualovix/reporting': resolve('./packages/reporting/src/index.ts'),
      '@qualovix/data': resolve('./packages/data/src/index.ts'),
    },
  },
});
