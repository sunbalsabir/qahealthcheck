import type { Severity } from '@qualovix/shared';

/**
 * Qualovix report design tokens.
 *
 * The palette matches the Qualovix brand (sky-blue primary, slate neutrals)
 * so the PDF sits alongside the rest of the agency's material. Values are
 * plain hex because @react-pdf/renderer does not support CSS variables.
 */

export const colors = {
  brand: '#0284c7',
  brandDark: '#0c4a6e',
  brandMid: '#0369a1',
  brandLight: '#e0f2fe',
  brandTint: '#f0f9ff',

  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',

  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',

  critical: '#b91c1c',
  criticalBg: '#fef2f2',
  criticalBorder: '#fecaca',

  high: '#c2410c',
  highBg: '#fff7ed',
  highBorder: '#fed7aa',

  medium: '#a16207',
  mediumBg: '#fefce8',
  mediumBorder: '#fef08a',

  low: '#0369a1',
  lowBg: '#f0f9ff',
  lowBorder: '#bae6fd',

  info: '#475569',
  infoBg: '#f8fafc',
  infoBorder: '#e2e8f0',

  success: '#15803d',
  successBg: '#f0fdf4',
  successBorder: '#bbf7d0',
} as const;

export const severityColors: Record<Severity, { fg: string; bg: string; border: string }> = {
  CRITICAL: { fg: colors.critical, bg: colors.criticalBg, border: colors.criticalBorder },
  HIGH: { fg: colors.high, bg: colors.highBg, border: colors.highBorder },
  MEDIUM: { fg: colors.medium, bg: colors.mediumBg, border: colors.mediumBorder },
  LOW: { fg: colors.low, bg: colors.lowBg, border: colors.lowBorder },
  INFO: { fg: colors.info, bg: colors.infoBg, border: colors.infoBorder },
};

/** Score-band colour, used for the headline score and the category bars. */
export function scoreColor(score: number): string {
  if (score >= 85) return colors.success;
  if (score >= 70) return colors.brand;
  if (score >= 50) return colors.medium;
  return colors.critical;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 26,
  xxl: 38,
} as const;

export const fontSize = {
  micro: 7,
  caption: 8,
  small: 9,
  body: 10,
  lead: 11,
  h4: 12,
  h3: 14,
  h2: 18,
  h1: 26,
  display: 40,
} as const;
