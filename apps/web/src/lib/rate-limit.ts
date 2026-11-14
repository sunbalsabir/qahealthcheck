import { createHash } from 'node:crypto';
import { getEnv } from '@qualovix/shared';
import { getRepository } from '@qualovix/data';

/**
 * Abuse prevention for the public audit endpoint.
 *
 * The spec is explicit that IP alone is not enough, because offices, schools
 * and mobile carriers share addresses. Four independent limits apply, and a
 * request must pass all of them:
 *
 *   per IP        — the blunt instrument, generous enough for shared networks
 *   per domain    — stops one target being scanned repeatedly from many IPs,
 *                   which is the shape of using this tool to harass a site
 *   per email     — ties the limit to an identity when one is supplied
 *   global        — a whole-service ceiling, so a distributed flood still
 *                   cannot consume every browser worker
 *
 * Counters live in the repository, so they survive a restart on the Prisma
 * driver rather than resetting the moment the process recycles.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface RateLimitDecision {
  allowed: boolean;
  reason?: string;
  /** Which limit was hit, for logging and tests. */
  scope?: 'ip' | 'domain' | 'email' | 'global';
  retryAfterSeconds?: number;
}

export interface RateLimitInput {
  ip: string;
  domain: string;
  email?: string;
}

export async function checkRateLimits(input: RateLimitInput): Promise<RateLimitDecision> {
  const env = getEnv();
  const repository = await getRepository();

  // --- global ceiling ---
  if (env.RATE_LIMIT_GLOBAL_PER_HOUR > 0) {
    const count = await repository.incrementRateLimit('global', 'all', HOUR_MS);
    if (count > env.RATE_LIMIT_GLOBAL_PER_HOUR) {
      return {
        allowed: false,
        scope: 'global',
        reason:
          'We are processing an unusually high number of audits right now. Please try again in a little while.',
        retryAfterSeconds: secondsUntilNextWindow(HOUR_MS),
      };
    }
  }

  // --- per IP ---
  if (env.RATE_LIMIT_PER_IP_PER_DAY > 0) {
    const key = hashKey(input.ip);
    const count = await repository.incrementRateLimit('ip', key, DAY_MS);
    if (count > env.RATE_LIMIT_PER_IP_PER_DAY) {
      return {
        allowed: false,
        scope: 'ip',
        reason: `Free audits are limited to ${env.RATE_LIMIT_PER_IP_PER_DAY} per day. Get in touch with Qualovix if you need a deeper assessment.`,
        retryAfterSeconds: secondsUntilNextWindow(DAY_MS),
      };
    }
  }

  // --- per target domain ---
  if (env.RATE_LIMIT_PER_DOMAIN_PER_DAY > 0) {
    const count = await repository.incrementRateLimit('domain', input.domain, DAY_MS);
    if (count > env.RATE_LIMIT_PER_DOMAIN_PER_DAY) {
      return {
        allowed: false,
        scope: 'domain',
        reason: `This website has already been audited ${env.RATE_LIMIT_PER_DOMAIN_PER_DAY} times today. Please try again tomorrow.`,
        retryAfterSeconds: secondsUntilNextWindow(DAY_MS),
      };
    }
  }

  // --- per email ---
  if (input.email && env.RATE_LIMIT_PER_EMAIL_PER_DAY > 0) {
    const key = hashKey(input.email.toLowerCase());
    const count = await repository.incrementRateLimit('email', key, DAY_MS);
    if (count > env.RATE_LIMIT_PER_EMAIL_PER_DAY) {
      return {
        allowed: false,
        scope: 'email',
        reason: `Free audits are limited to ${env.RATE_LIMIT_PER_EMAIL_PER_DAY} per day per email address.`,
        retryAfterSeconds: secondsUntilNextWindow(DAY_MS),
      };
    }
  }

  return { allowed: true };
}

/**
 * IPs and email addresses are personal data. Hashing them means the rate
 * limiter keeps working without the counters table becoming a list of who
 * visited the site.
 */
function hashKey(value: string): string {
  const env = getEnv();
  return createHash('sha256').update(`${env.AUTH_SECRET}:${value}`).digest('hex').slice(0, 32);
}

function secondsUntilNextWindow(windowMs: number): number {
  const now = Date.now();
  return Math.ceil((Math.ceil(now / windowMs) * windowMs - now) / 1000);
}

/**
 * Best-effort client IP. Trusts the first entry of X-Forwarded-For, which is
 * correct behind a single reverse proxy (Vercel, Fly, Nginx). If the app is
 * ever deployed without a proxy in front, this falls back to a constant,
 * which makes the per-IP limit behave like a global one rather than failing
 * open per request.
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return (
    headers.get('x-real-ip') ??
    headers.get('cf-connecting-ip') ??
    headers.get('x-vercel-forwarded-for') ??
    'unknown'
  );
}
