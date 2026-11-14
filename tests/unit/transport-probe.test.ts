import { describe, expect, it } from 'vitest';
import { securityScanner } from '@qualovix/scanners';
import type { CrawlResult, TransportObservation } from '@qualovix/scanners';

/**
 * The security scanner must only report what the transport probe actually
 * established. A probe that timed out tells us nothing, and "we could not
 * check" must never become "this site is misconfigured" — that would be a
 * finding with no evidence behind it.
 *
 * This was a real false positive: a site whose port 80 did not answer within
 * the timeout was reported as failing to redirect to HTTPS.
 */

function crawlWith(transport: Partial<TransportObservation>): CrawlResult {
  return {
    auditId: 'probe-test',
    origin: 'https://example.com',
    domain: 'example.com',
    pages: [],
    linkChecks: [],
    transport: {
      httpsAvailable: true,
      httpRedirectsToHttps: false,
      httpProbeOutcome: 'inconclusive',
      securityHeaders: { 'content-type': 'text/html' },
      cookies: [],
      ...transport,
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    mockMode: false,
    warnings: [],
  };
}

const scan = (transport: Partial<TransportObservation>) =>
  securityScanner.scan({
    auditId: 'probe-test',
    crawl: crawlWith(transport),
    limits: { maxFindingsPerRule: 25, maxPages: 10 },
  }) as ReturnType<typeof securityScanner.scan> & {
    findings: Array<{ ruleId: string }>;
    passed: Array<{ ruleId: string }>;
    warnings: string[];
  };

describe('HTTP to HTTPS redirect reporting', () => {
  it('reports a finding when HTTP answered and stayed on HTTP', () => {
    const result = scan({
      httpProbeOutcome: 'no-redirect',
      httpRedirectsToHttps: false,
      httpRedirectTarget: 'http://example.com/',
    });

    const finding = result.findings.find((f) => f.ruleId === 'security.no-https-redirect');
    expect(finding).toBeDefined();
  });

  it('passes when HTTP redirected to HTTPS', () => {
    const result = scan({ httpProbeOutcome: 'redirects', httpRedirectsToHttps: true });

    expect(result.findings.some((f) => f.ruleId === 'security.no-https-redirect')).toBe(false);
    expect(result.passed.some((p) => p.ruleId === 'security.https-redirect')).toBe(true);
  });

  it('passes when nothing is listening on port 80', () => {
    // No HTTP listener means there is no unencrypted path to close.
    const result = scan({
      httpProbeOutcome: 'not-served',
      httpProbeError: 'Connection refused',
    });

    expect(result.findings.some((f) => f.ruleId === 'security.no-https-redirect')).toBe(false);
    expect(result.passed.some((p) => p.ruleId === 'security.https-redirect')).toBe(true);
  });

  it('reports nothing at all when the probe was inconclusive', () => {
    const result = scan({
      httpProbeOutcome: 'inconclusive',
      httpProbeError: 'Request timed out',
    });

    // Neither a finding nor a pass — just a warning that we could not check.
    expect(result.findings.some((f) => f.ruleId === 'security.no-https-redirect')).toBe(false);
    expect(result.passed.some((p) => p.ruleId === 'security.https-redirect')).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/could not be checked/i);
  });
});
