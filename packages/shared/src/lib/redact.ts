/**
 * Evidence redaction.
 *
 * Console messages, network URLs and response headers routinely contain
 * tokens, session cookies and personal data. Everything that reaches a
 * finding's evidence — and therefore a client-facing report — passes through
 * here first. The product principle is explicit: never expose credentials or
 * sensitive information.
 */

const REDACTED = '[redacted]';

/** Header names whose values are never reproduced. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'api-key',
  'auth-token',
  'session',
  'x-session-token',
  'x-access-token',
  'x-refresh-token',
]);

/** Object keys whose values are never reproduced. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[-_]?key|auth|credential|session[-_]?id|private[-_]?key|bearer|signature|otp|pin|ssn|credit[-_]?card|card[-_]?number|cvv)/i;

/** Query-string parameters stripped from any URL we echo back. */
const SENSITIVE_QUERY_PARAMS = [
  'token', 'access_token', 'refresh_token', 'id_token', 'auth', 'authorization',
  'key', 'api_key', 'apikey', 'secret', 'client_secret', 'password', 'passwd',
  'pwd', 'session', 'sessionid', 'sid', 'code', 'signature', 'sig', 'email',
];

/** Value patterns redacted wherever they appear in free text. */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[redacted-jwt]'],
  // Bearer tokens
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, 'Bearer [redacted]'],
  // Common provider key shapes
  [/\b(sk|pk|rk|ak)[-_](live|test|prod)?[-_]?[A-Za-z0-9]{16,}\b/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted-github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted-slack-token]'],
  // key=value / "key": "value" pairs carrying a sensitive name
  [
    /((?:pass(?:word|wd)?|secret|token|api[-_]?key|auth|credential|bearer)["'\s]*[:=]["'\s]*)([^\s",;&}]{4,})/gi,
    `$1${REDACTED}`,
  ],
  // Email addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  // Long digit runs (card / account numbers)
  [/\b\d{13,19}\b/g, '[redacted-number]'],
];

/** Redact secrets from an arbitrary string. */
export function redactText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Strip credentials and sensitive query parameters from a URL. */
export function redactUrl(input: string): string {
  try {
    const u = new URL(input);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const param of SENSITIVE_QUERY_PARAMS) {
      if (u.searchParams.has(param)) u.searchParams.set(param, REDACTED);
    }
    // Fragments can carry implicit-flow tokens.
    if (/(^|[&#])(access_token|id_token|token)=/.test(u.hash)) u.hash = '#[redacted]';
    return u.toString();
  } catch {
    return redactText(input);
  }
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

/** Redact a header map, dropping the values of sensitive headers entirely. */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? REDACTED : redactText(value);
  }
  return out;
}

/**
 * Deep-redact an arbitrary value. Sensitive keys lose their value outright;
 * every remaining string is scrubbed for secret-shaped substrings.
 */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === 'string') {
    return (looksLikeUrl(value) ? redactUrl(value) : redactText(value)) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        SENSITIVE_KEY_PATTERN.test(key) || isSensitiveHeader(key)
          ? REDACTED
          : redactValue(val, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Clamp a string so one runaway console message cannot bloat a report. */
export function truncate(input: string, max = 500): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}… (${input.length - max} more characters)`;
}

/** The standard treatment for anything going into `Finding.evidence`. */
export function sanitizeEvidenceText(input: string, max = 500): string {
  return truncate(redactText(input).trim(), max);
}
