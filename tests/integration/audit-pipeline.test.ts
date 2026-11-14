import { beforeAll, describe, expect, it } from 'vitest';
import { runAudit } from '@qualovix/audit-engine';
import { SCANNERS } from '@qualovix/scanners';
import { getEnv, resetEnvCache, type AuditStage } from '@qualovix/shared';
import type { AuditOutcome } from '@qualovix/audit-engine';

/**
 * Full audit pipeline, end to end.
 *
 * Runs in mock mode, which swaps out only the crawler — every scanner, the
 * normalizer, the severity engine, the scorer and the summary generation run
 * their real code paths against realistic data. That makes this a genuine
 * integration test of everything except the network layer.
 */

const env = getEnv({
  ...process.env,
  AUDIT_MOCK_MODE: 'true',
  AI_ENABLED: 'false',
  MAX_PAGES: '10',
} as NodeJS.ProcessEnv);

let outcome: AuditOutcome;
const stages: AuditStage[] = [];

beforeAll(async () => {
  resetEnvCache();
  outcome = await runAudit({
    auditId: 'integration-test-audit',
    url: 'https://example.com',
    env,
    onProgress: (progress) => {
      if (!stages.includes(progress.stage)) stages.push(progress.stage);
    },
  });
});

describe('pipeline output', () => {
  it('crawls pages and produces findings', () => {
    expect(outcome.crawl.pages.length).toBeGreaterThan(0);
    expect(outcome.crawl.pages.length).toBeLessThanOrEqual(env.MAX_PAGES);
    expect(outcome.findings.length).toBeGreaterThan(0);
  });

  it('produces a score inside the valid range with a matching band', () => {
    expect(outcome.overallScore).toBeGreaterThanOrEqual(0);
    expect(outcome.overallScore).toBeLessThanOrEqual(100);
    expect(outcome.scoreBand).toBeTruthy();
  });

  it('scores all seven categories', () => {
    expect(outcome.categoryScores).toHaveLength(7);
    for (const category of outcome.categoryScores) {
      expect(category.score).toBeGreaterThanOrEqual(0);
      expect(category.score).toBeLessThanOrEqual(100);
      expect(category.summary).toBeTruthy();
    }
  });

  it('reports progress through the stages in order', () => {
    expect(stages).toContain('Discovering pages');
    expect(stages).toContain('Checking links');
    expect(stages).toContain('Analyzing findings');
    expect(stages.at(-1)).toBe('Generating QA report');
  });

  it('always produces an executive summary and recommendations', () => {
    expect(outcome.executiveSummary.length).toBeGreaterThan(80);
    expect(outcome.recommendations.length).toBeGreaterThan(0);
  });

  it('identifies top issues that all reference real findings', () => {
    expect(outcome.topIssues.length).toBeGreaterThan(0);
    const ids = new Set(outcome.findings.map((f) => f.id));
    for (const issue of outcome.topIssues) {
      expect(ids.has(issue.findingId)).toBe(true);
    }
  });
});

describe('every finding is well formed', () => {
  it('carries evidence, a recommendation and a source scanner', () => {
    for (const finding of outcome.findings) {
      expect(finding.id, finding.ruleId).toBeTruthy();
      expect(finding.evidence.summary.trim().length, finding.ruleId).toBeGreaterThan(0);
      expect(finding.recommendation.trim().length, finding.ruleId).toBeGreaterThan(0);
      expect(finding.detectedBy, finding.ruleId).toBeTruthy();
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).toContain(finding.severity);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(finding.confidence);
    }
  });

  it('has unique finding ids after normalization', () => {
    const ids = outcome.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is sorted worst-first', () => {
    const rank = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 } as const;
    for (let i = 1; i < outcome.findings.length; i += 1) {
      expect(rank[outcome.findings[i - 1]!.severity]).toBeGreaterThanOrEqual(
        rank[outcome.findings[i]!.severity],
      );
    }
  });

  it('starts every finding in PENDING_REVIEW', () => {
    // Nothing reaches a client until a QA engineer has triaged it.
    for (const finding of outcome.findings) {
      expect(finding.status).toBe('PENDING_REVIEW');
    }
  });
});

describe('scanner coverage', () => {
  it('runs all nine registered scanners', () => {
    expect(SCANNERS).toHaveLength(9);
    const ids = SCANNERS.map((scanner) => scanner.id).sort();
    expect(ids).toEqual([
      'accessibility',
      'broken-links',
      'console',
      'forms',
      'performance',
      'responsive',
      'security',
      'technical',
      'ux',
    ]);
  });

  it('produces findings from several different scanners', () => {
    const contributors = new Set(outcome.findings.map((f) => f.detectedBy.split(',')[0]!.trim()));
    expect(contributors.size).toBeGreaterThanOrEqual(4);
  });

  it('records passed checks as well as failures', () => {
    expect(outcome.passedChecks.length).toBeGreaterThan(0);
    for (const check of outcome.passedChecks) {
      expect(check.title).toBeTruthy();
      expect(check.detail).toBeTruthy();
    }
  });
});

describe('product safety guarantees', () => {
  it('never reports a critical finding from mock data', () => {
    // The severity engine caps mock-mode findings, because nothing was
    // measured against a real site.
    expect(outcome.findings.some((f) => f.severity === 'CRITICAL')).toBe(false);
  });

  it('flags forms for manual testing rather than submitting them', () => {
    const formFindings = outcome.findings.filter((f) => f.ruleId.startsWith('forms.'));
    const manualNote = formFindings.find((f) =>
      f.ruleId.endsWith('manual-testing-recommended'),
    );

    expect(manualNote).toBeDefined();
    expect(manualNote!.severity).toBe('INFO');
    expect(manualNote!.title).toContain('manual functional testing');
    expect(String(manualNote!.evidence.details?.notSubmittedReason)).toContain('never');
  });

  it('labels security findings as a baseline, not a penetration test', () => {
    const securityFindings = outcome.findings.filter((f) => f.category === 'SECURITY');
    for (const finding of securityFindings) {
      expect(finding.description).toContain('not a penetration test');
    }
  });

  it('never claims WCAG compliance or certification', () => {
    const text = [
      outcome.executiveSummary,
      ...outcome.recommendations,
      ...outcome.findings.map((f) => `${f.title} ${f.description} ${f.recommendation}`),
    ]
      .join(' ')
      .toLowerCase();

    expect(text).not.toContain('wcag compliant');
    expect(text).not.toContain('fully compliant');
    expect(text).not.toContain('certified');
    expect(text).not.toContain('guarantee');
  });

  it('caveats performance results as environment-dependent', () => {
    const performanceFindings = outcome.findings.filter((f) => f.category === 'PERFORMANCE');
    if (performanceFindings.length > 0) {
      const caveated = performanceFindings.filter((f) =>
        f.description.toLowerCase().includes('vary with network'),
      );
      expect(caveated.length).toBeGreaterThan(0);
    }
  });

  it('leaks no credentials into any finding', () => {
    const serialized = JSON.stringify(outcome.findings);
    expect(serialized).not.toMatch(/Bearer [A-Za-z0-9._~+/-]{12,}/);
    expect(serialized).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\./);
    expect(serialized).not.toMatch(/password["'\s]*[:=]["'\s]*[^\s",;&}]{4,}/i);
  });
});

describe('AI degradation', () => {
  it('completes without the AI layer and says so', () => {
    expect(outcome.aiAnalysisUsed).toBe(false);
    // The report is still complete: deterministic fallbacks filled every gap.
    expect(outcome.executiveSummary).toBeTruthy();
    expect(outcome.recommendations.length).toBeGreaterThan(0);
    expect(outcome.topIssues.length).toBeGreaterThan(0);
  });

  it('still produces a full report when the AI key is missing', async () => {
    const withAiEnabledButNoKey = getEnv({
      ...process.env,
      AUDIT_MOCK_MODE: 'true',
      AI_ENABLED: 'true',
      ANTHROPIC_API_KEY: '',
    } as NodeJS.ProcessEnv);

    const result = await runAudit({
      auditId: 'ai-missing-key',
      url: 'https://example.com',
      env: withAiEnabledButNoKey,
    });

    expect(result.aiAnalysisUsed).toBe(false);
    expect(result.aiFailureReason).toContain('ANTHROPIC_API_KEY');
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.executiveSummary).toBeTruthy();
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
  });
});

describe('determinism', () => {
  it('produces the same score for the same site on a re-run', async () => {
    const second = await runAudit({
      auditId: 'determinism-check',
      url: 'https://example.com',
      env,
    });

    expect(second.overallScore).toBe(outcome.overallScore);
    expect(second.findings.length).toBe(outcome.findings.length);
    expect(second.findings.map((f) => f.ruleId)).toEqual(outcome.findings.map((f) => f.ruleId));
  });
});

describe('SSRF refusal reaches the pipeline boundary', () => {
  it('refuses to audit a private address even in mock mode', async () => {
    await expect(
      runAudit({ auditId: 'ssrf-test', url: 'http://192.168.1.1', env }),
    ).rejects.toThrow(/private network/i);
  });

  it('refuses non-http protocols', async () => {
    await expect(
      runAudit({ auditId: 'ssrf-protocol', url: 'file:///etc/passwd', env }),
    ).rejects.toThrow(/http/i);
  });
});
