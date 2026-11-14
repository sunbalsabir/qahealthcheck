import type { NextRequest } from 'next/server';
import { AUDIT_STAGES, auditIdSchema, type Finding } from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { apiError, handleApiError, ok } from '@/lib/api';
import { getSessionUser, requireSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/audits/:id
 *
 * Serves both the public progress/results screen and the admin detail view.
 * The audit id is an unguessable UUID and acts as the capability to view the
 * result, which is what lets a visitor come back to their report without an
 * account. Admin-only material (the lead's contact details, the internal
 * review record) is stripped for unauthenticated callers.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const auditId = auditIdSchema.parse(id);

    const repository = await getRepository();
    const audit = await repository.getAuditDetail(auditId);
    if (!audit) {
      return apiError('That audit could not be found.', 'not_found', 404);
    }

    const session = await getSessionUser();
    const isAdmin = Boolean(session);

    // While the scan is running, return progress only — there are no
    // findings to show yet and the client is polling.
    if (audit.status === 'PENDING' || audit.status === 'SCANNING' || audit.status === 'ANALYZING') {
      return ok({
        id: audit.id,
        url: audit.url,
        status: audit.status,
        stageIndex: audit.stageIndex,
        totalStages: audit.totalStages,
        currentStage: audit.currentStage ?? AUDIT_STAGES[0],
        progressDetail: audit.progressDetail,
        stages: AUDIT_STAGES,
        mockMode: audit.mockMode,
        complete: false,
      });
    }

    if (audit.status === 'FAILED') {
      return ok({
        id: audit.id,
        url: audit.url,
        status: audit.status,
        complete: true,
        failed: true,
        errorMessage: audit.errorMessage,
      });
    }

    return ok({
      ...audit,
      complete: true,
      failed: false,
      stages: AUDIT_STAGES,
      // Lead details and the internal review are admin-only.
      lead: isAdmin ? audit.lead : null,
      review: isAdmin ? audit.review : audit.review ? { approved: audit.review.approved } : null,
      findings: audit.findings
        // A visitor never sees findings a QA engineer chose to drop.
        .filter((finding) => isAdmin || finding.status !== 'IGNORED')
        .map((finding) => (isAdmin ? finding : stripInternal(finding))),
    });
  } catch (error) {
    return handleApiError(error, 'audits.get');
  }
}

/**
 * DELETE /api/audits/:id — admin only.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;
    const auditId = auditIdSchema.parse(id);

    const repository = await getRepository();
    const audit = await repository.getAudit(auditId);
    if (!audit) return apiError('That audit could not be found.', 'not_found', 404);

    await repository.deleteAudit(auditId);
    return ok({ deleted: true, id: auditId });
  } catch (error) {
    return handleApiError(error, 'audits.delete');
  }
}

/** Removes internal review metadata from a finding shown to a visitor. */
function stripInternal(finding: Finding): Omit<Finding, 'qaNote' | 'status'> {
  const { qaNote: _qaNote, status: _status, ...rest } = finding;
  return rest;
}
