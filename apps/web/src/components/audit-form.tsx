'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ChevronDown, Loader2, ShieldCheck } from 'lucide-react';
import { Button, Field, inputClass } from './ui';

/**
 * The audit submission form.
 *
 * Only the URL is required — asking for a company name and email up front
 * costs conversions on a free tool, so the lead fields are collapsed behind a
 * disclosure and clearly marked optional.
 *
 * Client-side validation is for feedback only. The server re-validates
 * everything, including the SSRF checks, which is where the real decision is
 * made.
 */

interface FormState {
  url: string;
  companyName: string;
  contactName: string;
  email: string;
  industry: string;
  focusAreas: string;
  website2: string; // honeypot
}

const EMPTY: FormState = {
  url: '',
  companyName: '',
  contactName: '',
  email: '',
  industry: '',
  focusAreas: '',
  website2: '',
};

const INDUSTRIES = [
  'SaaS / Software',
  'E-commerce',
  'Financial services',
  'Healthcare',
  'Education',
  'Professional services',
  'Media / Publishing',
  'Travel / Hospitality',
  'Non-profit',
  'Other',
];

export function AuditForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showDetails, setShowDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const update = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    const trimmed = form.url.trim();
    if (!trimmed) {
      setFieldError('Enter the website address you would like us to check.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/audits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, url: trimmed }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          payload?.error ??
          'We could not start the audit. Please check the URL and try again.';
        // URL problems belong next to the URL field; everything else is a
        // form-level message.
        if (response.status === 400 && /url|address|domain|host|port|protocol/i.test(message)) {
          setFieldError(message);
        } else {
          setError(message);
        }
        setSubmitting(false);
        return;
      }

      router.push(`/audit/${payload.id}`);
    } catch {
      setError('We could not reach the audit service. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full" noValidate>
      {/* Honeypot. Hidden from users, tempting to bots. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="website2">Leave this field empty</label>
        <input
          id="website2"
          name="website2"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.website2}
          onChange={update('website2')}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <label htmlFor="url" className="sr-only">
            Website URL
          </label>
          <input
            id="url"
            name="url"
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            placeholder="https://example.com"
            value={form.url}
            onChange={update('url')}
            aria-invalid={fieldError ? 'true' : undefined}
            aria-describedby={fieldError ? 'url-error' : 'url-hint'}
            className="block w-full rounded-xl border-0 bg-white px-4 py-3.5 text-base text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-brand-600"
            disabled={submitting}
          />
        </div>
        <Button type="submit" size="lg" disabled={submitting} className="shrink-0 px-7 py-3.5">
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Starting audit…
            </>
          ) : (
            <>
              Start Free QA Audit
              <ArrowRight className="h-4 w-4" aria-hidden />
            </>
          )}
        </Button>
      </div>

      {fieldError ? (
        <p id="url-error" role="alert" className="mt-2 text-sm font-medium text-red-600">
          {fieldError}
        </p>
      ) : (
        <p id="url-hint" className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
          <ShieldCheck className="h-3.5 w-3.5 text-slate-400" aria-hidden />
          Public websites only. We never submit your forms, create accounts, or run destructive tests.
        </p>
      )}

      {error ? (
        <div role="alert" className="mt-4 rounded-lg bg-red-50 p-4 ring-1 ring-inset ring-red-200">
          <p className="text-sm font-medium text-red-800">{error}</p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShowDetails((open) => !open)}
        aria-expanded={showDetails}
        aria-controls="audit-details"
        className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
      >
        <ChevronDown
          className={`h-4 w-4 transition-transform ${showDetails ? 'rotate-180' : ''}`}
          aria-hidden
        />
        Tell us about you {showDetails ? '' : '(optional — helps us tailor the report)'}
      </button>

      <div id="audit-details" hidden={!showDetails} className="mt-5 grid gap-5 sm:grid-cols-2">
        <Field label="Company name" htmlFor="companyName">
          <input
            id="companyName"
            name="companyName"
            type="text"
            autoComplete="organization"
            className={inputClass}
            value={form.companyName}
            onChange={update('companyName')}
            disabled={submitting}
          />
        </Field>

        <Field label="Your name" htmlFor="contactName">
          <input
            id="contactName"
            name="contactName"
            type="text"
            autoComplete="name"
            className={inputClass}
            value={form.contactName}
            onChange={update('contactName')}
            disabled={submitting}
          />
        </Field>

        <Field
          label="Business email"
          htmlFor="email"
          hint="So we can send the report and follow up if you want us to."
        >
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            className={inputClass}
            value={form.email}
            onChange={update('email')}
            disabled={submitting}
          />
        </Field>

        <Field label="Industry" htmlFor="industry">
          <select
            id="industry"
            name="industry"
            className={inputClass}
            value={form.industry}
            onChange={update('industry')}
            disabled={submitting}
          >
            <option value="">Select an industry</option>
            {INDUSTRIES.map((industry) => (
              <option key={industry} value={industry}>
                {industry}
              </option>
            ))}
          </select>
        </Field>

        <div className="sm:col-span-2">
          <Field
            label="What would you like us to focus on?"
            htmlFor="focusAreas"
            hint="For example: checkout flow, mobile layout, accessibility, or a recent release."
          >
            <textarea
              id="focusAreas"
              name="focusAreas"
              rows={3}
              className={inputClass}
              value={form.focusAreas}
              onChange={update('focusAreas')}
              disabled={submitting}
            />
          </Field>
        </div>
      </div>
    </form>
  );
}
