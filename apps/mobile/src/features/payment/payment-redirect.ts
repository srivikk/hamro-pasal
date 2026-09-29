import type {
  EsewaInitiateResponseBody,
  KhaltiInitiateResponseBody,
} from '@hamro-pasal/shared-types';

/*
 * Pure payment WebView logic: what to load, and how to classify every URL the WebView visits.
 * Kept free of React so the redirect rules are unit-tested exhaustively.
 */

/** What the payment WebView loads and which redirects end the payment. */
export type PaymentTarget =
  | {
      method: 'ESEWA';
      orderId: string;
      /** Auto-submitting form that POSTs the signed fields to eSewa (SPEC: ePay v2). */
      html: string;
      /** `success_url` / `failure_url` from the signed fields, reduced to origin + path. */
      successUrl: string;
      failureUrl: string;
    }
  | {
      method: 'KHALTI';
      orderId: string;
      paymentUrl: string;
      pidx: string;
    };

export type PaymentRedirect =
  /** Not a callback: an eSewa/Khalti page, or the auto-submit form itself. Keep browsing. */
  | { kind: 'none' }
  /** eSewa's success redirect. `data` is the signed base64 payload, exactly as eSewa sent it. */
  | { kind: 'esewa_success'; data: string }
  /** Khalti's return_url redirect for this payment's pidx. */
  | { kind: 'khalti_return'; pidx: string; status: string | null }
  /** eSewa failure_url, or a return without the data needed to confirm. Payment not completed. */
  | { kind: 'failure' };

export class PaymentTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentTargetError';
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** `scheme://host[:port]/path` of an absolute http(s) URL, or null. Query and fragment dropped. */
function originAndPath(url: string): string | null {
  const match = /^(https?:\/\/[^/?#\s]+)(\/[^?#\s]*)?/i.exec(url.trim());
  if (match === null) return null;
  const origin = (match[1] ?? '').toLowerCase();
  const path = (match[2] ?? '/').replace(/\/+$/, '') || '/';
  return `${origin}${path}`;
}

function originOf(url: string): string | null {
  const match = /^(https?:\/\/[^/?#\s]+)/i.exec(url.trim());
  return match === null ? null : (match[1] ?? '').toLowerCase();
}

function requireHttpUrl(url: string, what: string): string {
  // z.url() accepts any scheme (javascript:, data:...); only http(s) may ever be loaded or posted to.
  const normalised = originAndPath(url);
  if (normalised === null) throw new PaymentTargetError(`${what} is not an http(s) URL: ${url}`);
  return normalised;
}

/**
 * Raw value of query parameter `name`, percent-decoded once but otherwise untouched. The eSewa
 * signature covers the exact base64 text, so URLSearchParams is not used: it turns `+` into a space.
 */
export function rawQueryParam(url: string, name: string): string | null {
  const query = url.split('#')[0]?.split('?').slice(1).join('?') ?? '';
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=');
    const key = separator === -1 ? pair : pair.slice(0, separator);
    if (key !== name) continue;
    const value = separator === -1 ? '' : pair.slice(separator + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** HTML page that immediately POSTs the signed eSewa fields to `payment_url`. Every value is escaped. */
export function buildEsewaFormHtml(
  paymentUrl: string,
  fields: Readonly<Record<string, string>>,
): string {
  const inputs = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`,
    )
    .join('');
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" /></head>',
    '<body onload="document.forms[0].submit()">',
    `<form method="POST" action="${escapeHtml(paymentUrl)}">${inputs}`,
    '<noscript><button type="submit">Continue to eSewa</button></noscript>',
    '</form></body></html>',
  ].join('');
}

export function esewaTarget(orderId: string, response: EsewaInitiateResponseBody): PaymentTarget {
  requireHttpUrl(response.payment_url, 'eSewa payment_url');
  const { success_url: successUrl, failure_url: failureUrl } = response.fields;
  if (successUrl === undefined || failureUrl === undefined) {
    throw new PaymentTargetError('eSewa fields lack success_url / failure_url');
  }
  return {
    method: 'ESEWA',
    orderId,
    html: buildEsewaFormHtml(response.payment_url, response.fields),
    successUrl: requireHttpUrl(successUrl, 'eSewa success_url'),
    failureUrl: requireHttpUrl(failureUrl, 'eSewa failure_url'),
  };
}

export function khaltiTarget(orderId: string, response: KhaltiInitiateResponseBody): PaymentTarget {
  requireHttpUrl(response.payment_url, 'Khalti payment_url');
  return {
    method: 'KHALTI',
    orderId,
    paymentUrl: response.payment_url.trim(),
    pidx: response.pidx,
  };
}

/**
 * Classifies a URL the WebView navigated to.
 *
 * eSewa: success_url and failure_url are compared on origin + path (never by substring, so
 * `https://evil.test/?next=<success_url>` does not match).
 *
 * Khalti: its return_url is configured on the server and not sent to the app, so the return is
 * recognised as any page outside Khalti's own origin that carries this payment's `pidx`.
 */
export function interpretNavigation(target: PaymentTarget, url: string): PaymentRedirect {
  const location = originAndPath(url);
  if (location === null) return { kind: 'none' };

  if (target.method === 'ESEWA') {
    if (location === target.failureUrl) return { kind: 'failure' };
    if (location !== target.successUrl) return { kind: 'none' };
    const data = rawQueryParam(url, 'data');
    return data === null || data === '' ? { kind: 'failure' } : { kind: 'esewa_success', data };
  }

  if (originOf(url) === originOf(target.paymentUrl)) return { kind: 'none' };
  const pidx = rawQueryParam(url, 'pidx');
  if (pidx !== target.pidx) return { kind: 'none' };
  return { kind: 'khalti_return', pidx, status: rawQueryParam(url, 'status') };
}

/**
 * Khalti reports the outcome in the return URL's `status`. Only these may be paid, so only these
 * are confirmed through the server lookup; "User canceled", "Expired" and the rest are failures.
 */
export function khaltiStatusNeedsLookup(status: string | null): boolean {
  return status === null || status === 'Completed' || status === 'Pending';
}
