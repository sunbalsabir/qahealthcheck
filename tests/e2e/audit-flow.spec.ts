import { expect, test } from '@playwright/test';

/**
 * End-to-end journeys.
 *
 * Covers the two flows that matter: a prospect submitting a URL and reaching
 * a report, and a QA engineer signing in and reviewing that report before the
 * prospect sees it.
 */

const ADMIN_EMAIL = 'qa@qualovix.com';
const ADMIN_PASSWORD = 'qualovix-admin';

test.describe('homepage', () => {
  test('presents the offer and the audit form', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      "Know What's Breaking Before Your Users Do",
    );
    await expect(page.getByRole('heading', { name: 'Get a Free QA Health Check' })).toBeVisible();
    await expect(page.getByPlaceholder('https://example.com')).toBeVisible();
    await expect(page.getByRole('button', { name: /Start Free QA Audit/i })).toBeVisible();
  });

  test('explains the process, including the human review step', async ({ page }) => {
    await page.goto('/');

    const howItWorks = page.locator('#how-it-works');
    await expect(howItWorks).toContainText('Submit your URL');
    await expect(howItWorks).toContainText('Automated QA scan');
    await expect(howItWorks).toContainText('QA engineer review');
    await expect(howItWorks).toContainText('Receive your report');
  });

  test('states the limits of an automated audit', async ({ page }) => {
    await page.goto('/');

    // The product must never overstate what it does.
    await expect(page.getByText(/never submit your forms/i).first()).toBeVisible();
    await expect(page.getByText(/not a penetration test/i).first()).toBeVisible();
    await expect(page.locator('footer')).toContainText(/not a complete manual functional test/i);
  });

  test('reveals the optional lead fields on request', async ({ page }) => {
    await page.goto('/');

    const disclosure = page.getByRole('button', { name: /Tell us about you/i });
    await expect(page.locator('#audit-details')).toBeHidden();

    await disclosure.click();
    await expect(page.getByLabel('Company name')).toBeVisible();
    await expect(page.getByLabel('Business email')).toBeVisible();
    await expect(page.getByLabel('Industry')).toBeVisible();
  });
});

test.describe('URL submission', () => {
  test('rejects a private address with a clear message', async ({ page }) => {
    await page.goto('/');

    await page.getByPlaceholder('https://example.com').fill('http://192.168.1.1');
    await page.getByRole('button', { name: /Start Free QA Audit/i }).click();

    await expect(page.locator('#url-error')).toContainText(/private network/i);
    // The refusal must not navigate — no audit was created.
    await expect(page).toHaveURL('/');
  });

  test('rejects localhost', async ({ page }) => {
    await page.goto('/');

    await page.getByPlaceholder('https://example.com').fill('http://localhost:3000');
    await page.getByRole('button', { name: /Start Free QA Audit/i }).click();

    await expect(page.locator('#url-error')).toContainText(/Local addresses cannot be audited/i);
  });

  test('runs an audit and shows the results', async ({ page }) => {
    await page.goto('/');

    await page.getByPlaceholder('https://example.com').fill('https://example.com');
    await page.getByRole('button', { name: /Start Free QA Audit/i }).click();

    // The progress screen appears while the scan runs.
    await expect(page).toHaveURL(/\/audit\/[a-z0-9-]+/i);

    // Then the results, once the pipeline finishes.
    await expect(page.getByRole('heading', { name: /QA Health Check/i }).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText('Executive summary')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('heading', { name: 'Category scores' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'All findings' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Download QA Report/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Talk to Qualovix/i }).first()).toBeVisible();
  });
});

test.describe('results page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('https://example.com').fill('https://example.com');
    await page.getByRole('button', { name: /Start Free QA Audit/i }).click();
    await expect(page.getByText('Executive summary')).toBeVisible({ timeout: 45_000 });
  });

  test('shows a score with the certification caveat', async ({ page }) => {
    await expect(page.getByText('out of 100').first()).toBeVisible();
    await expect(
      page.getByText(/automated QA health indicator and is not a certification/i).first(),
    ).toBeVisible();
  });

  test('shows evidence for a finding when expanded', async ({ page }) => {
    const firstFinding = page
      .locator('button[aria-expanded]')
      .filter({ hasText: /./ })
      .nth(1);
    await firstFinding.click();

    // Every finding must be able to show what was actually observed.
    await expect(page.getByText('Evidence').first()).toBeVisible();
    await expect(page.getByText('Recommendation').first()).toBeVisible();
  });

  test('filters findings by severity', async ({ page }) => {
    const statusLine = page.getByText(/Showing \d+ of \d+ finding/);
    await expect(statusLine).toBeVisible();
    const before = await statusLine.textContent();

    const highFilter = page.getByRole('button', { name: /^High Priority \(\d+\)$/ });
    if (await highFilter.count()) {
      await highFilter.first().click();
      await expect(statusLine).not.toHaveText(before ?? '');
    }
  });

  test('serves a downloadable PDF report', async ({ page }) => {
    const url = page.url();
    const auditId = url.split('/audit/')[1];

    const response = await page.request.get(`/api/audits/${auditId}/report`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/pdf');

    const body = await response.body();
    expect(body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(body.byteLength).toBeGreaterThan(5000);
  });
});

test.describe('admin', () => {
  test('requires sign in', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByRole('heading', { name: 'QA team sign in' })).toBeVisible();
  });

  test('rejects bad credentials without revealing which part was wrong', async ({ page }) => {
    await page.goto('/admin/login');

    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert').first()).toContainText(/not valid/i);
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('signs in and lists audits', async ({ page }) => {
    await page.goto('/admin/login');

    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Audits' })).toBeVisible();
  });

  test('reviews an audit and publishes only the kept findings', async ({ page }) => {
    // Create an audit as a visitor first.
    await page.goto('/');
    await page.getByPlaceholder('https://example.com').fill('https://example.com');
    await page.getByRole('button', { name: /Start Free QA Audit/i }).click();
    await expect(page.getByText('Executive summary')).toBeVisible({ timeout: 45_000 });
    const auditId = page.url().split('/audit/')[1]!;

    // Sign in as a QA engineer.
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin$/);

    // Open the audit and use the review controls.
    await page.goto(`/admin/audits/${auditId}`);
    await expect(page.getByRole('heading', { name: /QA review/ })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Keep' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Ignore' }).first().click();

    await page
      .getByLabel('QA engineer notes')
      .fill('Confirmed the navigation link manually — reproduces in Chrome and Firefox.');

    await page.getByRole('button', { name: /Approve and publish/i }).click();
    await expect(page.getByText(/Review approved/i)).toBeVisible({ timeout: 20_000 });

    // The client view now reflects the review.
    await page.goto(`/audit/${auditId}`);
    await expect(page.getByText(/Reviewed by a Qualovix QA engineer/i)).toBeVisible();
  });

  test('shows the leads list', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto('/admin/leads');
    await expect(page.getByRole('heading', { name: 'Leads' })).toBeVisible();
    // The product must never contact leads on its own.
    await expect(page.getByText(/No automated emails are sent/i)).toBeVisible();
  });
});

test.describe('API contract', () => {
  test('refuses an SSRF attempt with a 400 and a safe message', async ({ request }) => {
    for (const url of [
      'http://127.0.0.1',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'http://10.0.0.1',
    ]) {
      const response = await request.post('/api/audits', { data: { url } });
      expect(response.status(), url).toBe(400);
      const body = await response.json();
      expect(body.error).toBeTruthy();
      // The message must not confirm anything about internal infrastructure.
      expect(body.error).not.toContain('169.254.169.254');
    }
  });

  test('requires authentication for admin endpoints', async ({ request }) => {
    expect((await request.get('/api/audits')).status()).toBe(401);
    expect((await request.get('/api/leads')).status()).toBe(401);
  });

  test('returns 404 for an unknown audit', async ({ request }) => {
    const response = await request.get('/api/audits/does-not-exist');
    expect(response.status()).toBe(404);
  });

  test('rejects a submission that trips the honeypot', async ({ request }) => {
    const response = await request.post('/api/audits', {
      data: { url: 'https://example.com', website2: 'bot filled this in' },
    });
    expect(response.status()).toBe(400);
  });

  test('sets the security headers the auditor checks other sites for', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'self'");
  });
});
