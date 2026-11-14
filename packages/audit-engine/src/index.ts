// Security
export {
  SsrfError,
  FetchFailure,
  validateUrl,
  parseUserUrl,
  assertSafeUrl,
  resolvePublicAddresses,
  safeFetch,
  getGuardedAgent,
  resetGuardedAgent,
  guardedLookup,
} from './security/url-guard';
export type { ValidatedUrl, SafeFetchResult, SafeFetchOptions } from './security/url-guard';
export {
  classifyIp,
  classifyIpv4,
  classifyHostname,
  isPublicIp,
  isIpv4,
  isIpv6,
  parseIpv4,
  expandIpv6,
} from './security/ip';
export type { IpClassification } from './security/ip';

// Crawler
export { crawlSite } from './crawler/crawler';
export { crawlSiteMock } from './crawler/mock-crawler';
export {
  normalizeUrl,
  tryNormalizeUrl,
  isSameSite,
  shouldCrawl,
  isDangerousPath,
  hasDownloadExtension,
  getRegistrableDomain,
  describePage,
} from './crawler/url-utils';
export type { CrawlDecision, SkipReason } from './crawler/url-utils';

// Engine
export { normalizeFindings, compareForReport } from './engine/normalizer';
export type { NormalizationResult } from './engine/normalizer';
export { applySeverityRules, countBySeverity } from './engine/severity-engine';
export type { SeverityAdjustment, SeverityEngineResult } from './engine/severity-engine';
export {
  calculateScore,
  calculateCategoryScore,
  calculateReviewedScore,
  penaltyFor,
} from './engine/score-engine';
export type { ScoreResult } from './engine/score-engine';
export { runAudit, AuditFailure, stageAt } from './engine/pipeline';
export type { AuditOutcome, RunAuditOptions, PipelineProgress } from './engine/pipeline';

// AI
export {
  analyzeFindings,
  validateAgainstFindings,
  buildFallbackSummary,
  buildFallbackRecommendations,
} from './ai/analyzer';
export type { AiAnalysisOutcome, AnalyzeOptions } from './ai/analyzer';
export { buildAnalysisPrompt, SYSTEM_PROMPT } from './ai/prompt';
