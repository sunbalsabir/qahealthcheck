import { BRAND, DISCLAIMER, SERVICES } from '@qualovix/shared';

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-slate-200 bg-slate-50">
      <div className="qv-container py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-heading text-sm font-bold text-white">
                Q
              </span>
              <span className="font-heading text-lg font-bold text-slate-900">{BRAND.name}</span>
            </div>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-600">
              Qualovix is a software quality engineering agency. The QA Auditor gives you an
              automated health check of your website, reviewed by our QA engineers before it
              reaches you.
            </p>
          </div>

          <div>
            <h3 className="font-heading text-sm font-bold text-slate-900">Services</h3>
            <ul className="mt-4 space-y-2">
              {SERVICES.map((service) => (
                <li key={service} className="text-sm text-slate-600">
                  {service}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="font-heading text-sm font-bold text-slate-900">Get in touch</h3>
            <p className="mt-4 text-sm text-slate-600">
              Want a deeper assessment than an automated scan can give you?
            </p>
            <a
              href={BRAND.contactUrl}
              className="mt-3 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Talk to Qualovix
            </a>
          </div>
        </div>

        <div className="mt-10 border-t border-slate-200 pt-6">
          <p className="text-xs leading-relaxed text-slate-500">{DISCLAIMER}</p>
          <p className="mt-3 text-xs text-slate-400">
            &copy; {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
