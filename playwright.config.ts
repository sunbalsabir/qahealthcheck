import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a real browser.
 *
 * Runs the app in mock mode with in-memory persistence and the inline queue,
 * so the suite needs no Postgres, no Redis and makes no outbound requests.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run build --workspace=@qualovix/web && npx next start -p 3100',
    cwd: './apps/web',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      NODE_ENV: 'production',
      AUDIT_MOCK_MODE: 'true',
      AI_ENABLED: 'false',
      PERSISTENCE_DRIVER: 'memory',
      QUEUE_DRIVER: 'inline',
      AUTH_SECRET: 'e2e-test-secret-not-for-production-use-0123',
      ADMIN_EMAIL: 'qa@qualovix.com',
      ADMIN_PASSWORD: 'qualovix-admin',
      RATE_LIMIT_PER_IP_PER_DAY: '100',
      RATE_LIMIT_PER_DOMAIN_PER_DAY: '100',
      RATE_LIMIT_GLOBAL_PER_HOUR: '1000',
    },
  },
});
