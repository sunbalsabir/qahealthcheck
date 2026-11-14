import Link from 'next/link';
import {
  Accessibility,
  Activity,
  ArrowRight,
  CheckCircle2,
  FileText,
  Gauge,
  Link2,
  Lock,
  Search,
  Smartphone,
  Terminal,
  UserCheck,
} from 'lucide-react';
import { BRAND, SCORE_DISCLAIMER } from '@qualovix/shared';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { AuditForm } from '@/components/audit-form';
import { Card, SectionHeading } from '@/components/ui';

const CHECKS = [
  {
    icon: Link2,
    title: 'Broken links & failed requests',
    body: 'Every link and page resource is probed for 404s, 5xx errors, DNS failures and timeouts — with severity based on what actually breaks, not just the status code.',
  },
  {
    icon: Terminal,
    title: 'JavaScript errors',
    body: 'Console errors and uncaught exceptions captured during a real page load, grouped so one recurring fault reads as one problem.',
  },
  {
    icon: Smartphone,
    title: 'Responsive behaviour',
    body: 'Layout measured at mobile, tablet and desktop widths: horizontal overflow, overlapping controls, tap targets too small to hit.',
  },
  {
    icon: Accessibility,
    title: 'Accessibility',
    body: 'Automated axe-core findings across every page — missing alt text, unlabelled inputs, contrast, heading structure and ARIA problems.',
  },
  {
    icon: Gauge,
    title: 'Performance',
    body: 'Core Web Vitals, page weight, render-blocking resources and oversized images, measured in a real browser.',
  },
  {
    icon: Lock,
    title: 'Security baseline',
    body: 'Passive checks only: HTTPS, security headers, cookie flags, mixed content. Never a penetration test.',
  },
];

const STEPS = [
  {
    icon: Search,
    title: 'Submit your URL',
    body: 'Enter a public website address. No signup, no access required, nothing installed.',
  },
  {
    icon: Activity,
    title: 'Automated QA scan',
    body: 'We crawl up to 10 pages in a real browser and run nine independent QA scanners against what we find.',
  },
  {
    icon: UserCheck,
    title: 'QA engineer review',
    body: 'A Qualovix QA engineer reviews every finding before it reaches you. False positives are removed, real issues are confirmed.',
  },
  {
    icon: FileText,
    title: 'Receive your report',
    body: 'A branded PDF with a health score, prioritised findings, evidence for each one, and recommended next steps.',
  },
];

export default function HomePage() {
  return (
    <>
      <SiteHeader />

      <main id="main">
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                              */}
        {/* ---------------------------------------------------------------- */}
        <section className="qv-gradient border-b border-slate-200/70">
          <div className="qv-container py-16 sm:py-24">
            <div className="mx-auto max-w-3xl text-center">
              <p className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-brand-700 shadow-sm ring-1 ring-inset ring-brand-200">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden />
                {BRAND.positioning}
              </p>

              <h1 className="mt-6 font-heading text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
                {BRAND.tagline}
              </h1>

              <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
                Get a free automated QA health check of your website — reviewed by QA engineers.
              </p>
            </div>

            <div id="start" className="mx-auto mt-10 max-w-3xl scroll-mt-24">
              <Card className="p-6 sm:p-8">
                <h2 className="font-heading text-xl font-bold text-slate-900">
                  Get a Free QA Health Check
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  Enter your website URL and we&apos;ll automatically analyze common quality,
                  usability, accessibility, performance, and technical issues.
                </p>
                <div className="mt-6">
                  <AuditForm />
                </div>
              </Card>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  No signup required
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  Up to 10 pages analysed
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  Results in minutes
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  Reviewed by a QA engineer
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* How it works                                                      */}
        {/* ---------------------------------------------------------------- */}
        <section id="how-it-works" className="scroll-mt-20 py-20">
          <div className="qv-container">
            <SectionHeading
              eyebrow="How it works"
              title="Four steps from URL to report"
              description="Most website scanners hand you a list of machine output and leave you to work out what matters. We put a QA engineer between the scan and your inbox."
            />

            <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <Card className="h-full p-6">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100">
                        <step.icon className="h-4.5 w-4.5" aria-hidden />
                      </span>
                      <span className="font-heading text-xs font-bold uppercase tracking-wider text-slate-400">
                        Step {index + 1}
                      </span>
                    </div>
                    <h3 className="mt-4 font-heading text-base font-bold text-slate-900">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
                  </Card>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* What we check                                                     */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-y border-slate-200 bg-slate-50 py-20">
          <div className="qv-container">
            <SectionHeading
              eyebrow="What we check"
              title="Nine independent QA scanners"
              description="Each scanner runs against the same single crawl of your site, so we get a full picture without hammering your servers."
            />

            <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {CHECKS.map((check) => (
                <Card key={check.title} className="p-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white">
                    <check.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 font-heading text-base font-bold text-slate-900">
                    {check.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{check.body}</p>
                </Card>
              ))}
            </div>

            <p className="mt-10 max-w-3xl text-sm leading-relaxed text-slate-500">
              Plus HTML and technical QA, form structure review, and automated UX heuristics. Your
              report gives every category its own score, weighted into a single QA Health Score.{' '}
              {SCORE_DISCLAIMER}
            </p>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Honest limits — the thing that builds trust with an engineer      */}
        {/* ---------------------------------------------------------------- */}
        <section className="py-20">
          <div className="qv-container">
            <div className="grid gap-12 lg:grid-cols-2">
              <div>
                <SectionHeading
                  eyebrow="What this is not"
                  title="An automated health check, not a full QA engagement"
                  description="We would rather tell you the limits up front than have you discover them later."
                />
                <ul className="mt-8 space-y-4">
                  {[
                    'We never submit your forms, create accounts, make payments or run anything destructive. Forms are inspected and flagged for manual testing.',
                    'This is not a penetration test. Security checks are passive observations of headers and transport only.',
                    'Automated accessibility tooling catches roughly a third of WCAG issues. We report findings, never certification.',
                    'A passing check means that specific check passed — not that the area is defect-free.',
                  ].map((item) => (
                    <li key={item} className="flex gap-3">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" aria-hidden />
                      <span className="text-sm leading-relaxed text-slate-600">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Card className="flex flex-col justify-between bg-slate-900 p-8 text-white">
                <div>
                  <h3 className="font-heading text-2xl font-bold">
                    Want a deeper assessment?
                  </h3>
                  <p className="mt-4 text-sm leading-relaxed text-slate-300">
                    The health check surfaces what a machine can see. A full Qualovix engagement
                    covers what it cannot: whether your user journeys actually work, whether your
                    forms deliver, and whether your releases stay stable over time.
                  </p>
                </div>
                <div className="mt-8">
                  <a
                    href={BRAND.contactUrl}
                    className="inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100"
                  >
                    Talk to Qualovix
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </a>
                  <Link
                    href="/#start"
                    className="ml-3 inline-flex items-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold text-slate-300 ring-1 ring-inset ring-slate-700 transition-colors hover:text-white"
                  >
                    Run the free check first
                  </Link>
                </div>
              </Card>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
