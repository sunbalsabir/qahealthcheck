import { z } from 'zod';
import { AUDIT_STATUSES, LEAD_FOLLOW_UP_STATUSES } from './types/audit';
import { CATEGORIES, FINDING_STATUSES, SEVERITIES } from './types/finding';

/**
 * Request/response validation for the REST API. Everything crossing the
 * network boundary is parsed here before it reaches the engine.
 */

const trimmed = (max: number) => z.string().trim().max(max);

/**
 * Structural URL validation only. Network-level safety (DNS resolution,
 * private-range blocking, redirect re-validation) lives in the audit
 * engine's URL guard and must run before any request is made.
 */
export const websiteUrlSchema = z
  .string()
  .trim()
  .min(4, 'Please enter a website URL.')
  .max(2048, 'That URL is too long.')
  .transform((value) => (/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`))
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Enter a valid public http(s) website URL.');

export const createAuditSchema = z.object({
  url: websiteUrlSchema,
  companyName: trimmed(200).optional().or(z.literal('')),
  contactName: trimmed(200).optional().or(z.literal('')),
  email: z.string().trim().email('Enter a valid business email.').max(320).optional().or(z.literal('')),
  industry: trimmed(120).optional().or(z.literal('')),
  focusAreas: trimmed(2000).optional().or(z.literal('')),
  // Honeypot: real users never fill this in.
  website2: z.string().max(0).optional(),
});
export type CreateAuditInput = z.infer<typeof createAuditSchema>;

export const auditIdSchema = z.string().min(1).max(64);

export const findingReviewDecisionSchema = z.object({
  findingId: z.string().min(1),
  status: z.enum(FINDING_STATUSES),
  severity: z.enum(SEVERITIES).optional(),
  title: trimmed(300).optional(),
  description: trimmed(4000).optional(),
  qaNote: trimmed(4000).optional(),
});
export type FindingReviewDecision = z.infer<typeof findingReviewDecisionSchema>;

export const submitReviewSchema = z.object({
  decisions: z.array(findingReviewDecisionSchema).max(1000).default([]),
  engineerNotes: trimmed(8000).optional(),
  scoreOverride: z.number().int().min(0).max(100).nullable().optional(),
  approve: z.boolean().default(false),
});
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

export const auditListQuerySchema = z.object({
  search: trimmed(200).optional(),
  status: z.enum(AUDIT_STATUSES).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  severity: z.enum(SEVERITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const createLeadSchema = z.object({
  companyName: trimmed(200).optional(),
  contactName: trimmed(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  website: websiteUrlSchema,
  industry: trimmed(120).optional(),
  focusAreas: trimmed(2000).optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = z.object({
  followUpStatus: z.enum(LEAD_FOLLOW_UP_STATUSES).optional(),
  internalNotes: trimmed(8000).optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(320),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const generateReportSchema = z.object({
  /** Reviewed reports include only KEPT/EDITED findings. */
  reviewedOnly: z.boolean().default(true),
});
