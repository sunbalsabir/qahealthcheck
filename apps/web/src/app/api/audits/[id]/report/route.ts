import type { NextRequest } from 'next/server';
import { auditIdSchema } from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { generateReport, reportFileName } from '@qualovix/reporting';
import { apiError, handleApiError, ok } from '@/lib/api';
import { requireSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/audits/:id/report — download the Qualovix PDF report.
 *
 * Rendered on demand rather than stored, so the report always reflects the
 * current review state: fix a finding's wording in the admin UI and the next
 * download carries it. The report record is written for audit history.
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
    if (!audit) return apiError('That audit could not be found.', 'not_found', 404);

    if (audit.status === 'FAILED') {
      return apiError('This audit failed, so no report is available.', 'audit_failed', 409);
    }
    if (!audit.overallScore && audit.overallScore !== 0) {
      return apiError(
        'This audit has not finished yet. The report will be available once the scan completes.',
        'audit_in_progress',
        409,
      );
    }

    const generatedAt = new Date();
    const report = await generateReport({ audit, reviewedOnly: true, generatedAt });

    await repository.recordReport({
      auditId,
      byteSize: report.byteSize,
      includesAi: report.includesAi,
      reviewed: report.reviewed,
    });

    return new Response(new Uint8Array(report.buffer), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${reportFileName(audit, generatedAt)}"`,
        'content-length': String(report.byteSize),
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return handleApiError(error, 'audits.report.get');
  }
}

/**
 * POST /api/audits/:id/report — regenerate and record a report version.
 * Admin only; used after a review to produce the client-ready version.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;
    const auditId = auditIdSchema.parse(id);

    const repository = await getRepository();
    const audit = await repository.getAuditDetail(auditId);
    if (!audit) return apiError('That audit could not be found.', 'not_found', 404);

    const report = await generateReport({ audit, reviewedOnly: true });
    const record = await repository.recordReport({
      auditId,
      byteSize: report.byteSize,
      includesAi: report.includesAi,
      reviewed: report.reviewed,
    });

    return ok({
      report: record,
      findingCount: report.findingCount,
      reviewed: report.reviewed,
      downloadUrl: `/api/audits/${auditId}/report`,
    });
  } catch (error) {
    return handleApiError(error, 'audits.report.create');
  }
}
