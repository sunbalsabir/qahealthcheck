import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { BRAND, getEnv } from '@qualovix/shared';
import { getSessionUser } from '@/lib/auth';
import { SignOutButton } from '@/components/sign-out-button';

export const dynamic = 'force-dynamic';

/**
 * Admin shell.
 *
 * Authorisation is enforced here rather than in middleware alone, so every
 * admin page is gated by a real session check on the server. The login page
 * lives outside this layout (it must render while signed out).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers();
  const pathname = headerList.get('x-pathname') ?? '';

  // /admin/login renders its own page and must not require a session.
  if (!pathname.endsWith('/admin/login')) {
    const session = await getSessionUser();
    if (!session) redirect('/admin/login');
  }

  const session = await getSessionUser();
  const env = getEnv();

  if (!session) return <>{children}</>;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
          <div className="flex items-center gap-8">
            <Link href="/admin" className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-heading text-sm font-bold text-white">
                Q
              </span>
              <span className="font-heading text-base font-bold text-slate-900">
                {BRAND.name}
                <span className="ml-1.5 text-xs font-medium text-slate-400">QA Dashboard</span>
              </span>
            </Link>

            <nav className="hidden items-center gap-1 sm:flex">
              <Link
                href="/admin"
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                Audits
              </Link>
              <Link
                href="/admin/leads"
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                Leads
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-slate-500 sm:block">{session.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      {env.PERSISTENCE_DRIVER === 'memory' ? (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className="mx-auto max-w-7xl px-5 py-2">
            <p className="text-xs font-medium text-amber-900">
              In-memory persistence is active — all audits, leads and review decisions are lost when
              the server restarts. Set <code className="font-mono">PERSISTENCE_DRIVER=prisma</code>{' '}
              for durable storage.
            </p>
          </div>
        </div>
      ) : null}

      <main id="main" className="mx-auto max-w-7xl px-5 py-8">
        {children}
      </main>
    </div>
  );
}
