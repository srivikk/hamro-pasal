import { users, type Database } from '@hamro-pasal/db';
import {
  OTP_MAX_VERIFY_ATTEMPTS,
  REFRESH_TOKEN_TTL_SECONDS,
  type User,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import type { SmsGateway } from '@hamro-pasal/sms';
import { ACCESS_TOKEN, signAccessToken } from './access-token';
import { generateOtpCode, type OtpStore } from './otp-store';
import { InvalidRefreshTokenError, signRefreshToken, verifyRefreshToken } from './refresh-token';

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
  readonly user: Pick<User, 'id' | 'role' | 'first_name'>;
  readonly isNewUser: boolean;
}

export interface RefreshedAccess {
  readonly accessToken: string;
  readonly accessTokenExpiresIn: number;
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
  const minutes = String(Math.round(ttlSeconds / 60));
  return (
    `Hamro Pasal: your login code is ${code}. It expires in ${minutes} minutes. ` +
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

  async sendOtp(phone: string): Promise<OtpSent> {
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

  async verifyOtp(phone: string, code: string): Promise<AuthSession> {
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
    return {
      accessToken: signAccessToken(
        { userId: user.id, role: user.role },
        this.secrets.accessTokenSecret,
      ),
      accessTokenExpiresIn: ACCESS_TOKEN.ttlSeconds,
      refreshToken: signRefreshToken(user.id, this.secrets.refreshTokenSecret),
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      user: { id: user.id, role: user.role, first_name: user.first_name },
      isNewUser,
    };
  }

  /**
   * POST /api/auth/token/refresh. The refresh token must carry our signature (JWT_REFRESH_SECRET),
   * the refresh audience and type, and be unexpired. The role is read from the database, not the
   * token, so a role change applies at the next refresh. A deleted account gets no new token.
   */
  async refreshAccessToken(refreshToken: string): Promise<RefreshedAccess> {
    const { userId } = verifyRefreshToken(refreshToken, this.secrets.refreshTokenSecret);
    const [user] = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    if (user === undefined) {
      throw new InvalidRefreshTokenError('account no longer exists');
    }
    return {
      accessToken: signAccessToken(
        { userId: user.id, role: user.role },
        this.secrets.accessTokenSecret,
      ),
      accessTokenExpiresIn: ACCESS_TOKEN.ttlSeconds,
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
