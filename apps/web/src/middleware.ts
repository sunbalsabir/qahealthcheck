import { NextResponse, type NextRequest } from 'next/server';

/**
 * Passes the request path down to server components via a header, so the
 * admin layout can tell whether it is rendering the login page (which must
 * be reachable while signed out) without duplicating route knowledge.
 *
 * Authentication itself is enforced in the layout and in each API route,
 * not here — middleware runs on the edge runtime where the session
 * verification dependencies are not all available.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/admin/:path*'],
};
