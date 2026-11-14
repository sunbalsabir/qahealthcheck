/**
 * IP address classification for SSRF defence.
 *
 * The audit engine fetches URLs supplied by anonymous users on the public
 * internet. Every address it is about to connect to is classified here, and
 * anything that is not unambiguously public internet space is refused.
 *
 * Deliberately deny-by-default: an address we cannot parse is treated as
 * unsafe rather than assumed to be fine.
 */

export type IpVersion = 4 | 6;

export interface IpClassification {
  safe: boolean;
  /** Machine-readable reason, used in tests and logs. */
  reason: string;
  version?: IpVersion;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 ranges that must never be reached by the scanner. */
const BLOCKED_IPV4_RANGES: Array<{ cidr: string; reason: string }> = [
  { cidr: '0.0.0.0/8', reason: 'this-network' },
  { cidr: '10.0.0.0/8', reason: 'private-network' },
  { cidr: '100.64.0.0/10', reason: 'carrier-grade-nat' },
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '169.254.0.0/16', reason: 'link-local-or-cloud-metadata' },
  { cidr: '172.16.0.0/12', reason: 'private-network' },
  { cidr: '192.0.0.0/24', reason: 'ietf-protocol-assignments' },
  { cidr: '192.0.2.0/24', reason: 'documentation' },
  { cidr: '192.88.99.0/24', reason: 'ipv6-relay-anycast' },
  { cidr: '192.168.0.0/16', reason: 'private-network' },
  { cidr: '198.18.0.0/15', reason: 'benchmarking' },
  { cidr: '198.51.100.0/24', reason: 'documentation' },
  { cidr: '203.0.113.0/24', reason: 'documentation' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
  { cidr: '240.0.0.0/4', reason: 'reserved' },
  { cidr: '255.255.255.255/32', reason: 'broadcast' },
];

/**
 * Cloud metadata services. 169.254.169.254 is already covered by link-local,
 * but these are listed explicitly so the refusal message is accurate and so
 * providers using routable metadata addresses are still caught.
 */
const CLOUD_METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS / GCP / Azure / DigitalOcean / OpenStack
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  'fd00:ec2::254', // AWS IMDS over IPv6
]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** Hostname suffixes that indicate internal DNS rather than public internet. */
const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.corp',
  '.home',
  '.lan',
  '.private',
  '.test',
  '.example',
  '.invalid',
  '.localdomain',
  '.ec2.internal',
  '.compute.internal',
  '.svc.cluster.local',
  '.cluster.local',
  '.onion',
];

export function parseIpv4(address: string): number | null {
  const match = IPV4_PATTERN.exec(address);
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    // Reject leading zeros: "010.0.0.1" is parsed as octal by some resolvers.
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    if (match[i]!.length > 1 && match[i]!.startsWith('0')) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(ip: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseIp = parseIpv4(base!);
  const bits = Number(bitsRaw);
  if (baseIp === null || !Number.isInteger(bits)) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (baseIp & mask) >>> 0;
}

export function isIpv4(address: string): boolean {
  return parseIpv4(address) !== null;
}

export function isIpv6(address: string): boolean {
  const candidate = address.startsWith('[') ? address.slice(1, -1) : address;
  if (!candidate.includes(':')) return false;
  // Node's URL parser is the most reliable IPv6 validator available to us.
  try {
    const url = new URL(`http://[${candidate.replace(/%.*$/, '')}]`);
    return url.hostname.startsWith('[');
  } catch {
    return false;
  }
}

/** Expand an IPv6 address to its 8 full hextets. Returns null if malformed. */
export function expandIpv6(address: string): string[] | null {
  let value = address.startsWith('[') ? address.slice(1, -1) : address;
  value = value.replace(/%.*$/, '').toLowerCase();
  if (value === '::') return Array(8).fill('0000');

  // An IPv4-mapped tail (::ffff:192.168.0.1) must be converted first.
  const v4Tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (v4Tail) {
    const v4 = parseIpv4(v4Tail[1]!);
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16).padStart(4, '0');
    const low = (v4 & 0xffff).toString(16).padStart(4, '0');
    value = `${value.slice(0, v4Tail.index)}${high}:${low}`;
  }

  const doubleColonCount = (value.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (doubleColonCount === 1) {
    const [headRaw = '', tailRaw = ''] = value.split('::');
    head = headRaw ? headRaw.split(':') : [];
    tail = tailRaw ? tailRaw.split(':') : [];
    if (head.length + tail.length > 7) return null;
  } else {
    head = value.split(':');
    tail = [];
    if (head.length !== 8) return null;
  }

  const fill = Array(8 - head.length - tail.length).fill('0000');
  const hextets = [...head, ...fill, ...tail];
  if (hextets.length !== 8) return null;
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
  }
  return hextets.map((h) => h.padStart(4, '0'));
}

function classifyIpv6(address: string): IpClassification {
  const hextets = expandIpv6(address);
  if (!hextets) return { safe: false, reason: 'malformed-ipv6', version: 6 };
  const normalized = hextets.join(':');
  const first = parseInt(hextets[0]!, 16);

  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return { safe: false, reason: 'loopback', version: 6 };
  }
  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return { safe: false, reason: 'unspecified', version: 6 };
  }
  // IPv4-mapped / IPv4-compatible: re-classify against the IPv4 rules so
  // ::ffff:127.0.0.1 cannot slip past the loopback check.
  if (hextets.slice(0, 5).every((h) => h === '0000')) {
    const mapped = hextets[5] === 'ffff' || hextets[5] === '0000';
    if (mapped) {
      const v4 =
        ((parseInt(hextets[6]!, 16) << 16) | parseInt(hextets[7]!, 16)) >>> 0;
      const dotted = [24, 16, 8, 0].map((s) => (v4 >>> s) & 0xff).join('.');
      const inner = classifyIpv4(dotted);
      if (!inner.safe) return { ...inner, version: 6 };
    }
  }
  if ((first & 0xfe00) === 0xfc00) {
    return { safe: false, reason: 'unique-local-address', version: 6 };
  }
  if ((first & 0xffc0) === 0xfe80) {
    return { safe: false, reason: 'link-local', version: 6 };
  }
  if ((first & 0xff00) === 0xff00) {
    return { safe: false, reason: 'multicast', version: 6 };
  }
  if (hextets[0] === '2001' && hextets[1]!.startsWith('0d')) {
    return { safe: false, reason: 'documentation', version: 6 };
  }
  if (hextets[0] === '0064' && hextets[1] === 'ff9b') {
    return { safe: false, reason: 'nat64-translation', version: 6 };
  }
  if (CLOUD_METADATA_ADDRESSES.has(compressIpv6(hextets))) {
    return { safe: false, reason: 'cloud-metadata-endpoint', version: 6 };
  }
  return { safe: true, reason: 'public', version: 6 };
}

/** Minimal IPv6 compression, used only for metadata-address comparison. */
function compressIpv6(hextets: string[]): string {
  return hextets
    .map((h) => h.replace(/^0+(?=.)/, ''))
    .join(':')
    .replace(/\b(?:0:){2,}0\b/, ':')
    .replace(/^:(?!:)/, '::')
    .replace(/(?<!:):$/, '::');
}

export function classifyIpv4(address: string): IpClassification {
  const ip = parseIpv4(address);
  if (ip === null) return { safe: false, reason: 'malformed-ipv4', version: 4 };
  if (CLOUD_METADATA_ADDRESSES.has(address)) {
    return { safe: false, reason: 'cloud-metadata-endpoint', version: 4 };
  }
  for (const range of BLOCKED_IPV4_RANGES) {
    if (ipv4InCidr(ip, range.cidr)) {
      return { safe: false, reason: range.reason, version: 4 };
    }
  }
  return { safe: true, reason: 'public', version: 4 };
}

/** Classify any IP literal. Unparseable input is refused. */
export function classifyIp(address: string): IpClassification {
  const value = address.trim().replace(/^\[|\]$/g, '');
  if (isIpv4(value)) return classifyIpv4(value);
  if (value.includes(':')) return classifyIpv6(value);
  return { safe: false, reason: 'not-an-ip-address' };
}

export function isPublicIp(address: string): boolean {
  return classifyIp(address).safe;
}

/**
 * Hostname-level screening, applied before DNS resolution so obviously
 * internal names are rejected without generating a lookup at all.
 */
export function classifyHostname(hostname: string): IpClassification {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return { safe: false, reason: 'empty-hostname' };
  if (BLOCKED_HOSTNAMES.has(host)) return { safe: false, reason: 'blocked-hostname' };
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host.endsWith(suffix)) return { safe: false, reason: 'internal-dns-suffix' };
  }
  // Decimal, octal and hex integer forms of an IPv4 address ("2130706433",
  // "0x7f000001") are accepted by many HTTP clients as 127.0.0.1. Checked
  // before the FQDN rule so these report their specific reason rather than
  // being lumped in with bare single-label names.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^0[0-7]+$/.test(host)) {
    return { safe: false, reason: 'numeric-host-encoding' };
  }

  // A bare single-label name ("intranet", "fileserver") resolves through
  // internal search domains and is never a public website.
  if (!host.includes('.')) return { safe: false, reason: 'non-fqdn-hostname' };
  if (isIpv4(host)) return classifyIpv4(host);
  if (host.includes(':')) return classifyIpv6(host);
  return { safe: true, reason: 'hostname-ok' };
}

export const __testing = {
  BLOCKED_IPV4_RANGES,
  CLOUD_METADATA_ADDRESSES,
  BLOCKED_HOSTNAMES,
  BLOCKED_HOSTNAME_SUFFIXES,
};
