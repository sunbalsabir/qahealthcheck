import type { NextRequest } from 'next/server';
import { CATEGORIES, SEVERITIES, auditIdSchema, type Severity } from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { apiError, handleApiError, ok } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/audits/:id/findings
 *
 * Findings for one audit, optionally filtered by severity or category.
 * Ignored findings are visible to admins only — the whole point of the
 * review step is that a visitor sees the reviewed set.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const auditId = auditIdSchema.parse(id);

    const repository = await getRepository();
    const audit = await repository.getAuditDetail(auditId);
    if (!audit) return apiError('That audit could not be found.', 'not_found', 404);

    const isAdmin = Boolean(await getSessionUser());

    const severityParam = request.nextUrl.searchParams.get('severity');
    const categoryParam = request.nextUrl.searchParams.get('category');

    let findings = audit.findings;
    if (!isAdmin) findings = findings.filter((finding) => finding.status !== 'IGNORED');

    if (severityParam && (SEVERITIES as readonly string[]).includes(severityParam)) {
      findings = findings.filter((finding) => finding.severity === severityParam);
    }
    if (categoryParam && (CATEGORIES as readonly string[]).includes(categoryParam)) {
      findings = findings.filter((finding) => finding.category === categoryParam);
    }

    const counts = SEVERITIES.reduce<Record<Severity, number>>(
      (acc, severity) => {
        acc[severity] = audit.findings.filter((f) => f.severity === severity).length;
        return acc;
      },
      { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    );

    return ok({
      auditId,
      total: findings.length,
      counts,
      passedChecks: audit.passedChecks,
      findings,
    });
  } catch (error) {
    return handleApiError(error, 'audits.findings');
  }
}
