import { pluralize, type ScannerResult } from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { LinkCheckResult, ScanContext, Scanner } from '../types';

/**
 * Broken link scanner.
 *
 * The spec is explicit that not every 404 is critical, so severity here is
 * driven by *what* is broken rather than the status code alone:
 *
 *   CRITICAL - a navigation link or an internal page-level resource is dead,
 *              so a real user journey is blocked.
 *   HIGH     - an internal page returns 5xx / 404, or a page asset failed.
 *   MEDIUM   - a non-critical internal link, or a broken external link in
 *              body content.
 *   LOW      - a slow-but-working link, or a minor third-party resource.
 */

const SERVER_ERROR_STATUSES = new Set([500, 502, 503, 504]);

export const brokenLinksScanner: Scanner = {
  id: 'broken-links',
  name: 'Broken Link Checker',
  category: 'FUNCTIONAL',
  description:
    'Probes every discovered link and page resource for 4xx/5xx responses, DNS failures, timeouts and TLS errors.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('broken-links', 'FUNCTIONAL');
    const { linkChecks, pages } = context.crawl;

    if (linkChecks.length === 0) {
      collector.warn('No links were available to check.');
    }

    const broken = linkChecks.filter((link) => !link.ok);

    for (const link of broken) {
      const severity = severityForLink(link);
      const label = statusLabel(link);

      collector.add({
        ruleId: ruleIdForLink(link),
        title: titleForLink(link, label),
        description: describeLink(link, label),
        severity,
        confidence: link.status === null ? 'MEDIUM' : 'HIGH',
        url: link.url,
        evidence: {
          summary: `${link.internal ? 'Internal' : 'External'} link to ${link.url} returned ${label}.`,
          observed: link.status !== null ? `HTTP ${link.status}` : (link.errorDetail ?? label),
          expected: 'HTTP 200 OK, or a working redirect to a valid page.',
          details: {
            linkText: link.anchorText || '(no link text)',
            foundOn: link.foundOn.slice(0, 10),
            inNavigation: link.inNavigation,
            redirectChain: link.redirectChain.slice(0, 5),
            errorType: link.errorType,
            responseTimeMs: link.responseTimeMs,
          },
        },
        recommendation: recommendationForLink(link),
        impact: impactForLink(link, severity),
        occurrences: link.foundOn.length,
        affectedUrls: link.foundOn,
      });
    }

    // Page-level resources (scripts, stylesheets, images) that failed to load.
    for (const page of pages) {
      const failedResources = page.network.filter(
        (request) =>
          (request.failed || (request.status !== undefined && request.status >= 400)) &&
          request.resourceType !== 'document',
      );

      const grouped = new Map<string, typeof failedResources>();
      for (const resource of failedResources) {
        const key = resource.resourceType;
        const list = grouped.get(key) ?? [];
        list.push(resource);
        grouped.set(key, list);
      }

      for (const [resourceType, resources] of grouped) {
        const critical = resourceType === 'script' || resourceType === 'stylesheet';
        collector.add({
          ruleId: `broken-links.failed-${resourceType}`,
          title: `${resources.length} ${resourceType} ${pluralize(resources.length, 'request')} failed to load`,
          description:
            critical
              ? `${resources.length} ${resourceType} ${pluralize(resources.length, 'file')} failed to load on this page. Missing scripts and stylesheets break interactive behaviour and layout for every visitor.`
              : `${resources.length} ${resourceType} ${pluralize(resources.length, 'request')} failed to load on this page.`,
          severity: critical ? 'HIGH' : resourceType === 'image' ? 'MEDIUM' : 'LOW',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${resources.length} failed ${resourceType} ${pluralize(resources.length, 'request')} observed while loading ${page.url}.`,
            observed: resources
              .slice(0, 5)
              .map((r) => `${r.status ?? r.failureText ?? 'failed'} ${r.url}`)
              .join('\n'),
            expected: 'All page resources return a successful response.',
            details: {
              resourceType,
              failures: resources.slice(0, 10).map((r) => ({
                url: r.url,
                status: r.status,
                failure: r.failureText,
              })),
            },
          },
          recommendation:
            critical
              ? `Fix or remove the failing ${resourceType} references. Check the build output paths and any CDN or cache-busting configuration.`
              : `Update or remove the broken ${resourceType} references.`,
          impact: critical
            ? 'Client-side functionality or page styling may be broken for all visitors.'
            : 'Some page content will not display as intended.',
          occurrences: resources.length,
        });
      }
    }

    // Slow-but-working links are worth reporting as a low-severity signal.
    const slowLinks = linkChecks.filter(
      (link) => link.ok && (link.responseTimeMs ?? 0) > 5000,
    );
    if (slowLinks.length > 0) {
      const first = slowLinks[0]!;
      collector.add({
        ruleId: 'broken-links.slow-response',
        title: `${slowLinks.length} ${pluralize(slowLinks.length, 'link')} responded very slowly`,
        description: `${slowLinks.length} linked ${pluralize(slowLinks.length, 'page')} took longer than 5 seconds to respond. Slow endpoints are a common precursor to timeouts under load.`,
        severity: 'LOW',
        confidence: 'MEDIUM',
        url: first.url,
        evidence: {
          summary: `Slowest response was ${Math.round(Math.max(...slowLinks.map((l) => l.responseTimeMs ?? 0)))}ms.`,
          observed: slowLinks
            .slice(0, 5)
            .map((l) => `${Math.round(l.responseTimeMs ?? 0)}ms — ${l.url}`)
            .join('\n'),
          expected: 'Linked pages respond in under 5 seconds.',
        },
        recommendation:
          'Investigate server response time for these endpoints. Consider caching, query optimisation or a CDN.',
        impact: 'Users may abandon slow pages before they load.',
        occurrences: slowLinks.length,
        affectedUrls: slowLinks.map((l) => l.url),
      });
    }

    if (linkChecks.length > 0 && broken.length === 0) {
      collector.pass(
        'broken-links.all-ok',
        'All discovered links resolved successfully',
        `${linkChecks.length} ${pluralize(linkChecks.length, 'link')} checked, none broken.`,
      );
    }

    const totalFailedResources = pages.reduce(
      (sum, page) => sum + page.network.filter((r) => r.failed).length,
      0,
    );
    if (pages.length > 0 && totalFailedResources === 0) {
      collector.pass(
        'broken-links.resources-ok',
        'All page resources loaded successfully',
        `No failed script, stylesheet, image or font requests across ${pages.length} ${pluralize(pages.length, 'page')}.`,
      );
    }

    return collector.result();
  },
};

function severityForLink(link: LinkCheckResult): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  // A dead link in the main navigation blocks a primary journey for everyone.
  if (link.internal && link.inNavigation) return 'CRITICAL';

  if (link.internal) {
    if (link.status !== null && SERVER_ERROR_STATUSES.has(link.status)) return 'HIGH';
    if (link.errorType === 'dns' || link.errorType === 'tls') return 'HIGH';
    if (link.status === 404 || link.status === 410) return 'HIGH';
    if (link.status === 403 || link.status === 401) return 'MEDIUM';
    if (link.errorType === 'timeout') return 'MEDIUM';
    return 'MEDIUM';
  }

  // External links are outside the client's control; a broken one is a
  // quality issue, not an outage.
  if (link.status !== null && SERVER_ERROR_STATUSES.has(link.status)) return 'LOW';
  if (link.status === 404 || link.errorType === 'dns') return 'MEDIUM';
  return 'LOW';
}

function ruleIdForLink(link: LinkCheckResult): string {
  const scope = link.internal ? 'internal' : 'external';
  if (link.status === null) return `broken-links.${scope}-${link.errorType ?? 'network'}`;
  if (SERVER_ERROR_STATUSES.has(link.status)) return `broken-links.${scope}-5xx`;
  return `broken-links.${scope}-${link.status}`;
}

function statusLabel(link: LinkCheckResult): string {
  if (link.status !== null) {
    const names: Record<number, string> = {
      400: '400 Bad Request',
      401: '401 Unauthorized',
      403: '403 Forbidden',
      404: '404 Not Found',
      410: '410 Gone',
      429: '429 Too Many Requests',
      500: '500 Internal Server Error',
      502: '502 Bad Gateway',
      503: '503 Service Unavailable',
      504: '504 Gateway Timeout',
    };
    return names[link.status] ?? `HTTP ${link.status}`;
  }
  switch (link.errorType) {
    case 'dns':
      return 'a DNS resolution failure';
    case 'timeout':
      return 'a request timeout';
    case 'tls':
      return 'a TLS certificate error';
    case 'refused':
      return 'a refused connection';
    default:
      return 'a network error';
  }
}

function titleForLink(link: LinkCheckResult, label: string): string {
  const scope = link.internal ? 'Internal' : 'External';
  const where = link.inNavigation ? ' in site navigation' : '';
  return `Broken ${scope.toLowerCase()} link${where} — ${label}`;
}

function describeLink(link: LinkCheckResult, label: string): string {
  const linkText = link.anchorText ? `"${link.anchorText}"` : 'A link';
  const where =
    link.foundOn.length === 1
      ? `on ${link.foundOn[0]}`
      : `on ${link.foundOn.length} pages`;
  const navNote = link.inNavigation
    ? ' It appears in the site navigation, so it is reachable from every page.'
    : '';
  return `${linkText} ${where} points to ${link.url}, which returned ${label}.${navNote}`;
}

function recommendationForLink(link: LinkCheckResult): string {
  if (link.inNavigation) {
    return 'Fix this navigation link as a priority — restore the target page or update the link to the correct destination.';
  }
  if (!link.internal) {
    return 'Update the link to the current destination, or remove it if the external resource no longer exists.';
  }
  if (link.status !== null && SERVER_ERROR_STATUSES.has(link.status)) {
    return 'Investigate the server error on this route. Check application logs for the failing request.';
  }
  if (link.status === 404) {
    return 'Restore the missing page or add a 301 redirect to its replacement.';
  }
  return 'Verify the link target and correct or remove the link.';
}

function impactForLink(link: LinkCheckResult, severity: string): string {
  if (severity === 'CRITICAL') {
    return 'A primary navigation path is broken, so visitors cannot reach this section of the site at all.';
  }
  if (link.internal) {
    return 'Visitors following this link reach an error page instead of the intended content.';
  }
  return 'Visitors following this link leave the site and land on an error, which reflects on site quality.';
}
