import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import {
  MAX_AUDIT_REQUEST_ID_LENGTH,
  MAX_AUDIT_USER_AGENT_LENGTH,
  type AuditActor,
  type AuditContext,
} from '@hamro-pasal/shared-types';
import type { Request, RequestHandler, Response } from 'express';

import { authOf } from './auth';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** What a caller (the load balancer, a client) may supply as a request id. */
const SUPPLIED_REQUEST_ID = new RegExp(
  `^[A-Za-z0-9._-]{1,${String(MAX_AUDIT_REQUEST_ID_LENGTH)}}$`,
);

interface RequestLocals {
  requestId?: string;
}

/**
 * Gives every request an id: the caller's `X-Request-Id` when it is well formed, otherwise a new
 * UUID. It is echoed on the response and written to the audit trail, so an entry can be matched
 * to the logs of the request that caused it.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const supplied = req.get(REQUEST_ID_HEADER);
  const id = supplied !== undefined && SUPPLIED_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  (res.locals as RequestLocals).requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};

/** "::ffff:103.10.28.14" (an IPv4 client on a dual-stack socket) -> "103.10.28.14". */
function clientAddress(address: string | undefined): string | null {
  if (address === undefined) return null;
  const unmapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (isIP(unmapped) !== 0) return unmapped;
  return isIP(address) !== 0 ? address : null;
}

/**
 * Where a request came from, for `recordAuditLog`. Anything unusable becomes null rather than
 * failing the request: a missing address must never stop a vendor's opt-in from being recorded.
 *
 * `req.ip` is the socket's peer unless Express's `trust proxy` is configured for the load
 * balancer in front of the API; set it at deployment, or every entry carries the balancer's address.
 */
export function auditContextOf(req: Request, res: Response): AuditContext {
  const userAgent = req.get('user-agent')?.trim() ?? '';
  return {
    request_id: (res.locals as RequestLocals).requestId ?? null,
    ip_address: clientAddress(req.ip),
    user_agent: userAgent === '' ? null : userAgent.slice(0, MAX_AUDIT_USER_AGENT_LENGTH),
  };
}

/** The signed-in caller as an audit actor; only valid behind `requireAuth`. */
export function auditActorOf(req: Request): AuditActor {
  const { userId, role } = authOf(req);
  return { kind: 'USER', user_id: userId, role };
}
