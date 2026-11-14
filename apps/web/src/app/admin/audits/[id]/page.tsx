import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ExternalLink } from 'lucide-react';
import {
  CATEGORY_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  formatMs,
  pluralize,
  type Severity,
} from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { Card, Pill, ScoreDial, scoreTone } from '@/components/ui';
import { ReviewWorkspace } from '@/components/review-workspace';
import { DeleteAuditButton } from '@/components/delete-audit-button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Review audit', robots: { index: false } };

export default async function AdminAuditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repository = await getRepository();
  const audit = await repository.getAuditDetail(id);

  if (!audit) notFound();

  const running =
    audit.status === 'PENDING' || audit.status === 'SCANNING' || audit.status === 'ANALYZING';

  const counts = SEVERITIES.reduce<Record<Severity, number>>(
    (acc, severity) => {
      acc[severity] = audit.findings.filter((f) => f.severity === severity).length;
      return acc;
    },
    { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  );

  return (
    <div>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All audits
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-bold text-slate-900">{audit.domain}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
            <a
              href={audit.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-brand-700"
            >
              {audit.url}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            <span>·</span>
            <span>
              {new Date(audit.createdAt).toLocaleString('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
            {audit.durationMs ? (
              <>
                <span>·</span>
                <span>{formatMs(audit.durationMs)}</span>
              </>
            ) : null}
            {audit.mockMode ? <Pill tone="warning">mock data</Pill> : null}
            {audit.review?.approved ? <Pill tone="success">approved</Pill> : null}
            {audit.aiAnalysisUsed ? (
              <Pill tone="brand">AI analysis</Pill>
            ) : (
              <Pill tone="neutral">deterministic only</Pill>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/audit/${audit.id}`}
            target="_blank"
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            Client view
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <DeleteAuditButton auditId={audit.id} domain={audit.domain} />
        </div>
      </div>

      {/* --- still running --- */}
      {running ? (
        <Card className="mt-6 p-8">
          <p className="font-heading text-base font-bold text-slate-900">Audit in progress</p>
          <p className="mt-1.5 text-sm text-slate-600">
            Currently: {audit.currentStage ?? 'starting'} ({audit.stageIndex} of {audit.totalStages}).
            Refresh in a moment.
          </p>
        </Card>
      ) : null}

      {/* --- failed --- */}
      {audit.status === 'FAILED' ? (
        <Card className="mt-6 p-6">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" aria-hidden />
            <div>
              <p className="font-heading text-base font-bold text-slate-900">Audit failed</p>
              <p className="mt-1.5 text-sm text-slate-600">{audit.errorMessage}</p>
            </div>
          </div>
        </Card>
      ) : null}

      {/* --- overview + review --- */}
      {!running && audit.status !== 'FAILED' ? (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="flex items-center justify-center p-5">
              <ScoreDial score={audit.overallScore ?? 0} size={120} />
            </Card>

            <Card className="p-5">
              <h2 className="font-heading text-sm font-bold text-slate-900">Findings</h2>
              <dl className="mt-3 space-y-1.5 text-sm">
                {SEVERITIES.map((severity) => (
                  <div key={severity} className="flex justify-between">
                    <dt className="text-slate-600">{SEVERITY_LABELS[severity]}</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">{counts[severity]}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card className="p-5">
              <h2 className="font-heading text-sm font-bold text-slate-900">Scan</h2>
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-600">Pages</dt>
                  <dd className="font-semibold tabular-nums text-slate-900">{audit.pages.length}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">Passed checks</dt>
                  <dd className="font-semibold tabular-nums text-slate-900">
                    {audit.passedChecks.length}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">Engine</dt>
                  <dd className="font-mono text-xs text-slate-500">v{audit.engineVersion}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-600">Status</dt>
                  <dd className="text-xs font-semibold text-slate-700">{audit.status}</dd>
                </div>
              </dl>
            </Card>

            <Card className="p-5">
              <h2 className="font-heading text-sm font-bold text-slate-900">Lead</h2>
              {audit.lead ? (
                <dl className="mt-3 space-y-1.5 text-sm">
                  {audit.lead.companyName ? (
                    <div>
                      <dt className="text-xs text-slate-500">Company</dt>
                      <dd className="font-medium text-slate-900">{audit.lead.companyName}</dd>
                    </div>
                  ) : null}
                  {audit.lead.contactName ? (
                    <div>
                      <dt className="text-xs text-slate-500">Contact</dt>
                      <dd className="font-medium text-slate-900">{audit.lead.contactName}</dd>
                    </div>
                  ) : null}
                  {audit.lead.email ? (
                    <div>
                      <dt className="text-xs text-slate-500">Email</dt>
                      <dd>
                        <a
                          href={`mailto:${audit.lead.email}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {audit.lead.email}
                        </a>
                      </dd>
                    </div>
                  ) : null}
                  {audit.lead.industry ? (
                    <div>
                      <dt className="text-xs text-slate-500">Industry</dt>
                      <dd className="text-slate-700">{audit.lead.industry}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="mt-3 text-sm text-slate-500">Anonymous submission — no lead captured.</p>
              )}
            </Card>
          </div>

          {audit.lead?.focusAreas ? (
            <Card className="mt-4 p-5">
              <h2 className="font-heading text-sm font-bold text-slate-900">
                What the prospect asked us to focus on
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">{audit.lead.focusAreas}</p>
            </Card>
          ) : null}

          {audit.aiFailureReason ? (
            <Card className="mt-4 border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-900">
                <span className="font-semibold">AI analysis was not applied: </span>
                {audit.aiFailureReason} The report was generated from deterministic findings only.
              </p>
            </Card>
          ) : null}

          <Card className="mt-4 p-5">
            <h2 className="font-heading text-sm font-bold text-slate-900">Executive summary</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{audit.executiveSummary}</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {audit.categoryScores.map((category) => {
                const tone = scoreTone(category.score);
                return (
                  <div key={category.category} className="rounded-lg bg-slate-50 px-3 py-2">
                    <p className="text-xs text-slate-600">{CATEGORY_LABELS[category.category]}</p>
                    <p className={`font-heading text-lg font-bold tabular-nums ${tone.text}`}>
                      {category.score}
                    </p>
                  </div>
                );
              })}
            </div>
          </Card>

          <section className="mt-8">
            <h2 className="font-heading text-xl font-bold text-slate-900">
              QA review · {audit.findings.length} {pluralize(audit.findings.length, 'finding')}
            </h2>
            <p className="mt-1.5 max-w-3xl text-sm text-slate-600">
              Decide what the client sees. Keep confirmed findings, ignore false positives, edit
              wording, and adjust severity where the automated rating is wrong. Only findings you
              keep appear in the report.
            </p>

            <div className="mt-5">
              <ReviewWorkspace
                auditId={audit.id}
                findings={audit.findings}
                initialNotes={audit.review?.engineerNotes ?? ''}
                approved={Boolean(audit.review?.approved)}
                automatedScore={audit.overallScore ?? 0}
              />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
