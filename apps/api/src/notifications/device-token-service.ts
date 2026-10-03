import { deviceTokens, type Database } from '@hamro-pasal/db';
import type { DevicePlatform } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';

import { isForeignKeyViolation } from '../infra/pg-errors';

/** The access token outlived its account (deleted within the token's 15 minutes). */
export class DeviceTokenOwnerNotFoundError extends Error {
  constructor() {
    super('The signed-in account no longer exists');
    this.name = 'DeviceTokenOwnerNotFoundError';
  }
}

export interface RegisteredDeviceToken {
  readonly token: string;
  readonly platform: DevicePlatform;
  readonly updatedAt: Date;
}

/** Phase 20: the Expo push tokens the worker sends order notifications to. */
export class DeviceTokenService {
  constructor(private readonly db: Database) {}

  /**
   * Registers a device's Expo push token for the caller, or refreshes it. One statement: a token
   * is unique, so a phone on which another account signs in moves to that account (the previous
   * one stops receiving this phone's pushes), and a repeat only updates `updated_at`.
   */
  async register(input: {
    readonly userId: string;
    readonly token: string;
    readonly platform: DevicePlatform;
  }): Promise<RegisteredDeviceToken> {
    try {
      const [row] = await this.db
        .insert(deviceTokens)
        .values({ user_id: input.userId, token: input.token, platform: input.platform })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          set: { user_id: input.userId, platform: input.platform, updated_at: sql`now()` },
        })
        .returning({
          token: deviceTokens.token,
          platform: deviceTokens.platform,
          updatedAt: deviceTokens.updated_at,
        });
      if (row === undefined) throw new Error('device token upsert returned no row');
      return row;
    } catch (error: unknown) {
      if (isForeignKeyViolation(error, 'device_tokens_user_id_users_id_fk')) {
        throw new DeviceTokenOwnerNotFoundError();
      }
      throw error;
    }
  }
}
