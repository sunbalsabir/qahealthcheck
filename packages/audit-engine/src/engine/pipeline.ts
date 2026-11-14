import {
  AUDIT_STAGES,
  ENGINE_VERSION,
  errorMessage,
  getEnv,
  nowIso,
  scoreBandFor,
  withTimeout,
  type AiAnalysisResult,
  type AppEnv,
  type AuditStage,
  type CategoryScore,
  type Finding,
  type PassedCheck,
} from '@qualovix/shared';
import { SCANNERS, type CrawlResult, type ScanContext, type ScannerResult } from '@qualovix/scanners';
import { crawlSite } from '../crawler/crawler';
import { crawlSiteMock } from '../crawler/mock-crawler';
import { normalizeFindings } from './normalizer';
import { applySeverityRules } from './severity-engine';
import { calculateScore } from './score-engine';
import {
  analyzeFindings,
  buildFallbackRecommendations,
  buildFallbackSummary,
} from '../ai/analyzer';
import { assertSafeUrl, SsrfError } from '../security/url-guard';

/**
 * The audit pipeline.
 *
 * Stages, in order:
 *
 *   validate -> crawl -> scan (9 scanners) -> normalize -> severity -> score
 *   -> AI analysis (optional) -> assemble result
 *
 * Failure policy: a scanner that throws is recorded as a warning and the
 * pipeline continues, because eight scanners' worth of findings is far more
 * useful than none. A crawl failure or an SSRF refusal is fatal, because
 * there is nothing to report.
 */

export interface PipelineProgress {
  stage: AuditStage;
  stageIndex: number;
  totalStages: number;
  detail?: string;
}

export interface RunAuditOptions {
  auditId: string;
  url: string;
  env?: AppEnv;
  signal?: AbortSignal;
  onProgress?: (progress: PipelineProgress) => void | Promise<void>;
}

export interface AuditOutcome {
  auditId: string;
  url: string;
  crawl: CrawlResult;
  findings: Finding[];
  passedChecks: PassedCheck[];
  categoryScores: CategoryScore[];
  overallScore: number;
  scoreBand: string;
  executiveSummary: string;
  recommendations: string[];
  topIssues: AiAnalysisResult['topIssues'];
  aiAnalysisUsed: boolean;
  aiFailureReason?: string;
  warnings: string[];
  engineVersion: string;
  durationMs: number;
}

/** Maps each scanner to the progress stage it belongs to. */
const SCANNER_STAGE: Record<string, AuditStage> = {
  'broken-links': 'Checking links',
  performance: 'Testing page performance',
  accessibility: 'Checking accessibility',
  console: 'Detecting console errors',
  responsive: 'Checking responsive behavior',
  forms: 'Checking forms',
  technical: 'Running technical checks',
  security: 'Running technical checks',
  ux: 'Running technical checks',
};

export async function runAudit(options: RunAuditOptions): Promise<AuditOutcome> {
  const env = options.env ?? getEnv();
  const startedAt = Date.now();
  const warnings: string[] = [];

  const emit = async (stage: AuditStage, detail?: string) => {
    await options.onProgress?.({
      stage,
      stageIndex: AUDIT_STAGES.indexOf(stage) + 1,
      totalStages: AUDIT_STAGES.length,
      detail,
    });
  };

  // --- Stage 0: validate ------------------------------------------------
  // The engine never trusts its caller. Validation runs here, before the
  // crawler is chosen, so mock mode cannot become a path that skips the SSRF
  // guard — the real crawler validates again at its own boundary.
  await assertSafeUrl(options.url, { env });

  // --- Stage 1: crawl ---------------------------------------------------
  await emit('Discovering pages', env.AUDIT_MOCK_MODE ? 'Generating mock audit data' : 'Loading the site');

  let crawl: CrawlResult;
  try {
    crawl = env.AUDIT_MOCK_MODE
      ? await crawlSiteMock({ auditId: options.auditId, url: options.url, env })
      : await withTimeout(
          crawlSite({
            auditId: options.auditId,
            url: options.url,
            env,
            signal: options.signal,
            onProgress: (message) => void emit('Discovering pages', message),
          }),
          env.AUDIT_JOB_TIMEOUT_MS,
          'Website crawl',
        );
  } catch (error) {
    // An SSRF refusal must surface as a clear message, not a stack trace.
    if (error instanceof SsrfError) throw error;
    throw new AuditFailure(
      `The site could not be audited: ${errorMessage(error)}`,
      options.url,
      error,
    );
  }

  warnings.push(...crawl.warnings);

  if (crawl.pages.length === 0) {
    throw new AuditFailure(
      'No pages could be loaded from this URL. Check that the site is publicly reachable and try again.',
      options.url,
    );
  }

  // --- Stage 2: run the scanners ---------------------------------------
  const context: ScanContext = {
    auditId: options.auditId,
    crawl,
    limits: { maxFindingsPerRule: 25, maxPages: env.MAX_PAGES },
  };

  const results: ScannerResult[] = [];
  for (const scanner of SCANNERS) {
    if (options.signal?.aborted) {
      warnings.push('Audit was cancelled before all scanners completed.');
      break;
    }
    await emit(SCANNER_STAGE[scanner.id] ?? 'Running technical checks', scanner.name);

    try {
      // A scanner is bounded so one pathological page cannot hang the job.
      const result = await withTimeout(
        Promise.resolve(scanner.scan(context)),
        60_000,
        `Scanner "${scanner.id}"`,
      );
      results.push(result);
    } catch (error) {
      // Non-fatal: record it and keep the other scanners' findings.
      warnings.push(`Scanner "${scanner.id}" failed and was skipped: ${errorMessage(error)}`);
    }
  }

  // --- Stage 3: normalize, apply severity rules, score ------------------
  await emit('Analyzing findings', 'Normalising and de-duplicating findings');

  const normalized = normalizeFindings(results);
  warnings.push(...normalized.warnings);
  if (normalized.duplicatesRemoved > 0) {
    warnings.push(
      `${normalized.duplicatesRemoved} duplicate findings were merged during normalisation.`,
    );
  }

  const { findings: severityAdjusted } = applySeverityRules(normalized.findings, crawl);
  const score = calculateScore(severityAdjusted, normalized.passed);

  // --- Stage 4: AI analysis (optional) ----------------------------------
  await emit('Analyzing findings', 'Preparing analysis');

  const ai = await analyzeFindings({
    findings: severityAdjusted,
    categoryScores: score.categories,
    overallScore: score.overall,
    siteUrl: crawl.origin,
    pageCount: crawl.pages.length,
    env,
    signal: options.signal,
  });

  if (ai.failureReason) warnings.push(ai.failureReason);

  // Deterministic fallbacks guarantee the report is complete either way.
  const executiveSummary =
    ai.result?.executiveSummary ??
    buildFallbackSummary(
      severityAdjusted,
      score.overall,
      score.band.label,
      crawl.origin,
      crawl.pages.length,
    );

  const recommendations =
    ai.result?.recommendations && ai.result.recommendations.length > 0
      ? ai.result.recommendations
      : buildFallbackRecommendations(severityAdjusted);

  const topIssues =
    ai.result?.topIssues && ai.result.topIssues.length > 0
      ? ai.result.topIssues
      : severityAdjusted.slice(0, 5).map((finding) => ({
          findingId: finding.id,
          title: finding.title,
          severity: finding.severity,
          whyItMatters: finding.impact ?? finding.description,
        }));

  await emit('Generating QA report', 'Assembling results');

  return {
    auditId: options.auditId,
    url: options.url,
    crawl,
    findings: ai.findings,
    passedChecks: normalized.passed,
    categoryScores: score.categories,
    overallScore: score.overall,
    scoreBand: score.band.label,
    executiveSummary,
    recommendations,
    topIssues,
    aiAnalysisUsed: ai.used,
    aiFailureReason: ai.failureReason,
    warnings,
    engineVersion: ENGINE_VERSION,
    durationMs: Date.now() - startedAt,
  };
}

/** A failure that should be shown to the user rather than logged as a crash. */
export class AuditFailure extends Error {
  readonly url: string;
  override readonly cause?: unknown;

  constructor(message: string, url: string, cause?: unknown) {
    super(message);
    this.name = 'AuditFailure';
    this.url = url;
    this.cause = cause;
  }
}

/** Convenience for surfacing a stage label without importing the constant. */
export function stageAt(index: number): AuditStage {
  return AUDIT_STAGES[Math.max(0, Math.min(AUDIT_STAGES.length - 1, index))]!;
}

export { nowIso, scoreBandFor };
