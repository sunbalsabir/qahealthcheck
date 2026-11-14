import {
  DANGEROUS_PATH_PATTERNS,
  DOWNLOAD_EXTENSIONS,
  NON_CRAWLABLE_PROTOCOLS,
} from '@qualovix/shared';

/**
 * URL normalization and crawl-eligibility rules.
 *
 * Normalization exists so the crawler visits `https://site.com/about`,
 * `https://site.com/about/`, `https://SITE.com/about?utm_source=x` and
 * `https://site.com/about#team` exactly once.
 */

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_source_platform', 'utm_creative_format',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'dclid', 'twclid',
  'mc_cid', 'mc_eid', 'igshid', 'ref', 'referrer', '_ga', '_gl', 'yclid',
];

export function normalizeUrl(input: string | URL, base?: string | URL): string {
  const url = typeof input === 'string' ? new URL(input, base) : new URL(input.toString());

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  // Drop the default port so :443 and the implicit form collapse together.
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  // Stable parameter order so ?a=1&b=2 and ?b=2&a=1 are one URL.
  url.searchParams.sort();

  // Collapse duplicate slashes and drop the trailing slash on non-root paths.
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  // Common index files are the same resource as the directory.
  url.pathname = url.pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, '') || '/';

  return url.toString();
}

/** Best-effort normalization that never throws; returns null for junk input. */
export function tryNormalizeUrl(input: string, base?: string): string | null {
  try {
    return normalizeUrl(input, base);
  } catch {
    return null;
  }
}

export function getRegistrableDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** Same site if the registrable domain matches, ignoring the `www.` prefix. */
export function isSameSite(a: string | URL, b: string | URL): boolean {
  try {
    const hostA = getRegistrableDomain(new URL(a.toString()).hostname);
    const hostB = getRegistrableDomain(new URL(b.toString()).hostname);
    return hostA === hostB;
  } catch {
    return false;
  }
}

export function hasDownloadExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return DOWNLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Paths the crawler must never follow. Visiting a logout or delete-account
 * link would be destructive testing, which the product forbids outright.
 */
export function isDangerousPath(url: string | URL): boolean {
  try {
    const parsed = new URL(url.toString());
    const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return DANGEROUS_PATH_PATTERNS.some((pattern) => haystack.includes(pattern));
  } catch {
    return false;
  }
}

export type SkipReason =
  | 'non-crawlable-protocol'
  | 'external-domain'
  | 'download-asset'
  | 'dangerous-path'
  | 'already-seen'
  | 'malformed'
  | 'depth-exceeded'
  | 'page-limit-reached';

export interface CrawlDecision {
  crawl: boolean;
  reason?: SkipReason;
  normalized?: string;
}

export interface CrawlEligibilityOptions {
  origin: string;
  seen: ReadonlySet<string>;
  depth: number;
  maxDepth: number;
}

/** Decide whether a discovered href should become a crawl target. */
export function shouldCrawl(
  href: string,
  options: CrawlEligibilityOptions,
): CrawlDecision {
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) {
    return { crawl: false, reason: 'malformed' };
  }

  const lowered = raw.toLowerCase();
  if (NON_CRAWLABLE_PROTOCOLS.some((proto) => lowered.startsWith(proto))) {
    return { crawl: false, reason: 'non-crawlable-protocol' };
  }

  const normalized = tryNormalizeUrl(raw, options.origin);
  if (!normalized) return { crawl: false, reason: 'malformed' };

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { crawl: false, reason: 'malformed' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { crawl: false, reason: 'non-crawlable-protocol', normalized };
  }
  if (!isSameSite(parsed, options.origin)) {
    return { crawl: false, reason: 'external-domain', normalized };
  }
  if (hasDownloadExtension(parsed.pathname)) {
    return { crawl: false, reason: 'download-asset', normalized };
  }
  if (isDangerousPath(parsed)) {
    return { crawl: false, reason: 'dangerous-path', normalized };
  }
  if (options.seen.has(normalized)) {
    return { crawl: false, reason: 'already-seen', normalized };
  }
  if (options.depth > options.maxDepth) {
    return { crawl: false, reason: 'depth-exceeded', normalized };
  }

  return { crawl: true, normalized };
}

/** Human-friendly path label used in finding titles ("the homepage", "/pricing"). */
export function describePage(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === '/' || path === '') return 'the homepage';
    return path;
  } catch {
    return url;
  }
}

export function isHomepage(url: string, origin: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/$/, '') === new URL(origin).pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}
