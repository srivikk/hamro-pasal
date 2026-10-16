import { userRoles, users, vendors, type Database } from '@hamro-pasal/db';
import {
  OTP_MAX_VERIFY_ATTEMPTS,
  REFRESH_TOKEN_TTL_SECONDS,
  type AppVariant,
  type User,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { and, eq, type SQL } from 'drizzle-orm';

import type { SmsGateway } from '@hamro-pasal/sms';
import { ACCESS_TOKEN, signAccessToken } from './access-token';
import { generateOtpCode, type OtpStore } from './otp-store';
import { InvalidRefreshTokenError, signRefreshToken, verifyRefreshToken } from './refresh-token';
import { SELLER_SIGNUP_TOKEN, signSellerSignupToken } from './seller-signup-token';

/**
 * Step 7.7: the Seller app signed in a number that has no shop. The code was right, so the error
 * carries a short-lived token proving the number, for POST /api/seller/signup.
 */
export class RoleNotGrantedError extends Error {
  constructor(
    readonly role: UserRole,
    readonly signupToken: string,
    readonly signupTokenExpiresIn: number,
  ) {
    super(`This number has no ${role.toLowerCase()} account yet`);
    this.name = 'RoleNotGrantedError';
  }
}

/**
 * Phase 36: the number belongs to a vendor that closed its shop. The account is kept for the
 * ledger and can no longer sign in; no code is sent to it.
 */
export class AccountDeactivatedError extends Error {
  constructor() {
    super('This shop account has been deactivated. Contact Hamro Pasal support.');
    this.name = 'AccountDeactivatedError';
  }
}

export class OtpCooldownError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`A code was sent recently; retry in ${String(retryAfterSeconds)} s`);
    this.name = 'OtpCooldownError';
  }
}

export class OtpInvalidError extends Error {
  constructor(readonly attemptsRemaining: number) {
    super(`Wrong code; ${String(attemptsRemaining)} attempts left`);
    this.name = 'OtpInvalidError';
  }
}

export class OtpAttemptsExceededError extends Error {
  constructor() {
    super(`Too many wrong codes (${String(OTP_MAX_VERIFY_ATTEMPTS)}); request a new one`);
    this.name = 'OtpAttemptsExceededError';
  }
}

/** Never sent, expired (2 min), already used, or burned by too many attempts. */
export class OtpExpiredError extends Error {
  constructor() {
    super('No valid code for this number; request a new one');
    this.name = 'OtpExpiredError';
  }
}

export interface OtpSent {
  readonly phone: string;
  readonly expiresInSeconds: number;
  readonly resendAfterSeconds: number;
}

export interface AuthSession {
  readonly accessToken: string;
  readonly accessTokenExpiresIn: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresIn: number;
  readonly user: Pick<User, 'id' | 'role' | 'first_name'> & { readonly roles: UserRole[] };
  readonly isNewUser: boolean;
}

export interface RefreshedAccess {
  readonly accessToken: string;
  readonly accessTokenExpiresIn: number;
}

export interface RefreshedCookieSession extends RefreshedAccess {
  readonly user: Pick<User, 'id' | 'role' | 'first_name' | 'phone'>;
}

export interface AuthSecrets {
  readonly accessTokenSecret: string;
  readonly refreshTokenSecret: string;
}

/**
 * The OTP SMS. Plain ASCII keeps it to one GSM-7 segment (Devanagari would force the more expensive
 * Unicode encoding); well under the 335-character limit.
 */
export function otpSmsText(code: string, ttlSeconds: number): string {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const lifetime = minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  return (
    `Hamro Pasal: your login code is ${code}. It expires in ${lifetime}. ` +
    `Do not share it with anyone.`
  );
}

/**
 * SPEC customer journey 1 (and vendor journey 1): "Auth via OTP (+977 only)".
 *   send   - per-phone resend cooldown, fresh 6-digit code in Redis (2 min), SMS via the adapter
 *   verify - atomic single-use check (5 attempts), fetch-or-create the CUSTOMER, mint a 15-min
 *            access token (JWT_ACCESS_SECRET) and a 7-day refresh token (JWT_REFRESH_SECRET)
 */
export class OtpAuthService {
  constructor(
    private readonly db: Database,
    private readonly otps: OtpStore,
    private readonly sms: SmsGateway,
    private readonly secrets: AuthSecrets,
  ) {}

  /** True when the account is a vendor whose shop was deactivated. */
  private async isDeactivated(where: SQL): Promise<boolean> {
    const [row] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .innerJoin(users, eq(users.id, vendors.user_id))
      .where(and(where, eq(vendors.status, 'DEACTIVATED')))
      .limit(1);
    return row !== undefined;
  }

  async sendOtp(phone: string): Promise<OtpSent> {
    // Before the cooldown and the SMS: a closed account is not texted (or billed) a code.
    if (await this.isDeactivated(eq(users.phone, phone))) throw new AccountDeactivatedError();
    const cooldownLeftMs = await this.otps.claimCooldown(phone);
    if (cooldownLeftMs !== null) {
      throw new OtpCooldownError(Math.max(1, Math.ceil(cooldownLeftMs / 1000)));
    }

    const code = generateOtpCode();
    // Stored before sending, so the code already works when the SMS arrives.
    await this.otps.save(phone, code);
    try {
      await this.sms.send({ to: phone, text: otpSmsText(code, this.otps.ttlMs / 1000) });
    } catch (error: unknown) {
      await this.otps.discard(phone);
      throw error;
    }
    return {
      phone,
      expiresInSeconds: Math.round(this.otps.ttlMs / 1000),
      resendAfterSeconds: Math.round(this.otps.cooldownMs / 1000),
    };
  }

  async verifyOtp(phone: string, code: string, app?: AppVariant): Promise<AuthSession> {
    const check = await this.otps.checkAndConsume(phone, code);
    switch (check.outcome) {
      case 'VALID':
        break;
      case 'WRONG':
        throw new OtpInvalidError(check.attemptsRemaining);
      case 'ATTEMPTS_EXCEEDED':
        throw new OtpAttemptsExceededError();
      case 'MISSING':
        throw new OtpExpiredError();
    }

    const { user, isNewUser } = await this.findOrCreateCustomer(phone);
    // A code sent just before the shop was closed opens nothing.
    if (await this.isDeactivated(eq(users.id, user.id))) throw new AccountDeactivatedError();
    const role = await this.roleForApp(user, app);
    // Without an app (the web, older apps) the session follows the primary role at each refresh,
    // as before; an app's session keeps the role it signed in with.
    return this.sessionFor(user, role, isNewUser, app !== undefined);
  }

  /**
   * Step 7.7: a session for the account in one of its roles (after a sign-in, or after the Seller
   * app signup granted the vendor role). With `pinRole` the refresh token remembers the role.
   */
  async sessionFor(
    user: Pick<User, 'id' | 'first_name'>,
    role: UserRole,
    isNewUser = false,
    pinRole = true,
  ): Promise<AuthSession> {
    return {
      accessToken: signAccessToken({ userId: user.id, role }, this.secrets.accessTokenSecret),
      accessTokenExpiresIn: ACCESS_TOKEN.ttlSeconds,
      refreshToken: signRefreshToken(
        user.id,
        this.secrets.refreshTokenSecret,
        pinRole ? role : undefined,
      ),
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      user: { id: user.id, role, first_name: user.first_name, roles: await this.rolesOf(user.id) },
      isNewUser,
    };
  }

  /**
   * Which role the app signs in with (decided 2026-10-15: one account, several roles):
   *  - no app (the web dashboard, older apps): the primary role, as before;
   *  - CUSTOMER: the customer role, added to the account when it lacks it (anyone may shop); a
   *    rider stays a DRIVER, since riders use the customer build;
   *  - SELLER: the vendor role of an account that has a shop, else ROLE_NOT_GRANTED with a signup
   *    token.
   */
  private async roleForApp(user: User, app: AppVariant | undefined): Promise<UserRole> {
    if (app === undefined) return user.role;
    const roles = await this.rolesOf(user.id);
    if (app === 'CUSTOMER') {
      if (user.role === 'DRIVER') return 'DRIVER';
      if (!roles.includes('CUSTOMER')) {
        await this.db
          .insert(userRoles)
          .values({ user_id: user.id, role: 'CUSTOMER' })
          .onConflictDoNothing();
      }
      return 'CUSTOMER';
    }
    const [shop] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, user.id));
    if (shop !== undefined && roles.includes('VENDOR')) return 'VENDOR';
    throw new RoleNotGrantedError(
      'VENDOR',
      signSellerSignupToken(user.id, this.secrets.refreshTokenSecret),
      SELLER_SIGNUP_TOKEN.ttlSeconds,
    );
  }

  async rolesOf(userId: string): Promise<UserRole[]> {
    const rows = await this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.user_id, userId))
      .orderBy(userRoles.role);
    return rows.map((row) => row.role);
  }

  /**
   * POST /api/auth/token/refresh. The refresh token must carry our signature (JWT_REFRESH_SECRET),
   * the refresh audience and type, and be unexpired. The role is read from the database, not the
   * token, so a role change applies at the next refresh. A deleted account gets no new token.
   */
  async refreshAccessToken(refreshToken: string): Promise<RefreshedAccess> {
    const { userId, role: sessionRole } = verifyRefreshToken(
      refreshToken,
      this.secrets.refreshTokenSecret,
    );
    const [user] = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    if (user === undefined) {
      throw new InvalidRefreshTokenError('account no longer exists');
    }
    // Step 7.7: the session keeps the role it signed in with, while the account still holds it.
    const role = sessionRole ?? user.role;
    if (sessionRole !== null && !(await this.rolesOf(user.id)).includes(sessionRole)) {
      throw new InvalidRefreshTokenError(`the account no longer holds the ${sessionRole} role`);
    }
    // Phase 36: the session of a closed shop ends at its next refresh (15 minutes at most).
    if (await this.isDeactivated(eq(users.id, user.id))) {
      throw new InvalidRefreshTokenError('the shop account was deactivated');
    }
    return {
      accessToken: signAccessToken({ userId: user.id, role }, this.secrets.accessTokenSecret),
      accessTokenExpiresIn: ACCESS_TOKEN.ttlSeconds,
    };
  }

  /**
   * POST /api/auth/refresh (Phase 16): the same checks for a refresh token that arrived in the
   * HttpOnly cookie. Only Super Admin sign-ins are given that cookie, so an account that is no
   * longer a SUPER_ADMIN gets no token from it (a demotion ends the browser session at the next
   * refresh). The account is returned too: a reloaded dashboard knows nothing else about itself.
   */
  async refreshCookieSession(refreshToken: string): Promise<RefreshedCookieSession> {
    const { userId } = verifyRefreshToken(refreshToken, this.secrets.refreshTokenSecret);
    const [user] = await this.db
      .select({
        id: users.id,
        role: users.role,
        first_name: users.first_name,
        phone: users.phone,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (user === undefined) {
      throw new InvalidRefreshTokenError('account no longer exists');
    }
    if (user.role !== 'SUPER_ADMIN') {
      throw new InvalidRefreshTokenError('cookie sessions are for Super Admins only');
    }
    return {
      accessToken: signAccessToken(
        { userId: user.id, role: user.role },
        this.secrets.accessTokenSecret,
      ),
      accessTokenExpiresIn: ACCESS_TOKEN.ttlSeconds,
      user,
    };
  }

  /**
   * An existing account keeps its role (a vendor signing in stays a VENDOR; routes decide what each
   * role may do). An unknown number becomes a new CUSTOMER with no name yet. ON CONFLICT makes two
   * simultaneous first logins of the same number resolve to one account.
   */
  private async findOrCreateCustomer(phone: string): Promise<{ user: User; isNewUser: boolean }> {
    const [created] = await this.db
      .insert(users)
      .values({ phone, role: 'CUSTOMER' })
      .onConflictDoNothing({ target: users.phone })
      .returning();
    if (created !== undefined) {
      return { user: created, isNewUser: true };
    }
    const [existing] = await this.db.select().from(users).where(eq(users.phone, phone));
    if (existing === undefined) {
      throw new Error('User vanished between insert and select');
    }
    return { user: existing, isNewUser: false };
  }
}
