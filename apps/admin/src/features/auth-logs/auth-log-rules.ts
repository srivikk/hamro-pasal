import {
  OTP_REVEAL_REASON_MAX_LENGTH,
  OTP_REVEAL_REASON_MIN_LENGTH,
  type AuthEventKind,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

/*
 * 2026-10-21 (Task 5, decided by the user: "guarded reveal"): the Authentication Logs screen's
 * rules. A live login code is shown only after a written reason, which goes to the audit trail.
 */

export const AUTH_EVENT_LABELS: Readonly<Record<AuthEventKind, string>> = {
  OTP_SENT: 'Code sent',
  OTP_SEND_FAILED: 'SMS failed',
  OTP_COOLDOWN: 'Resend too soon',
  OTP_VERIFIED: 'Signed in',
  OTP_WRONG: 'Wrong code',
  OTP_LOCKED: 'Locked (too many tries)',
  OTP_EXPIRED: 'No live code',
};

/** The badge tone of an event: failures stand out. */
export function eventTone(kind: AuthEventKind): 'ok' | 'warn' | 'bad' {
  if (kind === 'OTP_SENT' || kind === 'OTP_VERIFIED') return 'ok';
  if (kind === 'OTP_SEND_FAILED' || kind === 'OTP_LOCKED') return 'bad';
  return 'warn';
}

/**
 * A number as typed into the filter, as the API stores it: +977 and 10 digits. "9801234567",
 * "+977 980-123-4567" and "977 9801234567" are all +9779801234567; anything else is null.
 */
export function normalisePhone(typed: string): string | null {
  const digits = typed.replace(/[\s()-]/g, '');
  const local = /^(?:\+?977)?(9\d{9})$/.exec(digits)?.[1];
  return local === undefined ? null : `+977${local}`;
}

/** The reason as the API takes it, or the message to show instead. */
export function checkRevealReason(
  reason: string,
): { ok: true; reason: string } | { ok: false; message: string } {
  const trimmed = reason.trim();
  if (
    trimmed.length < OTP_REVEAL_REASON_MIN_LENGTH ||
    trimmed.length > OTP_REVEAL_REASON_MAX_LENGTH
  ) {
    return {
      ok: false,
      message: `Write why you need the code (${String(OTP_REVEAL_REASON_MIN_LENGTH)} to ${String(OTP_REVEAL_REASON_MAX_LENGTH)} characters). It is kept in the audit log.`,
    };
  }
  return { ok: true, reason: trimmed };
}

/** "1:42": what is left of a revealed code's life. */
export function countdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60))}:${String(safe % 60).padStart(2, '0')}`;
}

export function authLogErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'OTP_REVEAL_DISABLED':
        return 'Codes cannot be revealed on this server (OTP_ADMIN_REVEAL is off).';
      case 'OTP_NOT_LIVE':
        return 'That code is no longer live: it was used, burned or expired. Ask for a new one.';
      case 'NETWORK_ERROR':
        return 'No connection to the server. Check the network and try again.';
      default:
        return error.message;
    }
  }
  return 'Something went wrong. Try again.';
}
