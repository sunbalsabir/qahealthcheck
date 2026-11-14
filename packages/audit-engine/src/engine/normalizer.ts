import {
  SEVERITY_RANK,
  stableId,
  type Finding,
  type PassedCheck,
  type ScannerResult,
} from '@qualovix/shared';

/**
 * Finding normalizer.
 *
 * Nine independent scanners will inevitably report the same underlying
 * problem more than once — a missing alt attribute is both an accessibility
 * violation and a UX heuristic failure, and a broken script is both a failed
 * request and a console error. The normalizer collapses those into one
 * finding each, without losing the evidence any scanner contributed.
 *
 * This is deterministic and runs before the AI layer. The AI may later
 * suggest further grouping, but it can never be the only thing standing
 * between a client and a duplicated report.
 */

export interface NormalizationResult {
  findings: Finding[];
  passed: PassedCheck[];
  warnings: string[];
  /** Number of findings removed as duplicates, for reporting. */
  duplicatesRemoved: number;
}

/**
 * Rules that describe the same defect from different angles. The first entry
 * in each group is the canonical one — it survives, the others merge into it.
 *
 * Chosen so the surviving finding is the one with the most actionable
 * evidence, not simply the most severe.
 */
const EQUIVALENT_RULE_GROUPS: string[][] = [
  // Missing alt text: axe is authoritative, the UX heuristic is a restatement.
  ['accessibility.image-alt', 'ux.image-missing-alt'],
  // Unlabelled inputs: the forms scanner names the form, so it wins.
  ['forms.missing-labels', 'accessibility.label'],
  // Nameless buttons.
  ['accessibility.button-name', 'ux.button-without-name'],
  // Empty links.
  ['accessibility.link-name', 'ux.empty-link'],
  // Missing lang attribute.
  ['technical.missing-lang', 'accessibility.html-has-lang'],
  // Duplicate ids.
  ['technical.duplicate-ids', 'accessibility.duplicate-id-active', 'accessibility.duplicate-id'],
  // Heading structure.
  ['accessibility.heading-order', 'ux.missing-h1'],
  // Missing viewport meta.
  ['responsive.missing-viewport-meta', 'accessibility.meta-viewport'],
];

/** rule id -> canonical rule id for that group. */
const CANONICAL_RULE = new Map<string, string>();
for (const group of EQUIVALENT_RULE_GROUPS) {
  const canonical = group[0]!;
  for (const ruleId of group) CANONICAL_RULE.set(ruleId, canonical);
}

export function normalizeFindings(results: ScannerResult[]): NormalizationResult {
  const warnings: string[] = [];
  const passed: PassedCheck[] = [];
  const raw: Finding[] = [];

  for (const result of results) {
    warnings.push(...result.warnings);
    passed.push(...result.passed);
    for (const finding of result.findings) {
      // Defence in depth: the collector already enforces this, but a finding
      // without evidence must never reach a client report.
      if (!finding.evidence?.summary?.trim()) {
        warnings.push(
          `Discarded finding "${finding.ruleId}" from ${finding.detectedBy}: no evidence attached.`,
        );
        continue;
      }
      raw.push(finding);
    }
  }

  const before = raw.length;
  const merged = mergeDuplicates(raw);
  const deduplicatedPassed = dedupePassedChecks(passed, merged);

  merged.sort(compareForReport);

  return {
    findings: merged,
    passed: deduplicatedPassed,
    warnings,
    duplicatesRemoved: before - merged.length,
  };
}

/**
 * Merge findings that describe the same defect.
 *
 * Two findings collapse when they share a merge key: the canonical rule id
 * plus the URL plus (where present) the selector. The survivor keeps the
 * higher severity and confidence, and accumulates the other's affected URLs
 * and occurrence count so nothing is silently dropped from the count.
 */
function mergeDuplicates(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();

  for (const finding of findings) {
    const key = mergeKey(finding);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, { ...finding, ruleId: canonicalRuleId(finding.ruleId) });
      continue;
    }

    byKey.set(key, mergeInto(existing, finding));
  }

  return Array.from(byKey.values());
}

function canonicalRuleId(ruleId: string): string {
  return CANONICAL_RULE.get(ruleId) ?? ruleId;
}

function mergeKey(finding: Finding): string {
  const canonical = canonicalRuleId(finding.ruleId);
  // Site-wide findings (no URL) merge on the rule alone; page-level findings
  // stay distinct per page so the report can point at the right page.
  const scope = finding.url ?? 'site';
  return `${canonical}|${scope}|${finding.selector ?? ''}`;
}

function mergeInto(target: Finding, source: Finding): Finding {
  const keepTarget = SEVERITY_RANK[target.severity] >= SEVERITY_RANK[source.severity];
  const winner = keepTarget ? target : source;
  const loser = keepTarget ? source : target;

  const affectedUrls = Array.from(
    new Set([...(winner.affectedUrls ?? []), ...(loser.affectedUrls ?? [])]),
  );

  return {
    ...winner,
    // The merged finding keeps its own id, derived from the merge key, so it
    // stays stable across re-runs regardless of scanner ordering.
    id: stableId(canonicalRuleId(winner.ruleId), winner.url ?? '', winner.selector ?? ''),
    ruleId: canonicalRuleId(winner.ruleId),
    occurrences: Math.max(winner.occurrences, loser.occurrences),
    affectedUrls: affectedUrls.length > 0 ? affectedUrls : undefined,
    confidence: higherConfidence(winner.confidence, loser.confidence),
    // Preserve the corroborating scanner so the evidence trail stays complete.
    detectedBy:
      winner.detectedBy === loser.detectedBy
        ? winner.detectedBy
        : `${winner.detectedBy}, ${loser.detectedBy}`,
    evidence: {
      ...winner.evidence,
      details: {
        ...(winner.evidence.details ?? {}),
        alsoDetectedBy: loser.detectedBy,
        corroboratingEvidence: loser.evidence.summary,
      },
      screenshot: winner.evidence.screenshot ?? loser.evidence.screenshot,
    },
  };
}

function higherConfidence(
  a: Finding['confidence'],
  b: Finding['confidence'],
): Finding['confidence'] {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * A check cannot be both passed and failed. Where a scanner reported a pass
 * that another scanner contradicted with a finding, the finding wins.
 */
function dedupePassedChecks(passed: PassedCheck[], findings: Finding[]): PassedCheck[] {
  const failedRules = new Set(findings.map((f) => canonicalRuleId(f.ruleId)));
  const seen = new Set<string>();
  const out: PassedCheck[] = [];

  for (const check of passed) {
    const canonical = canonicalRuleId(check.ruleId);
    if (failedRules.has(canonical)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(check);
  }

  return out;
}

/** Report ordering: severity, then confidence, then occurrence count. */
export function compareForReport(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;

  const confidenceRank = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
  const byConfidence = confidenceRank[b.confidence] - confidenceRank[a.confidence];
  if (byConfidence !== 0) return byConfidence;

  const byOccurrence = b.occurrences - a.occurrences;
  if (byOccurrence !== 0) return byOccurrence;

  return a.title.localeCompare(b.title);
}

export const __testing = { EQUIVALENT_RULE_GROUPS, mergeKey, canonicalRuleId };
