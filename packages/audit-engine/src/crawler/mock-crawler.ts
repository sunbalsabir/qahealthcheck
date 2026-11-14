import { getEnv, type AppEnv } from '@qualovix/shared';
import type {
  CrawlResult,
  LinkCheckResult,
  PageSnapshot,
  ViewportObservation,
} from '@qualovix/scanners';
import { getRegistrableDomain, normalizeUrl } from './url-utils';

/**
 * Mock crawler (AUDIT_MOCK_MODE=true).
 *
 * Produces a realistic `CrawlResult` without touching the network, so the
 * frontend, scoring, review workflow and report can be developed and tested
 * without repeatedly scanning a real site.
 *
 * Two deliberate design points:
 *
 *  - It swaps out only the crawler. Every scanner, the normalizer, the
 *    severity engine, the scorer and the report generator run their real code
 *    paths against this data, so mock mode exercises the whole pipeline.
 *
 *  - Output is deterministic per URL (seeded from the hostname). The same
 *    domain always produces the same audit, which makes screenshots, demos
 *    and snapshot tests stable.
 */

export interface MockCrawlOptions {
  auditId: string;
  url: string;
  env?: AppEnv;
}

/** Small deterministic PRNG so a given hostname always yields the same site. */
function makeRandom(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) {
    state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

export async function crawlSiteMock(options: MockCrawlOptions): Promise<CrawlResult> {
  const env = options.env ?? getEnv();
  const startedAt = new Date();
  const origin = normalizeUrl(options.url);
  const parsed = new URL(origin);
  const domain = getRegistrableDomain(parsed.hostname);
  const random = makeRandom(domain);

  // Simulate a scan taking a plausible amount of time without actually
  // waiting minutes — enough for the progress UI to be exercised.
  await delay(200);

  const paths = ['/', '/about', '/services', '/pricing', '/blog', '/contact', '/careers'].slice(
    0,
    Math.min(env.MAX_PAGES, 4 + Math.floor(random() * 3)),
  );

  const pages: PageSnapshot[] = paths.map((path, index) =>
    buildPage(parsed.origin, path, index, random),
  );

  const linkChecks = buildLinkChecks(parsed.origin, pages, random);
  const redirectsToHttps = random() > 0.25;

  const finishedAt = new Date();
  return {
    auditId: options.auditId,
    origin,
    domain,
    pages,
    linkChecks,
    transport: {
      httpsAvailable: true,
      httpRedirectsToHttps: redirectsToHttps,
      httpProbeOutcome: redirectsToHttps ? 'redirects' : 'no-redirect',
      httpRedirectTarget: `https://${parsed.host}/`,
      securityHeaders: buildHeaders(random),
      cookies: [
        { name: 'session_id', secure: random() > 0.4, httpOnly: random() > 0.3, sameSite: 'Lax', firstParty: true },
        { name: 'analytics_uid', secure: true, httpOnly: false, sameSite: null, firstParty: true },
      ],
    },
    robotsTxt: { present: true, disallowsAll: false, sitemapUrls: [`${parsed.origin}/sitemap.xml`] },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    mockMode: true,
    warnings: ['Mock mode is enabled — no network requests were made and no real site was scanned.'],
  };
}

function buildHeaders(random: () => number): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    server: 'nginx/1.24.0',
    'x-powered-by': 'Express 4.18.2',
  };
  // Vary which security headers are present so the security scanner has
  // something to both pass and fail on.
  if (random() > 0.5) headers['strict-transport-security'] = 'max-age=31536000';
  if (random() > 0.7) headers['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'";
  if (random() > 0.4) headers['x-content-type-options'] = 'nosniff';
  if (random() > 0.6) headers['x-frame-options'] = 'SAMEORIGIN';
  if (random() > 0.5) headers['referrer-policy'] = 'strict-origin-when-cross-origin';
  return headers;
}

function buildPage(
  origin: string,
  path: string,
  index: number,
  random: () => number,
): PageSnapshot {
  const url = `${origin}${path === '/' ? '' : path}`;
  const isHome = path === '/';
  const label = path === '/' ? 'Home' : path.slice(1).replace(/^\w/, (c) => c.toUpperCase());

  // A few pages deliberately carry defects so the report has content.
  const hasConsoleError = isHome || index === 2;
  const hasBrokenImage = index === 1;
  const missingAltCount = Math.floor(random() * 5);
  const hasOverflow = index <= 1;

  const links = [
    { href: '/', text: 'Home', internal: true },
    { href: '/about', text: 'About us', internal: true },
    { href: '/services', text: 'Services', internal: true },
    { href: '/pricing', text: 'Pricing', internal: true },
    { href: '/contact', text: 'Contact', internal: true },
    { href: '/blog/old-post', text: 'Read more', internal: true },
    { href: 'https://twitter.com/example', text: '', internal: false },
    { href: 'https://linkedin.com/company/example', text: 'Follow us on LinkedIn', internal: false },
  ].map((link) => ({
    href: link.href,
    resolved: link.internal ? `${origin}${link.href === '/' ? '' : link.href}` : link.href,
    text: link.text,
    internal: link.internal,
    rel: link.internal ? undefined : 'noopener',
    target: link.internal ? undefined : '_blank',
    ariaLabel: undefined,
    hasVisibleText: link.text.length > 0,
    hasImageChild: link.text.length === 0,
  }));

  const images = Array.from({ length: 3 + Math.floor(random() * 4) }, (_, i) => ({
    src: `/images/${label.toLowerCase()}-${i + 1}.jpg`,
    resolved: `${origin}/images/${label.toLowerCase()}-${i + 1}.jpg`,
    alt: i < missingAltCount ? null : `${label} illustration ${i + 1}`,
    isDecorative: false,
    width: 640,
    height: 360,
    naturalWidth: i === 0 ? 2400 : 720,
    naturalHeight: i === 0 ? 1350 : 405,
    loading: i > 1 ? 'lazy' : undefined,
    transferBytes: i === 0 ? 840_000 : 90_000,
    failedToLoad: hasBrokenImage && i === 2,
  }));

  const forms =
    path === '/contact' || isHome
      ? [
          {
            index: 0,
            id: 'contact-form',
            action: '/api/contact',
            method: 'post',
            inferredPurpose: 'contact',
            hasSubmitControl: true,
            hasNoValidate: false,
            insecureAction: false,
            fields: [
              { tag: 'input' as const, type: 'text', name: 'name', id: 'name', required: true, hasLabel: true, labelSource: 'for' as const, accessibleName: 'Your name' },
              { tag: 'input' as const, type: 'text', name: 'email', id: 'email', required: true, hasLabel: false, labelSource: 'none' as const, placeholder: 'Email address' },
              { tag: 'textarea' as const, name: 'message', id: 'message', required: false, hasLabel: true, labelSource: 'for' as const, accessibleName: 'Message' },
              { tag: 'button' as const, type: 'submit', required: false, hasLabel: true, labelSource: 'wrapping' as const, accessibleName: 'Send message' },
            ],
          },
        ]
      : [];

  return {
    url,
    normalizedUrl: url,
    depth: isHome ? 0 : 1,
    title: isHome ? `${label} | Example Company` : `${label} | Example Company`,
    statusCode: 200,
    responseTimeMs: 180 + Math.floor(random() * 500),
    contentType: 'text/html; charset=utf-8',
    byteSize: 48_000 + Math.floor(random() * 40_000),
    headers: buildHeaders(random),
    redirectChain: [],
    lang: index === 3 ? null : 'en',
    meta: {
      description: index === 2 ? undefined : `${label} page for Example Company.`,
      viewport: 'width=device-width, initial-scale=1',
      charset: 'utf-8',
      canonical: url,
    },
    headings: [
      ...(index === 4 ? [] : [{ level: 1, text: `${label}` }]),
      { level: 2, text: 'What we do' },
      { level: 2, text: 'Why choose us' },
      { level: 4, text: 'Skipped level' },
    ],
    links,
    images,
    forms,
    buttons: [
      { tag: 'button', type: 'submit', text: 'Get started', hasAccessibleName: true, disabled: false },
      { tag: 'button', type: 'button', text: '', hasAccessibleName: false, disabled: false },
      { tag: 'button', type: 'button', text: 'Learn more', hasAccessibleName: true, disabled: false },
    ],
    scripts: [
      { src: '/assets/app.js', inline: false, async: false, defer: true, blocking: false },
      { src: 'https://cdn.example-analytics.com/tag.js', inline: false, async: false, defer: false, blocking: true },
      { inline: true, async: false, defer: false, blocking: false },
    ],
    stylesheets: [
      { href: '/assets/main.css', media: 'all', blocking: true },
      { href: 'https://fonts.example.com/css?family=Inter', blocking: true },
    ],
    duplicateIds: index === 1 ? [{ id: 'cta-button', count: 3 }] : [],
    elementCount: 120,
    textLength: index === 5 ? 90 : 2400 + Math.floor(random() * 3000),
    console: hasConsoleError
      ? [
          {
            type: 'error' as const,
            text: "TypeError: Cannot read properties of undefined (reading 'map')",
            url: `${origin}/assets/app.js`,
            lineNumber: 142,
            source: 'pageerror' as const,
            stack: "TypeError: Cannot read properties of undefined (reading 'map')\n    at renderList (app.js:142:19)",
          },
          {
            type: 'warning' as const,
            text: 'Image with src "/images/hero.jpg" has no explicit width or height',
            source: 'console' as const,
          },
        ]
      : [],
    network: buildNetwork(origin, label, hasBrokenImage, random),
    performance: {
      ttfbMs: 320 + Math.floor(random() * 900),
      domContentLoadedMs: 1200,
      loadEventMs: 2400,
      lcpMs: 1800 + Math.floor(random() * 3200),
      firstContentfulPaintMs: 1100 + Math.floor(random() * 900),
      cls: Number((random() * 0.3).toFixed(3)),
      totalBlockingTimeMs: Math.floor(random() * 800),
      longTaskCount: Math.floor(random() * 8),
      totalTransferBytes: 1_200_000 + Math.floor(random() * 3_000_000),
      requestCount: 45 + Math.floor(random() * 90),
      imageBytes: 800_000 + Math.floor(random() * 1_500_000),
      scriptBytes: 380_000,
      stylesheetBytes: 90_000,
      fontBytes: 120_000,
      renderBlockingCount: 3,
      domNodeCount: 900 + Math.floor(random() * 2500),
    },
    viewports: buildViewports(hasOverflow, random),
    axe: buildAxeResults(missingAltCount, index, random),
  };
}

function buildNetwork(
  origin: string,
  label: string,
  hasBrokenImage: boolean,
  random: () => number,
) {
  const requests = [
    { url: `${origin}/assets/main.css`, resourceType: 'stylesheet', status: 200, bytes: 90_000 },
    { url: `${origin}/assets/app.js`, resourceType: 'script', status: 200, bytes: 380_000 },
    { url: `${origin}/images/${label.toLowerCase()}-1.jpg`, resourceType: 'image', status: 200, bytes: 840_000 },
    { url: 'https://cdn.example-analytics.com/tag.js', resourceType: 'script', status: 200, bytes: 60_000 },
    { url: 'https://fonts.example.com/inter.woff2', resourceType: 'font', status: 200, bytes: 120_000 },
  ];
  if (hasBrokenImage) {
    requests.push({
      url: `${origin}/images/${label.toLowerCase()}-3.jpg`,
      resourceType: 'image',
      status: 404,
      bytes: 0,
    });
  }
  if (random() > 0.7) {
    requests.push({ url: `${origin}/api/config.json`, resourceType: 'fetch', status: 500, bytes: 0 });
  }

  return requests.map((request) => ({
    url: request.url,
    method: 'GET',
    resourceType: request.resourceType,
    status: request.status,
    failed: request.status >= 400,
    transferBytes: request.bytes,
    durationMs: 80 + Math.floor(random() * 400),
    fromCache: false,
    thirdParty: !request.url.startsWith(origin),
  }));
}

function buildViewports(hasOverflow: boolean, random: () => number): ViewportObservation[] {
  return [
    {
      viewport: 'Mobile',
      width: 375,
      height: 812,
      documentWidth: hasOverflow ? 375 + 40 + Math.floor(random() * 120) : 375,
      documentHeight: 3200,
      hasHorizontalOverflow: hasOverflow,
      overflowAmountPx: hasOverflow ? 40 + Math.floor(random() * 120) : 0,
      overflowingElements: hasOverflow
        ? [
            { selector: 'div.hero-banner', tag: 'div', overflowPx: 88, width: 463, text: 'Build better software' },
            { selector: 'table.pricing-table', tag: 'table', overflowPx: 52, width: 427, text: 'Plan Features Price' },
          ]
        : [],
      tinyTextCount: Math.floor(random() * 6),
      tinyTapTargets: [
        { selector: 'a.social-icon', tag: 'a', width: 18, height: 18, text: '' },
        { selector: 'button.close', tag: 'button', width: 20, height: 20, text: 'x' },
      ],
      overlappingElements: hasOverflow
        ? [{ a: 'button.cta', b: 'div.sticky-banner', overlapArea: 1840 }]
        : [],
      offscreenInteractiveCount: hasOverflow ? 2 : 0,
    },
    {
      viewport: 'Tablet',
      width: 768,
      height: 1024,
      documentWidth: 768,
      documentHeight: 2600,
      hasHorizontalOverflow: false,
      overflowAmountPx: 0,
      overflowingElements: [],
      tinyTextCount: 0,
      tinyTapTargets: [],
      overlappingElements: [],
      offscreenInteractiveCount: 0,
    },
    {
      viewport: 'Desktop',
      width: 1440,
      height: 900,
      documentWidth: 1440,
      documentHeight: 2200,
      hasHorizontalOverflow: false,
      overflowAmountPx: 0,
      overflowingElements: [],
      tinyTextCount: 0,
      tinyTapTargets: [],
      overlappingElements: [],
      offscreenInteractiveCount: 0,
    },
  ];
}

function buildAxeResults(missingAltCount: number, index: number, random: () => number) {
  const violations = [];

  if (missingAltCount > 0) {
    violations.push({
      id: 'image-alt',
      impact: 'critical' as const,
      help: 'Images must have alternate text',
      description:
        'Ensures <img> elements have alternate text or a role of none or presentation',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
      tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'],
      nodes: Array.from({ length: missingAltCount }, (_, i) => ({
        target: [`img:nth-of-type(${i + 1})`],
        html: `<img src="/images/photo-${i + 1}.jpg">`,
        failureSummary: 'Fix any of the following: Element does not have an alt attribute',
      })),
    });
  }

  violations.push({
    id: 'color-contrast',
    impact: 'serious' as const,
    help: 'Elements must meet minimum color contrast ratio thresholds',
    description: 'Ensures the contrast between foreground and background colors meets WCAG 2 AA thresholds',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
    tags: ['cat.color', 'wcag2aa', 'wcag143'],
    nodes: [
      {
        target: ['.footer-links a'],
        html: '<a href="/privacy" class="footer-link">Privacy policy</a>',
        failureSummary: 'Element has insufficient color contrast of 3.1:1 (expected 4.5:1)',
      },
      {
        target: ['.hero p.subtitle'],
        html: '<p class="subtitle">Trusted by teams worldwide</p>',
        failureSummary: 'Element has insufficient color contrast of 2.9:1 (expected 4.5:1)',
      },
    ],
  });

  if (index === 3) {
    violations.push({
      id: 'html-has-lang',
      impact: 'serious' as const,
      help: '<html> element must have a lang attribute',
      description: 'Ensures every HTML document has a lang attribute',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/html-has-lang',
      tags: ['cat.language', 'wcag2a', 'wcag311'],
      nodes: [{ target: ['html'], html: '<html>', failureSummary: 'The <html> element does not have a lang attribute' }],
    });
  }

  if (random() > 0.5) {
    violations.push({
      id: 'heading-order',
      impact: 'moderate' as const,
      help: 'Heading levels should only increase by one',
      description: 'Ensures the order of headings is semantically correct',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/heading-order',
      tags: ['cat.semantics', 'best-practice'],
      nodes: [{ target: ['h4'], html: '<h4>Skipped level</h4>', failureSummary: 'Heading order invalid' }],
    });
  }

  return {
    violations,
    passes: [
      { id: 'document-title', help: 'Documents must have <title> element', nodeCount: 1 },
      { id: 'button-name', help: 'Buttons must have discernible text', nodeCount: 3 },
      { id: 'duplicate-id-active', help: 'IDs of active elements must be unique', nodeCount: 12 },
      { id: 'link-name', help: 'Links must have discernible text', nodeCount: 8 },
      { id: 'aria-valid-attr-value', help: 'ARIA attributes must conform to valid values', nodeCount: 6 },
    ],
    incomplete: [
      { id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', nodeCount: 3 },
    ],
  };
}

function buildLinkChecks(
  origin: string,
  pages: PageSnapshot[],
  random: () => number,
): LinkCheckResult[] {
  const allPages = pages.map((p) => p.url);
  const checks: LinkCheckResult[] = pages.map((page) => ({
    url: page.url,
    foundOn: allPages.slice(0, 3),
    anchorText: page.title ?? '',
    internal: true,
    status: 200,
    ok: true,
    redirectChain: [],
    inNavigation: true,
    responseTimeMs: 140 + Math.floor(random() * 300),
  }));

  // A broken internal link that appears in navigation — the CRITICAL case.
  checks.push({
    url: `${origin}/blog/old-post`,
    foundOn: allPages,
    anchorText: 'Read more',
    internal: true,
    status: 404,
    ok: false,
    errorType: 'http',
    redirectChain: [],
    inNavigation: true,
    responseTimeMs: 120,
  });

  // A broken external link — MEDIUM at most.
  checks.push({
    url: 'https://twitter.com/example',
    foundOn: allPages.slice(0, 2),
    anchorText: '',
    internal: false,
    status: 404,
    ok: false,
    errorType: 'http',
    redirectChain: [],
    inNavigation: false,
    responseTimeMs: 340,
  });

  if (random() > 0.5) {
    checks.push({
      url: `${origin}/api/status`,
      foundOn: [allPages[0]!],
      anchorText: 'System status',
      internal: true,
      status: 503,
      ok: false,
      errorType: 'http',
      redirectChain: [],
      inNavigation: false,
      responseTimeMs: 5200,
    });
  }

  return checks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
