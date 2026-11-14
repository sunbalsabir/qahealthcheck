import { pluralize, truncate, type ScannerResult, type Severity } from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { ConsoleMessageRecord, ScanContext, Scanner } from '../types';

/**
 * Console / runtime error scanner.
 *
 * Captures console.error output, uncaught exceptions and page errors recorded
 * by the crawler. Messages are grouped by normalized signature so a single
 * error thrown in a render loop produces one finding, not two hundred.
 */

/** Noise that is not the site's fault and would only dilute the report. */
const IGNORABLE_PATTERNS = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[HMR\]/i,
  /\[vite\]/i,
  /was preloaded using link preload but not used/i,
  /Tracking Prevention blocked access to storage/i,
  /net::ERR_BLOCKED_BY_CLIENT/i,
];

/** Error text that reliably indicates a genuine application fault. */
const HIGH_SIGNAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /TypeError/i, label: 'TypeError' },
  { pattern: /ReferenceError/i, label: 'ReferenceError' },
  { pattern: /SyntaxError/i, label: 'SyntaxError' },
  { pattern: /RangeError/i, label: 'RangeError' },
  { pattern: /is not a function/i, label: 'call on a non-function' },
  { pattern: /cannot read propert(y|ies)/i, label: 'property access on null/undefined' },
  { pattern: /undefined is not an object/i, label: 'property access on undefined' },
  { pattern: /Unhandled (Promise )?[Rr]ejection/i, label: 'unhandled promise rejection' },
  { pattern: /Uncaught/i, label: 'uncaught exception' },
];

export const consoleScanner: Scanner = {
  id: 'console',
  name: 'Console Error Checker',
  category: 'FUNCTIONAL',
  description:
    'Captures console errors, uncaught exceptions and failed network requests observed while each page loads.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('console', 'FUNCTIONAL');
    const { pages } = context.crawl;

    // Group by error signature across the whole site.
    const groups = new Map<
      string,
      { messages: ConsoleMessageRecord[]; urls: Set<string> }
    >();

    for (const page of pages) {
      for (const message of page.console) {
        if (message.type !== 'error' && message.source !== 'pageerror') continue;
        if (IGNORABLE_PATTERNS.some((p) => p.test(message.text))) continue;

        const signature = signatureFor(message);
        const group = groups.get(signature) ?? { messages: [], urls: new Set<string>() };
        group.messages.push(message);
        group.urls.add(page.url);
        groups.set(signature, group);
      }
    }

    for (const [signature, group] of groups) {
      const first = group.messages[0]!;
      const isException = first.source === 'pageerror';
      const matched = HIGH_SIGNAL_PATTERNS.find((p) => p.pattern.test(first.text));
      const severity = severityFor(first, Boolean(matched), group.urls.size, pages.length);
      const urls = Array.from(group.urls);

      collector.add({
        ruleId: isException ? 'console.uncaught-exception' : 'console.error',
        title: isException
          ? `Uncaught JavaScript exception on ${describeScope(urls, pages.length)}`
          : `JavaScript error logged on ${describeScope(urls, pages.length)}`,
        description: buildDescription(first, matched?.label, group.urls.size),
        severity,
        confidence: matched ? 'HIGH' : 'MEDIUM',
        url: urls[0],
        evidence: {
          summary: `${group.messages.length} ${pluralize(group.messages.length, 'occurrence')} of this error were captured across ${group.urls.size} ${pluralize(group.urls.size, 'page')}.`,
          observed: truncate(first.text, 600),
          expected: 'No errors reported in the browser console during page load.',
          details: {
            source: first.source,
            scriptUrl: first.url,
            line: first.lineNumber,
            stackHead: first.stack ? truncate(first.stack, 400) : undefined,
            signature,
            pages: urls.slice(0, 10),
          },
        },
        recommendation: isException
          ? 'Reproduce the error in a browser with source maps enabled and fix the underlying exception. Add error boundaries or defensive checks around the failing call.'
          : 'Investigate the logged error. If it is expected and harmless, downgrade it from console.error so real faults stay visible.',
        impact:
          'Client-side JavaScript errors may affect interactive functionality such as navigation, forms, filters or dynamic content.',
        occurrences: group.messages.length,
        affectedUrls: urls,
      });
    }

    // Console warnings are reported as a single informational roll-up.
    const warningCount = pages.reduce(
      (sum, page) =>
        sum +
        page.console.filter(
          (m) => m.type === 'warning' && !IGNORABLE_PATTERNS.some((p) => p.test(m.text)),
        ).length,
      0,
    );
    if (warningCount >= 10) {
      const sample = pages
        .flatMap((p) => p.console.filter((m) => m.type === 'warning'))
        .slice(0, 5)
        .map((m) => truncate(m.text, 160));
      collector.add({
        ruleId: 'console.warning-volume',
        title: `${warningCount} console warnings logged during page loads`,
        description: `A high volume of console warnings was recorded. Warnings are not failures in themselves, but they make genuine errors harder to notice during development and QA.`,
        severity: 'INFO',
        confidence: 'HIGH',
        url: pages[0]?.url,
        evidence: {
          summary: `${warningCount} console warnings across ${pages.length} ${pluralize(pages.length, 'page')}.`,
          observed: sample.join('\n'),
          expected: 'A clean console during normal page load.',
        },
        recommendation:
          'Triage the warnings and resolve or silence the expected ones so the console stays useful as a QA signal.',
        impact: 'Reduces the usefulness of the browser console for detecting real defects.',
        occurrences: warningCount,
      });
    }

    if (groups.size === 0 && pages.length > 0) {
      collector.pass(
        'console.clean',
        'No JavaScript errors detected',
        `No console errors or uncaught exceptions were recorded across ${pages.length} ${pluralize(pages.length, 'page')}.`,
      );
    }

    return collector.result();
  },
};

/**
 * Normalize an error message into a stable signature so the same fault with
 * varying ids, URLs or line numbers groups into one finding.
 */
function signatureFor(message: ConsoleMessageRecord): string {
  return message.text
    .replace(/https?:\/\/[^\s)]+/g, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function severityFor(
  message: ConsoleMessageRecord,
  highSignal: boolean,
  affectedPages: number,
  totalPages: number,
): Severity {
  const sitewide = totalPages > 1 && affectedPages >= Math.ceil(totalPages * 0.6);
  if (message.source === 'pageerror' && sitewide) return 'CRITICAL';
  if (message.source === 'pageerror') return 'HIGH';
  if (highSignal) return sitewide ? 'HIGH' : 'MEDIUM';
  return 'MEDIUM';
}

function describeScope(urls: string[], totalPages: number): string {
  if (urls.length === 1) {
    try {
      const path = new URL(urls[0]!).pathname;
      return path === '/' ? 'the homepage' : path;
    } catch {
      return 'one page';
    }
  }
  if (urls.length >= totalPages && totalPages > 1) return 'every page audited';
  return `${urls.length} pages`;
}

function buildDescription(
  message: ConsoleMessageRecord,
  label: string | undefined,
  pageCount: number,
): string {
  const kind = message.source === 'pageerror' ? 'An uncaught exception' : 'A console error';
  const type = label ? ` (${label})` : '';
  const scope =
    pageCount === 1 ? 'on one audited page' : `on ${pageCount} of the audited pages`;
  const location = message.url
    ? ` It originates in ${message.url}${message.lineNumber ? ` at line ${message.lineNumber}` : ''}.`
    : '';
  return `${kind}${type} was recorded ${scope} during normal page load, with no user interaction.${location}`;
}
