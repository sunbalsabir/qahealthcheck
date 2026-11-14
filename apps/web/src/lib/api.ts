import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { errorMessage } from '@qualovix/shared';
import { SsrfError } from '@qualovix/audit-engine';
import { UnauthorizedError } from './auth';

/**
 * Shared API response helpers.
 *
 * Error responses are deliberately uniform and never leak internals: a caller
 * gets a message they can act on, and anything unexpected is logged
 * server-side rather than returned. That matters more than usual here — the
 * error path of a URL-fetching service is exactly where an attacker probes
 * for information about the internal network.
 */

export interface ApiErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function created<T>(data: T): NextResponse<T> {
  return NextResponse.json(data, { status: 201 });
}

export function apiError(
  message: string,
  code: string,
  status: number,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: message, code, details }, { status });
}

/**
 * Maps a thrown error to a response. Known error types get a specific,
 * user-facing message; anything else becomes a generic 500 and is logged.
 */
export function handleApiError(error: unknown, context: string): NextResponse<ApiErrorBody> {
  if (error instanceof UnauthorizedError) {
    return apiError('You need to sign in to do that.', 'unauthorized', 401);
  }

  if (error instanceof SsrfError) {
    // The guard's messages are written to be shown to a visitor: they say
    // what is not allowed without confirming what exists internally.
    return apiError(error.message, error.code, 400);
  }

  if (error instanceof ZodError) {
    return apiError('Some of the details you entered are not valid.', 'validation_failed', 400, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  console.error(`[api:${context}]`, error);
  return apiError(
    'Something went wrong on our side. Please try again.',
    'internal_error',
    500,
  );
}

/** Parse a JSON body, returning a typed error rather than throwing on junk. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ZodError([
      {
        code: 'custom',
        path: [],
        message: 'Request body must be valid JSON.',
      },
    ]);
  }
}

export { errorMessage };
