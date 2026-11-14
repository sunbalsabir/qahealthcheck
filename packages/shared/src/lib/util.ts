import { randomUUID, createHash } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/**
 * Deterministic short id derived from stable inputs. Used so the same finding
 * on the same URL keeps the same id across re-runs, which lets the review
 * layer and the AI enrichment map line up reliably.
 */
export function stableId(...parts: Array<string | number | undefined>): string {
  return createHash('sha256')
    .update(parts.filter((p) => p !== undefined).join(' '))
    .digest('hex')
    .slice(0, 24);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function groupBy<T, K extends string>(
  items: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}

/** Reject a promise that outruns `ms`, so one hung page cannot stall a job. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run tasks with bounded concurrency, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
