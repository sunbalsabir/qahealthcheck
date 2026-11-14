import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { getEnv } from '@qualovix/shared';
import { getRepository, type UserRecord } from '@qualovix/data';

/**
 * Admin authentication.
 *
 * Deliberately small: a scrypt password hash plus a signed, httpOnly session
 * cookie. The admin area is used by three people at one agency, so a full
 * identity provider would be more surface area than the problem needs — and
 * more surface area is the thing an auditing product can least afford.
 *
 * Properties that matter:
 *  - Passwords are never stored or compared in plaintext (scrypt + per-user salt).
 *  - Verification is constant-time, so timing cannot reveal a valid email.
 *  - The session cookie is httpOnly, SameSite=Lax and Secure in production,
 *    so page scripts cannot read it and it does not ride cross-site requests.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SESSION_COOKIE = 'qualovix_session';
const KEY_LENGTH = 64;

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  role: 'ADMIN' | 'QA_ENGINEER';
}

// --- password hashing -------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(password, salt, expected.length);
    // Constant-time: a length mismatch is handled without an early return
    // that would leak information through timing.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// --- sessions ---------------------------------------------------------------

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().AUTH_SECRET);
}

export async function createSession(user: SessionUser): Promise<string> {
  const env = getEnv();
  const expires = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000);

  const token = await new SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name ?? undefined,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('qualovix-qa-auditor')
    .setAudience('qualovix-admin')
    .setExpirationTime(expires)
    .sign(secretKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires,
  });

  return token;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: 'qualovix-qa-auditor',
      audience: 'qualovix-admin',
    });
    if (!payload.sub || typeof payload.email !== 'string') return null;
    return {
      id: payload.sub,
      email: payload.email,
      name: typeof payload.name === 'string' ? payload.name : null,
      role: payload.role === 'ADMIN' ? 'ADMIN' : 'QA_ENGINEER',
    };
  } catch {
    // Expired or tampered token — treat as signed out.
    return null;
  }
}

/** Throws if there is no valid session. Used to gate admin API routes. */
export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Authentication required.');
    this.name = 'UnauthorizedError';
  }
}

// --- credential check -------------------------------------------------------

export async function authenticate(email: string, password: string): Promise<SessionUser | null> {
  const repository = await getRepository();
  await ensureBootstrapAdmin();

  const user = await repository.findUserByEmail(email.trim().toLowerCase());
  if (!user) {
    // Run a hash anyway so a missing account and a wrong password take
    // comparable time, and the response cannot be used to enumerate emails.
    await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==');
    return null;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

let bootstrapPromise: Promise<UserRecord> | null = null;

/**
 * Creates the admin account from ADMIN_EMAIL / ADMIN_PASSWORD on first use.
 * Idempotent, and a no-op once the account exists — changing the env var
 * later does not reset an existing password.
 */
export async function ensureBootstrapAdmin(): Promise<UserRecord> {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const env = getEnv();
    const repository = await getRepository();
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
    return repository.ensureAdminUser(env.ADMIN_EMAIL.toLowerCase(), passwordHash);
  })();

  return bootstrapPromise;
}
