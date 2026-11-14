import { SECURITY_CATEGORY_LABEL, pluralize, type ScannerResult } from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { ScanContext, Scanner, TransportObservation } from '../types';

/**
 * Security baseline scanner.
 *
 * PASSIVE OBSERVATION ONLY. This scanner reads response headers and transport
 * behaviour that the crawler already observed during a normal page load. It
 * performs no active testing whatsoever:
 *
 *   no brute force, no credential testing, no injection attempts,
 *   no authentication bypass, no fuzzing, no vulnerability scanning,
 *   no denial-of-service, no destructive requests.
 *
 * Reported under the label "Security Baseline - Not a Penetration Test". The
 * absence of a finding here says nothing about the application's real
 * security posture, and every finding says so.
 */

const NOT_A_PENTEST =
  'This is a passive header and transport observation, not a penetration test. A missing header is a hardening gap, not a confirmed vulnerability.';

interface HeaderCheck {
  header: string;
  ruleId: string;
  title: string;
  description: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  recommendation: string;
  impact: string;
  example: string;
}

const HEADER_CHECKS: HeaderCheck[] = [
  {
    header: 'strict-transport-security',
    ruleId: 'security.missing-hsts',
    title: 'HSTS header is not set',
    description:
      'The site does not send Strict-Transport-Security. Without it, a visitor\'s first request over plain HTTP can be intercepted and downgraded before the redirect to HTTPS takes effect.',
    severity: 'MEDIUM',
    recommendation:
      'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Start with a shorter max-age while verifying every subdomain serves HTTPS correctly.',
    impact: 'Leaves a window for an active network attacker to downgrade the first connection.',
    example: 'Strict-Transport-Security: max-age=31536000; includeSubDomains',
  },
  {
    header: 'content-security-policy',
    ruleId: 'security.missing-csp',
    title: 'No Content-Security-Policy header',
    description:
      'No Content-Security-Policy was returned. CSP is the main defence-in-depth control against cross-site scripting: it restricts which script, style and frame sources the browser will execute.',
    severity: 'MEDIUM',
    recommendation:
      'Introduce a CSP, starting in Report-Only mode to find violations without breaking the site, then enforce it. A nonce- or hash-based script-src is the meaningful part.',
    impact:
      'If an XSS flaw exists anywhere in the application, there is no second layer to limit what injected script can do.',
    example: "Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-…'",
  },
  {
    header: 'x-content-type-options',
    ruleId: 'security.missing-content-type-options',
    title: 'X-Content-Type-Options is not set',
    description:
      'Without `X-Content-Type-Options: nosniff`, browsers may ignore the declared Content-Type and infer it from the response body, which can turn an uploaded file into executable script.',
    severity: 'LOW',
    recommendation: 'Add `X-Content-Type-Options: nosniff` to all responses.',
    impact: 'MIME-type confusion can turn user-supplied content into executable script.',
    example: 'X-Content-Type-Options: nosniff',
  },
  {
    header: 'x-frame-options',
    ruleId: 'security.missing-frame-protection',
    title: 'No clickjacking protection',
    description:
      'Neither X-Frame-Options nor a CSP frame-ancestors directive was found, so the site can be embedded in an iframe on any origin. That is the setup for a clickjacking attack.',
    severity: 'MEDIUM',
    recommendation:
      "Add `X-Frame-Options: SAMEORIGIN`, or the modern equivalent `Content-Security-Policy: frame-ancestors 'self'`.",
    impact:
      'The site can be framed by a malicious page that overlays it to trick users into clicking hidden controls.',
    example: "Content-Security-Policy: frame-ancestors 'self'",
  },
  {
    header: 'referrer-policy',
    ruleId: 'security.missing-referrer-policy',
    title: 'Referrer-Policy is not set',
    description:
      'No Referrer-Policy header was returned. The browser default may send the full URL — including any path or query parameters — to third-party sites when a visitor follows an outbound link.',
    severity: 'LOW',
    recommendation: 'Add `Referrer-Policy: strict-origin-when-cross-origin`.',
    impact: 'Internal URLs and any identifiers in them can leak to third parties.',
    example: 'Referrer-Policy: strict-origin-when-cross-origin',
  },
  {
    header: 'permissions-policy',
    ruleId: 'security.missing-permissions-policy',
    title: 'Permissions-Policy is not set',
    description:
      'No Permissions-Policy was returned. This header lets a site explicitly disable powerful browser features (camera, microphone, geolocation) for itself and any embedded frames.',
    severity: 'INFO',
    recommendation:
      'Add a Permissions-Policy disabling features the site does not use, for example `Permissions-Policy: camera=(), microphone=(), geolocation=()`.',
    impact: 'Embedded third-party content could request device permissions on the site\'s behalf.',
    example: 'Permissions-Policy: camera=(), microphone=(), geolocation=()',
  },
];

/** Headers that disclose stack details useful to an attacker during recon. */
const DISCLOSURE_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'];

export const securityScanner: Scanner = {
  id: 'security',
  name: SECURITY_CATEGORY_LABEL,
  category: 'SECURITY',
  description:
    'Passive transport and response-header observations. No active testing of any kind is performed.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('security', 'SECURITY');
    const { transport, pages } = context.crawl;
    const headers = transport.securityHeaders;

    // --- HTTPS availability ---
    if (!transport.httpsAvailable) {
      collector.add({
        ruleId: 'security.no-https',
        title: 'Site is not available over HTTPS',
        description: `The site could not be reached over HTTPS. All traffic — including anything typed into a form — travels in plain text and can be read or modified by anyone on the network path. Browsers mark such sites as "Not secure". ${NOT_A_PENTEST}`,
        severity: 'CRITICAL',
        confidence: 'HIGH',
        url: context.crawl.origin,
        evidence: {
          summary: `HTTPS request to the origin failed: ${transport.httpsError ?? 'no secure response'}.`,
          observed: transport.httpsError ?? 'https:// request did not complete',
          expected: 'The site serves content over HTTPS with a valid certificate.',
        },
        recommendation:
          'Obtain a TLS certificate (Let\'s Encrypt issues them free) and serve the entire site over HTTPS.',
        impact:
          'All data in transit is readable and modifiable in transit, and browsers actively warn visitors away.',
      });
    } else {
      collector.pass(
        'security.https-available',
        'Site is served over HTTPS',
        'A valid HTTPS response was received from the origin.',
      );

      // --- HTTP -> HTTPS redirect ---
      if (transport.httpProbeOutcome === 'inconclusive') {
        // We learned nothing, so we say nothing. A finding here would have no
        // evidence behind it.
        collector.warn(
          `The plain-HTTP redirect could not be checked: ${transport.httpProbeError ?? 'the probe did not complete'}.`,
        );
      } else if (transport.httpProbeOutcome === 'not-served') {
        collector.pass(
          'security.https-redirect',
          'Plain HTTP is not served',
          'Nothing is listening on port 80, so there is no unencrypted path to the site.',
        );
      } else if (transport.httpProbeOutcome === 'no-redirect') {
        collector.add({
          ruleId: 'security.no-https-redirect',
          title: 'HTTP does not redirect to HTTPS',
          description: `HTTPS works, but a plain http:// request is not redirected to it${transport.httpRedirectTarget ? ` (it resolved to ${transport.httpRedirectTarget})` : ''}. Visitors who type the bare domain, or follow an old link, stay on an unencrypted connection. ${NOT_A_PENTEST}`,
          severity: 'HIGH',
          confidence: 'HIGH',
          url: context.crawl.origin,
          evidence: {
            summary: 'An http:// request to the origin did not redirect to https://.',
            observed: transport.httpRedirectTarget
              ? `http:// resolved to ${transport.httpRedirectTarget}`
              : (transport.httpProbeError ?? 'no redirect to https observed'),
            expected: '301 redirect from http:// to the https:// equivalent.',
          },
          recommendation:
            'Add a permanent (301) redirect from HTTP to HTTPS at the web server or CDN, then enable HSTS.',
          impact: 'Visitors can browse the entire site over an unencrypted connection without noticing.',
        });
      } else {
        collector.pass(
          'security.https-redirect',
          'HTTP redirects to HTTPS',
          'Plain HTTP requests are redirected to the secure equivalent.',
        );
      }
    }

    // --- TLS certificate problems observed during the crawl ---
    if (transport.tlsCertificateError) {
      collector.add({
        ruleId: 'security.tls-certificate-problem',
        title: 'TLS certificate problem detected',
        description: `The browser reported a certificate problem when connecting over HTTPS. Visitors will see a full-page security interstitial before they can reach the site. ${NOT_A_PENTEST}`,
        severity: 'CRITICAL',
        confidence: 'HIGH',
        url: context.crawl.origin,
        evidence: {
          summary: 'A TLS certificate error was raised during the HTTPS handshake.',
          observed: transport.tlsCertificateError,
          expected: 'A valid, unexpired certificate matching the hostname, from a trusted CA.',
        },
        recommendation:
          'Renew or reissue the certificate, confirm it covers every hostname in use, and check the intermediate chain is served.',
        impact: 'Browsers show a security warning, and most visitors will not proceed past it.',
      });
    }

    // --- Security headers ---
    if (transport.httpsAvailable && Object.keys(headers).length === 0) {
      collector.warn('No response headers were captured, so header checks were skipped.');
    } else {
      const csp = headers['content-security-policy'];
      for (const check of HEADER_CHECKS) {
        const value = headers[check.header];

        // frame-ancestors in CSP supersedes X-Frame-Options.
        if (check.header === 'x-frame-options' && csp?.includes('frame-ancestors')) {
          collector.pass(
            'security.frame-protection',
            'Clickjacking protection is configured',
            'A CSP frame-ancestors directive restricts who can frame the site.',
          );
          continue;
        }

        if (value) {
          collector.pass(
            check.ruleId.replace('missing-', ''),
            `${headerLabel(check.header)} is configured`,
            `Observed: ${truncateHeader(value)}`,
          );
          continue;
        }

        collector.add({
          ruleId: check.ruleId,
          title: check.title,
          description: `${check.description} ${NOT_A_PENTEST}`,
          severity: check.severity,
          confidence: 'HIGH',
          url: context.crawl.origin,
          evidence: {
            summary: `The ${headerLabel(check.header)} response header was not present on the origin response.`,
            observed: `(header absent)`,
            expected: check.example,
            details: {
              headersObserved: Object.keys(headers).filter((h) => !h.startsWith('x-cache')).slice(0, 25),
            },
          },
          recommendation: check.recommendation,
          impact: check.impact,
        });
      }

      // --- A CSP that permits unsafe-inline defeats most of its purpose ---
      if (csp && /unsafe-inline/.test(csp) && /script-src|default-src/.test(csp)) {
        collector.add({
          ruleId: 'security.weak-csp',
          title: "Content-Security-Policy allows 'unsafe-inline' scripts",
          description: `A CSP is present but permits 'unsafe-inline' for scripts, which allows exactly the inline injection CSP exists to block. ${NOT_A_PENTEST}`,
          severity: 'LOW',
          confidence: 'HIGH',
          url: context.crawl.origin,
          evidence: {
            summary: "The Content-Security-Policy header includes 'unsafe-inline' in a script directive.",
            observed: truncateHeader(csp),
            expected: "script-src using a nonce or hash instead of 'unsafe-inline'.",
          },
          recommendation:
            "Replace 'unsafe-inline' with a per-request nonce or a hash allowlist for the inline scripts you genuinely need.",
          impact: 'The policy provides much weaker protection against injected script than it appears to.',
        });
      }
    }

    // --- Cookie flags ---
    const firstPartyCookies = transport.cookies.filter((c) => c.firstParty);
    const insecureCookies = firstPartyCookies.filter((c) => !c.secure);
    const nonHttpOnly = firstPartyCookies.filter((c) => !c.httpOnly);
    const noSameSite = firstPartyCookies.filter((c) => !c.sameSite);

    if (insecureCookies.length > 0 && transport.httpsAvailable) {
      collector.add({
        ruleId: 'security.cookie-missing-secure',
        title: `${insecureCookies.length} ${pluralize(insecureCookies.length, 'cookie')} set without the Secure flag`,
        description: `${insecureCookies.length} first-party ${pluralize(insecureCookies.length, 'cookie is', 'cookies are')} set without the Secure attribute on an HTTPS site, so the browser will also send them over plain HTTP. ${NOT_A_PENTEST}`,
        severity: 'MEDIUM',
        confidence: 'HIGH',
        url: context.crawl.origin,
        evidence: {
          summary: `${insecureCookies.length} cookies observed without Secure. Cookie values were not recorded.`,
          observed: insecureCookies.map((c) => `${c.name} (Secure: no)`).join('\n'),
          expected: 'All cookies on an HTTPS site carry the Secure attribute.',
        },
        recommendation: 'Set the Secure attribute on every cookie.',
        impact: 'Cookies can be transmitted unencrypted if any request falls back to HTTP.',
        occurrences: insecureCookies.length,
      });
    }

    if (nonHttpOnly.length > 0) {
      collector.add({
        ruleId: 'security.cookie-missing-httponly',
        title: `${nonHttpOnly.length} ${pluralize(nonHttpOnly.length, 'cookie is', 'cookies are')} readable by JavaScript`,
        description: `${nonHttpOnly.length} first-party ${pluralize(nonHttpOnly.length, 'cookie')} lack the HttpOnly attribute, so page scripts can read them. For session cookies this turns any XSS flaw into full session theft. Cookies that client-side code legitimately needs are a valid exception. ${NOT_A_PENTEST}`,
        severity: 'LOW',
        confidence: 'MEDIUM',
        url: context.crawl.origin,
        evidence: {
          summary: `${nonHttpOnly.length} cookies observed without HttpOnly. Cookie values were not recorded.`,
          observed: nonHttpOnly.map((c) => `${c.name} (HttpOnly: no)`).join('\n'),
          expected: 'Session and authentication cookies carry HttpOnly.',
        },
        recommendation:
          'Set HttpOnly on any cookie that client-side JavaScript does not need to read, especially session cookies.',
        impact: 'An XSS flaw anywhere on the site could read these cookies.',
        occurrences: nonHttpOnly.length,
      });
    }

    if (noSameSite.length > 0) {
      collector.add({
        ruleId: 'security.cookie-missing-samesite',
        title: `${noSameSite.length} ${pluralize(noSameSite.length, 'cookie has', 'cookies have')} no SameSite attribute`,
        description: `${noSameSite.length} ${pluralize(noSameSite.length, 'cookie')} do not declare SameSite. Browsers default to Lax, but stating it explicitly is clearer and avoids relying on differing browser defaults. ${NOT_A_PENTEST}`,
        severity: 'INFO',
        confidence: 'MEDIUM',
        url: context.crawl.origin,
        evidence: {
          summary: `${noSameSite.length} cookies observed with no SameSite attribute.`,
          observed: noSameSite.map((c) => c.name).join(', '),
          expected: 'SameSite=Lax or SameSite=Strict declared explicitly.',
        },
        recommendation: 'Declare SameSite explicitly on every cookie.',
        impact: 'Cross-site request behaviour depends on browser defaults rather than your intent.',
        occurrences: noSameSite.length,
      });
    }

    if (firstPartyCookies.length > 0 && insecureCookies.length === 0 && nonHttpOnly.length === 0) {
      collector.pass(
        'security.cookie-flags',
        'Cookies carry Secure and HttpOnly flags',
        `${firstPartyCookies.length} first-party ${pluralize(firstPartyCookies.length, 'cookie')} observed, all correctly flagged.`,
      );
    }

    // --- Version disclosure ---
    const disclosed = DISCLOSURE_HEADERS.filter((h) => headers[h] && /\d/.test(headers[h]!));
    if (disclosed.length > 0) {
      collector.add({
        ruleId: 'security.version-disclosure',
        title: 'Server software versions are disclosed in response headers',
        description: `Response headers reveal specific software versions. This is not itself a vulnerability, but it lets an attacker match the exact stack against known CVEs without probing. ${NOT_A_PENTEST}`,
        severity: 'INFO',
        confidence: 'HIGH',
        url: context.crawl.origin,
        evidence: {
          summary: `${disclosed.length} response ${pluralize(disclosed.length, 'header')} disclose version information.`,
          observed: disclosed.map((h) => `${h}: ${headers[h]}`).join('\n'),
          expected: 'Version details suppressed or genericised.',
        },
        recommendation:
          'Suppress or genericise these headers at the web server, framework or CDN layer.',
        impact: 'Makes reconnaissance easier by confirming the exact stack in use.',
      });
    }

    // --- Mixed content ---
    const mixedContent = pages.flatMap((page) =>
      page.url.startsWith('https:')
        ? page.network.filter((r) => r.url.startsWith('http://'))
        : [],
    );
    if (mixedContent.length > 0) {
      collector.add({
        ruleId: 'security.mixed-content',
        title: `${mixedContent.length} ${pluralize(mixedContent.length, 'resource is', 'resources are')} loaded over plain HTTP`,
        description: `HTTPS pages request ${mixedContent.length} ${pluralize(mixedContent.length, 'resource')} over http://. Browsers block active mixed content outright and may show a degraded security indicator. ${NOT_A_PENTEST}`,
        severity: 'MEDIUM',
        confidence: 'HIGH',
        url: mixedContent[0]?.url,
        evidence: {
          summary: `${mixedContent.length} http:// subresource requests observed from https:// pages.`,
          observed: mixedContent.slice(0, 6).map((r) => `${r.resourceType}: ${r.url}`).join('\n'),
          expected: 'Every subresource on an HTTPS page is requested over HTTPS.',
        },
        recommendation:
          'Update the URLs to https:// or use protocol-relative paths. Add `upgrade-insecure-requests` to the CSP as a stopgap.',
        impact: 'Blocked resources break functionality, and the connection is no longer fully secure.',
        occurrences: mixedContent.length,
      });
    }

    return collector.result();
  },
};

function headerLabel(header: string): string {
  return header
    .split('-')
    .map((part) => (part.length <= 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join('-');
}

function truncateHeader(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

export type { TransportObservation };
