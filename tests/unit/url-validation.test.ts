import { describe, expect, it } from 'vitest';
import {
  SsrfError,
  classifyHostname,
  classifyIp,
  expandIpv6,
  isPublicIp,
  parseIpv4,
  validateUrl,
  normalizeUrl,
  shouldCrawl,
  isDangerousPath,
  isSameSite,
  hasDownloadExtension,
} from '@qualovix/audit-engine';
import { getEnv } from '@qualovix/shared';

/**
 * URL validation and SSRF protection.
 *
 * This is the security-critical surface of the product: the audit engine
 * fetches URLs supplied by anonymous users on the public internet. A gap here
 * turns the scanner into a proxy for reaching internal infrastructure, so
 * these tests are deliberately adversarial rather than happy-path.
 */

const env = getEnv({ ...process.env, SSRF_ALLOWLIST: '' } as NodeJS.ProcessEnv);
const options = { env };

describe('parseIpv4', () => {
  it('parses dotted-quad addresses', () => {
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('127.0.0.1')).toBe(2130706433);
    expect(parseIpv4('255.255.255.255')).toBe(4294967295);
  });

  it('rejects octets out of range', () => {
    expect(parseIpv4('256.0.0.1')).toBeNull();
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
  });

  it('rejects leading zeros, which some resolvers read as octal', () => {
    // 0177.0.0.1 is 127.0.0.1 when interpreted as octal.
    expect(parseIpv4('0177.0.0.1')).toBeNull();
    expect(parseIpv4('010.0.0.1')).toBeNull();
  });
});

describe('classifyIp', () => {
  it('accepts genuinely public addresses', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
    expect(isPublicIp('93.184.216.34')).toBe(true);
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private-network'],
    ['10.255.255.255', 'private-network'],
    ['172.16.0.1', 'private-network'],
    ['172.31.255.255', 'private-network'],
    ['192.168.1.1', 'private-network'],
    ['169.254.169.254', 'cloud-metadata-endpoint'],
    ['169.254.1.1', 'link-local-or-cloud-metadata'],
    ['100.64.0.1', 'carrier-grade-nat'],
    ['0.0.0.0', 'this-network'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.2.1', 'documentation'],
  ])('blocks %s (%s)', (address, reason) => {
    const classification = classifyIp(address);
    expect(classification.safe).toBe(false);
    expect(classification.reason).toBe(reason);
  });

  it('blocks the boundary addresses of private ranges', () => {
    // 172.16.0.0/12 spans 172.16.x to 172.31.x; 172.32 is public.
    expect(isPublicIp('172.15.255.255')).toBe(true);
    expect(isPublicIp('172.16.0.0')).toBe(false);
    expect(isPublicIp('172.31.255.255')).toBe(false);
    expect(isPublicIp('172.32.0.0')).toBe(true);
  });

  it('blocks cloud metadata endpoints for every major provider', () => {
    for (const address of ['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192']) {
      expect(isPublicIp(address)).toBe(false);
    }
  });
});

describe('IPv6 classification', () => {
  it('expands compressed forms correctly', () => {
    expect(expandIpv6('::1')).toEqual([
      '0000', '0000', '0000', '0000', '0000', '0000', '0000', '0001',
    ]);
    expect(expandIpv6('2001:db8::1')?.[0]).toBe('2001');
    expect(expandIpv6('::')).toEqual(Array(8).fill('0000'));
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local-address'],
    ['fd12:3456::1', 'unique-local-address'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
  ])('blocks %s (%s)', (address, reason) => {
    const classification = classifyIp(address);
    expect(classification.safe).toBe(false);
    expect(classification.reason).toBe(reason);
  });

  it('blocks IPv4-mapped addresses that wrap a private address', () => {
    // ::ffff:127.0.0.1 is loopback wearing an IPv6 costume.
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:192.168.1.1')).toBe(false);
    expect(isPublicIp('::ffff:169.254.169.254')).toBe(false);
  });

  it('rejects malformed input rather than assuming it is safe', () => {
    expect(classifyIp('not-an-ip').safe).toBe(false);
    expect(classifyIp('::::::').safe).toBe(false);
    expect(classifyIp('').safe).toBe(false);
  });
});

describe('classifyHostname', () => {
  it('accepts ordinary public hostnames', () => {
    expect(classifyHostname('example.com').safe).toBe(true);
    expect(classifyHostname('www.example.co.uk').safe).toBe(true);
    expect(classifyHostname('sub.domain.example.org').safe).toBe(true);
  });

  it.each([
    ['localhost', 'blocked-hostname'],
    ['metadata.google.internal', 'blocked-hostname'],
    ['instance-data', 'blocked-hostname'],
    ['app.local', 'internal-dns-suffix'],
    ['db.internal', 'internal-dns-suffix'],
    ['service.svc.cluster.local', 'internal-dns-suffix'],
    ['host.corp', 'internal-dns-suffix'],
    ['intranet', 'non-fqdn-hostname'],
    ['fileserver', 'non-fqdn-hostname'],
  ])('blocks %s (%s)', (hostname, reason) => {
    const classification = classifyHostname(hostname);
    expect(classification.safe).toBe(false);
    expect(classification.reason).toBe(reason);
  });

  it('blocks numeric host encodings that decode to loopback', () => {
    // All of these are accepted as 127.0.0.1 by various HTTP clients.
    expect(classifyHostname('2130706433').reason).toBe('numeric-host-encoding');
    expect(classifyHostname('0x7f000001').reason).toBe('numeric-host-encoding');
    expect(classifyHostname('017700000001').reason).toBe('numeric-host-encoding');
  });
});

describe('validateUrl', () => {
  it('accepts public http and https URLs', () => {
    expect(validateUrl('https://example.com', options).hostname).toBe('example.com');
    expect(validateUrl('http://example.com/path', options).pathname).toBe('/path');
  });

  it('defaults a bare domain to https', () => {
    expect(validateUrl('example.com', options).protocol).toBe('https:');
  });

  it.each([
    ['file:///etc/passwd', 'protocol-not-allowed'],
    ['javascript:alert(1)', 'protocol-not-allowed'],
    ['data:text/html,<script>alert(1)</script>', 'protocol-not-allowed'],
    ['ftp://example.com', 'protocol-not-allowed'],
    ['gopher://example.com', 'protocol-not-allowed'],
    ['ws://example.com', 'protocol-not-allowed'],
  ])('rejects %s', (url, code) => {
    expect(() => validateUrl(url, options)).toThrow(SsrfError);
    try {
      validateUrl(url, options);
    } catch (error) {
      expect((error as SsrfError).code).toBe(code);
    }
  });

  it('rejects localhost and private addresses', () => {
    for (const url of [
      'http://localhost',
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://127.0.0.1:8080',
      'http://0.0.0.0',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://172.16.0.1',
      'http://[::1]',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(() => validateUrl(url, options), url).toThrow(SsrfError);
    }
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => validateUrl('https://user:pass@example.com', options)).toThrow(SsrfError);
    try {
      validateUrl('https://user:pass@example.com', options);
    } catch (error) {
      expect((error as SsrfError).code).toBe('credentials-in-url');
    }
  });

  it('rejects non-web ports, so the scanner cannot probe internal services', () => {
    for (const port of [22, 25, 3306, 5432, 6379, 9200, 11211, 27017]) {
      expect(() => validateUrl(`https://example.com:${port}`, options), String(port)).toThrow(
        SsrfError,
      );
    }
  });

  it('allows standard web ports', () => {
    for (const port of [80, 443, 5000, 8080, 8443, 3000, 4000, 6000, 8000]) {
      expect(() => validateUrl(`https://example.com:${port}`, options)).not.toThrow();
    }
  });

  it('rejects malformed and empty input', () => {
    expect(() => validateUrl('', options)).toThrow(SsrfError);
    expect(() => validateUrl('   ', options)).toThrow(SsrfError);
    expect(() => validateUrl('http://', options)).toThrow(SsrfError);
    expect(() => validateUrl(`https://example.com/${'a'.repeat(3000)}`, options)).toThrow(SsrfError);
  });

  it('produces user-facing messages that do not leak internal details', () => {
    try {
      validateUrl('http://192.168.1.50:8080/admin', options);
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as SsrfError).message;
      // The refusal must not confirm whether that host or port exists.
      expect(message).not.toContain('192.168.1.50');
      expect(message).toMatch(/private network/i);
    }
  });
});

describe('normalizeUrl', () => {
  it('collapses equivalent forms to one canonical URL', () => {
    const canonical = 'https://example.com/about';
    expect(normalizeUrl('https://example.com/about')).toBe(canonical);
    expect(normalizeUrl('https://example.com/about/')).toBe(canonical);
    expect(normalizeUrl('https://EXAMPLE.com/about')).toBe(canonical);
    expect(normalizeUrl('https://example.com:443/about')).toBe(canonical);
    expect(normalizeUrl('https://example.com/about#team')).toBe(canonical);
    expect(normalizeUrl('https://example.com//about')).toBe(canonical);
    expect(normalizeUrl('https://example.com/about?utm_source=twitter')).toBe(canonical);
  });

  it('sorts query parameters so ordering does not create duplicates', () => {
    expect(normalizeUrl('https://example.com/s?b=2&a=1')).toBe(
      normalizeUrl('https://example.com/s?a=1&b=2'),
    );
  });

  it('treats index files as the directory itself', () => {
    expect(normalizeUrl('https://example.com/docs/index.html')).toBe('https://example.com/docs');
    expect(normalizeUrl('https://example.com/index.php')).toBe('https://example.com/');
  });

  it('keeps meaningful query parameters', () => {
    expect(normalizeUrl('https://example.com/search?q=qa')).toContain('q=qa');
  });
});

describe('crawl eligibility', () => {
  const origin = 'https://example.com';
  const base = { origin, seen: new Set<string>(), depth: 1, maxDepth: 2 };

  it('crawls same-site links', () => {
    expect(shouldCrawl('/about', base).crawl).toBe(true);
    expect(shouldCrawl('https://example.com/pricing', base).crawl).toBe(true);
    expect(shouldCrawl('https://www.example.com/pricing', base).crawl).toBe(true);
  });

  it('does not crawl external domains', () => {
    expect(shouldCrawl('https://other.com/page', base).reason).toBe('external-domain');
  });

  it('does not follow mailto, tel or javascript links', () => {
    expect(shouldCrawl('mailto:hi@example.com', base).reason).toBe('non-crawlable-protocol');
    expect(shouldCrawl('tel:+441234567890', base).reason).toBe('non-crawlable-protocol');
    expect(shouldCrawl('javascript:void(0)', base).reason).toBe('non-crawlable-protocol');
  });

  it('does not download assets', () => {
    expect(shouldCrawl('/brochure.pdf', base).reason).toBe('download-asset');
    expect(shouldCrawl('/archive.zip', base).reason).toBe('download-asset');
    expect(shouldCrawl('/photo.jpg', base).reason).toBe('download-asset');
  });

  it('never follows destructive links', () => {
    // Visiting these would be destructive testing against a third party.
    for (const path of [
      '/logout',
      '/sign-out',
      '/account/delete',
      '/unsubscribe?token=abc',
      '/cancel-subscription',
      '/reset-password',
    ]) {
      expect(shouldCrawl(path, base).reason, path).toBe('dangerous-path');
    }
  });

  it('does not revisit a URL already seen', () => {
    const seen = new Set([normalizeUrl('https://example.com/about')]);
    expect(shouldCrawl('/about', { ...base, seen }).reason).toBe('already-seen');
  });

  it('respects the depth limit', () => {
    expect(shouldCrawl('/deep', { ...base, depth: 3, maxDepth: 2 }).reason).toBe('depth-exceeded');
  });
});

describe('helpers', () => {
  it('treats www and apex as the same site', () => {
    expect(isSameSite('https://example.com/a', 'https://www.example.com/b')).toBe(true);
    expect(isSameSite('https://example.com', 'https://other.com')).toBe(false);
  });

  it('identifies destructive paths regardless of case or query position', () => {
    expect(isDangerousPath('https://example.com/LOGOUT')).toBe(true);
    expect(isDangerousPath('https://example.com/account?action=delete-account')).toBe(true);
    expect(isDangerousPath('https://example.com/about')).toBe(false);
  });

  it('identifies downloadable extensions', () => {
    expect(hasDownloadExtension('/file.PDF')).toBe(true);
    expect(hasDownloadExtension('/style.css')).toBe(false);
  });
});
