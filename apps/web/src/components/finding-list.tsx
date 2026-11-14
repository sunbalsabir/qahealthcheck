'use client';

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  CATEGORY_LABELS,
  SEVERITIES,
  SEVERITY_DEFINITIONS,
  SEVERITY_LABELS,
  pluralize,
  type Finding,
  type FindingCategory,
  type Severity,
} from '@qualovix/shared';
import { SeverityBadge, Pill } from './ui';

/**
 * The findings list shown on the results page.
 *
 * Each finding is collapsed to its headline, with the evidence available on
 * demand. Evidence is the thing that separates this from a generic scanner
 * report, so it is always one click away and never summarised into nothing.
 */

export function FindingList({ findings }: { findings: Finding[] }) {
  const [severityFilter, setSeverityFilter] = useState<Severity | 'ALL'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<FindingCategory | 'ALL'>('ALL');

  const counts = useMemo(() => {
    const map = {} as Record<Severity, number>;
    for (const severity of SEVERITIES) {
      map[severity] = findings.filter((f) => f.severity === severity).length;
    }
    return map;
  }, [findings]);

  const categories = useMemo(() => {
    const present = new Set(findings.map((f) => f.category));
    return Array.from(present);
  }, [findings]);

  const visible = findings.filter(
    (finding) =>
      (severityFilter === 'ALL' || finding.severity === severityFilter) &&
      (categoryFilter === 'ALL' || finding.category === categoryFilter),
  );

  if (findings.length === 0) {
    return (
      <div className="qv-card p-8 text-center">
        <p className="font-heading text-lg font-bold text-slate-900">No issues detected</p>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-600">
          None of the automated checks in scope found a problem. That confirms these specific checks
          passed — it does not confirm the site is free of defects. Manual functional testing covers
          what automation cannot see.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterButton
          active={severityFilter === 'ALL'}
          onClick={() => setSeverityFilter('ALL')}
          label={`All (${findings.length})`}
        />
        {SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => (
          <FilterButton
            key={severity}
            active={severityFilter === severity}
            onClick={() => setSeverityFilter(severity)}
            label={`${SEVERITY_LABELS[severity]} (${counts[severity]})`}
          />
        ))}

        {categories.length > 1 ? (
          <>
            <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" aria-hidden />
            <label htmlFor="category-filter" className="sr-only">
              Filter by category
            </label>
            <select
              id="category-filter"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value as FindingCategory | 'ALL')}
              className="rounded-lg border-0 bg-white py-1.5 pl-3 pr-8 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
            >
              <option value="ALL">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <p className="mt-4 text-sm text-slate-500" role="status">
        Showing {visible.length} of {findings.length} {pluralize(findings.length, 'finding')}.
      </p>

      <div className="mt-4 space-y-3">
        {visible.map((finding) => (
          <FindingCard key={finding.id} finding={finding} />
        ))}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-slate-900 text-white'
          : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const title = finding.editedTitle ?? finding.title;
  const description = finding.editedDescription ?? finding.aiSummary ?? finding.description;
  const impact = finding.aiImpact ?? finding.impact;
  const recommendation = finding.aiRemediation ?? finding.recommendation;

  return (
    <div className="qv-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50"
      >
        <SeverityBadge severity={finding.severity} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-slate-900">{title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{CATEGORY_LABELS[finding.category]}</span>
            {finding.url ? <span className="truncate">{shortUrl(finding.url)}</span> : null}
            {finding.occurrences > 1 ? (
              <span>
                {finding.occurrences} {pluralize(finding.occurrences, 'occurrence')}
              </span>
            ) : null}
            {finding.confidence !== 'HIGH' ? (
              <Pill tone="neutral">{finding.confidence.toLowerCase()} confidence</Pill>
            ) : null}
            {finding.qaNote ? <Pill tone="success">QA reviewed</Pill> : null}
          </span>
        </span>
        <ChevronDown
          className={`mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="border-t border-slate-100 px-5 py-5">
          <p className="text-sm leading-relaxed text-slate-700">{description}</p>

          {impact ? (
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              <span className="font-semibold text-slate-900">Impact: </span>
              {impact}
            </p>
          ) : null}

          <div className="mt-4 rounded-lg bg-slate-50 p-4 ring-1 ring-inset ring-slate-200">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Evidence</p>
            <p className="mt-1.5 text-sm text-slate-700">{finding.evidence.summary}</p>
            {finding.evidence.observed ? (
              <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-white p-3 font-mono text-xs leading-relaxed text-slate-800 ring-1 ring-inset ring-slate-200">
                {finding.evidence.observed}
              </pre>
            ) : null}
            {finding.evidence.expected ? (
              <p className="mt-2.5 text-xs text-slate-500">
                <span className="font-semibold">Expected: </span>
                {finding.evidence.expected}
              </p>
            ) : null}
          </div>

          <div className="mt-3 rounded-lg bg-brand-50 p-4 ring-1 ring-inset ring-brand-100">
            <p className="text-[11px] font-bold uppercase tracking-wider text-brand-700">
              Recommendation
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{recommendation}</p>
          </div>

          {finding.qaNote ? (
            <div className="mt-3 rounded-lg bg-emerald-50 p-4 ring-1 ring-inset ring-emerald-100">
              <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">
                Qualovix QA engineer note
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{finding.qaNote}</p>
            </div>
          ) : null}

          <p className="mt-4 text-xs text-slate-400">
            {SEVERITY_DEFINITIONS[finding.severity]} Detected by the {finding.detectedBy} scanner
            (rule <code className="font-mono">{finding.ruleId}</code>).
          </p>
        </div>
      ) : null}
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? parsed.hostname : `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}
