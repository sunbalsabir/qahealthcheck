import Link from 'next/link';
import {
  LEAD_FOLLOW_UP_STATUSES,
  pluralize,
  type LeadFollowUpStatus,
} from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { Card, scoreTone } from '@/components/ui';
import { LeadStatusSelect } from '@/components/lead-status-select';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Leads', robots: { index: false } };

const STATUS_LABEL: Record<LeadFollowUpStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  CONVERTED: 'Converted',
  NOT_INTERESTED: 'Not interested',
};

export default async function AdminLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const statusParam = Array.isArray(params.status) ? params.status[0] : params.status;
  const status = (LEAD_FOLLOW_UP_STATUSES as readonly string[]).includes(statusParam ?? '')
    ? (statusParam as LeadFollowUpStatus)
    : undefined;

  const repository = await getRepository();
  const { leads, total } = await repository.listLeads({ status });

  return (
    <div>
      <div>
        <h1 className="font-heading text-2xl font-bold text-slate-900">Leads</h1>
        <p className="mt-1 text-sm text-slate-600">
          {total} {pluralize(total, 'lead')} captured from free QA health checks.
        </p>
      </div>

      {/* Follow-up is a manual decision — the system never contacts anyone
          automatically, which the spec requires explicitly. */}
      <p className="mt-3 rounded-lg bg-slate-100 px-4 py-2.5 text-xs text-slate-600">
        No automated emails are sent to these contacts. Follow-up is manual and tracked here.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        <Link
          href="/admin/leads"
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            !status ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'
          }`}
        >
          All
        </Link>
        {LEAD_FOLLOW_UP_STATUSES.map((value) => (
          <Link
            key={value}
            href={`/admin/leads?status=${value}`}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              status === value
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'
            }`}
          >
            {STATUS_LABEL[value]}
          </Link>
        ))}
      </div>

      {leads.length === 0 ? (
        <Card className="mt-6 p-12 text-center">
          <p className="font-heading text-base font-bold text-slate-900">No leads yet</p>
          <p className="mt-1.5 text-sm text-slate-600">
            Leads appear when someone supplies contact details with their audit request.
          </p>
        </Card>
      ) : (
        <Card className="mt-6 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Company</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Contact</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Website</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Score</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Audits</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Date</th>
                  <th scope="col" className="px-5 py-3 font-semibold text-slate-700">Follow-up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {leads.map((lead) => {
                  const tone =
                    lead.latestScore !== null && lead.latestScore !== undefined
                      ? scoreTone(lead.latestScore)
                      : null;
                  return (
                    <tr key={lead.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3 font-medium text-slate-900">
                        {lead.companyName ?? <span className="text-slate-400">—</span>}
                        {lead.industry ? (
                          <p className="mt-0.5 text-xs text-slate-400">{lead.industry}</p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3">
                        <p className="text-slate-700">{lead.contactName ?? '—'}</p>
                        {lead.email ? (
                          <a
                            href={`mailto:${lead.email}`}
                            className="text-xs text-brand-700 hover:underline"
                          >
                            {lead.email}
                          </a>
                        ) : null}
                      </td>
                      <td className="max-w-[14rem] truncate px-5 py-3 text-slate-600">
                        {lead.website}
                      </td>
                      <td className="px-5 py-3">
                        {tone && lead.latestAuditId ? (
                          <Link
                            href={`/admin/audits/${lead.latestAuditId}`}
                            className={`font-heading text-base font-bold tabular-nums ${tone.text} hover:underline`}
                          >
                            {lead.latestScore}
                          </Link>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 tabular-nums text-slate-600">{lead.auditCount}</td>
                      <td className="px-5 py-3 text-xs text-slate-500">
                        {new Date(lead.createdAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="px-5 py-3">
                        <LeadStatusSelect leadId={lead.id} status={lead.followUpStatus} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
