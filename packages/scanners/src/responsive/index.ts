import { pluralize, type ScannerResult, type Severity } from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { ScanContext, Scanner, ViewportObservation } from '../types';

/**
 * Responsive QA scanner.
 *
 * Reads the per-viewport observations the crawler captured at 375x812,
 * 768x1024 and 1440x900 and reports layout faults that are objectively
 * measurable: overflow past the viewport, unreadable text, tap targets below
 * the 24x24 CSS px guideline, overlapping interactive elements and content
 * positioned outside the viewport.
 *
 * Mobile overflow is weighted hardest — it is the failure most visitors
 * actually hit, and it is almost always a real defect rather than a
 * stylistic choice.
 */

/** Overflow smaller than this is usually a rounding artefact, not a bug. */
const OVERFLOW_NOISE_THRESHOLD_PX = 4;

export const responsiveScanner: Scanner = {
  id: 'responsive',
  name: 'Responsive QA',
  category: 'RESPONSIVE',
  description:
    'Tests each page at mobile, tablet and desktop viewports for horizontal overflow, overlapping elements, tiny tap targets and unreadable text.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('responsive', 'RESPONSIVE');
    const { pages } = context.crawl;

    const pagesWithViewports = pages.filter((page) => page.viewports.length > 0);
    if (pagesWithViewports.length === 0) {
      collector.warn('No viewport measurements were captured, so responsive checks were skipped.');
      return collector.result();
    }

    let overflowFindings = 0;
    let tapTargetFindings = 0;
    let overlapFindings = 0;

    for (const page of pagesWithViewports) {
      // --- Missing viewport meta tag makes every mobile check meaningless ---
      if (!page.meta.viewport) {
        collector.add({
          ruleId: 'responsive.missing-viewport-meta',
          title: 'Page has no responsive viewport meta tag',
          description:
            'This page does not declare <meta name="viewport">. Mobile browsers fall back to rendering at a desktop width and then scaling down, which makes text small and tap targets hard to hit.',
          severity: 'HIGH',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: 'No <meta name="viewport"> element was present in the document head.',
            observed: '(meta viewport absent)',
            expected: '<meta name="viewport" content="width=device-width, initial-scale=1">',
          },
          recommendation:
            'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the document head.',
          impact: 'Mobile visitors see a zoomed-out desktop layout that is difficult to read and use.',
        });
      }

      for (const observation of page.viewports) {
        // --- Horizontal overflow ---
        if (
          observation.hasHorizontalOverflow &&
          observation.overflowAmountPx > OVERFLOW_NOISE_THRESHOLD_PX
        ) {
          overflowFindings += 1;
          const culprits = observation.overflowingElements.slice(0, 5);
          collector.add({
            ruleId: `responsive.horizontal-overflow.${observation.viewport.toLowerCase()}`,
            title: `Horizontal scrolling at ${observation.viewport} (${observation.width}px)`,
            description: `At ${observation.width}x${observation.height} the page content is ${Math.round(observation.overflowAmountPx)}px wider than the viewport, forcing horizontal scrolling.${
              culprits.length > 0
                ? ` ${culprits.length} ${pluralize(culprits.length, 'element')} extend past the right edge.`
                : ''
            }`,
            severity: overflowSeverity(observation),
            confidence: 'HIGH',
            url: page.url,
            selector: culprits[0]?.selector,
            evidence: {
              summary: `Document width ${Math.round(observation.documentWidth)}px exceeds viewport width ${observation.width}px by ${Math.round(observation.overflowAmountPx)}px.`,
              observed: culprits.length
                ? culprits
                    .map((c) => `${c.selector} — ${Math.round(c.overflowPx)}px past the edge (width ${Math.round(c.width)}px)`)
                    .join('\n')
                : `documentWidth=${Math.round(observation.documentWidth)}px`,
              expected: `Content fits within ${observation.width}px with no horizontal scrollbar.`,
              details: {
                viewport: observation.viewport,
                viewportWidth: observation.width,
                documentWidth: Math.round(observation.documentWidth),
                overflowingElements: culprits,
              },
              screenshot: observation.screenshot,
            },
            recommendation:
              'Find the element exceeding the viewport width and constrain it — typically a fixed pixel width, an unwrapped table, a wide image or a long unbroken string. `max-width: 100%`, `overflow-wrap: break-word` or a responsive container usually resolves it.',
            impact:
              observation.viewport === 'Mobile'
                ? 'Mobile visitors must scroll sideways to read content, which is a well-known cause of drop-off.'
                : 'Visitors at this width see content cut off or must scroll sideways.',
          });
        }

        // --- Tap targets below the accessibility guideline ---
        if (observation.viewport === 'Mobile' && observation.tinyTapTargets.length > 0) {
          tapTargetFindings += 1;
          const targets = observation.tinyTapTargets.slice(0, 8);
          collector.add({
            ruleId: 'responsive.tiny-tap-targets',
            title: `${observation.tinyTapTargets.length} interactive ${pluralize(observation.tinyTapTargets.length, 'element')} are too small to tap reliably`,
            description: `At mobile width, ${observation.tinyTapTargets.length} ${pluralize(observation.tinyTapTargets.length, 'link or button')} render smaller than the 24x24 CSS pixel minimum target size. Small targets are hard to hit accurately, especially for users with motor impairments.`,
            severity: observation.tinyTapTargets.length > 5 ? 'MEDIUM' : 'LOW',
            confidence: 'MEDIUM',
            url: page.url,
            selector: targets[0]?.selector,
            evidence: {
              summary: `${observation.tinyTapTargets.length} interactive elements measured under 24x24 CSS pixels at 375px width.`,
              observed: targets
                .map((t) => `${t.selector} — ${Math.round(t.width)}x${Math.round(t.height)}px${t.text ? ` ("${t.text}")` : ''}`)
                .join('\n'),
              expected: 'Interactive targets are at least 24x24 CSS pixels, ideally 44x44.',
              details: { targets },
              screenshot: observation.screenshot,
            },
            recommendation:
              'Increase padding on small links and icon buttons so the touch area reaches at least 24x24 CSS pixels.',
            impact: 'Users mis-tap and trigger the wrong action, or fail to activate the control at all.',
            occurrences: observation.tinyTapTargets.length,
          });
        }

        // --- Unreadably small text ---
        if (observation.viewport === 'Mobile' && observation.tinyTextCount > 0) {
          collector.add({
            ruleId: 'responsive.unreadable-text',
            title: `Text rendered below 12px at mobile width`,
            description: `${observation.tinyTextCount} visible text ${pluralize(observation.tinyTextCount, 'element')} render below 12px at 375px width, which is below the practical readability threshold on a phone.`,
            severity: 'LOW',
            confidence: 'MEDIUM',
            url: page.url,
            evidence: {
              summary: `${observation.tinyTextCount} text elements measured under 12px computed font size at mobile width.`,
              observed: `${observation.tinyTextCount} elements below 12px`,
              expected: 'Body text renders at 14px or larger on mobile.',
              screenshot: observation.screenshot,
            },
            recommendation:
              'Raise the minimum font size for body copy on small screens, or scale typography with viewport-relative units.',
            impact: 'Content is hard to read on phones, particularly for older users.',
            occurrences: observation.tinyTextCount,
          });
        }

        // --- Overlapping interactive elements ---
        if (observation.overlappingElements.length > 0) {
          overlapFindings += 1;
          const pairs = observation.overlappingElements.slice(0, 5);
          collector.add({
            ruleId: 'responsive.overlapping-elements',
            title: `Overlapping elements at ${observation.viewport} (${observation.width}px)`,
            description: `${observation.overlappingElements.length} ${pluralize(observation.overlappingElements.length, 'pair')} of interactive elements visually overlap at this viewport, which usually means content is colliding rather than reflowing.`,
            severity: observation.viewport === 'Mobile' ? 'MEDIUM' : 'LOW',
            confidence: 'MEDIUM',
            url: page.url,
            selector: pairs[0]?.a,
            evidence: {
              summary: `${observation.overlappingElements.length} overlapping element pairs detected at ${observation.width}px.`,
              observed: pairs
                .map((p) => `${p.a}  overlaps  ${p.b} (${Math.round(p.overlapArea)}px² shared)`)
                .join('\n'),
              expected: 'Interactive elements do not visually overlap at any supported viewport.',
              details: { pairs },
              screenshot: observation.screenshot,
            },
            recommendation:
              'Review the layout at this width. Absolute positioning and fixed heights are the usual causes; switching to a flex or grid flow normally fixes it.',
            impact: 'Overlapping controls obscure content and can make the element underneath unclickable.',
            occurrences: observation.overlappingElements.length,
          });
        }

        // --- Interactive content pushed outside the viewport ---
        if (observation.offscreenInteractiveCount > 0) {
          collector.add({
            ruleId: 'responsive.offscreen-interactive',
            title: `${observation.offscreenInteractiveCount} interactive ${pluralize(observation.offscreenInteractiveCount, 'element')} sit outside the ${observation.viewport} viewport`,
            description: `${observation.offscreenInteractiveCount} ${pluralize(observation.offscreenInteractiveCount, 'button or link')} render outside the horizontal bounds of the ${observation.width}px viewport, so they may be unreachable without horizontal scrolling.`,
            severity: observation.viewport === 'Mobile' ? 'MEDIUM' : 'LOW',
            confidence: 'MEDIUM',
            url: page.url,
            evidence: {
              summary: `${observation.offscreenInteractiveCount} interactive elements measured outside the ${observation.width}px viewport bounds.`,
              observed: `${observation.offscreenInteractiveCount} elements positioned beyond x=${observation.width}px`,
              expected: 'All interactive controls are reachable within the viewport.',
              screenshot: observation.screenshot,
            },
            recommendation:
              'Check that navigation and action buttons collapse or wrap at this width rather than being pushed off-canvas.',
            impact: 'Visitors cannot reach controls that are positioned off-screen.',
            occurrences: observation.offscreenInteractiveCount,
          });
        }
      }
    }

    // --- Passed checks ---
    const viewportCount = pagesWithViewports.reduce((n, p) => n + p.viewports.length, 0);
    if (overflowFindings === 0) {
      collector.pass(
        'responsive.no-overflow',
        'No horizontal overflow at any tested viewport',
        `${viewportCount} viewport ${pluralize(viewportCount, 'measurement')} across ${pagesWithViewports.length} ${pluralize(pagesWithViewports.length, 'page')} fit within the viewport width.`,
      );
    }
    if (tapTargetFindings === 0) {
      collector.pass(
        'responsive.tap-targets-ok',
        'Tap targets meet the minimum size guideline',
        'No interactive elements measured below 24x24 CSS pixels at mobile width.',
      );
    }
    if (overlapFindings === 0) {
      collector.pass(
        'responsive.no-overlap',
        'No overlapping interactive elements detected',
        'Layout reflowed cleanly at mobile, tablet and desktop widths.',
      );
    }
    if (pagesWithViewports.every((p) => p.meta.viewport)) {
      collector.pass(
        'responsive.viewport-meta-present',
        'Responsive viewport meta tag present on all pages',
        'Every audited page declares <meta name="viewport">.',
      );
    }

    return collector.result();
  },
};

function overflowSeverity(observation: ViewportObservation): Severity {
  if (observation.viewport === 'Mobile') {
    // Severe overflow on mobile is a genuine functional problem.
    return observation.overflowAmountPx > 100 ? 'HIGH' : 'MEDIUM';
  }
  if (observation.viewport === 'Tablet') {
    return observation.overflowAmountPx > 150 ? 'MEDIUM' : 'LOW';
  }
  return 'LOW';
}
