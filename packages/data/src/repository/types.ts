import type {
  AuditDetail,
  AuditRecord,
  AuditStatus,
  CategoryScore,
  Finding,
  FindingStatus,
  LeadFollowUpStatus,
  LeadRecord,
  PassedCheck,
  Severity,
  AiTopIssue,
  AuditPageRecord,
} from '@qualovix/shared';

/**
 * Persistence contract.
 *
 * Two implementations exist: Prisma/PostgreSQL (the production path) and an
 * in-memory store (zero-infrastructure development and tests). Nothing above
 * this interface knows which is in use, which is also what lets the test
 * suite run the API and review workflow without a database.
 */

export interface CreateAuditData {
  url: string;
  normalizedUrl: string;
  domain: string;
  requestedIp?: string;
  mockMode: boolean;
  leadId?: string;
}

export interface AuditProgressUpdate {
  status?: AuditStatus;
  currentStage?: string;
  stageIndex?: number;
  progressDetail?: string;
  errorMessage?: string;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
}

export interface CompleteAuditData {
  findings: Finding[];
  passedChecks: PassedCheck[];
  categoryScores: CategoryScore[];
  pages: Array<Omit<AuditPageRecord, 'id'>>;
  overallScore: number;
  scoreBand: string;
  executiveSummary: string;
  recommendations: string[];
  topIssues: AiTopIssue[];
  aiAnalysisUsed: boolean;
  aiFailureReason?: string;
  scannerWarnings: string[];
  engineVersion: string;
  durationMs: number;
}

export interface AuditListFilters {
  search?: string;
  status?: AuditStatus;
  minScore?: number;
  maxScore?: number;
  severity?: Severity;
  page: number;
  pageSize: number;
}

export interface AuditListResult {
  audits: Array<AuditRecord & { findingCount: number; criticalCount: number; leadEmail?: string | null }>;
  total: number;
  page: number;
  pageSize: number;
}

export interface FindingReviewUpdate {
  findingId: string;
  status: FindingStatus;
  severity?: Severity;
  title?: string;
  description?: string;
  qaNote?: string;
  reviewerId?: string;
}

export interface SubmitReviewData {
  auditId: string;
  reviewerId?: string;
  decisions: FindingReviewUpdate[];
  engineerNotes?: string;
  scoreOverride?: number | null;
  /** Score recalculated from the kept findings, set by the review endpoint. */
  reviewedScore?: number | null;
  approve: boolean;
}

export interface CreateLeadData {
  companyName?: string;
  contactName?: string;
  email?: string;
  website: string;
  industry?: string;
  focusAreas?: string;
  sourceIp?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name?: string | null;
  role: 'ADMIN' | 'QA_ENGINEER';
  passwordHash: string;
}

export interface ReportRecord {
  id: string;
  auditId: string;
  version: number;
  filePath?: string | null;
  byteSize?: number | null;
  includesAi: boolean;
  reviewed: boolean;
  generatedAt: string;
}

export interface AuditRepository {
  // --- audits ---
  createAudit(data: CreateAuditData): Promise<AuditRecord>;
  getAudit(id: string): Promise<AuditRecord | null>;
  getAuditDetail(id: string): Promise<AuditDetail | null>;
  updateAuditProgress(id: string, update: AuditProgressUpdate): Promise<void>;
  completeAudit(id: string, data: CompleteAuditData): Promise<void>;
  failAudit(id: string, message: string): Promise<void>;
  listAudits(filters: AuditListFilters): Promise<AuditListResult>;
  deleteAudit(id: string): Promise<void>;

  // --- human QA review ---
  submitReview(data: SubmitReviewData): Promise<void>;
  updateFinding(auditId: string, update: FindingReviewUpdate): Promise<void>;

  // --- reports ---
  recordReport(data: {
    auditId: string;
    filePath?: string;
    byteSize?: number;
    includesAi: boolean;
    reviewed: boolean;
  }): Promise<ReportRecord>;
  getLatestReport(auditId: string): Promise<ReportRecord | null>;

  // --- leads ---
  createLead(data: CreateLeadData): Promise<LeadRecord>;
  listLeads(options?: { status?: LeadFollowUpStatus; page?: number; pageSize?: number }): Promise<{
    leads: Array<LeadRecord & { auditCount: number; latestScore?: number | null; latestAuditId?: string | null }>;
    total: number;
  }>;
  updateLead(
    id: string,
    data: { followUpStatus?: LeadFollowUpStatus; internalNotes?: string },
  ): Promise<LeadRecord | null>;

  // --- users ---
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  ensureAdminUser(email: string, passwordHash: string): Promise<UserRecord>;

  // --- abuse prevention ---
  /** Increment a counter and return the new value within the current window. */
  incrementRateLimit(scope: string, key: string, windowMs: number): Promise<number>;
  /** Read a counter without incrementing it. */
  peekRateLimit(scope: string, key: string, windowMs: number): Promise<number>;

  /** Count audits started for a domain within a period, for abuse checks. */
  countRecentAuditsForDomain(domain: string, sinceMs: number): Promise<number>;
}
