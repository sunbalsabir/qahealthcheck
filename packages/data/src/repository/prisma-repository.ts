import { PrismaClient, type Prisma } from '@prisma/client';
import {
  nowIso,
  type AiTopIssue,
  type AuditDetail,
  type AuditRecord,
  type CategoryScore,
  type Finding,
  type FindingCategory,
  type LeadFollowUpStatus,
  type LeadRecord,
  type PassedCheck,
  type Severity,
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
 * PostgreSQL repository via Prisma. The production persistence path.
 *
 * Findings are stored as rows rather than a JSON blob so the admin dashboard
 * can filter by severity and category in the database, and so the human
 * review layer can update one finding without rewriting the audit.
 */

let client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return client;
}

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  // --- audits -------------------------------------------------------------

  async createAudit(data: CreateAuditData): Promise<AuditRecord> {
    const audit = await this.prisma.audit.create({
      data: {
        url: data.url,
        normalizedUrl: data.normalizedUrl,
        domain: data.domain,
        requestedIp: data.requestedIp,
        mockMode: data.mockMode,
        leadId: data.leadId,
      },
    });
    return toAuditRecord(audit);
  }

  async getAudit(id: string): Promise<AuditRecord | null> {
    const audit = await this.prisma.audit.findUnique({ where: { id } });
    return audit ? toAuditRecord(audit) : null;
  }

  async getAuditDetail(id: string): Promise<AuditDetail | null> {
    const audit = await this.prisma.audit.findUnique({
      where: { id },
      include: {
        pages: { orderBy: { depth: 'asc' } },
        findings: { orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }] },
        categoryScores: true,
        review: { include: { reviewer: true } },
        lead: true,
      },
    });
    if (!audit) return null;

    return {
      ...toAuditRecord(audit),
      pages: audit.pages.map((page) => ({
        id: page.id,
        url: page.url,
        normalizedUrl: page.normalizedUrl,
        depth: page.depth,
        title: page.title,
        statusCode: page.statusCode,
        responseTimeMs: page.responseTimeMs,
        contentType: page.contentType,
        byteSize: page.byteSize,
        linkCount: page.linkCount,
        imageCount: page.imageCount,
        scriptCount: page.scriptCount,
        stylesheetCount: page.stylesheetCount,
        formCount: page.formCount,
        buttonCount: page.buttonCount,
        headingCount: page.headingCount,
      })),
      findings: audit.findings.map(toFinding),
      passedChecks: (audit.passedChecks as PassedCheck[] | null) ?? [],
      categoryScores: audit.categoryScores.map((score) => ({
        category: score.category as FindingCategory,
        score: score.score,
        weight: score.weight,
        findingCount: score.findingCount,
        passedChecks: score.passedChecks,
        summary: score.summary ?? undefined,
      })),
      review: audit.review
        ? {
            id: audit.review.id,
            auditId: audit.review.auditId,
            reviewerId: audit.review.reviewerId,
            reviewerName: audit.review.reviewer?.name ?? audit.review.reviewer?.email ?? null,
            engineerNotes: audit.review.engineerNotes,
            scoreOverride: audit.review.scoreOverride,
            reviewedScore: audit.review.reviewedScore,
            approved: audit.review.approved,
            approvedAt: audit.review.approvedAt?.toISOString() ?? null,
            keptCount: audit.review.keptCount,
            ignoredCount: audit.review.ignoredCount,
            editedCount: audit.review.editedCount,
          }
        : null,
      lead: audit.lead ? toLeadRecord(audit.lead) : null,
    };
  }

  async updateAuditProgress(id: string, update: AuditProgressUpdate): Promise<void> {
    await this.prisma.audit.update({
      where: { id },
      data: {
        status: update.status,
        currentStage: update.currentStage,
        stageIndex: update.stageIndex,
        progressDetail: update.progressDetail,
        errorMessage: update.errorMessage,
        startedAt: update.startedAt,
        finishedAt: update.finishedAt,
        durationMs: update.durationMs,
      },
    });
  }

  async completeAudit(id: string, data: CompleteAuditData): Promise<void> {
    // One transaction so an audit is never half-written: a partially saved
    // result would show a score with no findings behind it.
    await this.prisma.$transaction(async (tx) => {
      await tx.finding.deleteMany({ where: { auditId: id } });
      await tx.auditPage.deleteMany({ where: { auditId: id } });
      await tx.auditCategoryScore.deleteMany({ where: { auditId: id } });

      if (data.pages.length > 0) {
        await tx.auditPage.createMany({
          data: data.pages.map((page) => ({
            auditId: id,
            url: page.url,
            normalizedUrl: page.normalizedUrl,
            depth: page.depth,
            title: page.title ?? null,
            statusCode: page.statusCode ?? null,
            responseTimeMs: page.responseTimeMs ?? null,
            contentType: page.contentType ?? null,
            byteSize: page.byteSize ?? null,
            linkCount: page.linkCount,
            imageCount: page.imageCount,
            scriptCount: page.scriptCount,
            stylesheetCount: page.stylesheetCount,
            formCount: page.formCount,
            buttonCount: page.buttonCount,
            headingCount: page.headingCount,
          })),
          skipDuplicates: true,
        });
      }

      if (data.findings.length > 0) {
        await tx.finding.createMany({
          data: data.findings.map((finding) => ({
            id: finding.id,
            auditId: id,
            ruleId: finding.ruleId,
            category: finding.category,
            title: finding.title,
            description: finding.description,
            severity: finding.severity,
            confidence: finding.confidence,
            url: finding.url ?? null,
            selector: finding.selector ?? null,
            evidence: finding.evidence as unknown as Prisma.InputJsonValue,
            recommendation: finding.recommendation,
            impact: finding.impact ?? null,
            detectedBy: finding.detectedBy,
            occurrences: finding.occurrences,
            affectedUrls: (finding.affectedUrls ?? []) as unknown as Prisma.InputJsonValue,
            originalSeverity: finding.originalSeverity ?? finding.severity,
            aiSummary: finding.aiSummary ?? null,
            aiImpact: finding.aiImpact ?? null,
            aiRemediation: finding.aiRemediation ?? null,
            detectedAt: new Date(finding.timestamp),
          })),
          skipDuplicates: true,
        });
      }

      if (data.categoryScores.length > 0) {
        await tx.auditCategoryScore.createMany({
          data: data.categoryScores.map((score) => ({
            auditId: id,
            category: score.category,
            score: score.score,
            weight: score.weight,
            findingCount: score.findingCount,
            passedChecks: score.passedChecks,
            summary: score.summary ?? null,
          })),
          skipDuplicates: true,
        });
      }

      await tx.audit.update({
        where: { id },
        data: {
          status: 'READY_FOR_REVIEW',
          stageIndex: 10,
          currentStage: 'Generating QA report',
          overallScore: data.overallScore,
          scoreBand: data.scoreBand,
          executiveSummary: data.executiveSummary,
          recommendations: data.recommendations as unknown as Prisma.InputJsonValue,
          topIssues: data.topIssues as unknown as Prisma.InputJsonValue,
          passedChecks: data.passedChecks as unknown as Prisma.InputJsonValue,
          scannerWarnings: data.scannerWarnings as unknown as Prisma.InputJsonValue,
          aiAnalysisUsed: data.aiAnalysisUsed,
          aiFailureReason: data.aiFailureReason ?? null,
          engineVersion: data.engineVersion,
          durationMs: data.durationMs,
          finishedAt: new Date(),
        },
      });
    });
  }

  async failAudit(id: string, message: string): Promise<void> {
    await this.prisma.audit.update({
      where: { id },
      data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
    });
  }

  async listAudits(filters: AuditListFilters): Promise<AuditListResult> {
    const where: Prisma.AuditWhereInput = {};

    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { url: { contains: filters.search, mode: 'insensitive' } },
        { domain: { contains: filters.search, mode: 'insensitive' } },
        { lead: { email: { contains: filters.search, mode: 'insensitive' } } },
        { lead: { companyName: { contains: filters.search, mode: 'insensitive' } } },
      ];
    }
    if (filters.minScore !== undefined || filters.maxScore !== undefined) {
      where.overallScore = {
        ...(filters.minScore !== undefined ? { gte: filters.minScore } : {}),
        ...(filters.maxScore !== undefined ? { lte: filters.maxScore } : {}),
      };
    }
    if (filters.severity) {
      where.findings = { some: { severity: filters.severity } };
    }

    const [total, audits] = await Promise.all([
      this.prisma.audit.count({ where }),
      this.prisma.audit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        include: {
          lead: { select: { email: true } },
          _count: { select: { findings: true } },
          findings: { where: { severity: 'CRITICAL' }, select: { id: true } },
        },
      }),
    ]);

    return {
      audits: audits.map((audit) => ({
        ...toAuditRecord(audit),
        findingCount: audit._count.findings,
        criticalCount: audit.findings.length,
        leadEmail: audit.lead?.email ?? null,
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async deleteAudit(id: string): Promise<void> {
    await this.prisma.audit.delete({ where: { id } });
  }

  // --- human QA review ----------------------------------------------------

  async submitReview(data: SubmitReviewData): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const decision of data.decisions) {
        await tx.finding.update({
          where: { id: decision.findingId },
          data: {
            status: decision.status,
            severity: decision.severity,
            editedTitle: decision.title,
            editedDescription: decision.description,
            qaNote: decision.qaNote,
            reviewedAt: new Date(),
            reviewedById: data.reviewerId ?? null,
          },
        });
      }

      const [kept, ignored, edited] = await Promise.all([
        tx.finding.count({ where: { auditId: data.auditId, status: 'KEPT' } }),
        tx.finding.count({ where: { auditId: data.auditId, status: 'IGNORED' } }),
        tx.finding.count({ where: { auditId: data.auditId, status: 'EDITED' } }),
      ]);

      await tx.auditReview.upsert({
        where: { auditId: data.auditId },
        create: {
          auditId: data.auditId,
          reviewerId: data.reviewerId ?? null,
          engineerNotes: data.engineerNotes ?? null,
          scoreOverride: data.scoreOverride ?? null,
          reviewedScore: data.reviewedScore ?? null,
          approved: data.approve,
          approvedAt: data.approve ? new Date() : null,
          keptCount: kept,
          ignoredCount: ignored,
          editedCount: edited,
        },
        update: {
          reviewerId: data.reviewerId ?? undefined,
          engineerNotes: data.engineerNotes ?? undefined,
          scoreOverride: data.scoreOverride,
          reviewedScore: data.reviewedScore ?? undefined,
          approved: data.approve || undefined,
          approvedAt: data.approve ? new Date() : undefined,
          keptCount: kept,
          ignoredCount: ignored,
          editedCount: edited,
        },
      });

      if (data.approve) {
        await tx.audit.update({ where: { id: data.auditId }, data: { status: 'REVIEWED' } });
      }
    });
  }

  async updateFinding(auditId: string, update: FindingReviewUpdate): Promise<void> {
    await this.prisma.finding.update({
      where: { id: update.findingId },
      data: {
        status: update.status,
        severity: update.severity,
        editedTitle: update.title,
        editedDescription: update.description,
        qaNote: update.qaNote,
        reviewedAt: new Date(),
        reviewedById: update.reviewerId ?? null,
      },
    });
  }

  // --- reports ------------------------------------------------------------

  async recordReport(data: {
    auditId: string;
    filePath?: string;
    byteSize?: number;
    includesAi: boolean;
    reviewed: boolean;
  }): Promise<ReportRecord> {
    const previous = await this.prisma.report.count({ where: { auditId: data.auditId } });
    const report = await this.prisma.report.create({
      data: {
        auditId: data.auditId,
        version: previous + 1,
        filePath: data.filePath ?? null,
        byteSize: data.byteSize ?? null,
        includesAi: data.includesAi,
        reviewed: data.reviewed,
      },
    });

    await this.prisma.audit.updateMany({
      where: { id: data.auditId, status: 'REVIEWED' },
      data: { status: 'REPORT_GENERATED' },
    });

    return {
      id: report.id,
      auditId: report.auditId,
      version: report.version,
      filePath: report.filePath,
      byteSize: report.byteSize,
      includesAi: report.includesAi,
      reviewed: report.reviewed,
      generatedAt: report.generatedAt.toISOString(),
    };
  }

  async getLatestReport(auditId: string): Promise<ReportRecord | null> {
    const report = await this.prisma.report.findFirst({
      where: { auditId },
      orderBy: { version: 'desc' },
    });
    if (!report) return null;
    return {
      id: report.id,
      auditId: report.auditId,
      version: report.version,
      filePath: report.filePath,
      byteSize: report.byteSize,
      includesAi: report.includesAi,
      reviewed: report.reviewed,
      generatedAt: report.generatedAt.toISOString(),
    };
  }

  // --- leads --------------------------------------------------------------

  async createLead(data: CreateLeadData): Promise<LeadRecord> {
    const lead = await this.prisma.lead.create({
      data: {
        companyName: data.companyName ?? null,
        contactName: data.contactName ?? null,
        email: data.email ?? null,
        website: data.website,
        industry: data.industry ?? null,
        focusAreas: data.focusAreas ?? null,
        sourceIp: data.sourceIp ?? null,
      },
    });
    return toLeadRecord(lead);
  }

  async listLeads(options: { status?: LeadFollowUpStatus; page?: number; pageSize?: number } = {}) {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    const where: Prisma.LeadWhereInput = options.status ? { followUpStatus: options.status } : {};

    const [total, leads] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          audits: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, overallScore: true },
          },
          _count: { select: { audits: true } },
        },
      }),
    ]);

    return {
      leads: leads.map((lead) => ({
        ...toLeadRecord(lead),
        auditCount: lead._count.audits,
        latestScore: lead.audits[0]?.overallScore ?? null,
        latestAuditId: lead.audits[0]?.id ?? null,
      })),
      total,
    };
  }

  async updateLead(
    id: string,
    data: { followUpStatus?: LeadFollowUpStatus; internalNotes?: string },
  ): Promise<LeadRecord | null> {
    const lead = await this.prisma.lead.update({
      where: { id },
      data: { followUpStatus: data.followUpStatus, internalNotes: data.internalNotes },
    });
    return toLeadRecord(lead);
  }

  // --- users --------------------------------------------------------------

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    return user
      ? { id: user.id, email: user.email, name: user.name, role: user.role, passwordHash: user.passwordHash }
      : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user
      ? { id: user.id, email: user.email, name: user.name, role: user.role, passwordHash: user.passwordHash }
      : null;
  }

  async ensureAdminUser(email: string, passwordHash: string): Promise<UserRecord> {
    const user = await this.prisma.user.upsert({
      where: { email: email.toLowerCase() },
      create: {
        email: email.toLowerCase(),
        name: 'Qualovix Admin',
        passwordHash,
        role: 'ADMIN',
      },
      update: {},
    });
    return { id: user.id, email: user.email, name: user.name, role: user.role, passwordHash: user.passwordHash };
  }

  // --- abuse prevention ---------------------------------------------------

  async incrementRateLimit(scope: string, key: string, windowMs: number): Promise<number> {
    const windowKey = String(Math.floor(Date.now() / windowMs));
    const expiresAt = new Date(Math.ceil(Date.now() / windowMs) * windowMs);

    const counter = await this.prisma.rateLimitCounter.upsert({
      where: { scope_key_windowKey: { scope, key, windowKey } },
      create: { scope, key, windowKey, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });

    // Opportunistic cleanup of expired buckets.
    if (counter.count === 1) {
      void this.prisma.rateLimitCounter
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch(() => undefined);
    }

    return counter.count;
  }

  async peekRateLimit(scope: string, key: string, windowMs: number): Promise<number> {
    const windowKey = String(Math.floor(Date.now() / windowMs));
    const counter = await this.prisma.rateLimitCounter.findUnique({
      where: { scope_key_windowKey: { scope, key, windowKey } },
    });
    return counter?.count ?? 0;
  }

  async countRecentAuditsForDomain(domain: string, sinceMs: number): Promise<number> {
    return this.prisma.audit.count({
      where: { domain, createdAt: { gte: new Date(Date.now() - sinceMs) } },
    });
  }
}

// --- mapping helpers --------------------------------------------------------

type PrismaAudit = Prisma.AuditGetPayload<Record<string, never>>;
type PrismaFinding = Prisma.FindingGetPayload<Record<string, never>>;
type PrismaLead = Prisma.LeadGetPayload<Record<string, never>>;

function toAuditRecord(audit: PrismaAudit): AuditRecord {
  return {
    id: audit.id,
    url: audit.url,
    normalizedUrl: audit.normalizedUrl,
    domain: audit.domain,
    status: audit.status,
    currentStage: audit.currentStage,
    stageIndex: audit.stageIndex,
    totalStages: audit.totalStages,
    progressDetail: audit.progressDetail,
    overallScore: audit.overallScore,
    scoreBand: audit.scoreBand,
    mockMode: audit.mockMode,
    requestedIp: audit.requestedIp,
    startedAt: audit.startedAt?.toISOString() ?? null,
    finishedAt: audit.finishedAt?.toISOString() ?? null,
    durationMs: audit.durationMs,
    errorMessage: audit.errorMessage,
    executiveSummary: audit.executiveSummary,
    topIssues: (audit.topIssues as AiTopIssue[] | null) ?? null,
    recommendations: (audit.recommendations as string[] | null) ?? null,
    aiAnalysisUsed: audit.aiAnalysisUsed,
    aiFailureReason: audit.aiFailureReason,
    engineVersion: audit.engineVersion,
    createdAt: audit.createdAt.toISOString(),
    updatedAt: audit.updatedAt.toISOString(),
    leadId: audit.leadId,
  };
}

function toFinding(finding: PrismaFinding): Finding {
  return {
    id: finding.id,
    ruleId: finding.ruleId,
    category: finding.category as FindingCategory,
    title: finding.title,
    description: finding.description,
    severity: finding.severity as Severity,
    confidence: finding.confidence,
    url: finding.url ?? undefined,
    selector: finding.selector ?? undefined,
    evidence: finding.evidence as unknown as Finding['evidence'],
    recommendation: finding.recommendation,
    impact: finding.impact ?? undefined,
    detectedBy: finding.detectedBy,
    occurrences: finding.occurrences,
    affectedUrls: (finding.affectedUrls as string[] | null) ?? undefined,
    timestamp: finding.detectedAt.toISOString(),
    status: finding.status,
    originalSeverity: (finding.originalSeverity as Severity | null) ?? undefined,
    qaNote: finding.qaNote ?? undefined,
    editedTitle: finding.editedTitle ?? undefined,
    editedDescription: finding.editedDescription ?? undefined,
    aiSummary: finding.aiSummary ?? undefined,
    aiImpact: finding.aiImpact ?? undefined,
    aiRemediation: finding.aiRemediation ?? undefined,
  };
}

function toLeadRecord(lead: PrismaLead): LeadRecord {
  return {
    id: lead.id,
    companyName: lead.companyName,
    contactName: lead.contactName,
    email: lead.email,
    website: lead.website,
    industry: lead.industry,
    focusAreas: lead.focusAreas,
    followUpStatus: lead.followUpStatus,
    internalNotes: lead.internalNotes,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

export { nowIso, type CategoryScore };
