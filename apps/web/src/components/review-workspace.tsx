'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, Loader2, Pencil, X } from 'lucide-react';
import {
  CATEGORY_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  pluralize,
  type Finding,
  type FindingStatus,
  type Severity,
} from '@qualovix/shared';
import { Button, Card, Pill, SeverityBadge, inputClass, scoreTone } from './ui';

/**
 * The human QA review workspace.
 *
 * This is the layer the product is built around: a QA engineer decides what
 * a client actually sees. For every automated finding they can
 *
 *   Keep            — confirmed, include it in the report
 *   Ignore          — false positive or not worth raising; excluded entirely
 *   Edit            — rewrite the title and description in their own words
 *   Change severity — override the engine's rating with their judgement
 *
 * plus a QA engineer note ("Confirmed manually — reproduces in Chrome and
 * Firefox") that appears alongside the finding in the report.
 *
 * Decisions are held locally and submitted together, so a reviewer can work
 * through a long list and approve once rather than firing a request per
 * click. Nothing reaches the client report until Approve is pressed.
 */

interface Decision {
  status: FindingStatus;
  severity?: Severity;
  title?: string;
  description?: string;
  qaNote?: string;
}

export function ReviewWorkspace({
  auditId,
  findings,
  initialNotes,
  approved,
  automatedScore,
}: {
  auditId: string;
  findings: Finding[];
  initialNotes: string;
  approved: boolean;
  automatedScore: number;
}) {
  const router = useRouter();
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(
      findings.map((finding) => [
        finding.id,
        {
          // Anything already triaged keeps its decision; everything else
          // defaults to Keep, so approving without touching a finding
          // publishes it rather than silently dropping it.
          status: finding.status && finding.status !== 'PENDING_REVIEW' ? finding.status : 'KEPT',
          severity: finding.severity,
          title: finding.editedTitle,
          description: finding.editedDescription,
          qaNote: finding.qaNote,
        },
      ]),
    ),
  );
  const [engineerNotes, setEngineerNotes] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'KEPT' | 'IGNORED'>('ALL');

  const kept = Object.values(decisions).filter((d) => d.status === 'KEPT' || d.status === 'EDITED');
  const ignored = Object.values(decisions).filter((d) => d.status === 'IGNORED');

  // Live preview of the score the client will see. Mirrors the deterministic
  // engine's shape closely enough to be useful while reviewing; the server
  // recalculates authoritatively on approve.
  const previewScore = useMemo(() => {
    const keptFindings = findings.filter((finding) => {
      const decision = decisions[finding.id];
      return decision?.status === 'KEPT' || decision?.status === 'EDITED';
    });
    if (keptFindings.length === findings.length) return automatedScore;
    const removed = findings.length - keptFindings.length;
    // Rough, clearly labelled as an estimate in the UI.
    return Math.min(100, automatedScore + Math.round(removed * 1.5));
  }, [decisions, findings, automatedScore]);

  const visible = findings.filter((finding) => {
    const decision = decisions[finding.id];
    if (filter === 'ALL') return true;
    if (filter === 'PENDING') return finding.status === 'PENDING_REVIEW';
    if (filter === 'KEPT') return decision?.status === 'KEPT' || decision?.status === 'EDITED';
    return decision?.status === 'IGNORED';
  });

  function update(findingId: string, patch: Partial<Decision>) {
    setDecisions((current) => ({
      ...current,
      [findingId]: { ...current[findingId]!, ...patch },
    }));
    setMessage(null);
  }

  async function submit(approve: boolean) {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/audits/${auditId}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approve,
          engineerNotes: engineerNotes || undefined,
          decisions: findings.map((finding) => {
            const decision = decisions[finding.id]!;
            const edited =
              (decision.title && decision.title !== finding.title) ||
              (decision.description && decision.description !== finding.description);
            return {
              findingId: finding.id,
              status: decision.status === 'IGNORED' ? 'IGNORED' : edited ? 'EDITED' : 'KEPT',
              severity: decision.severity,
              title: decision.title || undefined,
              description: decision.description || undefined,
              qaNote: decision.qaNote || undefined,
            };
          }),
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: 'error', text: payload?.error ?? 'Could not save the review.' });
        setSaving(false);
        return;
      }

      setMessage({
        tone: 'ok',
        text: approve
          ? `Review approved. The client report now shows ${payload.reviewedScore}/100 with ${kept.length} ${pluralize(kept.length, 'finding')}.`
          : 'Draft saved. Nothing has been published to the client yet.',
      });
      router.refresh();
    } catch {
      setMessage({ tone: 'error', text: 'We could not reach the server. Try again.' });
    } finally {
      setSaving(false);
    }
  }

  const tone = scoreTone(previewScore);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
      {/* --- finding queue --- */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {(['ALL', 'PENDING', 'KEPT', 'IGNORED'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === value
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'
              }`}
            >
              {value === 'ALL'
                ? `All (${findings.length})`
                : value === 'PENDING'
                  ? `Untouched (${findings.filter((f) => f.status === 'PENDING_REVIEW').length})`
                  : value === 'KEPT'
                    ? `Keeping (${kept.length})`
                    : `Ignoring (${ignored.length})`}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          {visible.map((finding) => (
            <ReviewCard
              key={finding.id}
              finding={finding}
              decision={decisions[finding.id]!}
              onChange={(patch) => update(finding.id, patch)}
            />
          ))}

          {visible.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-sm text-slate-600">No findings match this filter.</p>
            </Card>
          ) : null}
        </div>
      </div>

      {/* --- review summary + actions --- */}
      <aside className="lg:sticky lg:top-8">
        <Card className="p-5">
          <h2 className="font-heading text-base font-bold text-slate-900">Review summary</h2>

          <dl className="mt-4 space-y-2.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">Keeping</dt>
              <dd className="font-semibold tabular-nums text-slate-900">{kept.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Ignoring</dt>
              <dd className="font-semibold tabular-nums text-slate-900">{ignored.length}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-2.5">
              <dt className="text-slate-600">Automated score</dt>
              <dd className="font-semibold tabular-nums text-slate-900">{automatedScore}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Estimated after review</dt>
              <dd className={`font-heading text-lg font-bold tabular-nums ${tone.text}`}>
                {previewScore}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            The estimate is indicative. The exact score is recalculated from the kept findings when
            you approve.
          </p>

          <div className="mt-5">
            <label htmlFor="engineerNotes" className="block text-sm font-semibold text-slate-800">
              QA engineer notes
            </label>
            <p className="mt-1 text-xs text-slate-500">
              Appears in the client report under the executive summary.
            </p>
            <textarea
              id="engineerNotes"
              rows={5}
              className={`${inputClass} mt-2 text-sm`}
              placeholder="e.g. Confirmed the checkout link manually — reproduces in Chrome and Firefox on a clean profile."
              value={engineerNotes}
              onChange={(event) => setEngineerNotes(event.target.value)}
              disabled={saving}
            />
          </div>

          {message ? (
            <p
              role="status"
              className={`mt-4 text-sm font-medium ${
                message.tone === 'ok' ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {message.text}
            </p>
          ) : null}

          <div className="mt-5 space-y-2">
            <Button onClick={() => submit(true)} disabled={saving} className="w-full">
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : approved ? (
                'Update approved review'
              ) : (
                'Approve and publish'
              )}
            </Button>
            <Button
              variant="secondary"
              onClick={() => submit(false)}
              disabled={saving}
              className="w-full"
            >
              Save draft
            </Button>
            <a
              href={`/api/audits/${auditId}/report`}
              className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100"
            >
              <Download className="h-4 w-4" aria-hidden />
              Preview PDF report
            </a>
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
            Only findings you keep reach the client report. Approving marks the audit as reviewed by
            a Qualovix QA engineer.
          </p>
        </Card>
      </aside>
    </div>
  );
}

function ReviewCard({
  finding,
  decision,
  onChange,
}: {
  finding: Finding;
  decision: Decision;
  onChange: (patch: Partial<Decision>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showNote, setShowNote] = useState(Boolean(decision.qaNote));
  const ignoring = decision.status === 'IGNORED';

  return (
    <Card className={`overflow-hidden transition-opacity ${ignoring ? 'opacity-55' : ''}`}>
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <SeverityBadge severity={decision.severity ?? finding.severity} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                type="text"
                aria-label="Finding title"
                className={`${inputClass} text-sm font-semibold`}
                value={decision.title ?? finding.title}
                onChange={(event) => onChange({ title: event.target.value })}
              />
            ) : (
              <h3 className="font-semibold text-slate-900">
                {decision.title ?? finding.title}
              </h3>
            )}

            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span>{CATEGORY_LABELS[finding.category]}</span>
              {finding.url ? <span className="truncate">{finding.url}</span> : null}
              <span>{finding.confidence.toLowerCase()} confidence</span>
              <span>via {finding.detectedBy}</span>
              {finding.occurrences > 1 ? (
                <span>
                  {finding.occurrences} {pluralize(finding.occurrences, 'occurrence')}
                </span>
              ) : null}
            </p>
          </div>
        </div>

        {editing ? (
          <textarea
            aria-label="Finding description"
            rows={4}
            className={`${inputClass} mt-3 text-sm`}
            value={decision.description ?? finding.description}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {decision.description ?? finding.description}
          </p>
        )}

        {/* Evidence is always visible: a reviewer cannot make a sound call
            without seeing what the scanner actually observed. */}
        <details className="mt-3 rounded-lg bg-slate-50 ring-1 ring-inset ring-slate-200">
          <summary className="cursor-pointer px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-500">
            Evidence
          </summary>
          <div className="border-t border-slate-200 px-4 py-3">
            <p className="text-sm text-slate-700">{finding.evidence.summary}</p>
            {finding.evidence.observed ? (
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-white p-3 font-mono text-xs text-slate-800 ring-1 ring-inset ring-slate-200">
                {finding.evidence.observed}
              </pre>
            ) : null}
            {finding.evidence.expected ? (
              <p className="mt-2 text-xs text-slate-500">
                <span className="font-semibold">Expected: </span>
                {finding.evidence.expected}
              </p>
            ) : null}
            {finding.originalSeverity && finding.originalSeverity !== finding.severity ? (
              <p className="mt-2 text-xs text-amber-700">
                Severity engine adjusted this from {finding.originalSeverity} to {finding.severity}.
              </p>
            ) : null}
          </div>
        </details>

        {showNote ? (
          <div className="mt-3">
            <label
              htmlFor={`note-${finding.id}`}
              className="block text-xs font-semibold text-slate-700"
            >
              QA engineer note
            </label>
            <input
              id={`note-${finding.id}`}
              type="text"
              className={`${inputClass} mt-1 text-sm`}
              placeholder="Confirmed manually — reproduces in Chrome and Firefox."
              value={decision.qaNote ?? ''}
              onChange={(event) => onChange({ qaNote: event.target.value })}
            />
          </div>
        ) : null}
      </div>

      {/* --- decision controls --- */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
        <Button
          size="sm"
          variant={ignoring ? 'secondary' : 'primary'}
          onClick={() => onChange({ status: 'KEPT' })}
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          Keep
        </Button>

        <Button
          size="sm"
          variant={ignoring ? 'danger' : 'secondary'}
          onClick={() => onChange({ status: 'IGNORED' })}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Ignore
        </Button>

        <Button size="sm" variant="secondary" onClick={() => setEditing((value) => !value)}>
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          {editing ? 'Done editing' : 'Edit'}
        </Button>

        <div className="flex items-center gap-1.5">
          <label htmlFor={`severity-${finding.id}`} className="text-xs font-medium text-slate-600">
            Severity
          </label>
          <select
            id={`severity-${finding.id}`}
            value={decision.severity ?? finding.severity}
            onChange={(event) => onChange({ severity: event.target.value as Severity })}
            className="rounded-lg border-0 py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
          >
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {SEVERITY_LABELS[severity]}
              </option>
            ))}
          </select>
        </div>

        {!showNote ? (
          <Button size="sm" variant="ghost" onClick={() => setShowNote(true)}>
            Add note
          </Button>
        ) : null}

        {decision.severity && decision.severity !== finding.severity ? (
          <Pill tone="warning">severity changed</Pill>
        ) : null}
        {ignoring ? <Pill tone="danger">excluded from report</Pill> : null}
      </div>
    </Card>
  );
}
