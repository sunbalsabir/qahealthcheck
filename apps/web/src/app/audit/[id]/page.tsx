import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowRight, Download, RotateCcw } from 'lucide-react';
import {
  BRAND,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  DISCLAIMER,
  SCORE_DISCLAIMER,
  SEVERITIES,
  SEVERITY_LABELS,
  formatMs,
  pluralize,
  type Severity,
} from '@qualovix/shared';
import { getRepository } from '@qualovix/data';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { AuditProgress } from '@/components/audit-progress';
import { FindingList } from '@/components/finding-list';
import { Card, Disclaimer, ScoreDial, scoreTone } from '@/components/ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repository = await getRepository();
  const audit = await repository.getAudit(id);
  if (!audit) return { title: 'Audit not found' };
  return {
    title: `QA Health Check — ${hostOf(audit.url)}`,
    robots: { index: false, follow: false },
  };
}

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repository = await getRepository();
  const audit = await repository.getAuditDetail(id);

  if (!audit) notFound();

  const running =
    audit.status === 'PENDING' || audit.status === 'SCANNING' || audit.status === 'ANALYZING';

  return (
    <>
      <SiteHeader showCta={false} />

      <main id="main" className="qv-container py-12">
        {/* ---------------------------------------------------------------- */}
        {/* Still running                                                     */}
        {/* ---------------------------------------------------------------- */}
        {running ? (
          <div className="mx-auto max-w-3xl">
            <AuditProgress auditId={audit.id} url={audit.url} />
          </div>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* Failed                                                            */}
        {/* ---------------------------------------------------------------- */}
        {audit.status === 'FAILED' ? (
          <div className="mx-auto max-w-2xl">
            <Card className="p-8">
              <div className="flex gap-4">
                <AlertTriangle className="h-6 w-6 shrink-0 text-amber-600" aria-hidden />
                <div>
                  <h1 className="font-heading text-xl font-bold text-slate-900">
                    We could not complete this audit
                  </h1>
                  <p className="mt-3 text-sm leading-relaxed text-slate-600">
                    {audit.errorMessage ??
                      'The audit failed for an unknown reason. Please try again.'}
                  </p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <Link
                      href="/#start"
                      className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      Try another URL
                    </Link>
                    <a
                      href={BRAND.contactUrl}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                    >
                      Talk to Qualovix
                    </a>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* Results                                                           */}
        {/* ---------------------------------------------------------------- */}
        {!running && audit.status !== 'FAILED' ? (
          <ResultsView audit={audit} />
        ) : null}
      </main>

      <SiteFooter />
    </>
  );
}

type AuditDetailType = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof getRepository>>['getAuditDetail']>>
>;

function ResultsView({ audit }: { audit: AuditDetailType }) {
  // Precedence: a number the reviewer typed, then the score recalculated from
  // the findings they kept, then the automated score — so the headline number
  // always matches the findings shown underneath it.
  const score =
    audit.review?.scoreOverride ?? audit.review?.reviewedScore ?? audit.overallScore ?? 0;
  const tone = scoreTone(score);
  const reviewed = Boolean(audit.review?.approved);

  // Visitors never see findings a QA engineer dismissed.
  const visibleFindings = audit.findings.filter((finding) => finding.status !== 'IGNORED');

  const counts = SEVERITIES.reduce<Record<Severity, number>>(
    (acc, severity) => {
      acc[severity] = visibleFindings.filter((f) => f.severity === severity).length;
      return acc;
    },
    { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  );

  const topIssues = (audit.topIssues ?? []).filter((issue) =>
    visibleFindings.some((f) => f.id === issue.findingId),
  );

  return (
    <div className="mx-auto max-w-5xl">
      {audit.mockMode ? (
        <div className="mb-6 rounded-lg bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
          <p className="text-sm font-medium text-amber-900">
            Mock mode is enabled. These results are generated sample data — no website was scanned.
            Set <code className="font-mono text-xs">AUDIT_MOCK_MODE=false</code> to run real audits.
          </p>
        </div>
      ) : null}

      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">
          QA Health Check
        </p>
        <h1 className="mt-2 font-heading text-3xl font-bold text-slate-900 sm:text-4xl">
          {hostOf(audit.url)}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {audit.pages.length} {pluralize(audit.pages.length, 'page')} analysed
          {audit.durationMs ? ` in ${formatMs(audit.durationMs)}` : ''} ·{' '}
          {new Date(audit.createdAt).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
          {reviewed ? ' · Reviewed by a Qualovix QA engineer' : ' · Automated findings, pending QA review'}
        </p>
      </header>

      {/* --- score + severity counts --- */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className={`flex flex-col items-center justify-center p-8 ${tone.bg}`}>
          <ScoreDial score={score} label={audit.scoreBand ?? undefined} />
          <p className="mt-4 text-center text-xs leading-relaxed text-slate-600">
            {SCORE_DISCLAIMER}
          </p>
        </Card>

        <Card className="lg:col-span-2 p-6 sm:p-8">
          <h2 className="font-heading text-lg font-bold text-slate-900">Executive summary</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">{audit.executiveSummary}</p>

          <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-5">
            {SEVERITIES.map((severity) => (
              <div key={severity} className="rounded-lg bg-slate-50 px-3 py-3 text-center">
                <p className="font-heading text-2xl font-bold tabular-nums text-slate-900">
                  {counts[severity]}
                </p>
                <p className="mt-0.5 text-[11px] font-medium leading-tight text-slate-500">
                  {SEVERITY_LABELS[severity]}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={`/api/audits/${audit.id}/report`}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download QA Report
            </a>
            <a
              href={BRAND.contactUrl}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            >
              Talk to Qualovix
              <ArrowRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
        </Card>
      </div>

      {/* --- category scores --- */}
      <section className="mt-10">
        <h2 className="font-heading text-xl font-bold text-slate-900">Category scores</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {audit.categoryScores.map((category) => {
            const categoryTone = scoreTone(category.score);
            return (
              <Card key={category.category} className="p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-heading text-sm font-bold text-slate-900">
                    {CATEGORY_LABELS[category.category]}
                  </h3>
                  <span className={`font-heading text-xl font-bold tabular-nums ${categoryTone.text}`}>
                    {category.score}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, category.score)}%`,
                      backgroundColor: categoryTone.stroke,
                    }}
                  />
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-slate-600">
                  {category.summary ?? CATEGORY_DESCRIPTIONS[category.category]}
                </p>
                <p className="mt-1.5 text-[11px] text-slate-400">
                  {Math.round(category.weight * 100)}% of overall score ·{' '}
                  {category.findingCount} {pluralize(category.findingCount, 'finding')} ·{' '}
                  {category.passedChecks} passed
                </p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* --- top issues --- */}
      {topIssues.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-heading text-xl font-bold text-slate-900">
            Top {topIssues.length} {pluralize(topIssues.length, 'issue')} to fix first
          </h2>
          <ol className="mt-4 space-y-3">
            {topIssues.map((issue, index) => (
              <li key={issue.findingId}>
                <Card className="flex gap-4 p-5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-slate-900">{issue.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">
                      {issue.whyItMatters}
                    </p>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* --- all findings --- */}
      <section className="mt-10">
        <h2 className="font-heading text-xl font-bold text-slate-900">All findings</h2>
        <p className="mt-1.5 text-sm text-slate-600">
          Every finding includes the evidence it was based on. Expand one to see what we observed and
          what we expected.
        </p>
        <div className="mt-5">
          <FindingList findings={visibleFindings} />
        </div>
      </section>

      {/* --- passed checks --- */}
      {audit.passedChecks.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-heading text-xl font-bold text-slate-900">
            Passed checks ({audit.passedChecks.length})
          </h2>
          <p className="mt-1.5 text-sm text-slate-600">
            These checks ran and found nothing wrong. A passed check confirms that specific check
            succeeded — not that the area is free of defects.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {audit.passedChecks.map((check) => (
              <div
                key={`${check.ruleId}-${check.title}`}
                className="flex gap-2.5 rounded-lg bg-emerald-50/60 px-4 py-3 ring-1 ring-inset ring-emerald-100"
              >
                <span className="mt-0.5 text-xs font-bold text-emerald-700" aria-hidden>
                  ✓
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-900">{check.title}</p>
                  <p className="mt-0.5 text-xs text-slate-600">{check.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* --- next steps --- */}
      {audit.recommendations && audit.recommendations.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-heading text-xl font-bold text-slate-900">Recommended next steps</h2>
          <ol className="mt-4 space-y-2.5">
            {audit.recommendations.map((recommendation, index) => (
              <li key={index} className="flex gap-3">
                <span className="font-heading text-sm font-bold text-brand-600">{index + 1}.</span>
                <span className="text-sm leading-relaxed text-slate-700">{recommendation}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* --- CTA --- */}
      <Card className="mt-12 bg-slate-900 p-8 text-white">
        <h2 className="font-heading text-2xl font-bold">Want a deeper assessment?</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          This health check is automated analysis reviewed by our QA engineers. A full engagement
          covers what automation cannot see: whether your user journeys actually work, whether your
          forms deliver, and whether your releases stay stable over time.
        </p>
        <a
          href={BRAND.contactUrl}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
        >
          Talk to Qualovix
          <ArrowRight className="h-4 w-4" aria-hidden />
        </a>
      </Card>

      <div className="mt-8 rounded-lg bg-slate-50 p-5 ring-1 ring-inset ring-slate-200">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          Scope and limitations
        </p>
        <Disclaimer>{DISCLAIMER}</Disclaimer>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
