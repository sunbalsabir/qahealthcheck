import Link from 'next/link';
import {
  AUDIT_STATUSES,
  SEVERITIES,
  auditListQuerySchema,
  formatMs,
  pluralize,
  type AuditStatus,
} from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { Card, Pill, scoreTone } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audits', robots: { index: false } };

const STATUS_TONE: Record<AuditStatus, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  PENDING: 'neutral',
  SCANNING: 'brand',
  ANALYZING: 'brand',
  READY_FOR_REVIEW: 'warning',
  REVIEWED: 'success',
  REPORT_GENERATED: 'success',
  FAILED: 'danger',
};

const STATUS_LABEL: Record<AuditStatus, string> = {
  PENDING: 'Pending',
  SCANNING: 'Scanning',
  ANALYZING: 'Analyzing',
  READY_FOR_REVIEW: 'Needs review',
  REVIEWED: 'Reviewed',
  REPORT_GENERATED: 'Report sent',
  FAILED: 'Failed',
};

export default async function AdminAuditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const flattened = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
  // Invalid filters fall back to defaults rather than erroring the page.
  const query = auditListQuerySchema.safeParse(flattened);
  const filters = query.success ? query.data : auditListQuerySchema.parse({});

  const repository = await getRepository();
  const result = await repository.listAudits(filters);

  const needingReview = result.audits.filter((a) => a.status === 'READY_FOR_REVIEW').length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-slate-900">Audits</h1>
          <p className="mt-1 text-sm text-slate-600">
            {result.total} {pluralize(result.total, 'audit')} total
            {needingReview > 0 ? ` · ${needingReview} awaiting QA review` : ''}
          </p>
        </div>
      </div>

      {/* --- filters --- */}
      <Card className="mt-6 p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <label htmlFor="search" className="sr-only">
              Search by URL, domain or lead
            </label>
            <input
              id="search"
              name="search"
              type="search"
              placeholder="Search URL, domain or lead email…"
              defaultValue={filters.search ?? ''}
              className="block w-full rounded-lg border-0 px-3.5 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-600"
            />
          </div>

          <div>
            <label htmlFor="status" className="sr-only">
              Filter by status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={filters.status ?? ''}
              className="block w-full rounded-lg border-0 py-2 pl-3 pr-8 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
            >
              <option value="">All statuses</option>
              {AUDIT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="severity" className="sr-only">
              Filter by severity present
            </label>
            <select
              id="severity"
              name="severity"
              defaultValue={filters.severity ?? ''}
              className="block w-full rounded-lg border-0 py-2 pl-3 pr-8 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
            >
              <option value="">Any severity</option>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  Has {severity.toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor="minScore" className="sr-only">
                Minimum score
              </label>
              <input
                id="minScore"
                name="minScore"
                type="number"
                min={0}
                max={100}
                placeholder="Min"
                defaultValue={filters.minScore ?? ''}
                className="block w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
              />
            </div>
            <div className="flex-1">
              <label htmlFor="maxScore" className="sr-only">
                Maximum score
              </label>
              <input
                id="maxScore"
                name="maxScore"
                type="number"
                min={0}
                max={100}
                placeholder="Max"
                defaultValue={filters.maxScore ?? ''}
                className="block w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
              />
            </div>
            <button
              type="submit"
              className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Filter
            </button>
          </div>
        </form>
      </Card>

      {/* --- list --- */}
      {result.audits.length === 0 ? (
        <Card className="mt-6 p-12 text-center">
          <p className="font-heading text-base font-bold text-slate-900">No audits found</p>
          <p className="mt-1.5 text-sm text-slate-600">
            {filters.search || filters.status
              ? 'Try relaxing the filters.'
              : 'Audits will appear here as prospects submit them.'}
          </p>
        </Card>
      ) : (
        <Card className="mt-6 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Website</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Status</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Score</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Findings</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Lead</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Created</th>
                  <th scope="col" className="px-5 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.audits.map((audit) => {
                  const tone = audit.overallScore !== null && audit.overallScore !== undefined
                    ? scoreTone(audit.overallScore)
                    : null;
                  return (
                    <tr key={audit.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <Link
                          href={`/admin/audits/${audit.id}`}
                          className="font-medium text-slate-900 hover:text-brand-700"
                        >
                          {audit.domain}
                        </Link>
                        {audit.mockMode ? (
                          <span className="ml-2">
                            <Pill tone="warning">mock</Pill>
                          </span>
                        ) : null}
                        <p className="mt-0.5 max-w-xs truncate text-xs text-slate-400">{audit.url}</p>
                      </td>
                      <td className="px-5 py-3">
                        <Pill tone={STATUS_TONE[audit.status]}>{STATUS_LABEL[audit.status]}</Pill>
                      </td>
                      <td className="px-5 py-3">
                        {tone ? (
                          <span className={`font-heading text-base font-bold tabular-nums ${tone.text}`}>
                            {audit.overallScore}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className="tabular-nums text-slate-700">{audit.findingCount}</span>
                        {audit.criticalCount > 0 ? (
                          <span className="ml-2">
                            <Pill tone="danger">{audit.criticalCount} critical</Pill>
                          </span>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-slate-600">
                        {audit.leadEmail ?? <span className="text-slate-300">anonymous</span>}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500">
                        {new Date(audit.createdAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                        })}
                        {audit.durationMs ? (
                          <span className="ml-1.5 text-slate-400">{formatMs(audit.durationMs)}</span>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Link
                          href={`/admin/audits/${audit.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {audit.status === 'READY_FOR_REVIEW' ? 'Review' : 'View'}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* --- pagination --- */}
      {result.total > result.pageSize ? (
        <nav className="mt-6 flex items-center justify-between" aria-label="Pagination">
          <p className="text-sm text-slate-600">
            Page {result.page} of {Math.ceil(result.total / result.pageSize)}
          </p>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link
                href={`/admin?${buildQuery(flattened, result.page - 1)}`}
                className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              >
                Previous
              </Link>
            ) : null}
            {result.page * result.pageSize < result.total ? (
              <Link
                href={`/admin?${buildQuery(flattened, result.page + 1)}`}
                className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              >
                Next
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function buildQuery(current: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (value && key !== 'page') params.set(key, value);
  }
  params.set('page', String(page));
  return params.toString();
}
