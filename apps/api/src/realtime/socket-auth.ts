import { SOCKET_UNAUTHENTICATED, type UserRole } from '@hamro-pasal/shared-types';
import type { ExtendedError, Socket } from 'socket.io';

import { verifyAccessToken } from '../auth/access-token';

/** What every authenticated namespace keeps about its caller. */
export interface AuthenticatedSocketData {
  userId: string;
  role: UserRole;
}

/** A handshake refusal the client receives as `connect_error` (message + data.code). */
export function refusal(code: string, message: string): ExtendedError & { data: { code: string } } {
  return Object.assign(new Error(code), { data: { code, message } });
}

/**
 * Namespace middleware shared by `/orders` and `/chat`: the handshake must carry a valid access
 * token in `auth.token` (the same HS256 contract as `Authorization: Bearer`). A missing, invalid
 * or expired token (or a refresh token) is refused with UNAUTHENTICATED, which the mobile client
 * answers by renewing its token; a valid token for another role is refused with FORBIDDEN.
 */
export function socketAuth(
  accessTokenSecret: string,
  allowedRoles: readonly UserRole[],
  forbiddenMessage: string,
) {
  return (
    socket: Socket<object, object, object, AuthenticatedSocketData>,
    next: (error?: ExtendedError) => void,
  ): void => {
    const auth: unknown = socket.handshake.auth;
    const token: unknown =
      typeof auth === 'object' && auth !== null ? Reflect.get(auth, 'token') : undefined;
    if (typeof token !== 'string' || token === '') {
      next(refusal(SOCKET_UNAUTHENTICATED, 'Missing access token'));
      return;
    }
    try {
      const claims = verifyAccessToken(token, accessTokenSecret);
      if (!allowedRoles.includes(claims.role)) {
        next(refusal('FORBIDDEN', forbiddenMessage));
        return;
      }
      socket.data.userId = claims.userId;
      socket.data.role = claims.role;
      next();
    } catch {
      next(refusal(SOCKET_UNAUTHENTICATED, 'Invalid or expired access token'));
    }
  };
}
