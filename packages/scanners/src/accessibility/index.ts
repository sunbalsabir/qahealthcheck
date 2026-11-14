import {
  ACCESSIBILITY_CATEGORY_LABEL,
  pluralize,
  truncate,
  type ScannerResult,
  type Severity,
} from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { AxeViolation, ScanContext, Scanner } from '../types';

/**
 * Accessibility scanner.
 *
 * Automated findings only, from axe-core run in a real browser. The product
 * rule is explicit: report these as "automated accessibility findings", never
 * as WCAG compliance or certification. Automated tooling reliably catches
 * roughly a third of WCAG issues; the rest needs a human.
 *
 * Severity maps from axe's own impact rating, then adjusts for scope — an
 * issue present on every page is worse than one on a single page.
 */

/** axe impact -> our severity floor. */
const IMPACT_SEVERITY: Record<string, Severity> = {
  critical: 'HIGH',
  serious: 'HIGH',
  moderate: 'MEDIUM',
  minor: 'LOW',
};

/**
 * Rules we promote above their axe impact because they block a user outright
 * rather than merely degrading the experience.
 */
const BLOCKING_RULES = new Set([
  'html-has-lang',
  'form-field-multiple-labels',
  'label',
  'select-name',
  'input-button-name',
  'button-name',
  'link-name',
  'frame-title',
  'aria-required-attr',
  'aria-required-children',
  'aria-required-parent',
  'bypass',
]);

/** Human explanation per rule, used where axe's own help text is terse. */
const IMPACT_NOTES: Record<string, string> = {
  'image-alt':
    'Screen reader users receive no description of these images, so any information they carry is lost.',
  'color-contrast':
    'Low-contrast text is hard to read for users with reduced vision and in bright ambient light.',
  label:
    'Form fields without labels cannot be identified by screen reader users, so the form cannot be completed reliably.',
  'link-name':
    'Links announced only as "link" give no indication of where they lead.',
  'button-name':
    'Buttons with no accessible name are announced as "button", giving no indication of what they do.',
  'html-has-lang':
    'Without a language attribute, screen readers may use the wrong pronunciation rules for the entire page.',
  'duplicate-id-active':
    'Duplicate ids on interactive elements break label association and scripted behaviour.',
  'heading-order':
    'Skipped heading levels break the document outline that screen reader users navigate by.',
  'landmark-one-main':
    'Without a main landmark, screen reader users cannot skip directly to the primary content.',
  'aria-valid-attr-value':
    'Invalid ARIA values are ignored or misinterpreted by assistive technology.',
  bypass:
    'Without a skip link or landmarks, keyboard users must tab through the whole navigation on every page.',
};

export const accessibilityScanner: Scanner = {
  id: 'accessibility',
  name: 'Accessibility (axe-core)',
  category: 'ACCESSIBILITY',
  description: `${ACCESSIBILITY_CATEGORY_LABEL} produced by running axe-core against each page in a real browser.`,

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('accessibility', 'ACCESSIBILITY');
    const { pages } = context.crawl;

    const pagesWithAxe = pages.filter((page) => page.axe && !page.axe.error);
    const failedPages = pages.filter((page) => page.axe?.error);

    for (const page of failedPages) {
      collector.warn(
        `Accessibility checks could not run on ${page.url}: ${page.axe?.error ?? 'unknown error'}`,
      );
    }

    if (pagesWithAxe.length === 0) {
      collector.warn('axe-core did not produce results for any page.');
      return collector.result();
    }

    // Aggregate violations by rule id across the whole site.
    const byRule = new Map<
      string,
      { violation: AxeViolation; urls: Set<string>; nodeCount: number }
    >();

    for (const page of pagesWithAxe) {
      for (const violation of page.axe!.violations) {
        const entry = byRule.get(violation.id) ?? {
          violation,
          urls: new Set<string>(),
          nodeCount: 0,
        };
        entry.urls.add(page.url);
        entry.nodeCount += violation.nodes.length;
        // Keep the example nodes from the first page that reported it.
        byRule.set(violation.id, entry);
      }
    }

    for (const [ruleId, entry] of byRule) {
      const { violation, urls, nodeCount } = entry;
      const severity = severityFor(violation, urls.size, pagesWithAxe.length);
      const sampleNodes = violation.nodes.slice(0, 5);
      const wcagTags = violation.tags.filter((t) => /^wcag\d|^best-practice$|^section508/.test(t));

      collector.add({
        ruleId: `accessibility.${ruleId}`,
        title: titleFor(violation, nodeCount),
        description: `${violation.help}. ${describeScope(urls.size, pagesWithAxe.length, nodeCount)} ${violation.description}`,
        severity,
        confidence: violation.impact === 'minor' ? 'MEDIUM' : 'HIGH',
        url: Array.from(urls)[0],
        selector: sampleNodes[0]?.target.join(' '),
        evidence: {
          summary: `axe-core rule "${ruleId}" failed on ${nodeCount} ${pluralize(nodeCount, 'element')} across ${urls.size} ${pluralize(urls.size, 'page')}.`,
          observed: sampleNodes
            .map((node) => `${node.target.join(' ')}\n  ${truncate(node.html.replace(/\s+/g, ' '), 180)}`)
            .join('\n'),
          expected: violation.help,
          details: {
            axeRuleId: ruleId,
            axeImpact: violation.impact ?? 'unspecified',
            standards: wcagTags,
            helpUrl: violation.helpUrl,
            totalElements: nodeCount,
            pages: Array.from(urls).slice(0, 10),
            failureSummary: sampleNodes[0]?.failureSummary
              ? truncate(sampleNodes[0].failureSummary, 300)
              : undefined,
          },
        },
        recommendation: `${violation.help}. Reference: ${violation.helpUrl}`,
        impact:
          IMPACT_NOTES[ruleId] ??
          'This issue affects users of assistive technology and may prevent them completing tasks on the page.',
        occurrences: nodeCount,
        affectedUrls: Array.from(urls),
      });
    }

    // --- Passed checks, taken from axe's own pass list ---
    const passedRuleIds = new Set<string>();
    for (const page of pagesWithAxe) {
      for (const pass of page.axe!.passes) {
        if (!byRule.has(pass.id)) passedRuleIds.add(pass.id);
      }
    }

    const notablePasses = [
      ['image-alt', 'Images have text alternatives'],
      ['label', 'Form fields have associated labels'],
      ['color-contrast', 'Text meets automated contrast thresholds'],
      ['html-has-lang', 'Page language is declared'],
      ['button-name', 'Buttons have accessible names'],
      ['link-name', 'Links have discernible text'],
      ['duplicate-id-active', 'Interactive element ids are unique'],
      ['heading-order', 'Heading levels follow a logical order'],
      ['document-title', 'Pages have a document title'],
      ['aria-valid-attr-value', 'ARIA attribute values are valid'],
    ] as const;

    for (const [ruleId, title] of notablePasses) {
      if (passedRuleIds.has(ruleId)) {
        collector.pass(
          `accessibility.${ruleId}`,
          title,
          `axe-core rule "${ruleId}" passed on all ${pagesWithAxe.length} audited ${pluralize(pagesWithAxe.length, 'page')}.`,
        );
      }
    }

    // Items axe flagged as needing human confirmation.
    const incompleteCount = pagesWithAxe.reduce(
      (sum, page) => sum + (page.axe?.incomplete.length ?? 0),
      0,
    );
    if (incompleteCount > 0) {
      const samples = pagesWithAxe
        .flatMap((p) => p.axe?.incomplete ?? [])
        .slice(0, 6)
        .map((i) => `${i.id} (${i.nodeCount} ${pluralize(i.nodeCount, 'element')})`);
      collector.add({
        ruleId: 'accessibility.needs-manual-review',
        title: `${incompleteCount} accessibility ${pluralize(incompleteCount, 'check')} need manual confirmation`,
        description:
          'axe-core identified elements it could not judge automatically — typically contrast over background images, or ARIA usage whose correctness depends on intent. These are candidates for manual accessibility testing rather than confirmed defects.',
        severity: 'INFO',
        confidence: 'HIGH',
        url: pagesWithAxe[0]?.url,
        evidence: {
          summary: `${incompleteCount} axe-core results were returned as "incomplete" and require a human decision.`,
          observed: samples.join('\n'),
          expected: 'Each item is confirmed as passing or failing by a QA engineer.',
        },
        recommendation:
          'Include these items in a manual accessibility review. Qualovix accessibility testing covers the checks automated tooling cannot decide.',
        impact:
          'Automated tooling cannot confirm these either way, so the true accessibility position is not yet known.',
        occurrences: incompleteCount,
      });
    }

    return collector.result();
  },
};

function severityFor(
  violation: AxeViolation,
  affectedPages: number,
  totalPages: number,
): Severity {
  const base = IMPACT_SEVERITY[violation.impact ?? 'moderate'] ?? 'MEDIUM';
  const sitewide = totalPages > 1 && affectedPages >= Math.ceil(totalPages * 0.8);

  if (BLOCKING_RULES.has(violation.id) && sitewide && violation.impact === 'critical') {
    return 'CRITICAL';
  }
  if (base === 'MEDIUM' && sitewide && BLOCKING_RULES.has(violation.id)) return 'HIGH';
  if (base === 'LOW' && sitewide) return 'MEDIUM';
  return base;
}

function titleFor(violation: AxeViolation, nodeCount: number): string {
  const count = `${nodeCount} ${pluralize(nodeCount, 'element')}`;
  switch (violation.id) {
    case 'image-alt':
      return `${count} missing alternative text`;
    case 'color-contrast':
      return `${count} with insufficient colour contrast`;
    case 'label':
      return `${count} form ${pluralize(nodeCount, 'field')} without an associated label`;
    case 'link-name':
      return `${count} without discernible link text`;
    case 'button-name':
      return `${count} without an accessible button name`;
    case 'html-has-lang':
      return 'Page language is not declared';
    case 'duplicate-id-active':
      return `${count} share a duplicate id`;
    case 'heading-order':
      return `Heading levels are skipped on ${count}`;
    default:
      return `${violation.help} (${count})`;
  }
}

function describeScope(pageCount: number, totalPages: number, nodeCount: number): string {
  if (pageCount >= totalPages && totalPages > 1) {
    return `Affects ${nodeCount} ${pluralize(nodeCount, 'element')} on every audited page.`;
  }
  return `Affects ${nodeCount} ${pluralize(nodeCount, 'element')} across ${pageCount} of ${totalPages} audited ${pluralize(totalPages, 'page')}.`;
}
