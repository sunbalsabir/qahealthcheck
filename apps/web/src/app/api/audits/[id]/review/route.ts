import type { NextRequest } from 'next/server';
import { auditIdSchema, submitReviewSchema } from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { calculateReviewedScore } from '@qualovix/audit-engine';
import { apiError, handleApiError, ok, readJson } from '@/lib/api';
import { requireSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/audits/:id/review — the human QA review step.
 *
 * This is the layer that makes the product "Automated + Human QA Reviewed".
 * A QA engineer marks each finding Keep / Ignore / Edit / Change Severity,
 * optionally attaches a note ("Confirmed manually — reproduces in Chrome and
 * Firefox"), and approves. Only approved findings reach the client report.
 *
 * Approving also recalculates the score from the kept findings, so a report
 * never shows a score that includes issues the reviewer dismissed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const auditId = auditIdSchema.parse(id);

    const body = await readJson(request);
    const input = submitReviewSchema.parse(body);

    const repository = await getRepository();
    const audit = await repository.getAuditDetail(auditId);
    if (!audit) return apiError('That audit could not be found.', 'not_found', 404);

    if (audit.status === 'PENDING' || audit.status === 'SCANNING' || audit.status === 'ANALYZING') {
      return apiError(
        'This audit is still running. Wait for the scan to finish before reviewing it.',
        'audit_in_progress',
        409,
      );
    }

    // Reject decisions referencing findings that do not belong to this audit.
    const validIds = new Set(audit.findings.map((finding) => finding.id));
    const unknown = input.decisions.filter((decision) => !validIds.has(decision.findingId));
    if (unknown.length > 0) {
      return apiError(
        `${unknown.length} of the submitted decisions reference findings that are not part of this audit.`,
        'unknown_finding',
        400,
        { findingIds: unknown.map((d) => d.findingId) },
      );
    }

    // Apply the decisions to a local copy first, so the score that gets
    // persisted is computed from exactly the findings the reviewer kept.
    // Without this the report and results page would show the pre-review
    // number while listing only the kept findings — a score that does not
    // match its own evidence.
    const decisionsById = new Map(input.decisions.map((d) => [d.findingId, d]));
    const afterReview = audit.findings.map((finding) => {
      const decision = decisionsById.get(finding.id);
      if (!decision) return finding;
      return {
        ...finding,
        status: decision.status,
        severity: decision.severity ?? finding.severity,
      };
    });

    const reviewedScore = calculateReviewedScore(afterReview, audit.passedChecks);

    await repository.submitReview({
      auditId,
      reviewerId: session.id,
      decisions: input.decisions.map((decision) => ({ ...decision, reviewerId: session.id })),
      engineerNotes: input.engineerNotes,
      scoreOverride: input.scoreOverride,
      // The audit's own overallScore stays as the engine produced it, so the
      // admin UI can still show what the review changed.
      reviewedScore: reviewedScore.overall,
      approve: input.approve,
    });

    const updated = await repository.getAuditDetail(auditId);

    return ok({
      auditId,
      approved: input.approve,
      reviewedBy: session.email,
      decisionsApplied: input.decisions.length,
      review: updated?.review ?? null,
      // The score the client will see, recalculated from kept findings only.
      reviewedScore: input.scoreOverride ?? reviewedScore.overall,
      reviewedBand: reviewedScore.band.label,
      categoryScores: reviewedScore.categories,
    });
  } catch (error) {
    return handleApiError(error, 'audits.review');
  }
}
