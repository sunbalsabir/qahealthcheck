import { describe, expect, it } from 'vitest';
import {
  applySeverityRules,
  calculateCategoryScore,
  calculateReviewedScore,
  calculateScore,
  countBySeverity,
  penaltyFor,
} from '@qualovix/audit-engine';
import {
  CATEGORY_WEIGHTS,
  scoreBandFor,
  type Finding,
  type FindingCategory,
  type PassedCheck,
  type Severity,
} from '@qualovix/shared';
import type { CrawlResult, PageSnapshot } from '@qualovix/scanners';

/**
 * Severity engine and QA score.
 *
 * The score is shown to prospective clients and the severity ordering decides
 * what a QA engineer looks at first, so both must be deterministic and
 * defensible. These tests pin the properties that matter rather than exact
 * magic numbers, so tuning a weight does not require rewriting the suite.
 */

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? `finding-${Math.random().toString(36).slice(2)}`,
    ruleId: 'test.rule',
    category: 'FUNCTIONAL',
    title: 'Test finding',
    description: 'A finding created for testing.',
    severity: 'MEDIUM',
    confidence: 'HIGH',
    evidence: { summary: 'Observed during testing.' },
    recommendation: 'Fix it.',
    detectedBy: 'test',
    occurrences: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeCrawl(pageCount: number, mockMode = false): CrawlResult {
  const pages: PageSnapshot[] = Array.from({ length: pageCount }, (_, index) => ({
    url: `https://example.com/${index === 0 ? '' : `page-${index}`}`,
    normalizedUrl: `https://example.com/${index === 0 ? '' : `page-${index}`}`,
    depth: index === 0 ? 0 : 1,
    title: `Page ${index}`,
    statusCode: 200,
    responseTimeMs: 200,
    contentType: 'text/html',
    byteSize: 1000,
    headers: {},
    redirectChain: [],
    lang: 'en',
    meta: {},
    headings: [],
    links: [],
    images: [],
    forms: [],
    buttons: [],
    scripts: [],
    stylesheets: [],
    duplicateIds: [],
    elementCount: 0,
    textLength: 1000,
    console: [],
    network: [],
    performance: {},
    viewports: [],
  }));

  return {
    auditId: 'test-audit',
    origin: 'https://example.com',
    domain: 'example.com',
    pages,
    linkChecks: [],
    transport: {
      httpsAvailable: true,
      httpRedirectsToHttps: true,
      httpProbeOutcome: 'redirects',
      securityHeaders: {},
      cookies: [],
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1000,
    mockMode,
    warnings: [],
  };
}

describe('penaltyFor', () => {
  it('scales with severity', () => {
    const critical = penaltyFor(makeFinding({ severity: 'CRITICAL' }));
    const high = penaltyFor(makeFinding({ severity: 'HIGH' }));
    const medium = penaltyFor(makeFinding({ severity: 'MEDIUM' }));
    const low = penaltyFor(makeFinding({ severity: 'LOW' }));

    expect(critical).toBeGreaterThan(high);
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
  });

  it('costs nothing for informational findings', () => {
    expect(penaltyFor(makeFinding({ severity: 'INFO' }))).toBe(0);
  });

  it('discounts low-confidence findings', () => {
    const confident = penaltyFor(makeFinding({ severity: 'HIGH', confidence: 'HIGH' }));
    const unsure = penaltyFor(makeFinding({ severity: 'HIGH', confidence: 'LOW' }));
    expect(unsure).toBeLessThan(confident);
  });

  it('damps repeat occurrences rather than multiplying them', () => {
    const once = penaltyFor(makeFinding({ severity: 'MEDIUM', occurrences: 1 }));
    const twenty = penaltyFor(makeFinding({ severity: 'MEDIUM', occurrences: 20 }));

    // Twenty missing alt attributes is one problem to fix, not twenty times
    // the damage.
    expect(twenty).toBeGreaterThan(once);
    expect(twenty).toBeLessThan(once * 4);
  });
});

describe('calculateScore', () => {
  it('gives a perfect score when nothing was found', () => {
    const result = calculateScore([], []);
    expect(result.overall).toBe(100);
    expect(result.band.label).toBe('Excellent');
  });

  it('is deterministic', () => {
    const findings = [
      makeFinding({ id: 'a', severity: 'HIGH', category: 'FUNCTIONAL' }),
      makeFinding({ id: 'b', severity: 'MEDIUM', category: 'ACCESSIBILITY' }),
    ];
    const first = calculateScore(findings, []);
    const second = calculateScore(findings, []);
    expect(first.overall).toBe(second.overall);
    expect(first.categories).toEqual(second.categories);
  });

  it('never falls outside 0 to 100, even with an extreme finding set', () => {
    const findings = Array.from({ length: 200 }, (_, index) =>
      makeFinding({ id: `f${index}`, severity: 'CRITICAL', occurrences: 50 }),
    );
    const result = calculateScore(findings, []);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
  });

  it('does not let one bad category zero the whole score', () => {
    // Everything wrong in Functional, nothing wrong anywhere else.
    const findings = Array.from({ length: 30 }, (_, index) =>
      makeFinding({ id: `f${index}`, severity: 'CRITICAL', category: 'FUNCTIONAL' }),
    );
    const result = calculateScore(findings, []);
    const functional = result.categories.find((c) => c.category === 'FUNCTIONAL')!;

    expect(functional.score).toBeLessThan(20);
    // Functional carries 25%, so the other 75% must still be reflected.
    expect(result.overall).toBeGreaterThan(50);
  });

  it('weights categories as the product spec requires', () => {
    const result = calculateScore([], []);
    for (const category of result.categories) {
      expect(category.weight).toBe(CATEGORY_WEIGHTS[category.category]);
    }
    const total = result.categories.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('scores a worse site lower than a better one', () => {
    const better = calculateScore([makeFinding({ severity: 'LOW' })], []);
    const worse = calculateScore(
      [
        makeFinding({ id: '1', severity: 'CRITICAL' }),
        makeFinding({ id: '2', severity: 'HIGH' }),
        makeFinding({ id: '3', severity: 'HIGH' }),
      ],
      [],
    );
    expect(worse.overall).toBeLessThan(better.overall);
  });

  it('ignores informational findings in the score', () => {
    const withInfo = calculateScore(
      [makeFinding({ id: 'a', severity: 'INFO' }), makeFinding({ id: 'b', severity: 'INFO' })],
      [],
    );
    expect(withInfo.overall).toBe(100);
  });
});

describe('score bands', () => {
  it.each([
    [0, 'Needs Significant Attention'],
    [49, 'Needs Significant Attention'],
    [50, 'Needs Improvement'],
    [69, 'Needs Improvement'],
    [70, 'Good'],
    [84, 'Good'],
    [85, 'Very Good'],
    [94, 'Very Good'],
    [95, 'Excellent'],
    [100, 'Excellent'],
  ])('maps %i to "%s"', (score, label) => {
    expect(scoreBandFor(score).label).toBe(label);
  });

  it('clamps out-of-range input rather than returning undefined', () => {
    expect(scoreBandFor(-10).label).toBe('Needs Significant Attention');
    expect(scoreBandFor(150).label).toBe('Excellent');
  });
});

describe('calculateCategoryScore', () => {
  it('counts only findings in that category', () => {
    const findings = [
      makeFinding({ id: 'a', category: 'ACCESSIBILITY', severity: 'HIGH' }),
      makeFinding({ id: 'b', category: 'PERFORMANCE', severity: 'HIGH' }),
    ];
    const accessibility = calculateCategoryScore('ACCESSIBILITY', findings, []);
    expect(accessibility.findingCount).toBe(1);
  });

  it('reports passed checks and writes an explanatory summary', () => {
    const passed: PassedCheck[] = [
      {
        ruleId: 'security.https-available',
        category: 'SECURITY',
        title: 'Site is served over HTTPS',
        detail: 'A valid HTTPS response was received.',
        detectedBy: 'security',
      },
    ];
    const score = calculateCategoryScore('SECURITY', [], passed);
    expect(score.score).toBe(100);
    expect(score.passedChecks).toBe(1);
    expect(score.summary).toContain('No issues detected');
  });
});

describe('applySeverityRules', () => {
  it('escalates a defect present on every page', () => {
    const finding = makeFinding({
      severity: 'MEDIUM',
      affectedUrls: [
        'https://example.com/',
        'https://example.com/page-1',
        'https://example.com/page-2',
        'https://example.com/page-3',
      ],
    });
    const { findings, adjustments } = applySeverityRules([finding], makeCrawl(4));

    expect(findings[0]!.severity).toBe('HIGH');
    expect(adjustments[0]!.rule).toBe('sitewide-reach');
    // The original must stay visible so a reviewer can see what changed.
    expect(findings[0]!.originalSeverity).toBe('MEDIUM');
  });

  it('records why every adjustment happened', () => {
    const finding = makeFinding({ ruleId: 'security.no-https', severity: 'HIGH' });
    const { findings } = applySeverityRules([finding], makeCrawl(3));

    const adjustments = findings[0]!.evidence.details?.severityAdjustments as Array<{
      rule: string;
      reason: string;
    }>;
    expect(adjustments).toBeDefined();
    expect(adjustments[0]!.reason.length).toBeGreaterThan(20);
  });

  it('always treats a site with no HTTPS as critical', () => {
    const finding = makeFinding({ ruleId: 'security.no-https', severity: 'LOW' });
    const { findings } = applySeverityRules([finding], makeCrawl(3));
    expect(findings[0]!.severity).toBe('CRITICAL');
  });

  it('caps low-confidence findings so uncertainty cannot top the report', () => {
    const finding = makeFinding({ severity: 'CRITICAL', confidence: 'LOW' });
    const { findings } = applySeverityRules([finding], makeCrawl(3));
    expect(findings[0]!.severity).toBe('MEDIUM');
  });

  it('keeps "manual testing recommended" as an observation', () => {
    const finding = makeFinding({
      ruleId: 'forms.manual-testing-recommended',
      severity: 'HIGH',
    });
    const { findings } = applySeverityRules([finding], makeCrawl(3));
    expect(findings[0]!.severity).toBe('INFO');
  });

  it('never reports a critical finding from mock data', () => {
    // Nothing in mock mode was measured against a real site.
    const finding = makeFinding({ severity: 'CRITICAL', ruleId: 'broken-links.internal-404' });
    const { findings } = applySeverityRules([finding], makeCrawl(3, true));
    expect(findings[0]!.severity).toBe('HIGH');
  });

  it('leaves an unremarkable finding untouched', () => {
    const finding = makeFinding({ severity: 'LOW', confidence: 'HIGH' });
    const { findings, adjustments } = applySeverityRules([finding], makeCrawl(1));
    expect(findings[0]!.severity).toBe('LOW');
    expect(adjustments).toHaveLength(0);
  });
});

describe('countBySeverity', () => {
  it('counts every severity, including those with no findings', () => {
    const counts = countBySeverity([
      makeFinding({ id: 'a', severity: 'CRITICAL' }),
      makeFinding({ id: 'b', severity: 'HIGH' }),
      makeFinding({ id: 'c', severity: 'HIGH' }),
    ]);
    expect(counts).toEqual({ CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0, INFO: 0 });
  });
});

describe('calculateReviewedScore', () => {
  it('excludes findings a QA engineer ignored', () => {
    const findings: Finding[] = [
      makeFinding({ id: 'a', severity: 'CRITICAL', status: 'IGNORED' }),
      makeFinding({ id: 'b', severity: 'LOW', status: 'KEPT' }),
    ];

    const automated = calculateScore(findings, []);
    const reviewed = calculateReviewedScore(findings, []);

    // Dropping a false-positive critical must improve the client's score.
    expect(reviewed.overall).toBeGreaterThan(automated.overall);
  });

  it('counts edited findings as kept', () => {
    const findings: Finding[] = [
      makeFinding({ id: 'a', severity: 'HIGH', status: 'EDITED' }),
      makeFinding({ id: 'b', severity: 'HIGH', status: 'KEPT' }),
    ];
    const reviewed = calculateReviewedScore(findings, []);
    const both = calculateScore(findings, []);
    expect(reviewed.overall).toBe(both.overall);
  });

  it('returns a perfect score when every finding was dismissed', () => {
    const findings: Finding[] = [
      makeFinding({ id: 'a', severity: 'CRITICAL', status: 'IGNORED' }),
      makeFinding({ id: 'b', severity: 'HIGH', status: 'IGNORED' }),
    ];
    expect(calculateReviewedScore(findings, []).overall).toBe(100);
  });
});

describe('category coverage', () => {
  it('scores every category, even ones with no findings', () => {
    const result = calculateScore([makeFinding({ category: 'FUNCTIONAL' })], []);
    const categories = result.categories.map((c) => c.category);
    const expected: FindingCategory[] = [
      'FUNCTIONAL',
      'ACCESSIBILITY',
      'PERFORMANCE',
      'RESPONSIVE',
      'TECHNICAL',
      'SECURITY',
      'UX',
    ];
    for (const category of expected) {
      expect(categories).toContain(category);
    }
  });

  it('orders severities consistently for the report', () => {
    const severities: Severity[] = ['LOW', 'CRITICAL', 'INFO', 'HIGH', 'MEDIUM'];
    const findings = severities.map((severity, index) =>
      makeFinding({ id: `f${index}`, severity }),
    );
    const counts = countBySeverity(findings);
    expect(Object.keys(counts)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
  });
});
