import { chromium, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  VIEWPORTS,
  errorMessage,
  getEnv,
  redactHeaders,
  redactUrl,
  sanitizeEvidenceText,
  truncate,
  mapWithConcurrency,
  type AppEnv,
} from '@qualovix/shared';
import type {
  AxeResults,
  ConsoleMessageRecord,
  CookieObservation,
  CrawlResult,
  FormRecord,
  LinkCheckResult,
  NetworkRequestRecord,
  PageSnapshot,
  TransportObservation,
  ViewportObservation,
} from '@qualovix/scanners';
import {
  assertSafeUrl,
  FetchFailure,
  safeFetch,
  SsrfError,
  validateUrl,
} from '../security/url-guard';
import { classifyIp } from '../security/ip';
import {
  collectPerformanceFn,
  extractPageFn,
  measureViewportFn,
  vitalsInitScript,
} from './page-extract';
import {
  getRegistrableDomain,
  isSameSite,
  normalizeUrl,
  shouldCrawl,
  tryNormalizeUrl,
} from './url-utils';

/**
 * The crawler.
 *
 * Visits up to MAX_PAGES same-domain pages with Playwright, capturing
 * everything the scanners need in a single pass per page: DOM inventory,
 * console output, network activity, performance timings, axe-core results and
 * layout measurements at three viewports.
 *
 * Crawling once and sharing the snapshot is deliberate — nine scanners each
 * loading the page would mean nine times the traffic against a prospect's
 * site, which is neither polite nor faster.
 */

export interface CrawlOptions {
  auditId: string;
  url: string;
  env?: AppEnv;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

interface QueueItem {
  url: string;
  depth: number;
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const env = options.env ?? getEnv();
  const startedAt = new Date();
  const warnings: string[] = [];
  const report = (message: string) => options.onProgress?.(message);

  // Re-validate at the engine boundary even though the API validated on
  // submission: the engine must never trust its caller.
  const validated = await assertSafeUrl(options.url, { env });
  const origin = normalizeUrl(validated.url);
  const domain = getRegistrableDomain(validated.url.hostname);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // The scanner must never be usable as a pivot into internal services.
      '--no-default-browser-check',
      '--disable-background-networking',
    ],
  });

  const pages: PageSnapshot[] = [];
  const discoveredLinks = new Map<string, { texts: Set<string>; foundOn: Set<string>; internal: boolean; inNav: boolean }>();

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 QualovixQAAuditor/1.0',
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
      bypassCSP: false,
      javaScriptEnabled: true,
    });
    context.setDefaultTimeout(env.PAGE_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(env.PAGE_TIMEOUT_MS);
    await context.addInitScript(vitalsInitScript);

    // Every request the browser makes is checked, not just navigations. A
    // page is free to reference http://169.254.169.254/ as an image source.
    await installRequestGuard(context, env, warnings);

    const queue: QueueItem[] = [{ url: origin, depth: 0 }];
    const seen = new Set<string>([origin]);

    while (queue.length > 0 && pages.length < env.MAX_PAGES) {
      if (options.signal?.aborted) {
        warnings.push('Crawl was cancelled before completing.');
        break;
      }
      const item = queue.shift()!;
      report(`Crawling ${item.url}`);

      const snapshot = await capturePage(context, item, env, warnings);
      pages.push(snapshot);

      // Record every link found, for the broken-link checker.
      for (const link of snapshot.links) {
        if (!link.resolved) continue;
        const entry = discoveredLinks.get(link.resolved) ?? {
          texts: new Set<string>(),
          foundOn: new Set<string>(),
          internal: link.internal,
          inNav: false,
        };
        if (link.text) entry.texts.add(link.text);
        entry.foundOn.add(snapshot.url);
        discoveredLinks.set(link.resolved, entry);
      }

      // Queue same-site links for crawling.
      if (item.depth < env.MAX_DEPTH) {
        for (const link of snapshot.links) {
          if (pages.length + queue.length >= env.MAX_PAGES) break;
          if (!link.resolved) continue;
          const decision = shouldCrawl(link.resolved, {
            origin,
            seen,
            depth: item.depth + 1,
            maxDepth: env.MAX_DEPTH,
          });
          if (!decision.crawl || !decision.normalized) continue;
          seen.add(decision.normalized);
          queue.push({ url: decision.normalized, depth: item.depth + 1 });
        }
      }
    }

    // Links appearing on most pages are almost certainly site navigation,
    // which raises the severity of a break.
    const navigationThreshold = Math.max(2, Math.ceil(pages.length * 0.8));
    for (const [, entry] of discoveredLinks) {
      entry.inNav = pages.length > 1 && entry.foundOn.size >= navigationThreshold;
    }

    await context.close();

    report('Checking links');
    const linkChecks = await checkLinks(discoveredLinks, origin, env, options.signal, warnings);

    report('Checking transport security');
    const transport = await observeTransport(validated.url, pages, env, warnings);

    const robotsTxt = await fetchRobots(validated.url, env);

    const finishedAt = new Date();
    return {
      auditId: options.auditId,
      origin,
      domain,
      pages,
      linkChecks,
      transport,
      robotsTxt,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      mockMode: false,
      warnings,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Blocks any browser request whose host resolves outside public address
 * space. This is the SSRF guard applied to the browser, which does its own
 * DNS resolution and would otherwise bypass the Node-side checks entirely.
 */
async function installRequestGuard(
  context: BrowserContext,
  env: AppEnv,
  warnings: string[],
): Promise<void> {
  const verdicts = new Map<string, boolean>();

  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    try {
      const parsed = new URL(requestUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        await route.abort('blockedbyclient');
        return;
      }

      const host = parsed.hostname.toLowerCase();
      let allowed = verdicts.get(host);
      if (allowed === undefined) {
        if (env.SSRF_ALLOWLIST.includes(host)) {
          allowed = true;
        } else {
          try {
            validateUrl(`${parsed.protocol}//${parsed.host}/`, { env });
            // Hostname passed; confirm the resolved addresses are public too.
            const { addresses } = await assertSafeUrl(`${parsed.protocol}//${parsed.host}/`, { env });
            allowed = addresses.every((address) => classifyIp(address).safe);
          } catch {
            allowed = false;
          }
        }
        verdicts.set(host, allowed);
        if (!allowed) {
          warnings.push(`Blocked a request to a non-public host: ${host}`);
        }
      }

      if (!allowed) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    } catch {
      await route.abort('failed').catch(() => undefined);
    }
  });
}

async function capturePage(
  context: BrowserContext,
  item: QueueItem,
  env: AppEnv,
  warnings: string[],
): Promise<PageSnapshot> {
  const page = await context.newPage();
  const consoleMessages: ConsoleMessageRecord[] = [];
  const network: NetworkRequestRecord[] = [];
  const requestStarts = new Map<Request, number>();
  const pageOrigin = safeOrigin(item.url);

  page.on('console', (message) => {
    const type = message.type();
    if (consoleMessages.length >= 200) return;
    consoleMessages.push({
      type: normalizeConsoleType(type),
      text: sanitizeEvidenceText(message.text(), 1000),
      url: message.location().url ? redactUrl(message.location().url) : undefined,
      lineNumber: message.location().lineNumber,
      source: 'console',
    });
  });

  page.on('pageerror', (error) => {
    if (consoleMessages.length >= 200) return;
    consoleMessages.push({
      type: 'error',
      text: sanitizeEvidenceText(error.message, 1000),
      source: 'pageerror',
      stack: error.stack ? truncate(sanitizeEvidenceText(error.stack, 1200), 1200) : undefined,
    });
  });

  page.on('request', (request) => requestStarts.set(request, Date.now()));

  page.on('requestfailed', (request) => {
    if (network.length >= 400) return;
    const failure = request.failure()?.errorText ?? 'request failed';
    // A navigation aborted by our own guard is recorded as a warning, not as
    // a defect on the customer's site.
    network.push({
      url: redactUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      failed: !failure.includes('BLOCKED_BY_CLIENT'),
      failureText: failure,
      fromCache: false,
      thirdParty: !isSameSite(request.url(), item.url),
      durationMs: Date.now() - (requestStarts.get(request) ?? Date.now()),
    });
  });

  page.on('response', (response) => {
    if (network.length >= 400) return;
    const request = response.request();
    void recordResponse(response, request, network, requestStarts, item.url);
  });

  let statusCode: number | null = null;
  let statusText: string | undefined;
  let headers: Record<string, string> = {};
  let redirectChain: string[] = [];
  let loadError: string | undefined;
  let responseTimeMs: number | null = null;
  let byteSize: number | null = null;

  const navigationStart = Date.now();
  try {
    const response = await page.goto(item.url, {
      waitUntil: 'domcontentloaded',
      timeout: env.PAGE_TIMEOUT_MS,
    });
    responseTimeMs = Date.now() - navigationStart;

    if (response) {
      statusCode = response.status();
      statusText = response.statusText();
      headers = redactHeaders(await response.allHeaders().catch(() => ({})));
      redirectChain = collectRedirectChain(response);
      byteSize = await response
        .body()
        .then((body) => body.byteLength)
        .catch(() => null);
    }

    // Give late-loading content and the vitals observers a moment to settle,
    // but never block the whole crawl on a page that never goes idle.
    await page
      .waitForLoadState('networkidle', { timeout: Math.min(8000, env.PAGE_TIMEOUT_MS) })
      .catch(() => undefined);
  } catch (error) {
    loadError = errorMessage(error);
    responseTimeMs = Date.now() - navigationStart;
    warnings.push(`Could not fully load ${item.url}: ${loadError}`);
  }

  // --- DOM extraction ---
  let extracted: Awaited<ReturnType<typeof extractPageFn>> | null = null;
  try {
    extracted = await page.evaluate(extractPageFn);
  } catch (error) {
    warnings.push(`DOM extraction failed on ${item.url}: ${errorMessage(error)}`);
  }

  // --- performance ---
  let performanceMetrics = {};
  try {
    performanceMetrics = await page.evaluate(collectPerformanceFn);
  } catch {
    // Non-fatal: a page that failed to load has no timings to read.
  }

  // --- accessibility ---
  const axe = loadError ? undefined : await runAxe(page);

  // --- responsive measurements at each viewport ---
  const viewports = await measureViewports(page, item.url, env, warnings);

  await page.close().catch(() => undefined);

  const bytesByUrl = new Map<string, number>();
  for (const request of network) {
    if (request.transferBytes) bytesByUrl.set(request.url, request.transferBytes);
  }

  const snapshot: PageSnapshot = {
    url: item.url,
    normalizedUrl: item.url,
    depth: item.depth,
    title: extracted?.title ?? null,
    statusCode,
    statusText,
    responseTimeMs,
    contentType: headers['content-type'] ?? null,
    byteSize,
    headers,
    redirectChain,
    loadError,
    lang: extracted?.lang ?? null,
    meta: {
      description: extracted?.meta.description,
      canonical: extracted?.meta.canonical,
      viewport: extracted?.meta.viewport,
      robots: extracted?.meta.robots,
      charset: extracted?.meta.charset,
      ogTitle: extracted?.meta.ogTitle,
      ogDescription: extracted?.meta.ogDescription,
      ogImage: extracted?.meta.ogImage,
      themeColor: extracted?.meta.themeColor,
      lang: extracted?.meta.lang,
      dir: extracted?.meta.dir,
      generator: extracted?.meta.generator,
    },
    headings: extracted?.headings ?? [],
    links: (extracted?.links ?? []).map((link) => ({
      href: link.href,
      resolved: link.resolved ? (tryNormalizeUrl(link.resolved) ?? undefined) : undefined,
      text: link.text,
      internal: link.resolved ? isSameSite(link.resolved, item.url) : false,
      rel: link.rel || undefined,
      target: link.target || undefined,
      ariaLabel: link.ariaLabel || undefined,
      hasVisibleText: link.hasVisibleText,
      hasImageChild: link.hasImageChild,
    })),
    images: (extracted?.images ?? []).map((image) => ({
      src: image.src,
      resolved: image.resolved || undefined,
      alt: image.alt,
      isDecorative: image.alt === '',
      width: image.width,
      height: image.height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      loading: image.loading || undefined,
      transferBytes: image.resolved ? bytesByUrl.get(redactUrl(image.resolved)) : undefined,
      failedToLoad: image.failedToLoad,
    })),
    forms: (extracted?.forms ?? []).map((form) => toFormRecord(form, pageOrigin)),
    buttons: (extracted?.buttons ?? []).map((button) => ({
      tag: button.tag,
      type: button.type || undefined,
      text: button.text,
      ariaLabel: button.ariaLabel || undefined,
      hasAccessibleName: button.hasAccessibleName,
      disabled: button.disabled,
    })),
    scripts: (extracted?.scripts ?? []).map((script) => ({
      src: script.src || undefined,
      inline: script.inline,
      async: script.async,
      defer: script.defer,
      blocking: script.blocking,
    })),
    stylesheets: (extracted?.stylesheets ?? []).map((sheet) => ({
      href: sheet.href || undefined,
      media: sheet.media || undefined,
      blocking: sheet.blocking,
    })),
    duplicateIds: extracted?.duplicateIds ?? [],
    elementCount: extracted?.elementCount ?? 0,
    textLength: extracted?.textLength ?? 0,
    console: consoleMessages,
    network,
    performance: {
      ...performanceMetrics,
      ...summariseNetwork(network),
      renderBlockingCount:
        (extracted?.scripts.filter((s) => s.blocking).length ?? 0) +
        (extracted?.stylesheets.filter((s) => s.blocking).length ?? 0),
      domNodeCount: extracted?.domNodeCount,
    },
    viewports,
    axe,
  };

  return snapshot;
}

async function recordResponse(
  response: Response,
  request: Request,
  network: NetworkRequestRecord[],
  starts: Map<Request, number>,
  pageUrl: string,
): Promise<void> {
  let transferBytes: number | undefined;
  try {
    const sizes = await response.request().sizes();
    transferBytes = sizes.responseBodySize + sizes.responseHeadersSize;
  } catch {
    const declared = response.headers()['content-length'];
    transferBytes = declared ? Number(declared) : undefined;
  }

  network.push({
    url: redactUrl(request.url()),
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    statusText: response.statusText(),
    failed: response.status() >= 400,
    transferBytes: Number.isFinite(transferBytes) ? transferBytes : undefined,
    durationMs: Date.now() - (starts.get(request) ?? Date.now()),
    fromCache: response.status() === 304,
    thirdParty: !isSameSite(request.url(), pageUrl),
  });
}

function summariseNetwork(network: NetworkRequestRecord[]) {
  const sumBy = (predicate: (r: NetworkRequestRecord) => boolean) =>
    network.filter(predicate).reduce((sum, r) => sum + (r.transferBytes ?? 0), 0);

  return {
    totalTransferBytes: sumBy(() => true),
    requestCount: network.length,
    imageBytes: sumBy((r) => r.resourceType === 'image'),
    scriptBytes: sumBy((r) => r.resourceType === 'script'),
    stylesheetBytes: sumBy((r) => r.resourceType === 'stylesheet'),
    fontBytes: sumBy((r) => r.resourceType === 'font'),
  };
}

async function runAxe(page: Page): Promise<AxeResults> {
  try {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();

    return {
      violations: results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        help: violation.help,
        description: violation.description,
        helpUrl: violation.helpUrl,
        tags: violation.tags,
        nodes: violation.nodes.slice(0, 10).map((node) => ({
          target: node.target.map(String),
          html: truncate(node.html, 300),
          failureSummary: node.failureSummary ? truncate(node.failureSummary, 400) : undefined,
        })),
      })),
      passes: results.passes.map((pass) => ({
        id: pass.id,
        help: pass.help,
        nodeCount: pass.nodes.length,
      })),
      incomplete: results.incomplete.map((item) => ({
        id: item.id,
        help: item.help,
        nodeCount: item.nodes.length,
      })),
    };
  } catch (error) {
    return { violations: [], passes: [], incomplete: [], error: errorMessage(error) };
  }
}

async function measureViewports(
  page: Page,
  pageUrl: string,
  env: AppEnv,
  warnings: string[],
): Promise<ViewportObservation[]> {
  const observations: ViewportObservation[] = [];

  for (const viewport of VIEWPORTS) {
    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // Allow CSS transitions and any resize handlers to settle.
      await page.waitForTimeout(350);

      const measurement = await page.evaluate(measureViewportFn);

      let screenshot: string | undefined;
      if (env.SCREENSHOTS_ENABLED && measurement.hasHorizontalOverflow) {
        screenshot = await captureScreenshot(page, pageUrl, viewport.name, env, warnings);
      }

      observations.push({
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
        ...measurement,
        screenshot,
      });
    } catch (error) {
      warnings.push(
        `Responsive measurement failed at ${viewport.name} on ${pageUrl}: ${errorMessage(error)}`,
      );
    }
  }

  // Leave the page at desktop width for anything that runs afterwards.
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  return observations;
}

async function captureScreenshot(
  page: Page,
  pageUrl: string,
  viewportName: string,
  env: AppEnv,
  warnings: string[],
): Promise<string | undefined> {
  try {
    const slug = `${slugify(pageUrl)}-${viewportName.toLowerCase()}.png`;
    const directory = env.SCREENSHOT_DIR;
    await mkdir(directory, { recursive: true });
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    // Cap stored evidence so a single audit cannot fill the disk.
    if (buffer.byteLength > 3 * 1024 * 1024) return undefined;
    await writeFile(join(directory, slug), buffer);
    return slug;
  } catch (error) {
    warnings.push(`Screenshot capture failed: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Probes each discovered link for availability. HEAD first (cheap), falling
 * back to GET for servers that reject HEAD. External links are checked too,
 * but capped so one page of outbound links cannot dominate the audit.
 */
async function checkLinks(
  discovered: Map<string, { texts: Set<string>; foundOn: Set<string>; internal: boolean; inNav: boolean }>,
  origin: string,
  env: AppEnv,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<LinkCheckResult[]> {
  const entries = Array.from(discovered.entries())
    // Internal links first so the budget is spent where it matters most.
    .sort((a, b) => Number(b[1].internal) - Number(a[1].internal))
    .slice(0, env.MAX_LINK_CHECKS);

  if (discovered.size > entries.length) {
    warnings.push(
      `${discovered.size - entries.length} links were not checked because the per-audit link limit (${env.MAX_LINK_CHECKS}) was reached.`,
    );
  }

  return mapWithConcurrency(entries, 6, async ([url, meta]) => {
    const base: LinkCheckResult = {
      url,
      foundOn: Array.from(meta.foundOn),
      anchorText: Array.from(meta.texts)[0] ?? '',
      internal: meta.internal,
      status: null,
      ok: false,
      redirectChain: [],
      inNavigation: meta.inNav,
    };

    if (signal?.aborted) {
      return { ...base, ok: true, status: 0, errorDetail: 'not checked (cancelled)' };
    }

    try {
      let result = await safeFetch(url, { method: 'HEAD', env, signal });
      // Some servers refuse HEAD outright; retry those with GET.
      if (result.status === 405 || result.status === 501 || result.status === 403) {
        result = await safeFetch(url, { method: 'GET', env, signal });
      }
      return {
        ...base,
        status: result.status,
        ok: result.status < 400,
        redirectChain: result.redirectChain,
        responseTimeMs: result.responseTimeMs,
        errorType: result.status >= 400 ? 'http' : undefined,
      };
    } catch (error) {
      if (error instanceof SsrfError) {
        // A link pointing at private space is a finding for a different
        // scanner; here it simply cannot be checked.
        warnings.push(`Link to a non-public address was not checked: ${url}`);
        return { ...base, ok: true, errorDetail: 'not checked (non-public address)' };
      }
      const detail = error instanceof FetchFailure ? error.message : errorMessage(error);
      return {
        ...base,
        ok: false,
        errorType: classifyFetchError(detail),
        errorDetail: detail,
      };
    }
  });
}

function classifyFetchError(detail: string): LinkCheckResult['errorType'] {
  const lower = detail.toLowerCase();
  if (lower.includes('dns')) return 'dns';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
  if (lower.includes('certificate') || lower.includes('tls')) return 'tls';
  if (lower.includes('refused')) return 'refused';
  return 'network';
}

/**
 * Passive transport observation: does HTTPS work, does HTTP redirect to it,
 * and what security headers and cookie flags come back. No active testing.
 */
async function observeTransport(
  url: URL,
  pages: PageSnapshot[],
  env: AppEnv,
  warnings: string[],
): Promise<TransportObservation> {
  const httpsUrl = `https://${url.host}${url.pathname}`;
  const httpUrl = `http://${url.host}${url.pathname}`;

  let httpsAvailable = false;
  let httpsError: string | undefined;
  let securityHeaders: Record<string, string> = {};
  let tlsCertificateError: string | undefined;
  const cookies: CookieObservation[] = [];

  try {
    const response = await safeFetch(httpsUrl, { method: 'GET', env });
    httpsAvailable = response.status < 500;
    securityHeaders = response.headers;

    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      // Values are already redacted upstream; only flags are inspected here.
      for (const cookie of parseCookieFlags(setCookie, url.hostname)) cookies.push(cookie);
    }
  } catch (error) {
    httpsError = errorMessage(error);
    if (/certificate|tls|ssl/i.test(httpsError)) tlsCertificateError = httpsError;
  }

  let httpRedirectsToHttps = false;
  let httpProbeOutcome: TransportObservation['httpProbeOutcome'] = 'inconclusive';
  let httpRedirectTarget: string | undefined;
  let httpProbeError: string | undefined;
  try {
    const response = await safeFetch(httpUrl, { method: 'GET', env });
    const finalUrl = response.redirectChain.at(-1) ?? response.finalUrl;
    httpRedirectTarget = finalUrl;
    httpRedirectsToHttps = finalUrl.startsWith('https://');
    httpProbeOutcome = httpRedirectsToHttps ? 'redirects' : 'no-redirect';
  } catch (error) {
    httpProbeError = errorMessage(error);
    if (/refused|reset|ECONNREFUSED|ECONNRESET/i.test(httpProbeError)) {
      // Nothing is listening on port 80, so there is no insecure path to
      // close. That is a correct configuration, not a defect.
      httpProbeOutcome = 'not-served';
      httpRedirectsToHttps = true;
    } else {
      // A timeout or DNS failure tells us nothing either way. Reporting
      // "does not redirect" here would be a finding with no evidence behind
      // it, which the product forbids.
      httpProbeOutcome = 'inconclusive';
      warnings.push(
        `The plain-HTTP probe of ${url.host} did not complete (${httpProbeError}), so the HTTP-to-HTTPS redirect could not be checked.`,
      );
    }
  }

  // Fall back to the headers the browser saw if the direct probe failed.
  if (Object.keys(securityHeaders).length === 0) {
    const homepage = pages[0];
    if (homepage && Object.keys(homepage.headers).length > 0) {
      securityHeaders = homepage.headers;
    } else {
      warnings.push('No response headers were captured for the security baseline.');
    }
  }

  return {
    httpsAvailable,
    httpsError,
    httpRedirectsToHttps,
    httpProbeOutcome,
    httpRedirectTarget,
    httpProbeError,
    securityHeaders,
    cookies,
    tlsCertificateError,
  };
}

function parseCookieFlags(setCookieHeader: string, hostname: string): CookieObservation[] {
  // Multiple cookies arrive joined; split on the comma that precedes a new
  // "name=" pair rather than one inside an Expires date.
  const parts = setCookieHeader.split(/,(?=\s*[^=;,\s]+\s*=)/);
  return parts.map((part) => {
    const [pair = ''] = part.split(';');
    const name = pair.split('=')[0]?.trim() ?? 'unknown';
    const lower = part.toLowerCase();
    const sameSiteMatch = /samesite\s*=\s*(strict|lax|none)/i.exec(part);
    const domainMatch = /domain\s*=\s*([^;]+)/i.exec(part);
    return {
      name,
      secure: lower.includes('secure'),
      httpOnly: lower.includes('httponly'),
      sameSite: sameSiteMatch?.[1] ?? null,
      firstParty: domainMatch
        ? hostname.endsWith(domainMatch[1]!.trim().replace(/^\./, ''))
        : true,
    };
  });
}

async function fetchRobots(
  url: URL,
  env: AppEnv,
): Promise<{ present: boolean; disallowsAll: boolean; sitemapUrls: string[] } | undefined> {
  try {
    const response = await safeFetch(`${url.protocol}//${url.host}/robots.txt`, {
      method: 'GET',
      readBody: true,
      env,
    });
    if (response.status >= 400 || !response.body) {
      return { present: false, disallowsAll: false, sitemapUrls: [] };
    }
    const body = response.body.slice(0, 20_000);
    const sitemapUrls = Array.from(body.matchAll(/^\s*sitemap:\s*(\S+)/gim)).map((m) => m[1]!);
    const disallowsAll = /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*$/im.test(body);
    return { present: true, disallowsAll, sitemapUrls: sitemapUrls.slice(0, 10) };
  } catch {
    return undefined;
  }
}

function toFormRecord(
  form: {
    index: number;
    id: string;
    name: string;
    action: string;
    method: string;
    hasSubmitControl: boolean;
    hasNoValidate: boolean;
    fields: Array<{
      tag: string;
      type: string;
      name: string;
      id: string;
      required: boolean;
      placeholder: string;
      autocomplete: string;
      hasLabel: boolean;
      labelSource: string;
      accessibleName: string;
    }>;
  },
  pageOrigin: string,
): FormRecord {
  const fields = form.fields.map((field) => ({
    tag: field.tag as FormRecord['fields'][number]['tag'],
    type: field.type || undefined,
    name: field.name || undefined,
    id: field.id || undefined,
    required: field.required,
    placeholder: field.placeholder || undefined,
    autocomplete: field.autocomplete || undefined,
    hasLabel: field.hasLabel,
    labelSource: field.labelSource as FormRecord['fields'][number]['labelSource'],
    accessibleName: field.accessibleName || undefined,
  }));

  let insecureAction = false;
  if (form.action) {
    try {
      insecureAction = new URL(form.action, pageOrigin).protocol === 'http:';
    } catch {
      insecureAction = false;
    }
  }

  return {
    index: form.index,
    id: form.id || undefined,
    name: form.name || undefined,
    action: form.action || undefined,
    method: form.method || undefined,
    inferredPurpose: inferFormPurpose(form.fields, form.action, form.id, form.name),
    fields,
    hasSubmitControl: form.hasSubmitControl,
    hasNoValidate: form.hasNoValidate,
    insecureAction,
  };
}

/**
 * Guesses what a form is for, purely so the report can describe it and so the
 * "we did not submit this" note can name the category. The guess is never
 * used to decide whether to interact with a form — the answer to that is
 * always no.
 */
function inferFormPurpose(
  fields: Array<{ type: string; name: string; id: string; placeholder: string; autocomplete: string }>,
  action: string,
  id: string,
  name: string,
): string {
  const haystack = [
    action,
    id,
    name,
    ...fields.map((f) => `${f.name} ${f.id} ${f.placeholder} ${f.autocomplete} ${f.type}`),
  ]
    .join(' ')
    .toLowerCase();

  const hasPassword = fields.some((f) => f.type === 'password');
  const passwordCount = fields.filter((f) => f.type === 'password').length;

  if (/card|cvv|payment|checkout|billing|stripe/.test(haystack)) return 'payment';
  if (passwordCount >= 2 || /register|signup|sign-up|create.?account/.test(haystack)) return 'signup';
  if (/reset|forgot/.test(haystack) && hasPassword) return 'password-reset';
  if (hasPassword || /login|signin|sign-in/.test(haystack)) return 'login';
  if (/delete|remove.?account|close.?account/.test(haystack)) return 'account-deletion';
  if (fields.some((f) => f.type === 'file')) return 'file-upload';
  if (/subscribe|newsletter|mailing/.test(haystack)) return 'newsletter';
  if (/search|query|\bq\b/.test(haystack) && fields.length <= 3) return 'search';
  if (/contact|message|enquiry|inquiry|feedback|support/.test(haystack)) return 'contact';
  if (/filter|sort/.test(haystack)) return 'filter';
  return 'unknown';
}

function collectRedirectChain(response: Response): string[] {
  const chain: string[] = [];
  let request: Request | null = response.request();
  const seen = new Set<string>();
  while (request) {
    const redirectedFrom: Request | null = request.redirectedFrom();
    if (!redirectedFrom) break;
    const url = redactUrl(redirectedFrom.url());
    if (seen.has(url)) break;
    seen.add(url);
    chain.unshift(url);
    request = redirectedFrom;
    if (chain.length > 10) break;
  }
  return chain;
}

function normalizeConsoleType(type: string): ConsoleMessageRecord['type'] {
  switch (type) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    case 'log':
      return 'log';
    default:
      return 'other';
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function slugify(value: string): string {
  return value
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
}
