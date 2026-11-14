import { getEnv, type AppEnv } from '@qualovix/shared';
import type { AuditRepository } from './repository/types';
import { MemoryAuditRepository } from './repository/memory-repository';

/**
 * Data layer entry point.
 *
 * `getRepository()` returns the repository for the configured persistence
 * driver. The Prisma implementation is imported dynamically so
 * `@prisma/client` — which requires a generated client and a reachable
 * database — is never loaded when running on the in-memory driver. That is
 * what lets the app boot with no database at all.
 */

/**
 * The singleton is kept on globalThis rather than in module scope.
 *
 * Next.js bundles route handlers and page server components into separate
 * module graphs, so a plain module-level singleton produces one instance per
 * bundle. With the in-memory driver that means an audit written by
 * POST /api/audits is invisible to the /audit/[id] page — and with Prisma it
 * means a new connection pool per bundle, plus another on every dev reload.
 * A global key is shared across all of them within the process.
 */
const REPOSITORY_KEY = Symbol.for('qualovix.auditRepository');

type RepositoryGlobal = typeof globalThis & {
  [REPOSITORY_KEY]?: AuditRepository | null;
};

const globalStore = globalThis as RepositoryGlobal;

export async function getRepository(env: AppEnv = getEnv()): Promise<AuditRepository> {
  const existing = globalStore[REPOSITORY_KEY];
  if (existing) return existing;

  if (env.PERSISTENCE_DRIVER === 'prisma') {
    if (!env.DATABASE_URL) {
      throw new Error(
        'PERSISTENCE_DRIVER=prisma requires DATABASE_URL to be set. Start Postgres with `npm run infra:up`, then run `npm run prisma:migrate`.',
      );
    }
    const { PrismaAuditRepository } = await import('./repository/prisma-repository');
    const prismaRepository = new PrismaAuditRepository();
    globalStore[REPOSITORY_KEY] = prismaRepository;
    return prismaRepository;
  }

  const memoryRepository = new MemoryAuditRepository();
  globalStore[REPOSITORY_KEY] = memoryRepository;
  return memoryRepository;
}

/** Test helper: replace the active repository. */
export function setRepository(next: AuditRepository | null): void {
  globalStore[REPOSITORY_KEY] = next;
}

export { MemoryAuditRepository } from './repository/memory-repository';
export type {
  AuditRepository,
  AuditListFilters,
  AuditListResult,
  AuditProgressUpdate,
  CompleteAuditData,
  CreateAuditData,
  CreateLeadData,
  FindingReviewUpdate,
  ReportRecord,
  SubmitReviewData,
  UserRecord,
} from './repository/types';

export {
  getAuditQueue,
  resetAuditQueue,
  AUDIT_QUEUE_NAME,
  InlineQueue,
} from './queue/index';
export type { AuditQueue, AuditJobPayload, AuditJobHandler } from './queue/index';
