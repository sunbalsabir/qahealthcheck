import type { NextRequest } from 'next/server';
import { createAuditSchema, getEnv } from '@qualovix/shared';
import { getAuditQueue, getRepository } from '@qualovix/data';
import { assertSafeUrl, getRegistrableDomain, normalizeUrl } from '@qualovix/audit-engine';
import { apiError, created, handleApiError, readJson } from '@/lib/api';
import { checkRateLimits, clientIpFrom } from '@/lib/rate-limit';
import { ensureAuditWorker } from '@/lib/audit-runner';
import { requireSession } from '@/lib/auth';
import { auditListQuerySchema } from '@qualovix/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/audits — start a free QA health check.
 *
 * Order of operations matters here:
 *
 *   1. Validate the payload shape.
 *   2. Reject the honeypot silently-ish (bots fill hidden fields).
 *   3. SSRF-validate the URL *before* anything is written or queued, so a
 *      request aimed at internal infrastructure never creates a job at all.
 *   4. Apply rate limits.
 *   5. Create the lead, create the audit, enqueue the job, return immediately.
 *
 * The response returns as soon as the job is queued — the scan itself runs in
 * the background and the client polls the progress endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    const env = getEnv();
    const body = await readJson(request);
    const input = createAuditSchema.parse(body);

    // Honeypot: a real browser leaves this hidden field empty.
    if (input.website2) {
      return apiError('Request rejected.', 'rejected', 400);
    }

    // SSRF validation up front. Structural checks, hostname screening and DNS
    // resolution all run before a record exists or a job is queued.
    const validated = await assertSafeUrl(input.url, { env });
    const normalizedUrl = normalizeUrl(validated.url);
    const domain = getRegistrableDomain(validated.url.hostname);

    const ip = clientIpFrom(request.headers);
    const limit = await checkRateLimits({ ip, domain, email: input.email || undefined });
    if (!limit.allowed) {
      return apiError(limit.reason ?? 'Rate limit reached.', 'rate_limited', 429, {
        scope: limit.scope,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const repository = await getRepository();

    // Capture the lead whenever any contact detail was supplied. A URL alone
    // is an anonymous audit and creates no lead record.
    const hasLeadDetails = Boolean(
      input.companyName || input.contactName || input.email || input.industry || input.focusAreas,
    );
    const lead = hasLeadDetails
      ? await repository.createLead({
          companyName: input.companyName || undefined,
          contactName: input.contactName || undefined,
          email: input.email || undefined,
          website: normalizedUrl,
          industry: input.industry || undefined,
          focusAreas: input.focusAreas || undefined,
          sourceIp: ip,
        })
      : null;

    const audit = await repository.createAudit({
      url: validated.url.toString(),
      normalizedUrl,
      domain,
      requestedIp: ip,
      mockMode: env.AUDIT_MOCK_MODE,
      leadId: lead?.id,
    });

    // The inline queue driver needs its handler registered in this process.
    await ensureAuditWorker();
    await getAuditQueue().enqueue({ auditId: audit.id, url: audit.url });

    return created({
      id: audit.id,
      url: audit.url,
      status: audit.status,
      mockMode: audit.mockMode,
      statusUrl: `/api/audits/${audit.id}`,
      resultsUrl: `/audit/${audit.id}`,
    });
  } catch (error) {
    return handleApiError(error, 'audits.create');
  }
}

/**
 * GET /api/audits — list audits. Admin only; this is the dashboard's feed.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSession();

    const params = Object.fromEntries(request.nextUrl.searchParams);
    const query = auditListQuerySchema.parse(params);

    const repository = await getRepository();
    const result = await repository.listAudits(query);

    return Response.json(result);
  } catch (error) {
    return handleApiError(error, 'audits.list');
  }
}
