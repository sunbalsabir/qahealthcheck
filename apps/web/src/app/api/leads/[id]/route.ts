import type { NextRequest } from 'next/server';
import { updateLeadSchema } from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { apiError, handleApiError, ok, readJson } from '@/lib/api';
import { requireSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/leads/:id — update follow-up status and internal notes.
 *
 * Follow-up is a manual decision by the agency. The system never contacts a
 * lead on its own; the spec is explicit that users must not be spammed.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;

    const body = await readJson(request);
    const input = updateLeadSchema.parse(body);

    const repository = await getRepository();
    const lead = await repository.updateLead(id, input);
    if (!lead) return apiError('That lead could not be found.', 'not_found', 404);

    return ok({ lead });
  } catch (error) {
    return handleApiError(error, 'leads.update');
  }
}
