import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="qv-container py-24 text-center">
        <p className="font-heading text-sm font-bold uppercase tracking-widest text-brand-600">
          404
        </p>
        <h1 className="mt-3 font-heading text-3xl font-bold text-slate-900">Page not found</h1>
        <p className="mx-auto mt-3 max-w-md text-slate-600">
          That audit or page does not exist. Audit links are only valid for audits that have been
          created — check the address, or start a new health check.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Start a free QA audit
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
