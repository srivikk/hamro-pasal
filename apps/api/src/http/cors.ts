import type { RequestHandler } from 'express';

import { HttpError } from './errors';

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';
const ALLOWED_HEADERS = 'Authorization, Content-Type, X-Request-Id';
const EXPOSED_HEADERS = 'X-Request-Id';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * Strict CORS: an exact allowlist (`CORS_ALLOWED_ORIGINS`), empty by default.
 *
 * Who needs it: nobody, in the planned deployment. The mobile apps (customer, vendor, rider) are
 * not browsers and send no `Origin`, and the admin dashboard is served from the API's own origin.
 * The allowlist exists for a dashboard hosted on another origin (`https://admin.…`), and nothing
 * else is ever let in:
 *
 * - an origin is allowed only if it is in the list, compared as an exact string. There is no
 *   wildcard, no pattern, and the request's origin is never reflected unless it is listed;
 * - a listed origin gets `Access-Control-Allow-Origin: <that origin>` and credentials (the Super
 *   Admin's HttpOnly refresh cookie is `SameSite=Strict`, so only a same-site origin can send it);
 * - a preflight from any other origin is refused with 403, so the browser never sends the request;
 * - a request without `Origin`, or a simple request from an unlisted origin, is handled as usual
 *   and answered **without** CORS headers: the browser keeps the response from the page that
 *   asked. (A same-origin POST also carries `Origin`, so such requests cannot be refused here.)
 *
 * CORS is a browser rule, not authentication: every route still checks its bearer token.
 */
export function strictCors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin === undefined) {
      next();
      return;
    }
    // The answer depends on the origin: a shared cache must not serve one origin's to another.
    res.vary('Origin');

    const preflight =
      req.method === 'OPTIONS' && req.get('access-control-request-method') !== undefined;

    if (!allowed.has(origin)) {
      if (preflight) {
        next(new HttpError(403, 'CORS_ORIGIN_NOT_ALLOWED', 'This origin may not call the API'));
        return;
      }
      next();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    if (!preflight) {
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
    res.status(204).end();
  };
}
