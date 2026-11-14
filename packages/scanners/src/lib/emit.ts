import {
  redactUrl,
  sanitizeEvidenceText,
  redactValue,
  stableId,
  nowIso,
  type Finding,
  type FindingCategory,
  type PassedCheck,
  type ScannerResult,
} from '@qualovix/shared';
import type { FindingDraft } from '../types';

/**
 * Finding builder shared by every scanner.
 *
 * Two invariants are enforced here rather than trusted to each scanner:
 *
 *  1. No finding without evidence. A draft with an empty evidence summary is
 *     dropped and recorded as a warning — the product principle is that a
 *     fabricated finding is worse than a missed one.
 *  2. Everything user-visible is redacted. Console text, URLs and raw detail
 *     blobs pass through the redaction layer on the way in, so a token in a
 *     query string cannot reach a client-facing PDF.
 */
export class FindingCollector {
  private readonly findings: Finding[] = [];
  private readonly passed: PassedCheck[] = [];
  private readonly warnings: string[] = [];
  private readonly ruleCounts = new Map<string, number>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly scannerId: string,
    private readonly category: FindingCategory,
    private readonly maxPerRule = 25,
  ) {}

  add(draft: FindingDraft): Finding | null {
    if (!draft.evidence || !draft.evidence.summary?.trim()) {
      this.warnings.push(
        `Dropped finding "${draft.ruleId}" because it carried no evidence.`,
      );
      return null;
    }

    const seen = this.ruleCounts.get(draft.ruleId) ?? 0;
    if (seen >= this.maxPerRule) {
      // The rule already reported its cap; extra instances are folded into
      // the existing finding's occurrence count by the normalizer.
      this.ruleCounts.set(draft.ruleId, seen + 1);
      return null;
    }
    this.ruleCounts.set(draft.ruleId, seen + 1);

    const url = draft.url ? redactUrl(draft.url) : undefined;
    const finding: Finding = {
      id: stableId(this.scannerId, draft.ruleId, url ?? '', draft.selector ?? '', String(seen)),
      ruleId: draft.ruleId,
      category: this.category,
      title: draft.title,
      description: draft.description,
      severity: draft.severity,
      confidence: draft.confidence,
      url,
      selector: draft.selector,
      evidence: {
        summary: sanitizeEvidenceText(draft.evidence.summary, 400),
        observed: draft.evidence.observed
          ? sanitizeEvidenceText(draft.evidence.observed, 800)
          : undefined,
        expected: draft.evidence.expected
          ? sanitizeEvidenceText(draft.evidence.expected, 400)
          : undefined,
        details: draft.evidence.details
          ? (redactValue(draft.evidence.details) as Record<string, unknown>)
          : undefined,
        screenshot: draft.evidence.screenshot,
      },
      recommendation: draft.recommendation,
      impact: draft.impact,
      detectedBy: this.scannerId,
      occurrences: draft.occurrences ?? 1,
      affectedUrls: draft.affectedUrls?.slice(0, 25).map(redactUrl),
      timestamp: nowIso(),
      status: 'PENDING_REVIEW',
      originalSeverity: draft.severity,
    };

    this.findings.push(finding);
    return finding;
  }

  pass(ruleId: string, title: string, detail: string): void {
    this.passed.push({
      ruleId,
      category: this.category,
      title,
      detail,
      detectedBy: this.scannerId,
    });
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /** How many instances a rule matched, including those past the cap. */
  countFor(ruleId: string): number {
    return this.ruleCounts.get(ruleId) ?? 0;
  }

  result(): ScannerResult {
    // Record suppressed instances so the report can say "and 40 more".
    for (const [ruleId, count] of this.ruleCounts) {
      if (count > this.maxPerRule) {
        const suppressed = count - this.maxPerRule;
        const first = this.findings.find((f) => f.ruleId === ruleId);
        if (first) {
          first.occurrences = count;
          first.evidence.details = {
            ...(first.evidence.details ?? {}),
            additionalInstancesNotListed: suppressed,
          };
        }
      }
    }

    return {
      scannerId: this.scannerId,
      findings: this.findings,
      passed: this.passed,
      warnings: this.warnings,
      durationMs: Date.now() - this.startedAt,
    };
  }
}

/** Shorthand for the common "this check ran and nothing was wrong" case. */
export function emptyResult(scannerId: string, durationMs = 0): ScannerResult {
  return { scannerId, findings: [], passed: [], warnings: [], durationMs };
}
