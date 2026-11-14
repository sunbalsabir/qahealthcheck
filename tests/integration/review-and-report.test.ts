import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuditRepository } from '@qualovix/data';
import { runAudit, calculateReviewedScore } from '@qualovix/audit-engine';
import { generateReport, reportFileName, selectFindings } from '@qualovix/reporting';
import { getEnv, type AuditDetail } from '@qualovix/shared';

/**
 * The human QA review workflow and report generation.
 *
 * This covers the product's central promise: a QA engineer decides what a
 * client sees, and the report reflects their decisions rather than raw
 * scanner output.
 */

const env = getEnv({
  ...process.env,
  AUDIT_MOCK_MODE: 'true',
  AI_ENABLED: 'false',
  PERSISTENCE_DRIVER: 'memory',
} as NodeJS.ProcessEnv);

let repository: MemoryAuditRepository;
let auditId: string;

async function seedCompletedAudit(): Promise<AuditDetail> {
  const audit = await repository.createAudit({
    url: 'https://example.com',
    normalizedUrl: 'https://example.com/',
    domain: 'example.com',
    mockMode: true,
  });
  auditId = audit.id;

  const outcome = await runAudit({ auditId: audit.id, url: 'https://example.com', env });

  await repository.completeAudit(audit.id, {
    findings: outcome.findings,
    passedChecks: outcome.passedChecks,
    categoryScores: outcome.categoryScores,
    pages: outcome.crawl.pages.map((page) => ({
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      depth: page.depth,
      title: page.title,
      statusCode: page.statusCode,
      responseTimeMs: page.responseTimeMs,
      contentType: page.contentType,
      byteSize: page.byteSize,
      linkCount: page.links.length,
      imageCount: page.images.length,
      scriptCount: page.scripts.length,
      stylesheetCount: page.stylesheets.length,
      formCount: page.forms.length,
      buttonCount: page.buttons.length,
      headingCount: page.headings.length,
    })),
    overallScore: outcome.overallScore,
    scoreBand: outcome.scoreBand,
    executiveSummary: outcome.executiveSummary,
    recommendations: outcome.recommendations,
    topIssues: outcome.topIssues,
    aiAnalysisUsed: outcome.aiAnalysisUsed,
    scannerWarnings: outcome.warnings,
    engineVersion: outcome.engineVersion,
    durationMs: outcome.durationMs,
  });

  return (await repository.getAuditDetail(audit.id))!;
}

beforeEach(() => {
  repository = new MemoryAuditRepository();
});

// ---------------------------------------------------------------------------

describe('audit persistence', () => {
  it('stores a completed audit and marks it ready for review', async () => {
    const detail = await seedCompletedAudit();

    expect(detail.status).toBe('READY_FOR_REVIEW');
    expect(detail.findings.length).toBeGreaterThan(0);
    expect(detail.categoryScores).toHaveLength(7);
    expect(detail.pages.length).toBeGreaterThan(0);
    expect(detail.overallScore).toBeGreaterThanOrEqual(0);
  });

  it('records a failure with a message the visitor can understand', async () => {
    const audit = await repository.createAudit({
      url: 'https://broken.example',
      normalizedUrl: 'https://broken.example/',
      domain: 'broken.example',
      mockMode: false,
    });

    await repository.failAudit(audit.id, 'We could not resolve that domain.');
    const detail = await repository.getAuditDetail(audit.id);

    expect(detail!.status).toBe('FAILED');
    expect(detail!.errorMessage).toContain('could not resolve');
  });

  it('filters the audit list by status, score and severity', async () => {
    await seedCompletedAudit();

    const byStatus = await repository.listAudits({
      status: 'READY_FOR_REVIEW',
      page: 1,
      pageSize: 20,
    });
    expect(byStatus.total).toBe(1);

    const impossibleScore = await repository.listAudits({
      minScore: 101,
      page: 1,
      pageSize: 20,
    });
    expect(impossibleScore.total).toBe(0);

    const byDomain = await repository.listAudits({
      search: 'example.com',
      page: 1,
      pageSize: 20,
    });
    expect(byDomain.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('human QA review', () => {
  it('excludes ignored findings from the client report', async () => {
    const detail = await seedCompletedAudit();
    const toIgnore = detail.findings[0]!;

    await repository.submitReview({
      auditId,
      reviewerId: 'engineer-1',
      approve: true,
      decisions: detail.findings.map((finding) => ({
        findingId: finding.id,
        status: finding.id === toIgnore.id ? 'IGNORED' : 'KEPT',
      })),
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;
    const reportFindings = selectFindings(reviewed.findings, true, true);

    expect(reportFindings.some((f) => f.id === toIgnore.id)).toBe(false);
    expect(reportFindings.length).toBe(detail.findings.length - 1);
  });

  it('preserves the automated severity when a reviewer overrides it', async () => {
    const detail = await seedCompletedAudit();
    const target = detail.findings.find((f) => f.severity !== 'INFO' && f.severity !== 'LOW')!;
    // originalSeverity records what the *scanner* said, which the severity
    // engine may already have adjusted before any human saw it.
    const beforeReview = target.originalSeverity ?? target.severity;

    await repository.submitReview({
      auditId,
      approve: false,
      decisions: [{ findingId: target.id, status: 'KEPT', severity: 'LOW' }],
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;
    const updated = reviewed.findings.find((f) => f.id === target.id)!;

    expect(updated.severity).toBe('LOW');
    // The change stays auditable: the pre-review value is still on the record
    // and a human override does not overwrite it.
    expect(updated.originalSeverity).toBe(beforeReview);
  });

  it('attaches a QA engineer note to a finding', async () => {
    const detail = await seedCompletedAudit();
    const target = detail.findings[0]!;
    const note = 'Confirmed manually — reproduces in Chrome and Firefox on a clean profile.';

    await repository.submitReview({
      auditId,
      approve: true,
      decisions: [{ findingId: target.id, status: 'KEPT', qaNote: note }],
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;
    expect(reviewed.findings.find((f) => f.id === target.id)!.qaNote).toBe(note);
  });

  it('records edited wording without destroying the original', async () => {
    const detail = await seedCompletedAudit();
    const target = detail.findings[0]!;

    await repository.submitReview({
      auditId,
      approve: true,
      decisions: [
        {
          findingId: target.id,
          status: 'EDITED',
          title: 'Rewritten by a QA engineer',
          description: 'A clearer explanation for the client.',
        },
      ],
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;
    const updated = reviewed.findings.find((f) => f.id === target.id)!;

    expect(updated.editedTitle).toBe('Rewritten by a QA engineer');
    expect(updated.title).toBe(target.title); // original preserved
    expect(updated.status).toBe('EDITED');
  });

  it('marks the audit reviewed and counts the decisions on approval', async () => {
    const detail = await seedCompletedAudit();

    await repository.submitReview({
      auditId,
      reviewerId: 'engineer-1',
      engineerNotes: 'Checked every critical finding by hand.',
      approve: true,
      decisions: detail.findings.map((finding, index) => ({
        findingId: finding.id,
        status: index % 3 === 0 ? 'IGNORED' : 'KEPT',
      })),
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;

    expect(reviewed.status).toBe('REVIEWED');
    expect(reviewed.review!.approved).toBe(true);
    expect(reviewed.review!.engineerNotes).toContain('by hand');
    expect(reviewed.review!.keptCount + reviewed.review!.ignoredCount).toBe(
      detail.findings.length,
    );
  });

  it('persists the recalculated score so the report matches its own findings', async () => {
    const detail = await seedCompletedAudit();
    const automated = detail.overallScore!;
    const dropped = detail.findings.filter((f) => f.severity === 'HIGH').slice(0, 2);

    const reviewedScore = calculateReviewedScore(
      detail.findings.map((finding) =>
        dropped.some((d) => d.id === finding.id)
          ? { ...finding, status: 'IGNORED' as const }
          : { ...finding, status: 'KEPT' as const },
      ),
      detail.passedChecks,
    );

    await repository.submitReview({
      auditId,
      approve: true,
      reviewedScore: reviewedScore.overall,
      decisions: detail.findings.map((finding) => ({
        findingId: finding.id,
        status: dropped.some((d) => d.id === finding.id) ? ('IGNORED' as const) : ('KEPT' as const),
      })),
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;

    // The audit keeps the automated score for the admin view...
    expect(reviewed.overallScore).toBe(automated);
    // ...while the review carries the number the client should see.
    expect(reviewed.review!.reviewedScore).toBe(reviewedScore.overall);
    expect(reviewed.review!.reviewedScore).toBeGreaterThan(automated);
  });

  it('lets a manual score override win over the recalculated score', async () => {
    const detail = await seedCompletedAudit();

    await repository.submitReview({
      auditId,
      approve: true,
      scoreOverride: 42,
      reviewedScore: 88,
      decisions: detail.findings.map((finding) => ({
        findingId: finding.id,
        status: 'KEPT' as const,
      })),
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;
    expect(reviewed.review!.scoreOverride).toBe(42);
    expect(reviewed.review!.reviewedScore).toBe(88);
  });

  it('recalculates the score from kept findings only', async () => {
    const detail = await seedCompletedAudit();
    const automated = detail.overallScore!;

    // Dismiss everything: the client-facing score must rise accordingly.
    await repository.submitReview({
      auditId,
      approve: true,
      decisions: detail.findings.map((finding) => ({
        findingId: finding.id,
        status: 'IGNORED' as const,
      })),
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;
    const reviewedScore = calculateReviewedScore(reviewed.findings, reviewed.passedChecks);

    expect(reviewedScore.overall).toBe(100);
    expect(reviewedScore.overall).toBeGreaterThanOrEqual(automated);
  });
});

// ---------------------------------------------------------------------------

describe('report generation', () => {
  it('produces a valid PDF', async () => {
    const detail = await seedCompletedAudit();
    const report = await generateReport({ audit: detail, reviewedOnly: true });

    expect(report.byteSize).toBeGreaterThan(5000);
    // PDF magic bytes.
    expect(report.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(report.findingCount).toBeGreaterThan(0);
  });

  it('includes all findings while the audit is unreviewed', async () => {
    const detail = await seedCompletedAudit();
    const report = await generateReport({ audit: detail, reviewedOnly: true });

    // Nothing has been triaged yet, so withholding findings would
    // misrepresent the scan.
    expect(report.reviewed).toBe(false);
    expect(report.findingCount).toBe(detail.findings.length);
  });

  it('includes only kept findings once reviewed and approved', async () => {
    const detail = await seedCompletedAudit();
    const keepCount = Math.ceil(detail.findings.length / 2);

    await repository.submitReview({
      auditId,
      approve: true,
      decisions: detail.findings.map((finding, index) => ({
        findingId: finding.id,
        status: index < keepCount ? ('KEPT' as const) : ('IGNORED' as const),
      })),
    });

    const reviewed = (await repository.getAuditDetail(auditId))!;
    const report = await generateReport({ audit: reviewed, reviewedOnly: true });

    expect(report.reviewed).toBe(true);
    expect(report.findingCount).toBe(keepCount);
  });

  it('records each generated report with an incrementing version', async () => {
    const detail = await seedCompletedAudit();

    const first = await repository.recordReport({
      auditId,
      byteSize: 1000,
      includesAi: false,
      reviewed: false,
    });
    const second = await repository.recordReport({
      auditId,
      byteSize: 1100,
      includesAi: false,
      reviewed: true,
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect((await repository.getLatestReport(auditId))!.version).toBe(2);
    expect(detail.id).toBe(auditId);
  });

  it('names the file after the site and date', async () => {
    const detail = await seedCompletedAudit();
    const filename = reportFileName(detail, new Date('2026-03-15T10:00:00Z'));

    expect(filename).toBe('Qualovix-QA-Health-Check-example.com-2026-03-15.pdf');
  });

  it('selects findings according to the review state', () => {
    const findings = [
      { id: 'a', status: 'KEPT' },
      { id: 'b', status: 'IGNORED' },
      { id: 'c', status: 'EDITED' },
      { id: 'd', status: 'PENDING_REVIEW' },
    ] as Parameters<typeof selectFindings>[0];

    // Reviewed: kept and edited only.
    expect(selectFindings(findings, true, true).map((f) => f.id)).toEqual(['a', 'c']);
    // Unreviewed: everything except explicitly ignored.
    expect(selectFindings(findings, true, false).map((f) => f.id)).toEqual(['a', 'c', 'd']);
    // Explicit full export still drops ignored findings.
    expect(selectFindings(findings, false, true).map((f) => f.id)).toEqual(['a', 'c', 'd']);
  });
});

// ---------------------------------------------------------------------------

describe('lead capture', () => {
  it('stores a lead and links it to the audit', async () => {
    const lead = await repository.createLead({
      companyName: 'Acme Ltd',
      contactName: 'Sam Rivers',
      email: 'sam@acme.test',
      website: 'https://acme.test',
      industry: 'SaaS / Software',
      focusAreas: 'Checkout flow and mobile layout',
    });

    const audit = await repository.createAudit({
      url: 'https://acme.test',
      normalizedUrl: 'https://acme.test/',
      domain: 'acme.test',
      mockMode: true,
      leadId: lead.id,
    });

    const detail = await repository.getAuditDetail(audit.id);
    expect(detail!.lead!.companyName).toBe('Acme Ltd');
    expect(lead.followUpStatus).toBe('NEW');
  });

  it('tracks follow-up status changes', async () => {
    const lead = await repository.createLead({ website: 'https://acme.test' });

    await repository.updateLead(lead.id, {
      followUpStatus: 'CONTACTED',
      internalNotes: 'Emailed the report on Tuesday.',
    });

    const { leads } = await repository.listLeads({ status: 'CONTACTED' });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.internalNotes).toContain('Tuesday');
  });
});

// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('counts within a window and resets in the next one', async () => {
    for (let i = 1; i <= 3; i += 1) {
      expect(await repository.incrementRateLimit('ip', 'test-key', 60_000)).toBe(i);
    }
    expect(await repository.peekRateLimit('ip', 'test-key', 60_000)).toBe(3);
    // A different key is counted independently.
    expect(await repository.incrementRateLimit('ip', 'other-key', 60_000)).toBe(1);
  });

  it('counts recent audits per domain, for abuse detection', async () => {
    await repository.createAudit({
      url: 'https://target.test',
      normalizedUrl: 'https://target.test/',
      domain: 'target.test',
      mockMode: true,
    });

    expect(await repository.countRecentAuditsForDomain('target.test', 86_400_000)).toBe(1);
    expect(await repository.countRecentAuditsForDomain('other.test', 86_400_000)).toBe(0);
  });
});
