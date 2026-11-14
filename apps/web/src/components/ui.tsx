import React from 'react';
import { clsx } from 'clsx';
import {
  SEVERITY_LABELS,
  type Severity,
} from '@qualovix/shared';

/**
 * Shared UI primitives.
 *
 * Small and hand-written rather than pulled from a component library — the
 * surface needed here is a handful of elements, and owning them keeps the
 * severity vocabulary consistent between the results page, the admin review
 * queue and the PDF.
 */

// --- severity ---------------------------------------------------------------

const SEVERITY_STYLES: Record<Severity, string> = {
  CRITICAL: 'bg-red-50 text-red-700 ring-red-200',
  HIGH: 'bg-orange-50 text-orange-700 ring-orange-200',
  MEDIUM: 'bg-amber-50 text-amber-800 ring-amber-200',
  LOW: 'bg-sky-50 text-sky-700 ring-sky-200',
  INFO: 'bg-slate-50 text-slate-600 ring-slate-200',
};

const SEVERITY_DOT: Record<Severity, string> = {
  CRITICAL: 'bg-red-600',
  HIGH: 'bg-orange-500',
  MEDIUM: 'bg-amber-500',
  LOW: 'bg-sky-500',
  INFO: 'bg-slate-400',
};

export function SeverityBadge({
  severity,
  className,
}: {
  severity: Severity;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        SEVERITY_STYLES[severity],
        className,
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[severity])} aria-hidden />
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

// --- score ------------------------------------------------------------------

export function scoreTone(score: number): {
  text: string;
  bg: string;
  ring: string;
  stroke: string;
} {
  if (score >= 85) {
    return { text: 'text-emerald-700', bg: 'bg-emerald-50', ring: 'ring-emerald-200', stroke: '#059669' };
  }
  if (score >= 70) {
    return { text: 'text-brand-700', bg: 'bg-brand-50', ring: 'ring-brand-200', stroke: '#0284c7' };
  }
  if (score >= 50) {
    return { text: 'text-amber-700', bg: 'bg-amber-50', ring: 'ring-amber-200', stroke: '#d97706' };
  }
  return { text: 'text-red-700', bg: 'bg-red-50', ring: 'ring-red-200', stroke: '#dc2626' };
}

/** Circular score gauge. Pure SVG so it renders identically everywhere. */
export function ScoreDial({
  score,
  size = 168,
  label,
}: {
  score: number;
  size?: number;
  label?: string;
}) {
  const tone = scoreTone(score);
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="img" aria-label={`QA health score ${score} out of 100`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.stroke}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx('font-heading text-4xl font-bold tabular-nums', tone.text)}>{score}</span>
        <span className="text-xs font-medium text-slate-500">out of 100</span>
        {label ? (
          <span className="mt-1 max-w-[7rem] text-center text-[11px] font-semibold text-slate-600">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// --- layout primitives ------------------------------------------------------

export function Card({
  children,
  className,
  as: Component = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  as?: React.ElementType;
}) {
  return <Component className={clsx('qv-card', className)}>{children}</Component>;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={clsx('max-w-2xl', className)}>
      {eyebrow ? (
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">{eyebrow}</p>
      ) : null}
      <h2 className="mt-2 font-heading text-2xl font-bold text-slate-900 sm:text-3xl">{title}</h2>
      {description ? <p className="mt-3 text-slate-600">{description}</p> : null}
    </div>
  );
}

// --- buttons ----------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600 disabled:bg-brand-300',
  secondary:
    'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed',
        size === 'sm' && 'px-3 py-1.5 text-sm',
        size === 'md' && 'px-4 py-2.5 text-sm',
        size === 'lg' && 'px-6 py-3 text-base',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

// --- form fields ------------------------------------------------------------

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-slate-800">
        {label}
        {required ? (
          <span className="ml-1 text-red-600" aria-hidden>
            *
          </span>
        ) : (
          <span className="ml-1.5 text-xs font-normal text-slate-400">optional</span>
        )}
      </label>
      {hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1.5 text-sm font-medium text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'block w-full rounded-lg border-0 bg-white px-3.5 py-2.5 text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-brand-600 disabled:bg-slate-50 disabled:text-slate-500';

// --- misc -------------------------------------------------------------------

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
}) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-700',
    brand: 'bg-brand-50 text-brand-700',
    success: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-800',
    danger: 'bg-red-50 text-red-700',
  };
  return (
    <span className={clsx('inline-flex rounded-md px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

/** Renders the "not a certification" caveats consistently wherever shown. */
export function Disclaimer({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs leading-relaxed text-slate-500">{children}</p>
  );
}
