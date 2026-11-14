import type { FindingCategory, Severity } from './types/finding';
import type { ScoreBand } from './types/audit';

export const ENGINE_VERSION = '1.0.0';

export const BRAND = {
  name: 'Qualovix',
  productName: 'Qualovix QA Auditor',
  reportTitle: 'FREE QA HEALTH CHECK',
  reportSubtitle: 'Automated QA Assessment Reviewed by Qualovix QA Engineers',
  tagline: "Know What's Breaking Before Your Users Do.",
  positioning: 'Automated QA Health Check reviewed by Qualovix QA Engineers.',
  contactUrl: 'https://qualovix.com',
  websiteUrl: 'https://qualovix.com',
} as const;

export const SERVICES = [
  'Manual QA',
  'Test Automation',
  'API Testing',
  'Regression Testing',
  'Performance Testing',
  'Accessibility Testing',
  'QA Process Improvement',
] as const;

/**
 * Category weights for the overall QA Health Score. These sum to 1.0 and are
 * fixed by the product spec — changing them changes every historical score,
 * so treat this as a versioned decision (see ENGINE_VERSION).
 */
export const CATEGORY_WEIGHTS: Record<FindingCategory, number> = {
  FUNCTIONAL: 0.25,
  PERFORMANCE: 0.15,
  ACCESSIBILITY: 0.15,
  RESPONSIVE: 0.15,
  TECHNICAL: 0.1,
  SECURITY: 0.1,
  UX: 0.1,
};

export const SCORE_BANDS: ScoreBand[] = [
  { min: 0, max: 49, label: 'Needs Significant Attention', tone: 'critical' },
  { min: 50, max: 69, label: 'Needs Improvement', tone: 'poor' },
  { min: 70, max: 84, label: 'Good', tone: 'fair' },
  { min: 85, max: 94, label: 'Very Good', tone: 'good' },
  { min: 95, max: 100, label: 'Excellent', tone: 'excellent' },
];

export function scoreBandFor(score: number): ScoreBand {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  // The bands are exhaustive over 0..100, so the fallback is unreachable in
  // practice; it exists to satisfy noUncheckedIndexedAccess.
  return (
    SCORE_BANDS.find((b) => clamped >= b.min && clamped <= b.max) ??
    SCORE_BANDS[0]!
  );
}

/**
 * Score penalty applied per finding, before per-category damping.
 * Deterministic: the AI layer is never allowed to influence these.
 */
export const SEVERITY_PENALTY: Record<Severity, number> = {
  CRITICAL: 30,
  HIGH: 15,
  MEDIUM: 6,
  LOW: 2,
  INFO: 0,
};

/**
 * Repeat occurrences of the same rule matter, but with sharply diminishing
 * returns — twenty missing alt attributes is one problem, not twenty.
 */
export const OCCURRENCE_DAMPING = 0.25;
export const MAX_OCCURRENCE_MULTIPLIER = 3;

/** Low-confidence findings carry less score weight but still get reported. */
export const CONFIDENCE_WEIGHT = {
  HIGH: 1,
  MEDIUM: 0.75,
  LOW: 0.4,
} as const;

export const SEVERITY_LABELS: Record<Severity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High Priority',
  MEDIUM: 'Medium Priority',
  LOW: 'Low Priority',
  INFO: 'Informational',
};

export const SEVERITY_DEFINITIONS: Record<Severity, string> = {
  CRITICAL: 'Issue prevents major user or business functionality.',
  HIGH: 'Major functional, accessibility, reliability or usability issue.',
  MEDIUM: 'Important quality issue, but a workaround exists.',
  LOW: 'Minor quality issue.',
  INFO: 'Observation or recommendation.',
};

export const DISCLAIMER =
  'This report is based primarily on automated analysis and QA heuristics. It is not a complete manual functional test, penetration test, security audit, accessibility certification, or guarantee that all defects have been identified.';

export const SCORE_DISCLAIMER =
  'This score is an automated QA health indicator and is not a certification.';

export const SECURITY_CATEGORY_LABEL =
  'Security Baseline — Not a Penetration Test';

export const ACCESSIBILITY_CATEGORY_LABEL = 'Automated accessibility findings';

/** Viewports exercised by the responsive scanner. */
export const VIEWPORTS = [
  { name: 'Mobile', width: 375, height: 812 },
  { name: 'Tablet', width: 768, height: 1024 },
  { name: 'Desktop', width: 1440, height: 900 },
] as const;

export type ViewportName = (typeof VIEWPORTS)[number]['name'];

/** Link path fragments the crawler must never follow. */
export const DANGEROUS_PATH_PATTERNS = [
  'logout',
  'log-out',
  'signout',
  'sign-out',
  'delete-account',
  'deleteaccount',
  'account/delete',
  'unsubscribe',
  'cancel-subscription',
  'remove',
  'destroy',
  'reset-password',
  'admin/delete',
] as const;

export const NON_CRAWLABLE_PROTOCOLS = [
  'mailto:',
  'tel:',
  'sms:',
  'javascript:',
  'data:',
  'file:',
  'ftp:',
  'blob:',
  'ws:',
  'wss:',
] as const;

export const DOWNLOAD_EXTENSIONS = [
  '.pdf', '.zip', '.rar', '.7z', '.tar', '.gz', '.dmg', '.exe', '.msi',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.webm', '.ogg',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
] as const;
