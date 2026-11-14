import {
  CATEGORIES,
  CATEGORY_WEIGHTS,
  CONFIDENCE_WEIGHT,
  MAX_OCCURRENCE_MULTIPLIER,
  OCCURRENCE_DAMPING,
  SEVERITY_PENALTY,
  clamp,
  scoreBandFor,
  type CategoryScore,
  type Finding,
  type FindingCategory,
  type PassedCheck,
  type ScoreBand,
} from '@qualovix/shared';

/**
 * QA Health Score.
 *
 * Each category starts at 100 and loses points per finding. The overall score
 * is the weighted mean of the category scores, using the weights fixed by the
 * product spec (Functional 25%, Performance 15%, Accessibility 15%,
 * Responsive 15%, Technical 10%, Security 10%, UX 10%).
 *
 * Three properties matter more than the exact numbers:
 *
 *  - **Deterministic.** The same findings always produce the same score. No
 *    randomness, no AI input, no time dependence.
 *  - **Bounded.** One catastrophic category cannot drag the whole score to
 *    zero, and a long tail of trivial issues cannot either. Both are damped.
 *  - **Explainable.** Every category score comes with a plain-language
 *    summary of what cost it points, so a QA engineer can defend the number
 *    to a client.
 *
 * The score is an internal heuristic indicator, never a certification — every
 * surface that displays it says so.
 */

export interface ScoreResult {
  overall: number;
  band: ScoreBand;
  categories: CategoryScore[];
  /** Total penalty applied, before weighting. Useful for debugging. */
  totalPenalty: number;
}

/**
 * Penalty for one finding: base severity cost, scaled by detection
 * confidence, with a damped bonus for repeat occurrences.
 */
export function penaltyFor(finding: Finding): number {
  const base = SEVERITY_PENALTY[finding.severity];
  if (base === 0) return 0;

  const confidence = CONFIDENCE_WEIGHT[finding.confidence];

  // Repeat occurrences matter, but twenty missing alt attributes is one
  // problem to fix, not twenty times the damage. Logarithmic growth, capped.
  const occurrenceMultiplier = Math.min(
    MAX_OCCURRENCE_MULTIPLIER,
    1 + Math.log10(Math.max(1, finding.occurrences)) * OCCURRENCE_DAMPING * 4,
  );

  return base * confidence * occurrenceMultiplier;
}

export function calculateCategoryScore(
  category: FindingCategory,
  findings: Finding[],
  passed: PassedCheck[],
): CategoryScore {
  const categoryFindings = findings.filter((f) => f.category === category);
  const categoryPassed = passed.filter((p) => p.category === category);

  const rawPenalty = categoryFindings.reduce((sum, finding) => sum + penaltyFor(finding), 0);

  // Damp the total so a category with many issues lands low but not at zero —
  // the difference between "twelve problems" and "forty problems" is real but
  // not four times as bad, and a floor of 0 hides any later improvement.
  const dampedPenalty = 100 * (1 - Math.exp(-rawPenalty / 100));
  const score = Math.round(clamp(100 - dampedPenalty, 0, 100));

  return {
    category,
    score,
    weight: CATEGORY_WEIGHTS[category],
    findingCount: categoryFindings.length,
    passedChecks: categoryPassed.length,
    summary: summariseCategory(category, score, categoryFindings, categoryPassed.length),
  };
}

export function calculateScore(findings: Finding[], passed: PassedCheck[]): ScoreResult {
  const categories = CATEGORIES.map((category) =>
    calculateCategoryScore(category, findings, passed),
  );

  const weightedSum = categories.reduce((sum, c) => sum + c.score * c.weight, 0);
  const totalWeight = categories.reduce((sum, c) => sum + c.weight, 0);
  const overall = Math.round(clamp(weightedSum / (totalWeight || 1), 0, 100));

  return {
    overall,
    band: scoreBandFor(overall),
    categories,
    totalPenalty: Number(findings.reduce((sum, f) => sum + penaltyFor(f), 0).toFixed(2)),
  };
}

/**
 * Recalculate after human review. Only KEPT and EDITED findings count —
 * anything a QA engineer marked IGNORED is excluded from both the report and
 * the score, which is the point of having a review step.
 */
export function calculateReviewedScore(
  findings: Finding[],
  passed: PassedCheck[],
): ScoreResult {
  const approved = findings.filter(
    (finding) => finding.status === 'KEPT' || finding.status === 'EDITED',
  );
  return calculateScore(approved, passed);
}

function summariseCategory(
  category: FindingCategory,
  score: number,
  findings: Finding[],
  passedCount: number,
): string {
  if (findings.length === 0) {
    return passedCount > 0
      ? `No issues detected across ${passedCount} automated ${passedCount === 1 ? 'check' : 'checks'}.`
      : 'No issues detected.';
  }

  const critical = findings.filter((f) => f.severity === 'CRITICAL').length;
  const high = findings.filter((f) => f.severity === 'HIGH').length;
  const medium = findings.filter((f) => f.severity === 'MEDIUM').length;
  const low = findings.filter((f) => f.severity === 'LOW').length;

  const parts: string[] = [];
  if (critical) parts.push(`${critical} critical`);
  if (high) parts.push(`${high} high`);
  if (medium) parts.push(`${medium} medium`);
  if (low) parts.push(`${low} low`);

  const breakdown = parts.length > 0 ? parts.join(', ') : `${findings.length} informational`;
  const lead = leadIssue(findings);

  if (score >= 85) {
    return `Strong overall. ${breakdown}. ${lead}`;
  }
  if (score >= 70) {
    return `Generally sound with room to improve. ${breakdown}. ${lead}`;
  }
  if (score >= 50) {
    return `Needs attention. ${breakdown}. ${lead}`;
  }
  return `Significant issues found. ${breakdown}. ${lead}`;
}

function leadIssue(findings: Finding[]): string {
  const worst = findings[0];
  if (!worst) return '';
  return `Most significant: ${worst.title}.`;
}

export const __testing = { summariseCategory };
