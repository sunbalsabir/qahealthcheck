import {
  SEVERITY_RANK,
  newId,
  nowIso,
  type AuditDetail,
  type AuditRecord,
  type CategoryScore,
  type Finding,
  type LeadFollowUpStatus,
  type LeadRecord,
  type PassedCheck,
  type AuditPageRecord,
  type AuditReviewRecord,
  type AiTopIssue,
} from '@qualovix/shared';
import type {
  AuditListFilters,
  AuditListResult,
  AuditProgressUpdate,
  AuditRepository,
  CompleteAuditData,
  CreateAuditData,
  CreateLeadData,
  FindingReviewUpdate,
  ReportRecord,
  SubmitReviewData,
  UserRecord,
} from './types';

/**
 * In-memory repository.
 *
 * Lets the whole application — API, worker, review workflow and report
 * generation — run with no database at all, which is what makes
 * `npm run dev` work on a clean machine and what lets the integration tests
 * exercise real code paths without infrastructure.
 *
 * Data is lost on restart. That is stated plainly in the README and the
 * admin UI, and PERSISTENCE_DRIVER=prisma is the documented production path.
 */

interface StoredAudit {
  record: AuditRecord;
  pages: AuditPageRecord[];
  findings: Finding[];
  passedChecks: PassedCheck[];
  categoryScores: CategoryScore[];
  review?: AuditReviewRecord;
  reports: ReportRecord[];
}

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

export class MemoryAuditRepository implements AuditRepository {
  private readonly audits = new Map<string, StoredAudit>();
  private readonly leads = new Map<string, LeadRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  // --- audits -------------------------------------------------------------

  async createAudit(data: CreateAuditData): Promise<AuditRecord> {
    const id = newId();
    const timestamp = nowIso();
    const record: AuditRecord = {
      id,
      url: data.url,
      normalizedUrl: data.normalizedUrl,
      domain: data.domain,
      status: 'PENDING',
      stageIndex: 0,
      totalStages: 10,
      mockMode: data.mockMode,
      requestedIp: data.requestedIp ?? null,
      aiAnalysisUsed: false,
      engineVersion: '1.0.0',
      createdAt: timestamp,
      updatedAt: timestamp,
      leadId: data.leadId ?? null,
    };

    this.audits.set(id, {
      record,
      pages: [],
      findings: [],
      passedChecks: [],
      categoryScores: [],
      reports: [],
    });
    return record;
  }

  async getAudit(id: string): Promise<AuditRecord | null> {
    return this.audits.get(id)?.record ?? null;
  }

  async getAuditDetail(id: string): Promise<AuditDetail | null> {
    const stored = this.audits.get(id);
    if (!stored) return null;
    return {
      ...stored.record,
      pages: stored.pages,
      findings: stored.findings,
      passedChecks: stored.passedChecks,
      categoryScores: stored.categoryScores,
      review: stored.review ?? null,
      lead: stored.record.leadId ? (this.leads.get(stored.record.leadId) ?? null) : null,
    };
  }

  async updateAuditProgress(id: string, update: AuditProgressUpdate): Promise<void> {
    const stored = this.audits.get(id);
    if (!stored) return;
    stored.record = {
      ...stored.record,
      status: update.status ?? stored.record.status,
      currentStage: update.currentStage ?? stored.record.currentStage,
      stageIndex: update.stageIndex ?? stored.record.stageIndex,
      progressDetail: update.progressDetail ?? stored.record.progressDetail,
      errorMessage: update.errorMessage ?? stored.record.errorMessage,
      startedAt: update.startedAt?.toISOString() ?? stored.record.startedAt,
      finishedAt: update.finishedAt?.toISOString() ?? stored.record.finishedAt,
      durationMs: update.durationMs ?? stored.record.durationMs,
      updatedAt: nowIso(),
    };
  }

  async completeAudit(id: string, data: CompleteAuditData): Promise<void> {
    const stored = this.audits.get(id);
    if (!stored) return;

    stored.pages = data.pages.map((page) => ({ ...page, id: newId() }));
    stored.findings = data.findings;
    stored.passedChecks = data.passedChecks;
    stored.categoryScores = data.categoryScores;
    stored.record = {
      ...stored.record,
      status: 'READY_FOR_REVIEW',
      stageIndex: 10,
      currentStage: 'Generating QA report',
      overallScore: data.overallScore,
      scoreBand: data.scoreBand,
      executiveSummary: data.executiveSummary,
      recommendations: data.recommendations,
      topIssues: data.topIssues,
      aiAnalysisUsed: data.aiAnalysisUsed,
      aiFailureReason: data.aiFailureReason ?? null,
      engineVersion: data.engineVersion,
      durationMs: data.durationMs,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  async failAudit(id: string, message: string): Promise<void> {
    const stored = this.audits.get(id);
    if (!stored) return;
    stored.record = {
      ...stored.record,
      status: 'FAILED',
      errorMessage: message,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  async listAudits(filters: AuditListFilters): Promise<AuditListResult> {
    let all = Array.from(this.audits.values());

    if (filters.status) {
      all = all.filter((a) => a.record.status === filters.status);
    }
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      all = all.filter(
        (a) =>
          a.record.url.toLowerCase().includes(needle) ||
          a.record.domain.toLowerCase().includes(needle) ||
          (a.record.leadId
            ? Object.values(this.leads.get(a.record.leadId) ?? {}).some((v) =>
                String(v ?? '').toLowerCase().includes(needle),
              )
            : false),
      );
    }
    if (filters.minScore !== undefined) {
      all = all.filter((a) => (a.record.overallScore ?? -1) >= filters.minScore!);
    }
    if (filters.maxScore !== undefined) {
      all = all.filter((a) => (a.record.overallScore ?? 101) <= filters.maxScore!);
    }
    if (filters.severity) {
      all = all.filter((a) => a.findings.some((f) => f.severity === filters.severity));
    }

    all.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));

    const total = all.length;
    const start = (filters.page - 1) * filters.pageSize;
    const slice = all.slice(start, start + filters.pageSize);

    return {
      audits: slice.map((stored) => ({
        ...stored.record,
        findingCount: stored.findings.length,
        criticalCount: stored.findings.filter((f) => f.severity === 'CRITICAL').length,
        leadEmail: stored.record.leadId ? (this.leads.get(stored.record.leadId)?.email ?? null) : null,
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async deleteAudit(id: string): Promise<void> {
    this.audits.delete(id);
  }

  // --- human QA review ----------------------------------------------------

  async submitReview(data: SubmitReviewData): Promise<void> {
    const stored = this.audits.get(data.auditId);
    if (!stored) return;

    for (const decision of data.decisions) {
      this.applyFindingUpdate(stored, decision);
    }

    const kept = stored.findings.filter((f) => f.status === 'KEPT').length;
    const ignored = stored.findings.filter((f) => f.status === 'IGNORED').length;
    const edited = stored.findings.filter((f) => f.status === 'EDITED').length;

    stored.review = {
      id: stored.review?.id ?? newId(),
      auditId: data.auditId,
      reviewerId: data.reviewerId ?? null,
      reviewerName: data.reviewerId ? (this.users.get(data.reviewerId)?.name ?? null) : null,
      engineerNotes: data.engineerNotes ?? stored.review?.engineerNotes ?? null,
      scoreOverride: data.scoreOverride ?? stored.review?.scoreOverride ?? null,
      reviewedScore: data.reviewedScore ?? stored.review?.reviewedScore ?? null,
      approved: data.approve || (stored.review?.approved ?? false),
      approvedAt: data.approve ? nowIso() : (stored.review?.approvedAt ?? null),
      keptCount: kept,
      ignoredCount: ignored,
      editedCount: edited,
    };

    if (data.approve) {
      stored.record = { ...stored.record, status: 'REVIEWED', updatedAt: nowIso() };
    }
  }

  async updateFinding(auditId: string, update: FindingReviewUpdate): Promise<void> {
    const stored = this.audits.get(auditId);
    if (!stored) return;
    this.applyFindingUpdate(stored, update);
  }

  private applyFindingUpdate(stored: StoredAudit, update: FindingReviewUpdate): void {
    const index = stored.findings.findIndex((f) => f.id === update.findingId);
    if (index === -1) return;
    const finding = stored.findings[index]!;

    stored.findings[index] = {
      ...finding,
      status: update.status,
      // The scanner's original severity is preserved so the report can show
      // that a human changed it, and so the change is auditable.
      originalSeverity: finding.originalSeverity ?? finding.severity,
      severity: update.severity ?? finding.severity,
      editedTitle: update.title ?? finding.editedTitle,
      editedDescription: update.description ?? finding.editedDescription,
      qaNote: update.qaNote ?? finding.qaNote,
    };
  }

  // --- reports ------------------------------------------------------------

  async recordReport(data: {
    auditId: string;
    filePath?: string;
    byteSize?: number;
    includesAi: boolean;
    reviewed: boolean;
  }): Promise<ReportRecord> {
    const stored = this.audits.get(data.auditId);
    const report: ReportRecord = {
      id: newId(),
      auditId: data.auditId,
      version: (stored?.reports.length ?? 0) + 1,
      filePath: data.filePath ?? null,
      byteSize: data.byteSize ?? null,
      includesAi: data.includesAi,
      reviewed: data.reviewed,
      generatedAt: nowIso(),
    };
    stored?.reports.push(report);
    if (stored) {
      stored.record = {
        ...stored.record,
        status: stored.record.status === 'REVIEWED' ? 'REPORT_GENERATED' : stored.record.status,
        updatedAt: nowIso(),
      };
    }
    return report;
  }

  async getLatestReport(auditId: string): Promise<ReportRecord | null> {
    const reports = this.audits.get(auditId)?.reports ?? [];
    return reports.at(-1) ?? null;
  }

  // --- leads --------------------------------------------------------------

  async createLead(data: CreateLeadData): Promise<LeadRecord> {
    const id = newId();
    const lead: LeadRecord = {
      id,
      companyName: data.companyName ?? null,
      contactName: data.contactName ?? null,
      email: data.email ?? null,
      website: data.website,
      industry: data.industry ?? null,
      focusAreas: data.focusAreas ?? null,
      followUpStatus: 'NEW',
      internalNotes: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.leads.set(id, lead);
    return lead;
  }

  async listLeads(options: { status?: LeadFollowUpStatus; page?: number; pageSize?: number } = {}) {
    let all = Array.from(this.leads.values());
    if (options.status) all = all.filter((lead) => lead.followUpStatus === options.status);
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    const slice = all.slice((page - 1) * pageSize, page * pageSize);

    return {
      leads: slice.map((lead) => {
        const audits = Array.from(this.audits.values()).filter(
          (a) => a.record.leadId === lead.id,
        );
        const latest = audits.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt))[0];
        return {
          ...lead,
          auditCount: audits.length,
          latestScore: latest?.record.overallScore ?? null,
          latestAuditId: latest?.record.id ?? null,
        };
      }),
      total: all.length,
    };
  }

  async updateLead(
    id: string,
    data: { followUpStatus?: LeadFollowUpStatus; internalNotes?: string },
  ): Promise<LeadRecord | null> {
    const lead = this.leads.get(id);
    if (!lead) return null;
    const updated: LeadRecord = {
      ...lead,
      followUpStatus: data.followUpStatus ?? lead.followUpStatus,
      internalNotes: data.internalNotes ?? lead.internalNotes,
      updatedAt: nowIso(),
    };
    this.leads.set(id, updated);
    return updated;
  }

  // --- users --------------------------------------------------------------

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const needle = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === needle) return user;
    }
    return null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async ensureAdminUser(email: string, passwordHash: string): Promise<UserRecord> {
    const existing = await this.findUserByEmail(email);
    if (existing) return existing;
    const user: UserRecord = {
      id: newId(),
      email,
      name: 'Qualovix Admin',
      role: 'ADMIN',
      passwordHash,
    };
    this.users.set(user.id, user);
    return user;
  }

  // --- abuse prevention ---------------------------------------------------

  async incrementRateLimit(scope: string, key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const bucket = `${scope}:${key}:${Math.floor(now / windowMs)}`;
    const entry = this.rateLimits.get(bucket);

    if (!entry || entry.expiresAt <= now) {
      this.rateLimits.set(bucket, { count: 1, expiresAt: now + windowMs });
      this.pruneRateLimits(now);
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  async peekRateLimit(scope: string, key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const bucket = `${scope}:${key}:${Math.floor(now / windowMs)}`;
    const entry = this.rateLimits.get(bucket);
    if (!entry || entry.expiresAt <= now) return 0;
    return entry.count;
  }

  private pruneRateLimits(now: number): void {
    if (this.rateLimits.size < 5000) return;
    for (const [key, entry] of this.rateLimits) {
      if (entry.expiresAt <= now) this.rateLimits.delete(key);
    }
  }

  async countRecentAuditsForDomain(domain: string, sinceMs: number): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    let count = 0;
    for (const stored of this.audits.values()) {
      if (stored.record.domain !== domain) continue;
      if (new Date(stored.record.createdAt).getTime() >= cutoff) count += 1;
    }
    return count;
  }

  /** Test helper. */
  clear(): void {
    this.audits.clear();
    this.leads.clear();
    this.users.clear();
    this.rateLimits.clear();
  }

  /** Sort helper shared with the Prisma implementation's expectations. */
  static sortFindings(findings: Finding[]): Finding[] {
    return [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  }
}

export type { AiTopIssue };
