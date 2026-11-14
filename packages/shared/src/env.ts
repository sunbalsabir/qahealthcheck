import { z } from 'zod';

/**
 * Central environment parsing. Nothing in the codebase reads process.env
 * directly for configuration — that keeps limits configurable and keeps
 * secrets out of the client bundle (this module is server-only).
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().default('http://localhost:5000'),

  PERSISTENCE_DRIVER: z.enum(['prisma', 'memory']).default('memory'),
  DATABASE_URL: z.string().optional(),

  QUEUE_DRIVER: z.enum(['bullmq', 'inline']).default('inline'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  AUTH_SECRET: z.string().min(16).default('qualovix-dev-secret-change-me-please'),
  ADMIN_EMAIL: z.string().default('qa@qualovix.com'),
  ADMIN_PASSWORD: z.string().default('qualovix-admin'),
  SESSION_TTL_HOURS: int(12, 1, 720),

  AI_ENABLED: bool(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  AI_TIMEOUT_MS: int(60_000, 1_000, 300_000),

  AUDIT_MOCK_MODE: bool(false),
  MAX_PAGES: int(10, 1, 100),
  MAX_DEPTH: int(2, 0, 5),
  PAGE_TIMEOUT_MS: int(30_000, 1_000, 120_000),
  REQUEST_TIMEOUT_MS: int(15_000, 1_000, 120_000),
  MAX_REDIRECTS: int(5, 0, 20),
  MAX_RESPONSE_BYTES: int(10 * 1024 * 1024, 1024, 200 * 1024 * 1024),
  AUDIT_JOB_TIMEOUT_MS: int(600_000, 10_000, 3_600_000),
  MAX_LINK_CHECKS: int(150, 1, 2_000),
  SCREENSHOTS_ENABLED: bool(true),
  SCREENSHOT_DIR: z.string().default('.data/screenshots'),

  RATE_LIMIT_PER_IP_PER_DAY: int(3, 0, 10_000),
  RATE_LIMIT_PER_DOMAIN_PER_DAY: int(2, 0, 10_000),
  RATE_LIMIT_PER_EMAIL_PER_DAY: int(3, 0, 10_000),
  RATE_LIMIT_GLOBAL_PER_HOUR: int(60, 0, 100_000),

  SSRF_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cached && source === process.env) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** Test helper: forget the memoized environment. */
export function resetEnvCache(): void {
  cached = null;
}

export function aiIsConfigured(env: AppEnv = getEnv()): boolean {
  return env.AI_ENABLED && Boolean(env.ANTHROPIC_API_KEY);
}
