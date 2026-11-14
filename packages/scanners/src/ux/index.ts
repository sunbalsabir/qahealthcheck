import { pluralize, truncate, type ScannerResult } from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { ScanContext, Scanner } from '../types';

/**
 * UX heuristics scanner.
 *
 * Automated heuristics only. These catch the mechanical usability defects a
 * machine can see — controls with no accessible name, link text that says
 * nothing, missing headings, empty pages, unbounded navigation. They cannot
 * judge whether a flow makes sense, whether copy is clear, or whether the
 * information architecture works.
 *
 * Every finding here is framed as a candidate for human review, and the
 * category description states plainly that this is not UX testing.
 */

const NOT_UX_TESTING =
  'Automated heuristics cannot assess whether a journey actually works for a real user; treat this as a starting point for manual UX review.';

/** Link text that conveys nothing out of context. */
const VAGUE_LINK_TEXT = new Set([
  'click here',
  'here',
  'read more',
  'more',
  'learn more',
  'this',
  'link',
  'this link',
  'continue',
  'go',
  'download',
  'see more',
  'details',
  'info',
  '>',
  '>>',
  '→',
]);

/** A page with less text than this is likely an empty or error state. */
const THIN_CONTENT_CHARS = 250;

export const uxScanner: Scanner = {
  id: 'ux',
  name: 'UX Heuristics',
  category: 'UX',
  description:
    'Automated usability heuristics: accessible names on controls, link text quality, heading structure, content density and navigation size.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('ux', 'UX');
    const { pages } = context.crawl;

    if (pages.length === 0) {
      collector.warn('No pages were crawled, so UX heuristics were skipped.');
      return collector.result();
    }

    for (const page of pages) {
      // --- Buttons with no accessible name ---
      const namelessButtons = page.buttons.filter((b) => !b.hasAccessibleName);
      if (namelessButtons.length > 0) {
        collector.add({
          ruleId: 'ux.button-without-name',
          title: `${namelessButtons.length} ${pluralize(namelessButtons.length, 'button has', 'buttons have')} no accessible name`,
          description: `${namelessButtons.length} ${pluralize(namelessButtons.length, 'button')} on this page have no text, aria-label or title. Icon-only buttons are the usual cause. A screen reader announces them simply as "button", and sighted users have to guess from the icon. ${NOT_UX_TESTING}`,
          severity: namelessButtons.length > 3 ? 'MEDIUM' : 'LOW',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${namelessButtons.length} of ${page.buttons.length} buttons have no discernible name.`,
            observed: namelessButtons
              .slice(0, 6)
              .map((b) => `<${b.tag}${b.type ? ` type="${b.type}"` : ''}> — no text, no aria-label`)
              .join('\n'),
            expected: 'Every button has visible text or an aria-label describing its action.',
          },
          recommendation:
            'Add an aria-label to icon-only buttons describing the action ("Close dialog", "Open menu"), or include visually hidden text.',
          impact: 'Users cannot tell what the control does before pressing it.',
          occurrences: namelessButtons.length,
        });
      }

      // --- Links with no text at all ---
      const emptyLinks = page.links.filter(
        (link) => !link.hasVisibleText && !link.ariaLabel && !link.hasImageChild,
      );
      if (emptyLinks.length > 0) {
        collector.add({
          ruleId: 'ux.empty-link',
          title: `${emptyLinks.length} ${pluralize(emptyLinks.length, 'link has', 'links have')} no text content`,
          description: `${emptyLinks.length} anchor ${pluralize(emptyLinks.length, 'element')} contain no text, no image and no aria-label, so there is nothing to indicate where they lead. ${NOT_UX_TESTING}`,
          severity: 'MEDIUM',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${emptyLinks.length} links have no discernible text.`,
            observed: emptyLinks.slice(0, 6).map((l) => `href="${truncate(l.href, 80)}"`).join('\n'),
            expected: 'Every link has text, an aria-label, or an image with alt text.',
          },
          recommendation: 'Add link text or an aria-label describing the destination.',
          impact: 'Screen reader users hear only the raw URL, and keyboard users see an empty focus target.',
          occurrences: emptyLinks.length,
        });
      }

      // --- Vague link text ---
      const vagueLinks = page.links.filter((link) =>
        VAGUE_LINK_TEXT.has(link.text.trim().toLowerCase().replace(/[.!:]+$/, '')),
      );
      if (vagueLinks.length >= 3) {
        const grouped = new Map<string, number>();
        for (const link of vagueLinks) {
          const key = link.text.trim().toLowerCase();
          grouped.set(key, (grouped.get(key) ?? 0) + 1);
        }
        collector.add({
          ruleId: 'ux.vague-link-text',
          title: `${vagueLinks.length} links use non-descriptive text`,
          description: `${vagueLinks.length} links use generic text such as "click here" or "read more". Screen reader users commonly navigate by pulling up a list of links out of context, where these entries are indistinguishable from each other. ${NOT_UX_TESTING}`,
          severity: 'LOW',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${vagueLinks.length} links use text that does not describe the destination.`,
            observed: Array.from(grouped)
              .slice(0, 6)
              .map(([text, count]) => `"${text}" — ${count} ${pluralize(count, 'link')}`)
              .join('\n'),
            expected: 'Link text describes the destination ("View pricing", "Read the case study").',
          },
          recommendation:
            'Rewrite link text to describe the destination. The link should make sense when read on its own.',
          impact: 'Users scanning the page, and screen reader users listing links, cannot tell them apart.',
          occurrences: vagueLinks.length,
        });
      }

      // --- Images without alt text (UX framing; axe covers the a11y angle) ---
      const missingAlt = page.images.filter((img) => img.alt === null && !img.isDecorative);
      if (missingAlt.length > 0) {
        collector.add({
          ruleId: 'ux.image-missing-alt',
          title: `${missingAlt.length} ${pluralize(missingAlt.length, 'image is', 'images are')} missing alt text`,
          description: `${missingAlt.length} ${pluralize(missingAlt.length, 'image')} have no alt attribute at all. Decorative images should carry an explicit empty alt="" so assistive technology knows to skip them; informative images need a description. ${NOT_UX_TESTING}`,
          severity: missingAlt.length > 5 ? 'MEDIUM' : 'LOW',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${missingAlt.length} of ${page.images.length} images have no alt attribute.`,
            observed: missingAlt.slice(0, 6).map((img) => truncate(img.src, 100)).join('\n'),
            expected: 'Informative images have descriptive alt text; decorative images have alt="".',
          },
          recommendation:
            'Add descriptive alt text to informative images and alt="" to purely decorative ones.',
          impact: 'Image content is unavailable to screen reader users and when images fail to load.',
          occurrences: missingAlt.length,
        });
      }

      // --- No H1 ---
      const h1s = page.headings.filter((h) => h.level === 1);
      if (h1s.length === 0 && page.headings.length > 0) {
        collector.add({
          ruleId: 'ux.missing-h1',
          title: 'Page has no top-level heading',
          description: `This page has ${page.headings.length} headings but no <h1>. The H1 is what tells a visitor — and a screen reader user navigating by heading — what the page is about. ${NOT_UX_TESTING}`,
          severity: 'LOW',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `No <h1> found; the highest heading level present is h${Math.min(...page.headings.map((h) => h.level))}.`,
            observed: page.headings
              .slice(0, 5)
              .map((h) => `h${h.level}: ${truncate(h.text, 60)}`)
              .join('\n'),
            expected: 'Exactly one <h1> describing the page.',
          },
          recommendation: 'Add a single <h1> that names the page content.',
          impact: 'Users skimming by heading cannot immediately identify the page topic.',
        });
      } else if (h1s.length > 1) {
        collector.add({
          ruleId: 'ux.multiple-h1',
          title: `Page has ${h1s.length} top-level headings`,
          description: `${h1s.length} <h1> elements were found. Multiple H1s flatten the document outline and make the page's actual subject ambiguous. ${NOT_UX_TESTING}`,
          severity: 'INFO',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${h1s.length} <h1> elements on a single page.`,
            observed: h1s.slice(0, 5).map((h) => truncate(h.text, 60)).join('\n'),
            expected: 'One <h1> per page, with subsections using <h2> onwards.',
          },
          recommendation: 'Keep one <h1> and demote the others to <h2> or lower.',
          impact: 'The document outline becomes ambiguous for assistive technology.',
          occurrences: h1s.length,
        });
      }

      // --- No headings at all ---
      if (page.headings.length === 0 && page.textLength > THIN_CONTENT_CHARS) {
        collector.add({
          ruleId: 'ux.no-headings',
          title: 'Page has no headings',
          description: `This page contains substantial text but no heading elements at all, so it offers no structure to skim or navigate by. ${NOT_UX_TESTING}`,
          severity: 'MEDIUM',
          confidence: 'MEDIUM',
          url: page.url,
          evidence: {
            summary: `${page.textLength} characters of text content with zero heading elements.`,
            observed: '(no h1-h6 elements)',
            expected: 'Content organised under a heading hierarchy.',
          },
          recommendation:
            'Introduce a heading structure. Headings are the primary navigation mechanism for screen reader users.',
          impact: 'The page cannot be skimmed or navigated by structure.',
        });
      }

      // --- Thin or empty pages ---
      if (page.textLength < THIN_CONTENT_CHARS && page.statusCode === 200) {
        collector.add({
          ruleId: 'ux.thin-content',
          title: 'Page has almost no visible content',
          description: `This page returned HTTP 200 but contains only ${page.textLength} characters of visible text. That usually means an empty state, a page whose content failed to render, or a route that silently returns nothing. ${NOT_UX_TESTING}`,
          severity: 'MEDIUM',
          confidence: 'MEDIUM',
          url: page.url,
          evidence: {
            summary: `Only ${page.textLength} characters of visible text rendered on a page returning HTTP 200.`,
            observed: `textLength=${page.textLength}, images=${page.images.length}, links=${page.links.length}`,
            expected: 'A successful page renders meaningful content.',
            details: {
              consoleErrors: page.console.filter((c) => c.type === 'error').length,
              failedRequests: page.network.filter((r) => r.failed).length,
            },
          },
          recommendation:
            'Check whether content is failing to render — look at the console errors and failed requests on this page first. If it is a genuine empty state, add explanatory copy and a next action.',
          impact: 'Visitors reaching this page find nothing useful and are given no way forward.',
        });
      }

      // --- Oversized navigation ---
      const navLinks = page.links.filter((l) => l.internal);
      if (navLinks.length > 120) {
        collector.add({
          ruleId: 'ux.excessive-links',
          title: `Page contains ${navLinks.length} internal links`,
          description: `A very high internal link count makes a page hard to scan and dilutes the prominence of primary actions. ${NOT_UX_TESTING}`,
          severity: 'INFO',
          confidence: 'LOW',
          url: page.url,
          evidence: {
            summary: `${navLinks.length} internal links on a single page.`,
            observed: `${navLinks.length} internal links, ${page.links.length} links total`,
            expected: 'A focused set of links with a clear primary action.',
          },
          recommendation:
            'Review whether every link needs to be on this page. Grouping or progressive disclosure usually helps.',
          impact: 'Users struggle to identify the primary action among many competing links.',
        });
      }

      // --- Links opening in a new tab without warning ---
      const unmarkedNewTab = page.links.filter(
        (l) => l.target === '_blank' && !l.ariaLabel && !/new (tab|window)/i.test(l.text),
      );
      if (unmarkedNewTab.length >= 5) {
        collector.add({
          ruleId: 'ux.unannounced-new-tab',
          title: `${unmarkedNewTab.length} links open in a new tab without indication`,
          description: `${unmarkedNewTab.length} links use target="_blank" with nothing telling the user a new tab will open. Unexpected new tabs are disorienting, and they break the back button as a way to return. ${NOT_UX_TESTING}`,
          severity: 'INFO',
          confidence: 'MEDIUM',
          url: page.url,
          evidence: {
            summary: `${unmarkedNewTab.length} target="_blank" links with no new-tab indication.`,
            observed: unmarkedNewTab
              .slice(0, 5)
              .map((l) => `"${truncate(l.text || '(no text)', 50)}" -> ${truncate(l.href, 60)}`)
              .join('\n'),
            expected: 'Links opening a new tab say so in their text or aria-label.',
          },
          recommendation:
            'Add a visual indicator and an accessible hint, for example aria-label="View pricing (opens in a new tab)".',
          impact: 'Users lose their place and cannot use the back button to return.',
          occurrences: unmarkedNewTab.length,
        });
      }

      // --- target="_blank" without rel="noopener" ---
      const unsafeNewTab = page.links.filter(
        (l) => l.target === '_blank' && !l.internal && !/noopener|noreferrer/.test(l.rel ?? ''),
      );
      if (unsafeNewTab.length > 0) {
        collector.add({
          ruleId: 'ux.blank-target-without-noopener',
          title: `${unsafeNewTab.length} external ${pluralize(unsafeNewTab.length, 'link')} open a new tab without rel="noopener"`,
          description: `External links using target="_blank" without rel="noopener" give the destination page a reference back to this window via window.opener. Modern browsers imply noopener, but declaring it stays correct in older ones. ${NOT_UX_TESTING}`,
          severity: 'LOW',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${unsafeNewTab.length} external target="_blank" links have no rel="noopener".`,
            observed: unsafeNewTab.slice(0, 5).map((l) => truncate(l.href, 80)).join('\n'),
            expected: 'rel="noopener noreferrer" on external links opening a new tab.',
          },
          recommendation: 'Add rel="noopener noreferrer" to external links that open a new tab.',
          impact: 'Older browsers allow the linked page limited access back to the opening window.',
          occurrences: unsafeNewTab.length,
        });
      }
    }

    // --- Passed checks ---
    if (pages.every((p) => p.buttons.every((b) => b.hasAccessibleName))) {
      collector.pass(
        'ux.buttons-named',
        'All buttons have accessible names',
        'Every button found carries text or an aria-label.',
      );
    }
    if (pages.every((p) => p.links.every((l) => l.hasVisibleText || l.ariaLabel || l.hasImageChild))) {
      collector.pass(
        'ux.links-have-text',
        'All links have discernible text',
        'No empty links were found on the audited pages.',
      );
    }
    if (pages.every((p) => p.headings.filter((h) => h.level === 1).length === 1)) {
      collector.pass(
        'ux.single-h1',
        'Every page has exactly one top-level heading',
        'Heading structure starts from a single <h1> on each page.',
      );
    }
    if (pages.every((p) => p.textLength >= THIN_CONTENT_CHARS)) {
      collector.pass(
        'ux.content-present',
        'All pages render meaningful content',
        'No empty or near-empty pages were returned with a 200 status.',
      );
    }

    return collector.result();
  },
};
