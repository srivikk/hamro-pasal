import {
  GEO_SRID,
  NEPAL_PHONE_PATTERN,
  NEPAL_PROVINCE_ID_MAX,
  NEPAL_PROVINCE_ID_MIN,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, geoPoint, primaryId, updatedAt } from './columns';
import { accountStatusEnum, languagePreferenceEnum, userRoleEnum } from './enums';

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    phone: text().notNull().unique(),
    role: userRoleEnum().notNull(),
    // Null until the customer adds a name: OTP sign-up only knows the phone number.
    first_name: text(),
    last_name: text(),
    // Step 7.1 (2026-10-15): the account's own settings, read and written through /api/me.
    email: text(),
    language_preference: languagePreferenceEnum().notNull().default('en'),
    terms_accepted_at: timestamp({ withTimezone: true }),
    whatsapp_opt_in: boolean().notNull().default(false),
    account_status: accountStatusEnum().notNull().default('ACTIVE'),
    deletion_requested_at: timestamp({ withTimezone: true }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    check('users_phone_np_check', sql`${t.phone} ~ '${sql.raw(NEPAL_PHONE_PATTERN)}'`),
    check('users_first_name_check', sql`${t.first_name} IS NULL OR btrim(${t.first_name}) <> ''`),
    check('users_last_name_check', sql`${t.last_name} IS NULL OR btrim(${t.last_name}) <> ''`),
    // Stored lower-cased, so the unique index below is case-insensitive.
    check(
      'users_email_check',
      sql`${t.email} IS NULL OR (${t.email} = lower(btrim(${t.email})) AND ${t.email} LIKE '_%@_%')`,
    ),
    uniqueIndex('users_email_uidx')
      .on(t.email)
      .where(sql`${t.email} IS NOT NULL`),
    check(
      'users_deletion_requested_check',
      sql`(${t.account_status} = 'DELETED_REQUESTED') = (${t.deletion_requested_at} IS NOT NULL)`,
    ),
  ],
);

/** Nepal address hierarchy (Province, District, Palika, Ward, Tole) plus a dropped pin. */
export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: primaryId(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    province_id: smallint().notNull(),
    district_string: text().notNull(),
    municipality_palika_string: text().notNull(),
    ward_number: integer().notNull(),
    tole_locality: text().notNull(),
    landmark: text().notNull(),
    exact_lat: doublePrecision().notNull(),
    exact_lng: doublePrecision().notNull(),
    // Derived from the pin so the geometry can never disagree with exact_lat/exact_lng.
    location: geoPoint()
      .notNull()
      .generatedAlwaysAs(
        sql`ST_SetSRID(ST_MakePoint("exact_lng", "exact_lat"), ${sql.raw(String(GEO_SRID))})`,
      ),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('customer_addresses_user_id_idx').on(t.user_id),
    index('customer_addresses_location_gist').using('gist', t.location),
    check(
      'customer_addresses_province_check',
      sql`${t.province_id} BETWEEN ${sql.raw(String(NEPAL_PROVINCE_ID_MIN))} AND ${sql.raw(String(NEPAL_PROVINCE_ID_MAX))}`,
    ),
    check('customer_addresses_ward_check', sql`${t.ward_number} >= 1`),
    check('customer_addresses_lat_check', sql`${t.exact_lat} BETWEEN -90 AND 90`),
    check('customer_addresses_lng_check', sql`${t.exact_lng} BETWEEN -180 AND 180`),
  ],
);
