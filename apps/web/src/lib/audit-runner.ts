import { errorMessage, getEnv } from '@qualovix/shared';
import { getAuditQueue, getRepository, type AuditJobPayload } from '@qualovix/data';
import { AuditFailure, runAudit, SsrfError } from '@qualovix/audit-engine';

/**
 * The bridge between the job queue and the audit engine.
 *
 * Responsible for the one thing the engine deliberately does not do: keeping
 * the database in step with the scan, so the public progress screen has
 * something to show and a crashed job never leaves an audit stuck in
 * SCANNING forever.
 *
 * Registered once per process. Under the inline queue driver that is the web
 * server; under BullMQ it is the worker app.
 */

/**
 * Registration state lives on globalThis alongside the queue itself, so a
 * second bundle does not believe the handler is already registered when its
 * own module-level flag says so.
 */
const REGISTERED_KEY = Symbol.for('qualovix.auditWorkerRegistered');
const globalStore = globalThis as typeof globalThis & { [REGISTERED_KEY]?: boolean };

export async function ensureAuditWorker(): Promise<void> {
  if (globalStore[REGISTERED_KEY]) return;
  globalStore[REGISTERED_KEY] = true;

  const queue = getAuditQueue();
  queue.process(processAuditJob);
}

export async function processAuditJob(payload: AuditJobPayload): Promise<void> {
  const env = getEnv();
  const repository = await getRepository();

  await repository.updateAuditProgress(payload.auditId, {
    status: 'SCANNING',
    startedAt: new Date(),
    currentStage: 'Discovering pages',
    stageIndex: 1,
  });

  const started = Date.now();

  try {
    const outcome = await runAudit({
      auditId: payload.auditId,
      url: payload.url,
      env,
      onProgress: async (progress) => {
        await repository.updateAuditProgress(payload.auditId, {
          // The last two stages are analysis rather than scanning; reflecting
          // that in the status is what drives the progress screen's copy.
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
  } catch (error) {
    // A refusal or a failed scan must leave the audit in a terminal state
    // with a message a visitor can understand, never a raw stack trace.
    const message =
      error instanceof SsrfError || error instanceof AuditFailure
        ? error.message
        : `The audit could not be completed: ${errorMessage(error)}`;

    await repository.failAudit(payload.auditId, message);

    if (!(error instanceof SsrfError) && !(error instanceof AuditFailure)) {
      console.error(`[audit ${payload.auditId}] unexpected failure`, error);
    }
  } finally {
    await repository
      .updateAuditProgress(payload.auditId, { durationMs: Date.now() - started })
      .catch(() => undefined);
  }
}
