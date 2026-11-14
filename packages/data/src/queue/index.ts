import { getEnv, errorMessage, type AppEnv } from '@qualovix/shared';

/**
 * Audit job queue.
 *
 * Two drivers:
 *
 *   bullmq  — Redis-backed, processed by the separate worker app. This is the
 *             production path: audits survive a web-server restart, the web
 *             tier stays responsive, and browser work is isolated from request
 *             handling.
 *
 *   inline  — runs the audit in-process, in the background, right after the
 *             request returns. No Redis required, which is what makes the
 *             quick-start work on a clean machine and what lets the tests run
 *             the full pipeline without infrastructure.
 *
 * Both satisfy the same interface, so the API route never knows which is
 * active.
 */

export interface AuditJobPayload {
  auditId: string;
  url: string;
}

export type AuditJobHandler = (payload: AuditJobPayload) => Promise<void>;

export interface AuditQueue {
  readonly driver: 'bullmq' | 'inline';
  enqueue(payload: AuditJobPayload): Promise<void>;
  /** Register the processor. Inline driver requires this before enqueueing. */
  process(handler: AuditJobHandler): void;
  close(): Promise<void>;
}

export const AUDIT_QUEUE_NAME = 'qualovix-audits';

/**
 * Inline driver. Jobs run in-process on the next tick so the HTTP response
 * is not held open for the duration of a scan.
 */
class InlineQueue implements AuditQueue {
  readonly driver = 'inline' as const;
  private handler: AuditJobHandler | null = null;
  private readonly running = new Set<Promise<void>>();

  process(handler: AuditJobHandler): void {
    this.handler = handler;
  }

  async enqueue(payload: AuditJobPayload): Promise<void> {
    const handler = this.handler;
    if (!handler) {
      throw new Error(
        'No audit job handler is registered. The inline queue driver requires process() to be called during startup.',
      );
    }

    const task = (async () => {
      try {
        await handler(payload);
      } catch (error) {
        // The handler is responsible for marking the audit failed; this is a
        // last-resort log so a thrown error is never silently swallowed.
        console.error(
          `[queue:inline] audit ${payload.auditId} failed: ${errorMessage(error)}`,
        );
      }
    })();

    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }

  async close(): Promise<void> {
    // Let anything already running finish rather than leaving an audit stuck
    // in SCANNING forever.
    await Promise.allSettled(Array.from(this.running));
  }

  /** Test helper: wait for all in-flight jobs. */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled(Array.from(this.running));
    }
  }
}

/**
 * BullMQ driver. Imported lazily so `ioredis` is never loaded — and no Redis
 * connection is ever attempted — when the inline driver is in use.
 */
class BullMqQueue implements AuditQueue {
  readonly driver = 'bullmq' as const;
  private queue: import('bullmq').Queue | null = null;
  private worker: import('bullmq').Worker | null = null;

  constructor(private readonly env: AppEnv) {}

  private async getQueue(): Promise<import('bullmq').Queue> {
    if (this.queue) return this.queue;
    const { Queue } = await import('bullmq');
    this.queue = new Queue(AUDIT_QUEUE_NAME, {
      connection: { url: this.env.REDIS_URL },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86_400, count: 500 },
        removeOnFail: { age: 604_800 },
      },
    });
    return this.queue;
  }

  async enqueue(payload: AuditJobPayload): Promise<void> {
    const queue = await this.getQueue();
    await queue.add('audit', payload, { jobId: payload.auditId });
  }

  process(handler: AuditJobHandler): void {
    void (async () => {
      const { Worker } = await import('bullmq');
      this.worker = new Worker(
        AUDIT_QUEUE_NAME,
        async (job) => {
          await handler(job.data as AuditJobPayload);
        },
        {
          connection: { url: this.env.REDIS_URL },
          // One audit at a time per worker: each runs a headless browser, so
          // concurrency here is memory, not throughput.
          concurrency: 1,
          lockDuration: this.env.AUDIT_JOB_TIMEOUT_MS,
        },
      );

      this.worker.on('failed', (job, error) => {
        console.error(`[queue:bullmq] job ${job?.id} failed: ${errorMessage(error)}`);
      });
    })();
  }

  async close(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }
}

/**
 * Held on globalThis for the same reason as the repository: Next.js gives
 * route handlers and page components separate module graphs, and the inline
 * driver's registered handler has to be reachable from whichever bundle
 * enqueues the job. A per-bundle instance would accept the job and then
 * never run it.
 */
const QUEUE_KEY = Symbol.for('qualovix.auditQueue');

type QueueGlobal = typeof globalThis & { [QUEUE_KEY]?: AuditQueue | null };

const globalStore = globalThis as QueueGlobal;

export function getAuditQueue(env: AppEnv = getEnv()): AuditQueue {
  const existing = globalStore[QUEUE_KEY];
  if (existing) return existing;
  const queue = env.QUEUE_DRIVER === 'bullmq' ? new BullMqQueue(env) : new InlineQueue();
  globalStore[QUEUE_KEY] = queue;
  return queue;
}

/** Test helper: drop the memoized queue. */
export function resetAuditQueue(): void {
  void globalStore[QUEUE_KEY]?.close().catch(() => undefined);
  globalStore[QUEUE_KEY] = null;
}

export { InlineQueue };
