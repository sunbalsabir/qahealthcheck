import 'dotenv/config';
import { errorMessage, getEnv } from '@qualovix/shared';
import { getAuditQueue, getRepository, type AuditJobPayload } from '@qualovix/data';
import { AuditFailure, runAudit, SsrfError } from '@qualovix/audit-engine';

/**
 * Audit worker.
 *
 * Consumes audit jobs from Redis and runs the pipeline. Running this out of
 * process is what keeps the web tier responsive: each audit drives a headless
 * Chromium instance, which is far too heavy to sit inside a request handler.
 *
 * With QUEUE_DRIVER=inline the web app runs audits itself and this process is
 * unnecessary — it exits with an explanation rather than idling silently.
 */

async function main(): Promise<void> {
  const env = getEnv();

  if (env.QUEUE_DRIVER !== 'bullmq') {
    console.log(
      [
        'QUEUE_DRIVER is not set to "bullmq", so audits run inside the web app and this',
        'worker has nothing to consume.',
        '',
        'To run the worker:',
        '  1. Start Redis:          npm run infra:up',
        '  2. Set in .env:          QUEUE_DRIVER=bullmq',
        '  3. Restart the web app, then start this worker again.',
      ].join('\n'),
    );
    return;
  }

  console.log(`[worker] starting (redis: ${redactRedisUrl(env.REDIS_URL)})`);
  console.log(`[worker] mock mode: ${env.AUDIT_MOCK_MODE ? 'ON' : 'off'}`);
  console.log(`[worker] persistence: ${env.PERSISTENCE_DRIVER}`);

  const queue = getAuditQueue(env);
  queue.process(processJob);

  console.log('[worker] waiting for audit jobs');

  // Finish the job in flight before exiting, so a deploy never strands an
  // audit in SCANNING.
  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
    await queue.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function processJob(payload: AuditJobPayload): Promise<void> {
  const env = getEnv();
  const repository = await getRepository(env);
  const started = Date.now();

  console.log(`[worker] audit ${payload.auditId} started: ${payload.url}`);

  await repository.updateAuditProgress(payload.auditId, {
    status: 'SCANNING',
    startedAt: new Date(),
    currentStage: 'Discovering pages',
    stageIndex: 1,
  });

  try {
    const outcome = await runAudit({
      auditId: payload.auditId,
      url: payload.url,
      env,
      onProgress: async (progress) => {
        await repository.updateAuditProgress(payload.auditId, {
          status: progress.stageIndex >= 9 ? 'ANALYZING' : 'SCANNING',
          currentStage: progress.stage,
          stageIndex: progress.stageIndex,
          progressDetail: progress.detail,
        });
      },
    });

    await repository.completeAudit(payload.auditId, {
      findings: outcome.findings,
      passedChecks: outcome.passedChecks,
      categoryScores: outcome.categoryScores,
      pages: outcome.crawl.pages.map((page) => ({
        url: page.url,
        normalizedUrl: page.normalizedUrl,
        depth: page.depth,
        title: page.title,
        statusCode: page.statusCode,
        responseTimeMs: page.responseTimeMs,
        contentType: page.contentType,
        byteSize: page.byteSize,
        linkCount: page.links.length,
        imageCount: page.images.length,
        scriptCount: page.scripts.length,
        stylesheetCount: page.stylesheets.length,
        formCount: page.forms.length,
        buttonCount: page.buttons.length,
        headingCount: page.headings.length,
      })),
      overallScore: outcome.overallScore,
      scoreBand: outcome.scoreBand,
      executiveSummary: outcome.executiveSummary,
      recommendations: outcome.recommendations,
      topIssues: outcome.topIssues,
      aiAnalysisUsed: outcome.aiAnalysisUsed,
      aiFailureReason: outcome.aiFailureReason,
      scannerWarnings: outcome.warnings,
      engineVersion: outcome.engineVersion,
      durationMs: outcome.durationMs,
    });

    console.log(
      `[worker] audit ${payload.auditId} complete in ${Math.round((Date.now() - started) / 1000)}s — score ${outcome.overallScore}, ${outcome.findings.length} findings`,
    );
  } catch (error) {
    const message =
      error instanceof SsrfError || error instanceof AuditFailure
        ? error.message
        : `The audit could not be completed: ${errorMessage(error)}`;

    await repository.failAudit(payload.auditId, message);
    console.error(`[worker] audit ${payload.auditId} failed: ${message}`);

    // Rethrow so BullMQ records the failure and applies its retry policy.
    throw error;
  }
}

/** Never print credentials from a connection string to the log. */
function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return 'redis://…';
  }
}

main().catch((error) => {
  console.error('[worker] fatal error', error);
  process.exit(1);
});
