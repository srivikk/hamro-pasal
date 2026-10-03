import {
  devicePlatforms,
  EXPO_PUSH_TOKEN_MAX_LENGTH,
  EXPO_PUSH_TOKEN_PATTERN,
  type DevicePlatform,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';
import { users } from './users';

/**
 * Phase 20: Expo push tokens, one row per app installation. A token names a device, not an
 * account: it is unique, and registering it again moves the row to the caller (the last account
 * to sign in on a phone is the one that receives its pushes). An account may have several devices.
 * Vendors are reached through their user (vendors.user_id). The worker deletes a token Expo
 * reports as DeviceNotRegistered.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: primaryId(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull(),
    platform: text().$type<DevicePlatform>().notNull(),
    created_at: createdAt(),
    /** The last registration (the app registers on every launch with a session). */
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('device_tokens_token_uidx').on(t.token),
    index('device_tokens_user_id_idx').on(t.user_id),
    check(
      'device_tokens_token_check',
      sql`${t.token} ~ '${sql.raw(EXPO_PUSH_TOKEN_PATTERN)}' AND char_length(${t.token}) <= ${sql.raw(String(EXPO_PUSH_TOKEN_MAX_LENGTH))}`,
    ),
    check(
      'device_tokens_platform_check',
      sql`${t.platform} IN (${sql.raw(devicePlatforms.map((platform) => `'${platform}'`).join(', '))})`,
    ),
  ],
);
