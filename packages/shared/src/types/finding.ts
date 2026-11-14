/**
 * The normalized finding model. Every scanner in the system emits this shape
 * and nothing downstream is allowed to invent one without evidence.
 */

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CATEGORIES = [
  'FUNCTIONAL',
  'ACCESSIBILITY',
  'PERFORMANCE',
  'RESPONSIVE',
  'TECHNICAL',
  'SECURITY',
  'UX',
] as const;
export type FindingCategory = (typeof CATEGORIES)[number];

export const FINDING_STATUSES = ['PENDING_REVIEW', 'KEPT', 'IGNORED', 'EDITED'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Rank used for ordering and for "worst severity wins" comparisons. */
export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  FUNCTIONAL: 'Functional QA',
  ACCESSIBILITY: 'Accessibility',
  PERFORMANCE: 'Performance',
  RESPONSIVE: 'Responsive QA',
  TECHNICAL: 'Technical QA',
  SECURITY: 'Security Baseline',
  UX: 'UX Quality',
};

export const CATEGORY_DESCRIPTIONS: Record<FindingCategory, string> = {
  FUNCTIONAL:
    'Broken links, failed requests and client-side JavaScript errors that stop the site doing its job.',
  ACCESSIBILITY:
    'Automated accessibility findings from axe-core. Not a WCAG certification.',
  PERFORMANCE:
    'Load behaviour, layout stability and asset weight. Results vary with network and environment.',
  RESPONSIVE:
    'Layout behaviour at mobile, tablet and desktop viewports.',
  TECHNICAL:
    'HTML correctness and page-level technical hygiene. Not a full SEO audit.',
  SECURITY:
    'Passive transport and header checks only — not a penetration test.',
  UX: 'Automated usability heuristics. Not a substitute for real UX testing.',
};

/**
 * A single piece of proof for a finding. Findings without evidence are
 * rejected by the normalizer.
 */
export interface FindingEvidence {
  /** Short human-readable statement of what was observed. */
  summary: string;
  /** Verbatim observed value: a status code, console message, header, etc. */
  observed?: string;
  /** What the check expected instead. */
  expected?: string;
  /** Raw supporting data, already redacted of secrets. */
  details?: Record<string, unknown>;
  /** Relative path of a stored screenshot, when one was captured. */
  screenshot?: string;
}

export interface Finding {
  id: string;
  /** Stable rule identifier, e.g. `broken-links.internal-404`. */
  ruleId: string;
  category: FindingCategory;
  title: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  url?: string;
  selector?: string;
  evidence: FindingEvidence;
  recommendation: string;
  impact?: string;
  /** Scanner id that produced the finding. */
  detectedBy: string;
  occurrences: number;
  affectedUrls?: string[];
  timestamp: string;

  // Human QA review layer
  status?: FindingStatus;
  originalSeverity?: Severity;
  qaNote?: string;
  editedTitle?: string;
  editedDescription?: string;

  // AI enrichment — must stay traceable to `evidence`
  aiSummary?: string;
  aiImpact?: string;
  aiRemediation?: string;
}

/** A check that ran and found nothing wrong. Shown as "Passed Checks". */
export interface PassedCheck {
  ruleId: string;
  category: FindingCategory;
  title: string;
  detail: string;
  detectedBy: string;
}

/** What a scanner returns. */
export interface ScannerResult {
  scannerId: string;
  findings: Finding[];
  passed: PassedCheck[];
  /** Non-fatal problems, e.g. a check that could not run on this site. */
  warnings: string[];
  durationMs: number;
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

export function worstSeverity(severities: Severity[]): Severity {
  return severities.reduce<Severity>(
    (worst, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst),
    'INFO',
  );
}
