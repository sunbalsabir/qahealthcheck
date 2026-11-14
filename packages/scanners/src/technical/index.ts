import { formatBytes, pluralize, truncate, type ScannerResult } from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { ScanContext, Scanner } from '../types';

/**
 * HTML / technical QA scanner.
 *
 * Page-level technical hygiene: titles, meta descriptions, duplicate ids,
 * broken images, viewport declaration, language attribute, canonical links,
 * page weight and redirect chains.
 *
 * These are QA and technical-correctness findings, not an SEO audit. Where a
 * check overlaps with SEO (title, description, canonical) it is reported for
 * its QA value — duplicate titles usually mean a templating bug, not a
 * keyword strategy problem.
 */

const MIN_TITLE_LENGTH = 10;
const MAX_TITLE_LENGTH = 70;
const MIN_DESCRIPTION_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 160;
const LARGE_PAGE_BYTES = 2 * 1024 * 1024;
const LONG_REDIRECT_CHAIN = 2;

export const technicalScanner: Scanner = {
  id: 'technical',
  name: 'HTML / Technical QA',
  category: 'TECHNICAL',
  description:
    'Checks page titles, meta information, duplicate ids, broken images, language and viewport declarations, page size and redirect behaviour.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('technical', 'TECHNICAL');
    const { pages } = context.crawl;
    if (pages.length === 0) {
      collector.warn('No pages were crawled, so technical checks were skipped.');
      return collector.result();
    }

    // --- Missing / weak page titles ---
    const untitled = pages.filter((p) => !p.title || p.title.trim().length === 0);
    for (const page of untitled) {
      collector.add({
        ruleId: 'technical.missing-title',
        title: 'Page has no title',
        description:
          'This page has no <title> element, or the title is empty. The title is what appears in the browser tab, in bookmarks, in search results and in the accessibility tree as the page name.',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        url: page.url,
        evidence: {
          summary: 'The document <title> element is missing or empty.',
          observed: '(no title)',
          expected: 'A descriptive <title> of 10 to 70 characters.',
        },
        recommendation: 'Add a unique, descriptive <title> to this page.',
        impact:
          'The page is hard to identify in browser tabs, bookmarks and search results, and screen readers announce no page name.',
      });
    }

    // --- Duplicate titles across pages: usually a templating defect ---
    const titleGroups = new Map<string, string[]>();
    for (const page of pages) {
      const title = page.title?.trim();
      if (!title) continue;
      const list = titleGroups.get(title) ?? [];
      list.push(page.url);
      titleGroups.set(title, list);
    }
    for (const [title, urls] of titleGroups) {
      if (urls.length < 2) continue;
      collector.add({
        ruleId: 'technical.duplicate-title',
        title: `${urls.length} pages share the title "${truncate(title, 60)}"`,
        description: `${urls.length} audited pages use an identical <title>. Duplicate titles usually indicate the title is not being set per-route, which makes tabs, history and search results ambiguous.`,
        severity: 'LOW',
        confidence: 'HIGH',
        url: urls[0],
        evidence: {
          summary: `The title "${truncate(title, 80)}" appears on ${urls.length} different pages.`,
          observed: urls.slice(0, 6).join('\n'),
          expected: 'Each page has a title describing its own content.',
          details: { title: truncate(title, 120), pages: urls.slice(0, 10) },
        },
        recommendation: 'Set a distinct title per route in the page template or routing layer.',
        impact: 'Users cannot tell pages apart in tabs, history or search listings.',
        occurrences: urls.length,
        affectedUrls: urls,
      });
    }

    // --- Title length ---
    const badLength = pages.filter((p) => {
      const t = p.title?.trim();
      return t && (t.length < MIN_TITLE_LENGTH || t.length > MAX_TITLE_LENGTH);
    });
    if (badLength.length > 0) {
      const first = badLength[0]!;
      collector.add({
        ruleId: 'technical.title-length',
        title: `${badLength.length} ${pluralize(badLength.length, 'page has', 'pages have')} a title outside the recommended length`,
        description: `Titles shorter than ${MIN_TITLE_LENGTH} characters rarely describe the page; titles longer than ${MAX_TITLE_LENGTH} are truncated in search results and browser tabs.`,
        severity: 'INFO',
        confidence: 'HIGH',
        url: first.url,
        evidence: {
          summary: `${badLength.length} page titles fall outside ${MIN_TITLE_LENGTH}-${MAX_TITLE_LENGTH} characters.`,
          observed: badLength
            .slice(0, 5)
            .map((p) => `${p.title!.length} chars — "${truncate(p.title!, 80)}"`)
            .join('\n'),
          expected: `Titles between ${MIN_TITLE_LENGTH} and ${MAX_TITLE_LENGTH} characters.`,
        },
        recommendation: 'Adjust the affected titles to sit within the recommended range.',
        occurrences: badLength.length,
        affectedUrls: badLength.map((p) => p.url),
      });
    }

    // --- Missing meta description ---
    const noDescription = pages.filter((p) => !p.meta.description?.trim());
    if (noDescription.length > 0) {
      collector.add({
        ruleId: 'technical.missing-meta-description',
        title: `${noDescription.length} ${pluralize(noDescription.length, 'page is', 'pages are')} missing a meta description`,
        description:
          'No <meta name="description"> was found on these pages. Search engines and social platforms then generate their own snippet from page content, which is often unhelpful.',
        severity: 'LOW',
        confidence: 'HIGH',
        url: noDescription[0]!.url,
        evidence: {
          summary: `${noDescription.length} of ${pages.length} audited pages have no meta description.`,
          observed: noDescription.slice(0, 6).map((p) => p.url).join('\n'),
          expected: `A meta description of ${MIN_DESCRIPTION_LENGTH}-${MAX_DESCRIPTION_LENGTH} characters.`,
        },
        recommendation: 'Add a concise, page-specific meta description to each page template.',
        impact: 'Search and social previews show an auto-generated snippet that may misrepresent the page.',
        occurrences: noDescription.length,
        affectedUrls: noDescription.map((p) => p.url),
      });
    }

    // --- Duplicate ids: breaks label association and querySelector logic ---
    for (const page of pages) {
      if (page.duplicateIds.length === 0) continue;
      const total = page.duplicateIds.reduce((sum, d) => sum + d.count - 1, 0);
      collector.add({
        ruleId: 'technical.duplicate-ids',
        title: `${page.duplicateIds.length} duplicate element ${pluralize(page.duplicateIds.length, 'id')} in the document`,
        description: `Element ids must be unique within a document. Duplicates break <label for> association, fragment links, and any JavaScript using getElementById or #id selectors — which will silently operate on the first match only.`,
        severity: 'MEDIUM',
        confidence: 'HIGH',
        url: page.url,
        evidence: {
          summary: `${page.duplicateIds.length} ids appear more than once (${total} extra ${pluralize(total, 'occurrence')}).`,
          observed: page.duplicateIds
            .slice(0, 8)
            .map((d) => `#${d.id} — ${d.count} occurrences`)
            .join('\n'),
          expected: 'Every id value appears at most once per document.',
          details: { duplicates: page.duplicateIds.slice(0, 20) },
        },
        recommendation:
          'Make ids unique, typically by generating them per component instance rather than hardcoding them in a repeated template.',
        impact:
          'Form labels, anchor links and scripted behaviour may target the wrong element or fail silently.',
        occurrences: page.duplicateIds.length,
      });
    }

    // --- Broken images ---
    for (const page of pages) {
      const broken = page.images.filter((img) => img.failedToLoad);
      if (broken.length === 0) continue;
      collector.add({
        ruleId: 'technical.broken-images',
        title: `${broken.length} ${pluralize(broken.length, 'image')} failed to load`,
        description: `${broken.length} <img> ${pluralize(broken.length, 'element')} on this page did not load, so visitors see a broken-image placeholder or empty space.`,
        severity: broken.length > 3 ? 'HIGH' : 'MEDIUM',
        confidence: 'HIGH',
        url: page.url,
        evidence: {
          summary: `${broken.length} images reported a zero natural size or a failed request.`,
          observed: broken.slice(0, 6).map((img) => img.src).join('\n'),
          expected: 'All referenced images load successfully.',
          details: { count: broken.length },
        },
        recommendation:
          'Correct the image paths or restore the missing files. Check for case-sensitivity differences between local and production filesystems.',
        impact: 'Visitors see broken placeholders, which reads as an unmaintained site.',
        occurrences: broken.length,
      });
    }

    // --- Missing lang attribute ---
    const noLang = pages.filter((p) => !p.lang?.trim());
    if (noLang.length > 0) {
      collector.add({
        ruleId: 'technical.missing-lang',
        title: `${noLang.length} ${pluralize(noLang.length, 'page is', 'pages are')} missing a language attribute`,
        description:
          'The <html> element has no lang attribute. Screen readers use it to select pronunciation rules, and browsers use it for translation offers and correct hyphenation.',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        url: noLang[0]!.url,
        evidence: {
          summary: `${noLang.length} of ${pages.length} pages have no lang attribute on <html>.`,
          observed: '<html> without lang',
          expected: '<html lang="en"> (or the appropriate language code).',
        },
        recommendation: 'Add a lang attribute to the <html> element in the base page template.',
        impact: 'Screen readers may read content with the wrong pronunciation rules.',
        occurrences: noLang.length,
        affectedUrls: noLang.map((p) => p.url),
      });
    }

    // --- Missing canonical on pages with query parameters ---
    const needsCanonical = pages.filter((p) => {
      if (p.meta.canonical) return false;
      try {
        return new URL(p.url).search.length > 0;
      } catch {
        return false;
      }
    });
    if (needsCanonical.length > 0) {
      collector.add({
        ruleId: 'technical.missing-canonical',
        title: `${needsCanonical.length} parameterised ${pluralize(needsCanonical.length, 'URL')} without a canonical link`,
        description:
          'These pages are reachable with query parameters but declare no canonical URL, so the same content can be indexed under multiple addresses.',
        severity: 'LOW',
        confidence: 'MEDIUM',
        url: needsCanonical[0]!.url,
        evidence: {
          summary: `${needsCanonical.length} pages with query strings have no <link rel="canonical">.`,
          observed: needsCanonical.slice(0, 5).map((p) => p.url).join('\n'),
          expected: 'A canonical link pointing at the preferred URL for the content.',
        },
        recommendation: 'Add <link rel="canonical"> pointing at the parameter-free URL.',
        impact: 'Duplicate content can be indexed under several URLs.',
        occurrences: needsCanonical.length,
      });
    }

    // --- Oversized HTML documents ---
    const heavy = pages.filter((p) => (p.byteSize ?? 0) > LARGE_PAGE_BYTES);
    if (heavy.length > 0) {
      const worst = heavy.reduce((a, b) => ((a.byteSize ?? 0) > (b.byteSize ?? 0) ? a : b));
      collector.add({
        ruleId: 'technical.large-html',
        title: `HTML document is ${formatBytes(worst.byteSize ?? 0)}`,
        description: `The HTML document itself is unusually large. This usually means server-rendered data, inline base64 assets or an unpaginated list is being embedded directly in the markup.`,
        severity: 'LOW',
        confidence: 'HIGH',
        url: worst.url,
        evidence: {
          summary: `HTML document size ${formatBytes(worst.byteSize ?? 0)} exceeds the ${formatBytes(LARGE_PAGE_BYTES)} guideline.`,
          observed: `${formatBytes(worst.byteSize ?? 0)} of HTML`,
          expected: `Under ${formatBytes(LARGE_PAGE_BYTES)} of HTML.`,
          details: { byteSize: worst.byteSize, domNodes: worst.performance.domNodeCount },
        },
        recommendation:
          'Move embedded data to a separate request, paginate long lists, and avoid inlining images as base64 in markup.',
        impact: 'Slower parsing and higher memory use, particularly on low-end devices.',
        occurrences: heavy.length,
      });
    }

    // --- Suspicious redirect chains ---
    for (const page of pages) {
      if (page.redirectChain.length < LONG_REDIRECT_CHAIN) continue;
      collector.add({
        ruleId: 'technical.redirect-chain',
        title: `${page.redirectChain.length} redirects before reaching the page`,
        description: `Requesting this URL goes through ${page.redirectChain.length} redirects before arriving at the final page. Each hop adds a full round trip.`,
        severity: page.redirectChain.length > 3 ? 'MEDIUM' : 'LOW',
        confidence: 'HIGH',
        url: page.url,
        evidence: {
          summary: `${page.redirectChain.length}-hop redirect chain observed.`,
          observed: page.redirectChain.slice(0, 6).join('\n  -> '),
          expected: 'At most one redirect to reach the canonical URL.',
          details: { chain: page.redirectChain.slice(0, 10) },
        },
        recommendation:
          'Collapse the chain so the first request redirects straight to the final destination. Check for a http->https hop stacked on a www->apex hop.',
        impact: 'Extra latency on every visit, compounding on slow mobile connections.',
      });
    }

    // --- Missing charset ---
    const noCharset = pages.filter((p) => !p.meta.charset);
    if (noCharset.length > 0) {
      collector.add({
        ruleId: 'technical.missing-charset',
        title: `${noCharset.length} ${pluralize(noCharset.length, 'page does', 'pages do')} not declare a character encoding`,
        description:
          'No <meta charset> was found. Without an explicit encoding the browser has to guess, which can mis-render accented and non-Latin characters.',
        severity: 'LOW',
        confidence: 'HIGH',
        url: noCharset[0]!.url,
        evidence: {
          summary: `${noCharset.length} pages have no <meta charset> declaration.`,
          observed: '(no meta charset)',
          expected: '<meta charset="utf-8"> as the first element in <head>.',
        },
        recommendation: 'Add <meta charset="utf-8"> as the first element inside <head>.',
        impact: 'Special characters may render incorrectly.',
        occurrences: noCharset.length,
      });
    }

    // --- Passed checks ---
    if (untitled.length === 0) {
      collector.pass(
        'technical.titles-present',
        'All pages have a title',
        `${pages.length} audited ${pluralize(pages.length, 'page')} declare a non-empty <title>.`,
      );
    }
    if (pages.every((p) => p.duplicateIds.length === 0)) {
      collector.pass(
        'technical.unique-ids',
        'Element ids are unique on every page',
        'No duplicate id attributes were found.',
      );
    }
    if (pages.every((p) => p.lang?.trim())) {
      collector.pass(
        'technical.lang-present',
        'Page language is declared',
        'Every audited page sets a lang attribute on <html>.',
      );
    }
    if (pages.every((p) => p.meta.viewport)) {
      collector.pass(
        'technical.viewport-present',
        'Responsive viewport is declared',
        'Every audited page includes a viewport meta tag.',
      );
    }
    if (pages.every((p) => p.images.every((img) => !img.failedToLoad))) {
      collector.pass(
        'technical.images-load',
        'All images loaded successfully',
        'No broken image references were detected.',
      );
    }
    if (noDescription.length === 0) {
      collector.pass(
        'technical.descriptions-present',
        'All pages have a meta description',
        'Every audited page declares a meta description.',
      );
    }

    return collector.result();
  },
};
