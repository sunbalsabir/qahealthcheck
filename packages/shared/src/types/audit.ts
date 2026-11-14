import type {
  Finding,
  FindingCategory,
  PassedCheck,
  Severity,
} from './finding';

export const AUDIT_STATUSES = [
  'PENDING',
  'SCANNING',
  'ANALYZING',
  'READY_FOR_REVIEW',
  'REVIEWED',
  'REPORT_GENERATED',
  'FAILED',
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const LEAD_FOLLOW_UP_STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'NOT_INTERESTED',
] as const;
export type LeadFollowUpStatus = (typeof LEAD_FOLLOW_UP_STATUSES)[number];

/**
 * The ten stages shown on the public progress screen, in order.
 * `AUDIT_STAGES[i]` corresponds to `stageIndex === i + 1` once complete.
 */
export const AUDIT_STAGES = [
  'Discovering pages',
  'Checking links',
  'Testing page performance',
  'Checking accessibility',
  'Detecting console errors',
  'Checking responsive behavior',
  'Checking forms',
  'Running technical checks',
  'Analyzing findings',
  'Generating QA report',
] as const;
export type AuditStage = (typeof AUDIT_STAGES)[number];

export interface CategoryScore {
  category: FindingCategory;
  score: number;
  weight: number;
  findingCount: number;
  passedChecks: number;
  summary?: string;
}

export interface ScoreBand {
  min: number;
  max: number;
  label: string;
  tone: 'critical' | 'poor' | 'fair' | 'good' | 'excellent';
}

export interface AuditPageRecord {
  id: string;
  url: string;
  normalizedUrl: string;
  depth: number;
  title?: string | null;
  statusCode?: number | null;
  responseTimeMs?: number | null;
  contentType?: string | null;
  byteSize?: number | null;
  linkCount: number;
  imageCount: number;
  scriptCount: number;
  stylesheetCount: number;
  formCount: number;
  buttonCount: number;
  headingCount: number;
}

export interface AuditReviewRecord {
  id: string;
  auditId: string;
  reviewerId?: string | null;
  reviewerName?: string | null;
  engineerNotes?: string | null;
  scoreOverride?: number | null;
  reviewedScore?: number | null;
  approved: boolean;
  approvedAt?: string | null;
  keptCount: number;
  ignoredCount: number;
  editedCount: number;
}

export interface LeadRecord {
  id: string;
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
  website: string;
  industry?: string | null;
  focusAreas?: string | null;
  followUpStatus: LeadFollowUpStatus;
  internalNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiAnalysisResult {
  executiveSummary: string;
  topIssues: AiTopIssue[];
  recommendations: string[];
  /** Per-finding enrichment, keyed by finding id. */
  enrichment: Record<
    string,
    { summary?: string; impact?: string; remediation?: string }
  >;
  /** Finding ids the AI believes duplicate an earlier finding. */
  duplicateOf: Record<string, string>;
}

export interface AiTopIssue {
  findingId: string;
  title: string;
  severity: Severity;
  whyItMatters: string;
}

export interface AuditRecord {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  status: AuditStatus;
  currentStage?: string | null;
  stageIndex: number;
  totalStages: number;
  progressDetail?: string | null;
  overallScore?: number | null;
  scoreBand?: string | null;
  mockMode: boolean;
  requestedIp?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  executiveSummary?: string | null;
  topIssues?: AiTopIssue[] | null;
  recommendations?: string[] | null;
  aiAnalysisUsed: boolean;
  aiFailureReason?: string | null;
  engineVersion: string;
  createdAt: string;
  updatedAt: string;
  leadId?: string | null;
}

/** Everything needed to render a results page or a PDF report. */
export interface AuditDetail extends AuditRecord {
  pages: AuditPageRecord[];
  findings: Finding[];
  passedChecks: PassedCheck[];
  categoryScores: CategoryScore[];
  review?: AuditReviewRecord | null;
  lead?: LeadRecord | null;
}
