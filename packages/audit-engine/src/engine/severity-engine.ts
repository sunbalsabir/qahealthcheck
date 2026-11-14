import {
  SEVERITY_RANK,
  type Finding,
  type Severity,
} from '@qualovix/shared';
import type { CrawlResult } from '@qualovix/scanners';

/**
 * Severity engine.
 *
 * Scanners assign a severity from what they can see on one page. This engine
 * applies the site-wide adjustments a single scanner cannot make, using
 * explicit, auditable rules.
 *
 * Two rules govern the whole file:
 *
 *   1. Every adjustment is deterministic and driven by observed evidence.
 *      No heuristic "feels worse" scoring, and the AI layer is never
 *      permitted to run before or instead of this.
 *
 *   2. Every adjustment records why it happened, in
 *      `evidence.details.severityAdjustments`. A QA engineer reviewing the
 *      finding can see exactly what moved it and disagree if they want to.
 */

export interface SeverityAdjustment {
  rule: string;
  from: Severity;
  to: Severity;
  reason: string;
}

export interface SeverityEngineResult {
  findings: Finding[];
  adjustments: SeverityAdjustment[];
}

const ORDER: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function escalate(severity: Severity, steps = 1): Severity {
  const index = ORDER.indexOf(severity);
  return ORDER[Math.min(ORDER.length - 1, index + steps)]!;
}

function deescalate(severity: Severity, steps = 1): Severity {
  const index = ORDER.indexOf(severity);
  return ORDER[Math.max(0, index - steps)]!;
}

export function applySeverityRules(
  findings: Finding[],
  crawl: CrawlResult,
): SeverityEngineResult {
  const adjustments: SeverityAdjustment[] = [];
  const pageCount = Math.max(1, crawl.pages.length);
  const homepageUrl = crawl.pages[0]?.url;

  const adjusted = findings.map((finding) => {
    let severity = finding.severity;
    const applied: SeverityAdjustment[] = [];

    const record = (rule: string, next: Severity, reason: string) => {
      if (next === severity) return;
      const adjustment: SeverityAdjustment = { rule, from: severity, to: next, reason };
      applied.push(adjustment);
      adjustments.push(adjustment);
      severity = next;
    };

    // --- Rule 1: site-wide reach escalates ---
    // A defect present on every page is a systemic template problem, not an
    // isolated page issue.
    const affectedPages = finding.affectedUrls?.length ?? 1;
    if (
      pageCount > 2 &&
      affectedPages >= pageCount &&
      SEVERITY_RANK[severity] >= SEVERITY_RANK.LOW &&
      severity !== 'CRITICAL'
    ) {
      record(
        'sitewide-reach',
        escalate(severity),
        `Present on all ${pageCount} audited pages, indicating a site-wide template issue rather than a single-page defect.`,
      );
    }

    // --- Rule 2: homepage impact escalates ---
    // The homepage carries the most traffic; a defect there costs more.
    if (
      homepageUrl &&
      finding.url === homepageUrl &&
      severity === 'MEDIUM' &&
      finding.confidence === 'HIGH'
    ) {
      record(
        'homepage-impact',
        escalate(severity),
        'Occurs on the homepage, which typically carries the majority of site traffic.',
      );
    }

    // --- Rule 3: low confidence caps severity ---
    // A finding we are not sure about must not top the report. It is still
    // reported, with its uncertainty visible.
    if (finding.confidence === 'LOW' && SEVERITY_RANK[severity] > SEVERITY_RANK.MEDIUM) {
      record(
        'low-confidence-cap',
        'MEDIUM',
        'Detection confidence is low, so severity is capped pending manual confirmation.',
      );
    }

    // --- Rule 4: a broken site-wide script is a functional outage ---
    if (
      finding.ruleId === 'broken-links.failed-script' &&
      affectedPages >= pageCount &&
      pageCount > 1
    ) {
      record(
        'sitewide-script-failure',
        'CRITICAL',
        'A JavaScript file fails to load on every page, so any behaviour depending on it is broken site-wide.',
      );
    }

    // --- Rule 5: no HTTPS is always critical ---
    if (finding.ruleId === 'security.no-https') {
      record(
        'transport-security-floor',
        'CRITICAL',
        'Serving a site without HTTPS exposes all traffic and is flagged by every modern browser.',
      );
    }

    // --- Rule 6: informational findings stay informational ---
    // Guards against a scanner accidentally inflating an observation.
    if (finding.ruleId.endsWith('manual-testing-recommended') && severity !== 'INFO') {
      record(
        'observation-floor',
        'INFO',
        'This is an observation and a recommendation for manual testing, not a defect.',
      );
    }

    // --- Rule 7: single-instance minor issues de-escalate ---
    // One low-contrast footer link on one page is not a MEDIUM problem.
    if (
      severity === 'MEDIUM' &&
      finding.occurrences === 1 &&
      pageCount > 3 &&
      affectedPages === 1 &&
      finding.confidence !== 'HIGH'
    ) {
      record(
        'isolated-instance',
        deescalate(severity),
        'A single occurrence on one page, with less than full detection confidence.',
      );
    }

    // --- Rule 8: mock-mode findings can never be CRITICAL ---
    // Nothing in mock mode was measured against a real site.
    if (crawl.mockMode && severity === 'CRITICAL') {
      record(
        'mock-mode-cap',
        'HIGH',
        'Audit ran in mock mode against generated data, so no finding is confirmed against the real site.',
      );
    }

    if (applied.length === 0) return finding;

    return {
      ...finding,
      severity,
      // originalSeverity is what the scanner said, preserved for the review UI.
      originalSeverity: finding.originalSeverity ?? finding.severity,
      evidence: {
        ...finding.evidence,
        details: {
          ...(finding.evidence.details ?? {}),
          severityAdjustments: applied,
        },
      },
    };
  });

  return { findings: adjusted, adjustments };
}

/**
 * Severity counts for the results dashboard and the report summary.
 */
export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export const __testing = { escalate, deescalate, ORDER };
