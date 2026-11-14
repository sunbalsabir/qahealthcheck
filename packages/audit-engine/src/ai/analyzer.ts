import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  SEVERITIES,
  aiIsConfigured,
  errorMessage,
  getEnv,
  truncate,
  type AiAnalysisResult,
  type AppEnv,
  type CategoryScore,
  type Finding,
} from '@qualovix/shared';
import { buildAnalysisPrompt, SYSTEM_PROMPT } from './prompt';

/**
 * Optional AI analysis layer.
 *
 * What it is allowed to do: rewrite descriptions in plainer language, explain
 * business impact, suggest remediation, group related findings, pick the five
 * that matter most, and write an executive summary.
 *
 * What it is not allowed to do, enforced in `validateAgainstFindings` rather
 * than merely requested in the prompt:
 *
 *   - invent a finding. Any id it returns that is not in the input is dropped.
 *   - change a severity. Severity is decided by the deterministic engine; the
 *     model is not even given the ability to express a different one, and any
 *     severity it echoes back is overwritten with ours.
 *   - remove a finding. `duplicateOf` only marks relationships; the merge
 *     decision stays with the normalizer.
 *
 * If the API is slow, rate-limited, misconfigured or down, `analyzeFindings`
 * returns a failure result and the pipeline produces the full deterministic
 * report regardless. The AI layer is an enhancement, never a dependency.
 */

const enrichmentSchema = z.object({
  findingId: z.string(),
  summary: z.string().max(600).optional(),
  impact: z.string().max(600).optional(),
  remediation: z.string().max(800).optional(),
});

const topIssueSchema = z.object({
  findingId: z.string(),
  title: z.string().max(200),
  severity: z.enum(SEVERITIES),
  whyItMatters: z.string().max(600),
});

const responseSchema = z.object({
  executiveSummary: z.string().max(3000),
  topIssues: z.array(topIssueSchema).max(10).default([]),
  recommendations: z.array(z.string().max(400)).max(12).default([]),
  enrichment: z.array(enrichmentSchema).max(200).default([]),
  duplicateGroups: z
    .array(z.object({ canonicalId: z.string(), duplicateIds: z.array(z.string()).max(20) }))
    .max(50)
    .default([]),
});

export interface AiAnalysisOutcome {
  used: boolean;
  result?: AiAnalysisResult;
  failureReason?: string;
  /** Findings enriched in place. Always returned, AI or not. */
  findings: Finding[];
}

export interface AnalyzeOptions {
  findings: Finding[];
  categoryScores: CategoryScore[];
  overallScore: number;
  siteUrl: string;
  pageCount: number;
  env?: AppEnv;
  signal?: AbortSignal;
}

export async function analyzeFindings(options: AnalyzeOptions): Promise<AiAnalysisOutcome> {
  const env = options.env ?? getEnv();

  if (!aiIsConfigured(env)) {
    return {
      used: false,
      findings: options.findings,
      failureReason: env.AI_ENABLED
        ? 'AI analysis is enabled but ANTHROPIC_API_KEY is not set.'
        : undefined,
    };
  }

  try {
    const client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY!,
      timeout: env.AI_TIMEOUT_MS,
      maxRetries: 2,
    });

    const prompt = buildAnalysisPrompt({
      findings: options.findings,
      categoryScores: options.categoryScores,
      overallScore: options.overallScore,
      siteUrl: options.siteUrl,
      pageCount: options.pageCount,
    });

    const response = await client.messages.create(
      {
        model: env.ANTHROPIC_MODEL,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: options.signal },
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const parsed = parseResponse(text);
    if (!parsed) {
      return {
        used: false,
        findings: options.findings,
        failureReason: 'AI response was not valid JSON in the expected shape.',
      };
    }

    const validated = validateAgainstFindings(parsed, options.findings);
    const enriched = applyEnrichment(options.findings, validated);

    return { used: true, result: validated, findings: enriched };
  } catch (error) {
    // Every failure path is non-fatal by design.
    return {
      used: false,
      findings: options.findings,
      failureReason: `AI analysis unavailable: ${truncate(errorMessage(error), 200)}`,
    };
  }
}

/** Extract JSON from the response, tolerating a fenced code block. */
function parseResponse(text: string): z.infer<typeof responseSchema> | null {
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1]);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = responseSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * The traceability gate.
 *
 * Everything the model returned is checked against the real finding set. An
 * id that does not exist is discarded rather than trusted, so a hallucinated
 * finding cannot reach a client report even if the model produces one.
 */
export function validateAgainstFindings(
  parsed: z.infer<typeof responseSchema>,
  findings: Finding[],
): AiAnalysisResult {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));

  const enrichment: AiAnalysisResult['enrichment'] = {};
  for (const item of parsed.enrichment) {
    if (!byId.has(item.findingId)) continue; // hallucinated id — drop it
    enrichment[item.findingId] = {
      summary: item.summary,
      impact: item.impact,
      remediation: item.remediation,
    };
  }

  const topIssues: AiAnalysisResult['topIssues'] = [];
  for (const issue of parsed.topIssues) {
    const finding = byId.get(issue.findingId);
    if (!finding) continue; // not a real finding — drop it
    topIssues.push({
      findingId: finding.id,
      // Title and severity come from our data, not the model's echo of it.
      title: finding.title,
      severity: finding.severity,
      whyItMatters: issue.whyItMatters,
    });
    if (topIssues.length >= 5) break;
  }

  // If the model returned nothing usable, fall back to the highest-severity
  // findings so the report always has a "top issues" section.
  if (topIssues.length === 0) {
    for (const finding of findings.slice(0, 5)) {
      topIssues.push({
        findingId: finding.id,
        title: finding.title,
        severity: finding.severity,
        whyItMatters: finding.impact ?? finding.description,
      });
    }
  }

  const duplicateOf: Record<string, string> = {};
  for (const group of parsed.duplicateGroups) {
    if (!byId.has(group.canonicalId)) continue;
    for (const duplicateId of group.duplicateIds) {
      if (!byId.has(duplicateId) || duplicateId === group.canonicalId) continue;
      duplicateOf[duplicateId] = group.canonicalId;
    }
  }

  return {
    executiveSummary: parsed.executiveSummary,
    topIssues,
    recommendations: parsed.recommendations,
    enrichment,
    duplicateOf,
  };
}

function applyEnrichment(findings: Finding[], analysis: AiAnalysisResult): Finding[] {
  return findings.map((finding) => {
    const enrichment = analysis.enrichment[finding.id];
    if (!enrichment) return finding;
    return {
      ...finding,
      // Enrichment is additive. The original description, evidence and
      // severity are untouched and remain what the report falls back to.
      aiSummary: enrichment.summary,
      aiImpact: enrichment.impact,
      aiRemediation: enrichment.remediation,
    };
  });
}

/**
 * Deterministic executive summary, used when the AI layer is off or failed.
 * The report must read professionally either way.
 */
export function buildFallbackSummary(
  findings: Finding[],
  overallScore: number,
  bandLabel: string,
  siteUrl: string,
  pageCount: number,
): string {
  const counts = {
    critical: findings.filter((f) => f.severity === 'CRITICAL').length,
    high: findings.filter((f) => f.severity === 'HIGH').length,
    medium: findings.filter((f) => f.severity === 'MEDIUM').length,
    low: findings.filter((f) => f.severity === 'LOW').length,
  };

  const host = safeHost(siteUrl);
  const parts: string[] = [
    `This automated QA health check reviewed ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} of ${host} across functional, accessibility, performance, responsive, technical, security-baseline and UX checks.`,
    `The site scored ${overallScore} out of 100, placing it in the "${bandLabel}" band.`,
  ];

  if (counts.critical > 0) {
    parts.push(
      `${counts.critical} critical ${counts.critical === 1 ? 'issue was' : 'issues were'} identified that prevent major user or business functionality and should be addressed first.`,
    );
  }
  if (counts.high > 0) {
    parts.push(
      `A further ${counts.high} high-priority ${counts.high === 1 ? 'issue' : 'issues'} affect functionality, accessibility or reliability.`,
    );
  }
  if (counts.medium + counts.low > 0) {
    parts.push(
      `${counts.medium + counts.low} additional quality ${counts.medium + counts.low === 1 ? 'issue' : 'issues'} were recorded at medium and low priority.`,
    );
  }
  if (counts.critical + counts.high + counts.medium + counts.low === 0) {
    parts.push(
      'No defects were identified by the automated checks in scope. Automated analysis cannot confirm that a site is defect-free — it confirms only that these specific checks passed.',
    );
  }

  parts.push(
    'These findings come from automated analysis and QA heuristics reviewed by Qualovix QA engineers. They are not a substitute for a full manual functional test pass.',
  );

  return parts.join(' ');
}

/** Deterministic next-step recommendations for the same fallback path. */
export function buildFallbackRecommendations(findings: Finding[]): string[] {
  const recommendations: string[] = [];
  const has = (prefix: string) => findings.some((f) => f.ruleId.startsWith(prefix));

  if (findings.some((f) => f.severity === 'CRITICAL')) {
    recommendations.push(
      'Resolve the critical findings first — each one blocks a user journey or exposes traffic.',
    );
  }
  if (has('broken-links')) {
    recommendations.push(
      'Fix the broken links and failed resources, prioritising anything reachable from site navigation.',
    );
  }
  if (has('console')) {
    recommendations.push(
      'Investigate the JavaScript errors captured during page load; they commonly indicate broken interactive features.',
    );
  }
  if (has('accessibility')) {
    recommendations.push(
      'Work through the automated accessibility findings, then commission a manual accessibility review for the checks automation cannot decide.',
    );
  }
  if (has('responsive')) {
    recommendations.push(
      'Address the mobile layout issues — mobile traffic typically exceeds desktop for marketing sites.',
    );
  }
  if (has('performance')) {
    recommendations.push(
      'Improve the Core Web Vitals flagged above, starting with image optimisation and render-blocking resources.',
    );
  }
  if (has('security')) {
    recommendations.push(
      'Apply the missing security headers. These are configuration changes rather than code changes and are usually quick wins.',
    );
  }
  if (has('forms')) {
    recommendations.push(
      'Commission manual functional testing of the forms detected — automated auditing deliberately does not submit them.',
    );
  }

  recommendations.push(
    'Introduce automated regression tests covering the issues fixed, so they cannot silently return.',
  );

  return recommendations.slice(0, 8);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
