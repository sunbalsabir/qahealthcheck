import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';

/**
 * Database seed.
 *
 * Creates the bootstrap admin account from ADMIN_EMAIL / ADMIN_PASSWORD.
 * Idempotent: re-running it will not reset an existing password, so it is
 * safe to run on every deploy.
 *
 * The hashing here must stay in step with apps/web/src/lib/auth.ts.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const email = (process.env.ADMIN_EMAIL ?? 'qa@qualovix.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? 'qualovix-admin';

  if (password === 'qualovix-admin' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed the default admin password in production. Set ADMIN_PASSWORD to a strong value.',
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin user already exists: ${email} (password unchanged)`);
    await prisma.$disconnect();
    return;
  }

  await prisma.user.create({
    data: {
      email,
      name: 'Qualovix Admin',
      passwordHash: await hashPassword(password),
      role: 'ADMIN',
    },
  });

  console.log(`Created admin user: ${email}`);
  console.log('Sign in at http://localhost:5000/admin/login');
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
