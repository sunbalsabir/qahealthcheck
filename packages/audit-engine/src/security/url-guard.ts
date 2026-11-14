import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { promises as dns } from 'node:dns';
import { Agent, type Dispatcher } from 'undici';
import { getEnv, type AppEnv } from '@qualovix/shared';
import { classifyHostname, classifyIp } from './ip';

/**
 * URL validation and SSRF containment.
 *
 * Three layers, because any one of them alone is bypassable:
 *
 *  1. `validateUrl` — structural checks (protocol allowlist, credentials,
 *     port policy) plus hostname screening. Cheap, runs on submission.
 *  2. `resolvePublicAddresses` — DNS resolution with every returned A/AAAA
 *     record classified. Catches names that point at private space.
 *  3. `createGuardedAgent` — a connect-time `lookup` hook that re-checks the
 *     address actually being dialled. This is what defeats DNS rebinding,
 *     where the name resolves to a public IP during validation and a private
 *     one microseconds later when the socket opens.
 *
 * Redirects are re-validated at every hop (`safeFetch`), because a public URL
 * is free to 302 to http://169.254.169.254/.
 */

export class SsrfError extends Error {
  readonly code: string;
  readonly targetUrl: string;

  constructor(message: string, code: string, targetUrl: string) {
    super(message);
    this.name = 'SsrfError';
    this.code = code;
    this.targetUrl = targetUrl;
  }
}

export interface UrlValidationOptions {
  env?: AppEnv;
  /** Skip DNS resolution. Used by the structural-only unit tests. */
  skipDnsResolution?: boolean;
}

export interface ValidatedUrl {
  /** The parsed, normalized URL that is safe to request. */
  url: URL;
  hostname: string;
  /** Every address the hostname resolved to, all of them public. */
  addresses: string[];
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Ports the scanner may connect to. Restricting this prevents the audit
 * engine being used to probe internal service ports (Redis 6379, Postgres
 * 5432, Elasticsearch 9200, ...) even on a public host.
 */
const ALLOWED_PORTS = new Set([80, 443, 5000, 8080, 8443, 3000, 4000, 6000, 8000]);

/** Normalize user input into a URL, defaulting to https when no scheme given. */
export function parseUserUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new SsrfError('No URL supplied.', 'empty-url', input);
  if (trimmed.length > 2048) {
    throw new SsrfError('URL is too long.', 'url-too-long', input);
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new SsrfError('That does not look like a valid URL.', 'malformed-url', input);
  }
  return url;
}

/**
 * Structural + hostname validation. Does not touch the network.
 * Throws `SsrfError` with a user-safe message on rejection.
 */
export function validateUrl(input: string, options: UrlValidationOptions = {}): URL {
  const env = options.env ?? getEnv();
  const url = parseUserUrl(input);

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfError(
      `Only http:// and https:// URLs can be audited (received ${url.protocol}).`,
      'protocol-not-allowed',
      input,
    );
  }

  if (url.username || url.password) {
    throw new SsrfError(
      'URLs containing credentials are not accepted.',
      'credentials-in-url',
      input,
    );
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new SsrfError(
      `Port ${port} is not permitted. Audits run against standard web ports only.`,
      'port-not-allowed',
      input,
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (env.SSRF_ALLOWLIST.includes(hostname)) return url;

  const classification = classifyHostname(hostname);
  if (!classification.safe) {
    throw new SsrfError(
      describeRefusal(classification.reason, hostname),
      classification.reason,
      input,
    );
  }

  return url;
}

function describeRefusal(reason: string, hostname: string): string {
  switch (reason) {
    case 'blocked-hostname':
    case 'loopback':
      return 'Local addresses cannot be audited. Enter a publicly reachable website.';
    case 'private-network':
    case 'unique-local-address':
      return 'Private network addresses cannot be audited. Enter a public website.';
    case 'link-local-or-cloud-metadata':
    case 'cloud-metadata-endpoint':
      return 'That address is a cloud metadata endpoint and cannot be audited.';
    case 'internal-dns-suffix':
      return `"${hostname}" is an internal hostname. Enter a public website.`;
    case 'non-fqdn-hostname':
      return 'Enter a full domain name, for example https://example.com.';
    case 'numeric-host-encoding':
      return 'Encoded numeric hosts are not accepted. Enter a domain name.';
    case 'carrier-grade-nat':
    case 'multicast':
    case 'reserved':
    case 'documentation':
    case 'benchmarking':
      return 'That address is in a reserved range and cannot be audited.';
    default:
      return 'That address cannot be audited. Enter a publicly reachable website.';
  }
}

/**
 * Resolve a hostname and require every returned address to be public.
 * A single private record fails the whole lookup — a hostname with mixed
 * public and private records is exactly the DNS-rebinding shape we refuse.
 */
export async function resolvePublicAddresses(
  hostname: string,
  options: UrlValidationOptions = {},
): Promise<string[]> {
  const env = options.env ?? getEnv();
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (env.SSRF_ALLOWLIST.includes(host)) return [];

  const literal = classifyIp(host);
  if (literal.reason !== 'not-an-ip-address') {
    if (!literal.safe) {
      throw new SsrfError(describeRefusal(literal.reason, host), literal.reason, hostname);
    }
    return [host];
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(
      `We could not resolve "${host}". Check the domain name and try again.`,
      'dns-resolution-failed',
      hostname,
    );
  }

  if (addresses.length === 0) {
    throw new SsrfError(
      `"${host}" did not resolve to any address.`,
      'dns-no-records',
      hostname,
    );
  }

  for (const record of addresses) {
    const classification = classifyIp(record.address);
    if (!classification.safe) {
      throw new SsrfError(
        describeRefusal(classification.reason, host),
        `resolved-${classification.reason}`,
        hostname,
      );
    }
  }

  return addresses.map((a) => a.address);
}

/** Full validation: structural, hostname, and DNS. */
export async function assertSafeUrl(
  input: string,
  options: UrlValidationOptions = {},
): Promise<ValidatedUrl> {
  const url = validateUrl(input, options);
  const addresses = options.skipDnsResolution
    ? []
    : await resolvePublicAddresses(url.hostname, options);
  return { url, hostname: url.hostname.toLowerCase(), addresses };
}

/**
 * Connect-time guard. Every socket the scanner opens resolves through this
 * hook, and a private address here aborts the connection even if validation
 * passed moments earlier.
 */
export function guardedLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
): void {
  const env = getEnv();
  const host = hostname.toLowerCase();

  const deny = (reason: string) => {
    const error: NodeJS.ErrnoException = new SsrfError(
      describeRefusal(reason, host),
      reason,
      hostname,
    );
    error.code = 'ESSRFBLOCKED';
    callback(error);
  };

  if (env.SSRF_ALLOWLIST.includes(host)) {
    dnsLookup(hostname, options as never, callback as never);
    return;
  }

  const hostClass = classifyHostname(host);
  if (!hostClass.safe && hostClass.reason !== 'malformed-ipv4') {
    deny(hostClass.reason);
    return;
  }

  dnsLookup(hostname, { ...(options as object), all: true } as never, ((
    err: NodeJS.ErrnoException | null,
    resolved: LookupAddress[],
  ) => {
    if (err) {
      callback(err);
      return;
    }
    const records = Array.isArray(resolved) ? resolved : [resolved];
    for (const record of records) {
      const classification = classifyIp(record.address);
      if (!classification.safe) {
        deny(`resolved-${classification.reason}`);
        return;
      }
    }
    // Preserve the caller's `all` expectation.
    const wantsAll = Boolean((options as { all?: boolean } | undefined)?.all);
    if (wantsAll) {
      callback(null, records, undefined);
    } else {
      const first = records[0]!;
      callback(null, first.address, first.family);
    }
  }) as never);
}

let guardedAgent: Dispatcher | null = null;

/**
 * Shared undici dispatcher that applies `guardedLookup` and enforces the
 * configured connect/body timeouts and redirect ceiling.
 */
export function getGuardedAgent(env: AppEnv = getEnv()): Dispatcher {
  if (guardedAgent) return guardedAgent;
  guardedAgent = new Agent({
    connect: {
      lookup: guardedLookup as never,
      timeout: Math.min(env.REQUEST_TIMEOUT_MS, 10_000),
    },
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
    // No redirect interceptor is installed: every redirect is surfaced to
    // safeFetch, which re-validates the target before following it.
  });
  return guardedAgent;
}

/** Test helper: drop the memoized dispatcher. */
export function resetGuardedAgent(): void {
  guardedAgent = null;
}

export interface SafeFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  redirectChain: string[];
  body?: string;
  byteSize: number;
  responseTimeMs: number;
  truncated: boolean;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  env?: AppEnv;
  /** Read and return the response body (capped at MAX_RESPONSE_BYTES). */
  readBody?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Fetch with redirects followed manually so every hop is re-validated, plus
 * hard caps on redirect count, time and response size.
 */
export async function safeFetch(
  input: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const env = options.env ?? getEnv();
  const timeoutMs = options.timeoutMs ?? env.REQUEST_TIMEOUT_MS;
  const started = Date.now();
  const redirectChain: string[] = [];

  let current = (await assertSafeUrl(input, { env })).url;
  let hops = 0;

  for (;;) {
    if (hops > env.MAX_REDIRECTS) {
      throw new SsrfError(
        `More than ${env.MAX_REDIRECTS} redirects were followed.`,
        'too-many-redirects',
        input,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(current, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent':
            'QualovixQAAuditor/1.0 (+https://qualovix.com/qa-auditor; automated QA health check)',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...options.headers,
        },
        // @ts-expect-error -- `dispatcher` is an undici extension to RequestInit.
        dispatcher: getGuardedAgent(env),
      });
    } catch (error) {
      if (error instanceof SsrfError) throw error;
      const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
      if (cause instanceof SsrfError) throw cause;
      if (cause?.code === 'ESSRFBLOCKED') throw cause as unknown as SsrfError;
      throw new FetchFailure(describeFetchError(error), current.toString());
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    const headers = headersToObject(response.headers);

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return finalize(response, current, headers, redirectChain, started, '', 0, false);
      }
      const next = new URL(location, current);
      redirectChain.push(next.toString());
      // Re-validate the redirect target from scratch: a public origin is
      // free to bounce us at an internal address.
      current = (await assertSafeUrl(next.toString(), { env })).url;
      hops += 1;
      // Drain the redirect body so the socket can be reused.
      await response.body?.cancel().catch(() => undefined);
      continue;
    }

    if (!options.readBody) {
      await response.body?.cancel().catch(() => undefined);
      const declared = Number(response.headers.get('content-length') ?? 0);
      return finalize(response, current, headers, redirectChain, started, undefined, declared, false);
    }

    const { text, bytes, truncated } = await readCapped(response, env.MAX_RESPONSE_BYTES);
    return finalize(response, current, headers, redirectChain, started, text, bytes, truncated);
  }
}

/** A network-level failure that is not an SSRF refusal. */
export class FetchFailure extends Error {
  readonly targetUrl: string;
  constructor(message: string, targetUrl: string) {
    super(message);
    this.name = 'FetchFailure';
    this.targetUrl = targetUrl;
  }
}

function finalize(
  response: Response,
  current: URL,
  headers: Record<string, string>,
  redirectChain: string[],
  started: number,
  body: string | undefined,
  byteSize: number,
  truncated: boolean,
): SafeFetchResult {
  return {
    url: current.toString(),
    finalUrl: current.toString(),
    status: response.status,
    ok: response.ok,
    headers,
    redirectChain,
    body,
    byteSize,
    responseTimeMs: Date.now() - started,
    truncated,
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0, truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Keep only up to the cap, then stop reading entirely.
      const keep = value.byteLength - (total - maxBytes);
      if (keep > 0) chunks.push(value.subarray(0, keep));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      total = maxBytes;
      break;
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buffer.toString('utf8'), bytes: total, truncated };
}

function describeFetchError(error: unknown): string {
  const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  const code = err.code ?? err.cause?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'DNS lookup failed';
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ECONNRESET':
      return 'Connection reset';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'Request timed out';
    case 'CERT_HAS_EXPIRED':
      return 'TLS certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'TLS certificate is self-signed';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS certificate could not be verified';
    default:
      if (err.name === 'AbortError') return 'Request timed out';
      return err.message || 'Request failed';
  }
}
