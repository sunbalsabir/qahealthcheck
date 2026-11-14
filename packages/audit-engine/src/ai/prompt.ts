import {
  CATEGORY_LABELS,
  truncate,
  type CategoryScore,
  type Finding,
} from '@qualovix/shared';

/**
 * Prompt construction for the AI analysis layer.
 *
 * The prompt is deliberately constraining. The model is given the findings as
 * data and asked to explain them — it is never asked to assess the site, and
 * it never sees the site. Anything it returns is validated against the real
 * finding ids before use (see analyzer.ts), so these instructions are the
 * first line of defence rather than the only one.
 */

export const SYSTEM_PROMPT = `You are a senior QA engineer at Qualovix, a software quality engineering agency, writing up the results of an automated QA health check for a prospective client.

Your role is to explain findings that automated scanners have already produced. You are not assessing the website yourself and you have not seen it.

Hard rules:

1. NEVER invent a finding. You may only reference findings present in the input, by their exact id. If something seems missing, say nothing about it.
2. NEVER change a severity. Severity is set by a deterministic engine from measured evidence. Report the severity given.
3. NEVER claim certification or compliance. Do not say "WCAG compliant", "secure", "penetration tested" or "fully tested". This is an automated health check reviewed by QA engineers.
4. Every statement you write must be traceable to the evidence in the input. If the evidence does not support a claim, do not make it.
5. Do not speculate about the client's business, revenue, competitors, or technology choices beyond what the evidence shows.
6. Write in clear British English for a technically literate business reader — a founder, product manager or engineering lead. Plain, specific, and free of marketing language.
7. Never mention that you are an AI, and never describe your own process.

Output valid JSON only, with no prose before or after it, matching this shape:

{
  "executiveSummary": "3-5 sentences summarising what was checked, the overall state, and what to do first.",
  "topIssues": [{ "findingId": "...", "title": "...", "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO", "whyItMatters": "1-2 sentences on the practical consequence." }],
  "recommendations": ["Specific, actionable next steps, most valuable first."],
  "enrichment": [{ "findingId": "...", "summary": "Clearer one-paragraph description.", "impact": "Practical consequence for users or the business.", "remediation": "Concrete fix." }],
  "duplicateGroups": [{ "canonicalId": "...", "duplicateIds": ["..."] }]
}`;

export interface PromptInput {
  findings: Finding[];
  categoryScores: CategoryScore[];
  overallScore: number;
  siteUrl: string;
  pageCount: number;
}

/** Cap the payload so a site with hundreds of findings cannot blow the context. */
const MAX_FINDINGS_IN_PROMPT = 60;

export function buildAnalysisPrompt(input: PromptInput): string {
  const findings = input.findings.slice(0, MAX_FINDINGS_IN_PROMPT);
  const omitted = input.findings.length - findings.length;

  const findingLines = findings.map((finding) => {
    const evidence = [
      finding.evidence.summary,
      finding.evidence.observed ? `observed: ${truncate(finding.evidence.observed, 300)}` : null,
      finding.evidence.expected ? `expected: ${truncate(finding.evidence.expected, 200)}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    return [
      `- id: ${finding.id}`,
      `  rule: ${finding.ruleId}`,
      `  category: ${CATEGORY_LABELS[finding.category]}`,
      `  severity: ${finding.severity} (confidence: ${finding.confidence})`,
      `  title: ${finding.title}`,
      `  description: ${truncate(finding.description, 400)}`,
      `  evidence: ${truncate(evidence, 500)}`,
      finding.url ? `  url: ${finding.url}` : null,
      finding.occurrences > 1 ? `  occurrences: ${finding.occurrences}` : null,
      `  currentRecommendation: ${truncate(finding.recommendation, 300)}`,
    ]
      .filter(Boolean)
      .join('\n');
  });

  const categoryLines = input.categoryScores.map(
    (score) =>
      `- ${CATEGORY_LABELS[score.category]}: ${score.score}/100 (weight ${Math.round(score.weight * 100)}%, ${score.findingCount} findings, ${score.passedChecks} passed checks)`,
  );

  return `Automated QA health check results for ${safeHost(input.siteUrl)}.

Pages audited: ${input.pageCount}
Overall QA Health Score: ${input.overallScore}/100

Category scores:
${categoryLines.join('\n')}

Findings (${input.findings.length} total${omitted > 0 ? `, ${omitted} lower-severity findings omitted from this list` : ''}):

${findingLines.join('\n\n')}

Tasks:

1. Write an executive summary for the client. State what was checked, the overall picture, and the single most important thing to do first. Do not restate the score alone — say what it means.
2. Identify the 5 issues that matter most. Rank by real-world consequence, not just severity: a broken navigation link outranks a missing meta description even where both are flagged. Use only ids from the list above.
3. For each significant finding, write a clearer description, the practical impact, and a concrete remediation step. Keep the technical specifics — an engineer has to act on this.
4. Group findings that describe the same underlying defect, naming one as canonical. Grouping is advisory; do not assume anything is removed.
5. Write prioritised recommendations for the client's next steps.

Remember: only reference ids that appear above, never change a severity, and never claim more certainty than the evidence supports.`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
