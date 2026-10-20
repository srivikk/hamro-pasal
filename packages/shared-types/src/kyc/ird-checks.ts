import { z } from 'zod';

import { vendorStatusSchema } from '../domain/enums';

/*
 * Automated IRD PAN verification (decided by the user 2026-10-21; SPEC core 10 amended): a worker
 * looks the vendor's PAN up on the IRD's public PAN search, compares the business name the IRD
 * holds with the vendor's, and verifies the PAN itself on a match. Anything it cannot settle goes
 * to "Action Required: Manual Review" in the admin dashboard.
 *
 * One `ird_pan_checks` row per check, a state machine:
 *
 *   QUEUED ──▶ RUNNING ──▶ VERIFIED        the names matched; pan_verified_at set by the job
 *                    └──▶ MANUAL_REVIEW   a mismatch, an inactive account, not found, a layout the
 *                                         parser does not know, or 3 failed attempts
 *   QUEUED / RUNNING / MANUAL_REVIEW ──▶ SUPERSEDED  the PAN or its document changed first
 *   MANUAL_REVIEW ──▶ RESOLVED          a Super Admin verified the PAN by hand
 *   MANUAL_REVIEW ──▶ QUEUED            a Super Admin asked for another try (attempts restart)
 */

export const irdPanCheckStatuses = [
  'QUEUED',
  'RUNNING',
  'VERIFIED',
  'MANUAL_REVIEW',
  'SUPERSEDED',
  'RESOLVED',
] as const;
export const irdPanCheckStatusSchema = z.enum(irdPanCheckStatuses);
export type IrdPanCheckStatus = z.infer<typeof irdPanCheckStatusSchema>;

/** Why a check needs a person. */
export const irdReviewReasons = [
  /** The IRD's business name is below the match threshold. */
  'NAME_MISMATCH',
  /** The IRD answered "invalid information" every time (no such PAN, or the CAPTCHA refused). */
  'PAN_NOT_FOUND',
  /** The PAN exists but no registration under it is Active. */
  'IRD_ACCOUNT_INACTIVE',
  /** The page or its result is not shaped as the parser expects: the IRD changed its site. */
  'LAYOUT_CHANGED',
  /** Three attempts failed (timeouts, network, CAPTCHA solving). */
  'SCRAPER_FAILED',
  /** IRD_VERIFICATION_PROVIDER=DISABLED: nothing checks automatically. */
  'AUTOMATION_DISABLED',
  /** The names matched but the PAN document is no longer on file. */
  'DOCUMENT_MISSING',
] as const;
export const irdReviewReasonSchema = z.enum(irdReviewReasons);
export type IrdReviewReason = z.infer<typeof irdReviewReasonSchema>;

/** Attempts per check (decided 2026-10-21): CAPTCHA misreads and timeouts are retried, 3 in all. */
export const IRD_CHECK_MAX_ATTEMPTS = 3;
/**
 * Every network step of an attempt (loading the page, each 2Captcha call, the IRD search request,
 * the result appearing) is abandoned after this long, and the attempt counts as failed.
 */
export const IRD_ATTEMPT_TIMEOUT_MS = 30_000;
/**
 * Solving the invisible reCAPTCHA through 2Captcha takes 15–45 s by its own figures, so it has a
 * budget of its own; past it the attempt counts as failed like a timeout.
 */
export const IRD_CAPTCHA_TIMEOUT_MS = 120_000;

/** One check awaiting a person, as the admin dashboard lists it. */
export const irdManualReviewViewSchema = z.strictObject({
  check_id: z.uuid(),
  vendor_id: z.uuid(),
  vendor_code: z.string(),
  business_name: z.string(),
  legal_name: z.string().nullable(),
  vendor_status: vendorStatusSchema,
  tax_id: z.string().regex(/^[0-9]{9}$/),
  reason: irdReviewReasonSchema,
  attempts: z.number().int().nonnegative(),
  ird_business_name: z.string().nullable(),
  ird_registration_date: z.string().nullable(),
  /** 0–1, the score the worker computed; null when the IRD gave no name. */
  name_similarity: z.number().min(0).max(1).nullable(),
  last_error: z.string().nullable(),
  requested_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
});
export type IrdManualReviewView = z.infer<typeof irdManualReviewViewSchema>;

/** GET /api/admin/kyc/manual-review: the open queue, oldest first. */
export const adminIrdManualReviewListResponseSchema = z.strictObject({
  checks: z.array(irdManualReviewViewSchema),
});
export type AdminIrdManualReviewListResponse = z.infer<
  typeof adminIrdManualReviewListResponseSchema
>;

/** POST /api/admin/kyc/checks/:id/retry: the check is queued again. */
export const adminIrdCheckRetryResponseSchema = z.strictObject({
  check_id: z.uuid(),
  status: z.literal('QUEUED'),
});
export type AdminIrdCheckRetryResponse = z.infer<typeof adminIrdCheckRetryResponseSchema>;
