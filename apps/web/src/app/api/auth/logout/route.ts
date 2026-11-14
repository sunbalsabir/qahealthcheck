import { handleApiError, ok } from '@/lib/api';
import { destroySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await destroySession();
    return ok({ signedOut: true });
  } catch (error) {
    return handleApiError(error, 'auth.logout');
  }
}
