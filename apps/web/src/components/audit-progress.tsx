'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { AUDIT_STAGES } from '@qualovix/shared';
import { Card } from './ui';

/**
 * Live progress screen.
 *
 * Polls the audit endpoint rather than holding a socket open — a scan takes
 * a couple of minutes at most and a poll is far simpler to reason about and
 * to deploy behind any proxy. Backs off as the wait lengthens so a stalled
 * job does not generate a request per second indefinitely.
 */

interface ProgressResponse {
  id: string;
  status: string;
  stageIndex: number;
  totalStages: number;
  currentStage: string;
  progressDetail?: string | null;
  mockMode?: boolean;
  complete: boolean;
  failed?: boolean;
  errorMessage?: string;
}

const INITIAL_INTERVAL_MS = 1500;
const MAX_INTERVAL_MS = 6000;
/** Give up polling after this long and tell the user plainly. */
const MAX_WAIT_MS = 15 * 60 * 1000;

export function AuditProgress({ auditId, url }: { auditId: string; url: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let interval = INITIAL_INTERVAL_MS;
    let consecutiveErrors = 0;

    const poll = async () => {
      if (cancelled) return;

      if (Date.now() - startedAt.current > MAX_WAIT_MS) {
        setTimedOut(true);
        return;
      }

      try {
        const response = await fetch(`/api/audits/${auditId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`status ${response.status}`);

        const data = (await response.json()) as ProgressResponse;
        if (cancelled) return;

        consecutiveErrors = 0;
        setError(null);
        setProgress(data);

        if (data.complete) {
          // Re-render the server component so the results are fetched fresh.
          router.refresh();
          return;
        }
      } catch {
        consecutiveErrors += 1;
        // A couple of failed polls is normal on a flaky connection; only
        // surface an error once it looks persistent.
        if (consecutiveErrors >= 3 && !cancelled) {
          setError('We lost contact with the audit service. Still retrying…');
        }
      }

      // Gentle backoff, capped.
      interval = Math.min(MAX_INTERVAL_MS, Math.round(interval * 1.15));
      timer = setTimeout(poll, interval);
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [auditId, router]);

  const currentIndex = progress?.stageIndex ?? 0;
  const percent = Math.round((currentIndex / AUDIT_STAGES.length) * 100);

  if (timedOut) {
    return (
      <Card className="p-8">
        <div className="flex gap-3">
          <AlertCircle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden />
          <div>
            <h2 className="font-heading text-lg font-bold text-slate-900">
              This audit is taking longer than expected
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              The scan has been running for over fifteen minutes, which usually means the site is
              very large or is responding slowly. Your results are still being processed — bookmark
              this page and come back shortly.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 bg-slate-50 px-6 py-5 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg font-bold text-slate-900">
              Running your QA health check
            </h2>
            <p className="mt-1 truncate text-sm text-slate-600">{url}</p>
          </div>
          <span className="shrink-0 font-heading text-2xl font-bold tabular-nums text-brand-700">
            {percent}%
          </span>
        </div>

        <div
          className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Audit progress"
        >
          <div
            className="h-full rounded-full bg-brand-600 transition-all duration-500 ease-out"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>
      </div>

      <ol className="divide-y divide-slate-100">
        {AUDIT_STAGES.map((stage, index) => {
          const stageNumber = index + 1;
          const done = stageNumber < currentIndex || (progress?.complete ?? false);
          const active = stageNumber === currentIndex && !progress?.complete;

          return (
            <li
              key={stage}
              className={`flex items-center gap-3 px-6 py-3 sm:px-8 ${active ? 'bg-brand-50/50' : ''}`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  done
                    ? 'bg-emerald-100 text-emerald-700'
                    : active
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-400'
                }`}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  stageNumber
                )}
              </span>

              <span
                className={`text-sm ${
                  done ? 'text-slate-500' : active ? 'font-semibold text-slate-900' : 'text-slate-400'
                }`}
              >
                {stage}
              </span>

              {active && progress?.progressDetail ? (
                <span className="ml-auto hidden truncate text-xs text-slate-500 sm:block">
                  {progress.progressDetail}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="border-t border-slate-200 bg-slate-50 px-6 py-4 sm:px-8">
        <p className="text-xs leading-relaxed text-slate-500">
          {progress?.mockMode
            ? 'Mock mode is enabled — this audit uses generated sample data and is not scanning a real site.'
            : 'We are loading your pages in a real browser and running nine QA scanners. This usually takes one to three minutes.'}
        </p>
        {error ? (
          <p className="mt-2 text-xs font-medium text-amber-700" role="status">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
