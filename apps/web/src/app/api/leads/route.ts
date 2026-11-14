import type { NextRequest } from 'next/server';
import { LEAD_FOLLOW_UP_STATUSES, createLeadSchema, type LeadFollowUpStatus } from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { created, handleApiError, ok, readJson } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { checkRateLimits, clientIpFrom } from '@/lib/rate-limit';
import { assertSafeUrl, normalizeUrl } from '@qualovix/audit-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/leads — the agency's lead list. Admin only, since it holds
 * contact details supplied by prospects.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSession();

    const statusParam = request.nextUrl.searchParams.get('status');
    const status = (LEAD_FOLLOW_UP_STATUSES as readonly string[]).includes(statusParam ?? '')
      ? (statusParam as LeadFollowUpStatus)
      : undefined;

    const page = Number(request.nextUrl.searchParams.get('page') ?? '1') || 1;
    const pageSize = Math.min(100, Number(request.nextUrl.searchParams.get('pageSize') ?? '50') || 50);

    const repository = await getRepository();
    const result = await repository.listLeads({ status, page, pageSize });

    return ok(result);
  } catch (error) {
    return handleApiError(error, 'leads.list');
  }
}

/**
 * POST /api/leads — capture a lead without starting an audit (for example
 * from a "talk to us" form). Rate limited like the audit endpoint, because
 * it is equally public.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson(request);
    const input = createLeadSchema.parse(body);

    const validated = await assertSafeUrl(input.website);
    const ip = clientIpFrom(request.headers);

    const limit = await checkRateLimits({
      ip,
      domain: validated.hostname,
      email: input.email,
    });
    if (!limit.allowed) {
      return Response.json(
        { error: limit.reason, code: 'rate_limited' },
        { status: 429 },
      );
    }

    const repository = await getRepository();
    const lead = await repository.createLead({
      companyName: input.companyName,
      contactName: input.contactName,
      email: input.email,
      website: normalizeUrl(validated.url),
      industry: input.industry,
      focusAreas: input.focusAreas,
      sourceIp: ip,
    });

    // Only the id goes back: the caller supplied this data, and echoing it
    // gives an enumeration oracle nothing useful.
    return created({ id: lead.id, followUpStatus: lead.followUpStatus });
  } catch (error) {
    return handleApiError(error, 'leads.create');
  }
}
