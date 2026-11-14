import type {
  Finding,
  FindingCategory,
  FindingEvidence,
  PassedCheck,
  ScannerResult,
  Severity,
  Confidence,
} from '@qualovix/shared';

/**
 * The crawl snapshot.
 *
 * The crawler visits each page exactly once and records everything here.
 * Scanners are then pure(ish) functions over this data rather than nine
 * separate passes over the customer's site. That keeps each scanner
 * independently testable and means adding a scanner costs no extra traffic.
 */

export interface LinkRecord {
  href: string;
  /** Resolved + normalized absolute URL, when the href could be parsed. */
  resolved?: string;
  text: string;
  /** True when the link points at the audited site. */
  internal: boolean;
  rel?: string;
  target?: string;
  ariaLabel?: string;
  hasVisibleText: boolean;
  hasImageChild: boolean;
  /** Bounding box, when the element was laid out. */
  box?: ElementBox;
}

export interface ImageRecord {
  src: string;
  resolved?: string;
  alt: string | null;
  /** Decorative images legitimately carry alt="". */
  isDecorative: boolean;
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  loading?: string;
  /** Transferred bytes, when the network log observed the request. */
  transferBytes?: number;
  failedToLoad: boolean;
}

export interface FormFieldRecord {
  tag: 'input' | 'select' | 'textarea' | 'button';
  type?: string;
  name?: string;
  id?: string;
  required: boolean;
  placeholder?: string;
  autocomplete?: string;
  /** True when a <label for>, wrapping label, aria-label or aria-labelledby exists. */
  hasLabel: boolean;
  labelSource?: 'for' | 'wrapping' | 'aria-label' | 'aria-labelledby' | 'title' | 'none';
  accessibleName?: string;
}

export interface FormRecord {
  index: number;
  id?: string;
  name?: string;
  action?: string;
  method?: string;
  /** Purpose guessed from field names — never used to decide to submit. */
  inferredPurpose: string;
  fields: FormFieldRecord[];
  hasSubmitControl: boolean;
  hasNoValidate: boolean;
  /** True when the form posts over plain HTTP from an HTTPS page. */
  insecureAction: boolean;
}

export interface HeadingRecord {
  level: number;
  text: string;
}

export interface ButtonRecord {
  tag: string;
  type?: string;
  text: string;
  ariaLabel?: string;
  hasAccessibleName: boolean;
  disabled: boolean;
  box?: ElementBox;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConsoleMessageRecord {
  type: 'error' | 'warning' | 'log' | 'info' | 'debug' | 'other';
  text: string;
  url?: string;
  lineNumber?: number;
  /** 'console' for console API output, 'pageerror' for uncaught exceptions. */
  source: 'console' | 'pageerror';
  stack?: string;
}

export interface NetworkRequestRecord {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  failed: boolean;
  failureText?: string;
  transferBytes?: number;
  durationMs?: number;
  fromCache: boolean;
  /** True when the request went to another origin. */
  thirdParty: boolean;
}

export interface MetaRecord {
  description?: string;
  canonical?: string;
  viewport?: string;
  robots?: string;
  charset?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  themeColor?: string;
  lang?: string;
  dir?: string;
  generator?: string;
}

export interface PerformanceMetrics {
  /** Navigation Timing: responseStart - requestStart. */
  ttfbMs?: number;
  domContentLoadedMs?: number;
  loadEventMs?: number;
  /** Largest Contentful Paint, from PerformanceObserver. */
  lcpMs?: number;
  firstContentfulPaintMs?: number;
  /** Cumulative Layout Shift score. */
  cls?: number;
  /** Total Blocking Time approximated from long tasks over 50ms. */
  totalBlockingTimeMs?: number;
  longTaskCount?: number;
  /** Total transferred bytes across all resources. */
  totalTransferBytes?: number;
  requestCount?: number;
  imageBytes?: number;
  scriptBytes?: number;
  stylesheetBytes?: number;
  fontBytes?: number;
  /** Stylesheets and synchronous scripts in <head>. */
  renderBlockingCount?: number;
  domNodeCount?: number;
}

export interface ViewportObservation {
  viewport: string;
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
  hasHorizontalOverflow: boolean;
  overflowAmountPx: number;
  /** Elements that stick out past the right edge of the viewport. */
  overflowingElements: OverflowingElement[];
  /** Visible text nodes rendered below the readable threshold. */
  tinyTextCount: number;
  /** Interactive elements smaller than the 24x24 CSS px target guideline. */
  tinyTapTargets: TinyTapTarget[];
  /** Interactive elements whose boxes visually overlap. */
  overlappingElements: OverlapPair[];
  /** Interactive elements positioned outside the viewport entirely. */
  offscreenInteractiveCount: number;
  screenshot?: string;
}

export interface OverflowingElement {
  selector: string;
  tag: string;
  overflowPx: number;
  width: number;
  text?: string;
}

export interface TinyTapTarget {
  selector: string;
  tag: string;
  width: number;
  height: number;
  text?: string;
}

export interface OverlapPair {
  a: string;
  b: string;
  overlapArea: number;
}

export interface AxeViolationNode {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface AxeViolation {
  id: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  description: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeViolationNode[];
}

export interface AxeResults {
  violations: AxeViolation[];
  passes: Array<{ id: string; help: string; nodeCount: number }>;
  incomplete: Array<{ id: string; help: string; nodeCount: number }>;
  /** Set when axe could not run on this page. */
  error?: string;
}

/** Everything the crawler recorded for one page. */
export interface PageSnapshot {
  url: string;
  normalizedUrl: string;
  depth: number;
  title: string | null;
  statusCode: number | null;
  statusText?: string;
  responseTimeMs: number | null;
  contentType: string | null;
  byteSize: number | null;
  /** Response headers of the main document, already redacted. */
  headers: Record<string, string>;
  redirectChain: string[];
  /** Set when the page could not be loaded at all. */
  loadError?: string;

  lang: string | null;
  meta: MetaRecord;
  headings: HeadingRecord[];
  links: LinkRecord[];
  images: ImageRecord[];
  forms: FormRecord[];
  buttons: ButtonRecord[];
  scripts: Array<{ src?: string; inline: boolean; async: boolean; defer: boolean; blocking: boolean }>;
  stylesheets: Array<{ href?: string; media?: string; blocking: boolean }>;
  /** Element ids appearing more than once in the document. */
  duplicateIds: Array<{ id: string; count: number }>;
  /** Count of elements that carry an id at all, for ratio reporting. */
  elementCount: number;
  textLength: number;

  console: ConsoleMessageRecord[];
  network: NetworkRequestRecord[];
  performance: PerformanceMetrics;
  viewports: ViewportObservation[];
  axe?: AxeResults;
}

/** Result of probing a single discovered link for availability. */
export interface LinkCheckResult {
  url: string;
  /** The page(s) the link was found on. */
  foundOn: string[];
  anchorText: string;
  internal: boolean;
  status: number | null;
  ok: boolean;
  errorType?: 'dns' | 'timeout' | 'tls' | 'refused' | 'network' | 'http';
  errorDetail?: string;
  redirectChain: string[];
  /** True when the link is in primary navigation, which raises its severity. */
  inNavigation: boolean;
  responseTimeMs?: number;
}

export interface TransportObservation {
  /** Whether https:// was reachable for the audited origin. */
  httpsAvailable: boolean;
  httpsError?: string;
  /** Whether http:// redirected to https://. Only meaningful when the probe
   *  actually completed — see `httpProbeOutcome`. */
  httpRedirectsToHttps: boolean;
  /**
   * What the plain-HTTP probe established:
   *   'redirects'    - HTTP responded and sent us to HTTPS.
   *   'no-redirect'  - HTTP responded and stayed on HTTP. A real finding.
   *   'not-served'   - the connection was refused, so HTTP is simply not
   *                    served. That is fine, and not a finding.
   *   'inconclusive' - the probe timed out or failed for another reason. We
   *                    learned nothing, so we report nothing.
   */
  httpProbeOutcome: 'redirects' | 'no-redirect' | 'not-served' | 'inconclusive';
  httpRedirectTarget?: string;
  httpProbeError?: string;
  /** Response headers observed on the origin over https, already redacted. */
  securityHeaders: Record<string, string>;
  /** Cookie flags observed from Set-Cookie, values stripped. */
  cookies: CookieObservation[];
  tlsCertificateError?: string;
}

export interface CookieObservation {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  /** Set on the document origin rather than a third party. */
  firstParty: boolean;
}

/** The complete crawl result handed to every scanner. */
export interface CrawlResult {
  auditId: string;
  /** The URL as submitted, after validation and normalization. */
  origin: string;
  domain: string;
  pages: PageSnapshot[];
  linkChecks: LinkCheckResult[];
  transport: TransportObservation;
  robotsTxt?: { present: boolean; disallowsAll: boolean; sitemapUrls: string[] };
  sitemapPresent?: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  mockMode: boolean;
  /** Problems encountered during crawling that are not findings themselves. */
  warnings: string[];
}

/** Context handed to a scanner's `scan` method. */
export interface ScanContext {
  auditId: string;
  crawl: CrawlResult;
  /** Absolute limits the scanner must respect. */
  limits: {
    maxFindingsPerRule: number;
    maxPages: number;
  };
}

/**
 * The scanner interface. Adding a scanner means implementing this and
 * registering it — nothing else in the pipeline changes.
 */
export interface Scanner {
  readonly id: string;
  readonly name: string;
  readonly category: FindingCategory;
  readonly description: string;
  scan(context: ScanContext): Promise<ScannerResult> | ScannerResult;
}

export interface FindingDraft {
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  url?: string;
  selector?: string;
  evidence: FindingEvidence;
  recommendation: string;
  impact?: string;
  occurrences?: number;
  affectedUrls?: string[];
}

export type { Finding, PassedCheck, ScannerResult, FindingCategory, Severity, Confidence };
