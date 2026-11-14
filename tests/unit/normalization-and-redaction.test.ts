import { describe, expect, it } from 'vitest';
import { normalizeFindings, validateAgainstFindings } from '@qualovix/audit-engine';
import {
  redactHeaders,
  redactText,
  redactUrl,
  redactValue,
  sanitizeEvidenceText,
  truncate,
  type Finding,
  type ScannerResult,
} from '@qualovix/shared';
import { FindingCollector } from '@qualovix/scanners';

/**
 * Finding normalization, evidence redaction, and the AI traceability gate.
 *
 * Three product principles are enforced here rather than merely documented:
 *
 *   - Never fabricate a finding.
 *   - Every finding must have evidence.
 *   - Never expose credentials or sensitive information.
 */

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? 'finding-1',
    ruleId: 'test.rule',
    category: 'FUNCTIONAL',
    title: 'Test finding',
    description: 'Description.',
    severity: 'MEDIUM',
    confidence: 'HIGH',
    evidence: { summary: 'Observed something.' },
    recommendation: 'Fix it.',
    detectedBy: 'test',
    occurrences: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeResult(findings: Finding[], scannerId = 'test'): ScannerResult {
  return { scannerId, findings, passed: [], warnings: [], durationMs: 1 };
}

// ---------------------------------------------------------------------------
// Evidence enforcement
// ---------------------------------------------------------------------------

describe('evidence is mandatory', () => {
  it('drops a finding with no evidence and records why', () => {
    const withoutEvidence = makeFinding({
      id: 'no-evidence',
      evidence: { summary: '   ' },
    });
    const result = normalizeFindings([makeResult([withoutEvidence])]);

    expect(result.findings).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('no evidence');
  });

  it('the collector refuses to emit an evidence-free finding', () => {
    const collector = new FindingCollector('test', 'FUNCTIONAL');
    const emitted = collector.add({
      ruleId: 'test.empty',
      title: 'No evidence',
      description: 'Should be dropped.',
      severity: 'HIGH',
      confidence: 'HIGH',
      evidence: { summary: '' },
      recommendation: 'n/a',
    });

    expect(emitted).toBeNull();
    const result = collector.result();
    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toContain('no evidence');
  });

  it('caps how many instances of one rule are emitted, without losing the count', () => {
    const collector = new FindingCollector('test', 'FUNCTIONAL', 3);
    for (let i = 0; i < 10; i += 1) {
      collector.add({
        ruleId: 'test.repeated',
        title: `Instance ${i}`,
        description: 'Repeated finding.',
        severity: 'LOW',
        confidence: 'HIGH',
        url: `https://example.com/page-${i}`,
        evidence: { summary: `Instance ${i} observed.` },
        recommendation: 'Fix it.',
      });
    }

    const result = collector.result();
    expect(result.findings).toHaveLength(3);
    // The suppressed instances are still counted, so the report can say
    // "and 7 more" rather than silently under-reporting.
    expect(result.findings[0]!.occurrences).toBe(10);
    expect(result.findings[0]!.evidence.details?.additionalInstancesNotListed).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Duplicate merging
// ---------------------------------------------------------------------------

describe('normalizeFindings', () => {
  it('merges the same defect reported by two scanners', () => {
    // axe and the UX heuristic both flag missing alt text.
    const axeFinding = makeFinding({
      id: 'axe-alt',
      ruleId: 'accessibility.image-alt',
      category: 'ACCESSIBILITY',
      severity: 'HIGH',
      url: 'https://example.com/',
      detectedBy: 'accessibility',
    });
    const uxFinding = makeFinding({
      id: 'ux-alt',
      ruleId: 'ux.image-missing-alt',
      category: 'UX',
      severity: 'MEDIUM',
      url: 'https://example.com/',
      detectedBy: 'ux',
    });

    const result = normalizeFindings([
      makeResult([axeFinding], 'accessibility'),
      makeResult([uxFinding], 'ux'),
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(1);
    // The higher severity survives.
    expect(result.findings[0]!.severity).toBe('HIGH');
    // And the corroborating scanner is still credited.
    expect(result.findings[0]!.detectedBy).toContain('ux');
  });

  it('keeps the same rule on different pages as separate findings', () => {
    const first = makeFinding({ id: 'a', url: 'https://example.com/one' });
    const second = makeFinding({ id: 'b', url: 'https://example.com/two' });
    const result = normalizeFindings([makeResult([first, second])]);
    expect(result.findings).toHaveLength(2);
  });

  it('sorts by severity, then confidence, then occurrence count', () => {
    const findings = [
      makeFinding({ id: 'low', ruleId: 'r.low', severity: 'LOW', url: 'https://a.test/1' }),
      makeFinding({ id: 'crit', ruleId: 'r.crit', severity: 'CRITICAL', url: 'https://a.test/2' }),
      makeFinding({ id: 'med', ruleId: 'r.med', severity: 'MEDIUM', url: 'https://a.test/3' }),
      makeFinding({ id: 'high', ruleId: 'r.high', severity: 'HIGH', url: 'https://a.test/4' }),
    ];
    const result = normalizeFindings([makeResult(findings)]);
    expect(result.findings.map((f) => f.severity)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  });

  it('does not report a check as both passed and failed', () => {
    const finding = makeFinding({
      id: 'a',
      ruleId: 'technical.missing-title',
      category: 'TECHNICAL',
    });
    const result = normalizeFindings([
      {
        scannerId: 'technical',
        findings: [finding],
        passed: [
          {
            ruleId: 'technical.missing-title',
            category: 'TECHNICAL',
            title: 'All pages have a title',
            detail: 'Contradicts the finding above.',
            detectedBy: 'technical',
          },
        ],
        warnings: [],
        durationMs: 1,
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.passed).toHaveLength(0);
  });

  it('collects warnings from every scanner', () => {
    const result = normalizeFindings([
      { scannerId: 'a', findings: [], passed: [], warnings: ['warning one'], durationMs: 1 },
      { scannerId: 'b', findings: [], passed: [], warnings: ['warning two'], durationMs: 1 },
    ]);
    expect(result.warnings).toEqual(['warning one', 'warning two']);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('redaction', () => {
  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const output = redactText(`Auth failed for token ${jwt}`);
    expect(output).not.toContain(jwt);
    expect(output).toContain('[redacted-jwt]');
  });

  it('redacts bearer tokens and provider API keys', () => {
    expect(redactText('Authorization: Bearer abcdef1234567890xyz')).toContain('[redacted]');
    expect(redactText('key sk_live_abcdefghijklmnop123456')).toContain('[redacted-key]');
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toContain('[redacted-aws-key]');
    expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz1234')).toContain('[redacted-github-token]');
  });

  it('redacts email addresses and long numbers', () => {
    expect(redactText('Contact person@example.com')).toContain('[redacted-email]');
    expect(redactText('card 4111111111111111')).toContain('[redacted-number]');
  });

  it('redacts password and secret assignments', () => {
    expect(redactText('password=hunter2000')).not.toContain('hunter2000');
    expect(redactText('"api_key": "abcd1234efgh"')).not.toContain('abcd1234efgh');
  });

  it('strips credentials and sensitive parameters from URLs', () => {
    expect(redactUrl('https://user:secret@example.com/path')).not.toContain('secret');
    const redacted = redactUrl('https://example.com/callback?access_token=abc123&page=2');
    expect(redacted).not.toContain('abc123');
    // Harmless parameters survive, so the URL stays useful as evidence.
    expect(redacted).toContain('page=2');
  });

  it('removes implicit-flow tokens from the fragment', () => {
    expect(redactUrl('https://example.com/#access_token=abc123')).not.toContain('abc123');
  });

  it('never reproduces the value of a sensitive header', () => {
    const headers = redactHeaders({
      'content-type': 'text/html',
      authorization: 'Bearer supersecrettoken',
      cookie: 'session=abc123; theme=dark',
      'set-cookie': 'session=xyz; HttpOnly',
      'x-api-key': 'key-12345',
    });

    expect(headers['content-type']).toBe('text/html');
    expect(headers.authorization).toBe('[redacted]');
    expect(headers.cookie).toBe('[redacted]');
    expect(headers['set-cookie']).toBe('[redacted]');
    expect(headers['x-api-key']).toBe('[redacted]');
  });

  it('deep-redacts nested objects by key name and by value shape', () => {
    const redacted = redactValue({
      safe: 'ordinary value',
      password: 'hunter2',
      nested: { apiKey: 'sk_live_abcdef1234567890', note: 'reach me at a@b.com' },
      list: ['https://example.com/?token=abc123'],
    }) as Record<string, unknown>;

    expect(redacted.safe).toBe('ordinary value');
    expect(redacted.password).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect(String((redacted.nested as Record<string, unknown>).note)).toContain('[redacted-email]');
    expect(String((redacted.list as string[])[0])).not.toContain('abc123');
  });

  it('is applied automatically to everything a scanner emits', () => {
    const collector = new FindingCollector('test', 'FUNCTIONAL');
    collector.add({
      ruleId: 'test.leak',
      title: 'Leaky finding',
      description: 'Test.',
      severity: 'HIGH',
      confidence: 'HIGH',
      url: 'https://example.com/callback?access_token=supersecret',
      evidence: {
        summary: 'Request failed with Authorization: Bearer verysecrettoken123456',
        observed: 'password=hunter2000',
        details: { cookie: 'session=abc123' },
      },
      recommendation: 'Fix it.',
    });

    const [finding] = collector.result().findings;
    expect(finding!.url).not.toContain('supersecret');
    expect(finding!.evidence.summary).not.toContain('verysecrettoken123456');
    expect(finding!.evidence.observed).not.toContain('hunter2000');
    expect(JSON.stringify(finding!.evidence.details)).not.toContain('abc123');
  });

  it('truncates runaway text so one console message cannot bloat a report', () => {
    const long = 'x'.repeat(5000);
    expect(truncate(long, 100).length).toBeLessThan(200);
    expect(sanitizeEvidenceText(long, 100).length).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// AI traceability gate
// ---------------------------------------------------------------------------

describe('AI output is validated against real findings', () => {
  const realFindings = [
    makeFinding({ id: 'real-1', severity: 'HIGH', title: 'Real finding one' }),
    makeFinding({ id: 'real-2', severity: 'LOW', title: 'Real finding two' }),
  ];

  it('discards enrichment for findings that do not exist', () => {
    const result = validateAgainstFindings(
      {
        executiveSummary: 'Summary.',
        topIssues: [],
        recommendations: [],
        enrichment: [
          { findingId: 'real-1', summary: 'Legitimate enrichment.' },
          { findingId: 'hallucinated-id', summary: 'Invented enrichment.' },
        ],
        duplicateGroups: [],
      },
      realFindings,
    );

    expect(result.enrichment['real-1']).toBeDefined();
    expect(result.enrichment['hallucinated-id']).toBeUndefined();
  });

  it('discards invented top issues', () => {
    const result = validateAgainstFindings(
      {
        executiveSummary: 'Summary.',
        topIssues: [
          { findingId: 'real-1', title: 'Real finding one', severity: 'HIGH', whyItMatters: 'Because.' },
          {
            findingId: 'does-not-exist',
            title: 'Your database is publicly exposed',
            severity: 'CRITICAL',
            whyItMatters: 'Entirely invented.',
          },
        ],
        recommendations: [],
        enrichment: [],
        duplicateGroups: [],
      },
      realFindings,
    );

    expect(result.topIssues).toHaveLength(1);
    expect(result.topIssues[0]!.findingId).toBe('real-1');
  });

  it('overrides any severity the model tries to assert', () => {
    const result = validateAgainstFindings(
      {
        executiveSummary: 'Summary.',
        topIssues: [
          {
            findingId: 'real-2',
            title: 'Renamed by the model',
            // The model claims CRITICAL; the real finding is LOW.
            severity: 'CRITICAL',
            whyItMatters: 'Model opinion.',
          },
        ],
        recommendations: [],
        enrichment: [],
        duplicateGroups: [],
      },
      realFindings,
    );

    // Severity and title come from our data, never from the model's echo.
    expect(result.topIssues[0]!.severity).toBe('LOW');
    expect(result.topIssues[0]!.title).toBe('Real finding two');
  });

  it('falls back to the worst real findings when the model returns nothing usable', () => {
    const result = validateAgainstFindings(
      {
        executiveSummary: 'Summary.',
        topIssues: [],
        recommendations: [],
        enrichment: [],
        duplicateGroups: [],
      },
      realFindings,
    );

    expect(result.topIssues.length).toBeGreaterThan(0);
    expect(result.topIssues.every((issue) => ['real-1', 'real-2'].includes(issue.findingId))).toBe(
      true,
    );
  });

  it('ignores duplicate groups referencing unknown ids', () => {
    const result = validateAgainstFindings(
      {
        executiveSummary: 'Summary.',
        topIssues: [],
        recommendations: [],
        enrichment: [],
        duplicateGroups: [
          { canonicalId: 'real-1', duplicateIds: ['real-2', 'ghost-id'] },
          { canonicalId: 'ghost-canonical', duplicateIds: ['real-1'] },
        ],
      },
      realFindings,
    );

    expect(result.duplicateOf['real-2']).toBe('real-1');
    expect(result.duplicateOf['ghost-id']).toBeUndefined();
    expect(Object.values(result.duplicateOf)).not.toContain('ghost-canonical');
  });
});
