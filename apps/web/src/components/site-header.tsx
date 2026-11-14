import Link from 'next/link';
import { BRAND } from '@qualovix/shared';

export function SiteHeader({ showCta = true }: { showCta?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 backdrop-blur">
      <div className="qv-container flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-heading text-sm font-bold text-white">
            Q
          </span>
          <span className="font-heading text-lg font-bold tracking-tight text-slate-900">
            {BRAND.name}
            <span className="ml-1.5 text-sm font-medium text-slate-400">QA Auditor</span>
          </span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-4">
          <Link
            href="/#how-it-works"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 sm:block"
          >
            How it works
          </Link>
          <Link
            href="/admin"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 sm:block"
          >
            QA team
          </Link>
          {showCta ? (
            <Link
              href="/#start"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Start free audit
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
