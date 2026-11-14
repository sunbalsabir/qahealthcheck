import { redirect } from 'next/navigation';
import { BRAND } from '@qualovix/shared';
import { getSessionUser } from '@/lib/auth';
import { LoginForm } from '@/components/login-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'QA team sign in', robots: { index: false } };

export default async function LoginPage() {
  // Already signed in? Go straight to the dashboard.
  const session = await getSessionUser();
  if (session) redirect('/admin');

  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-slate-50 px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 font-heading text-base font-bold text-white">
            Q
          </span>
          <span className="font-heading text-xl font-bold text-slate-900">{BRAND.name}</span>
        </div>

        <div className="qv-card p-7">
          <h1 className="font-heading text-lg font-bold text-slate-900">QA team sign in</h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Internal access for Qualovix QA engineers.
          </p>
          <div className="mt-6">
            <LoginForm />
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          Not a Qualovix engineer?{' '}
          <a href="/" className="font-medium text-brand-700 hover:underline">
            Run a free QA health check
          </a>
        </p>
      </div>
    </main>
  );
}
