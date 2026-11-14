import type { NextRequest } from 'next/server';
import { loginSchema } from '@qualovix/shared';
import { apiError, handleApiError, ok, readJson } from '@/lib/api';
import { authenticate, createSession } from '@/lib/auth';
import { clientIpFrom } from '@/lib/rate-limit';
import { getRepository } from '@qualovix/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Failed sign-ins are rate limited per IP to blunt credential stuffing. */
const LOGIN_ATTEMPTS_PER_15_MIN = 10;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    const body = await readJson(request);
    const input = loginSchema.parse(body);

    const repository = await getRepository();
    const ip = clientIpFrom(request.headers);
    const attempts = await repository.incrementRateLimit('login', ip, WINDOW_MS);
    if (attempts > LOGIN_ATTEMPTS_PER_15_MIN) {
      return apiError(
        'Too many sign-in attempts. Please wait a few minutes and try again.',
        'rate_limited',
        429,
      );
    }

    const user = await authenticate(input.email, input.password);
    if (!user) {
      // One message for both "no such user" and "wrong password", so the
      // response cannot be used to discover which accounts exist.
      return apiError('Those credentials are not valid.', 'invalid_credentials', 401);
    }

    await createSession(user);
    return ok({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    return handleApiError(error, 'auth.login');
  }
}
