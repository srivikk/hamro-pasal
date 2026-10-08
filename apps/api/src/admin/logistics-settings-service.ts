import {
  platformSettings,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  NO_AUDIT_CONTEXT,
  PLATFORM_SETTINGS_ENTITY_ID,
  type AuditContext,
  type LogisticsSettingsWrite,
} from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';

type PlatformSettingsRow = typeof platformSettings.$inferSelect;

export interface LogisticsSettings {
  readonly settings: PlatformSettingsRow;
  /** LIVE shops on each delivery mode: the shops a switched-off mode takes offline. */
  readonly selfDeliveryVendorCount: number;
  readonly platformFleetVendorCount: number;
}

/**
 * The platform's delivery switches and its fleet delivery charge (SPEC Super Admin flow step 4).
 *
 * Both modes may be off: the global Emergency Stop. Nothing is written per vendor for a
 * switched-off mode; the feed, the menu and checkout read these three columns (CatalogService
 * `enabledModes`), so shops return by themselves when a mode is switched on again.
 */
export class LogisticsSettingsService {
  constructor(private readonly db: Database) {}

  /** One snapshot, so the settings and the counts agree. */
  get(): Promise<LogisticsSettings> {
    return this.db.transaction(async (tx) => withCounts(tx, await currentSettings(tx)), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  /**
   * One transaction under the settings row lock, with its audit entry. Saving what is stored
   * changes and records nothing.
   */
  update(
    adminUserId: string,
    input: LogisticsSettingsWrite,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<LogisticsSettings> {
    return this.db.transaction(async (tx) => {
      const before = await currentSettings(tx, true);
      if (
        before.self_delivery_enabled === input.self_delivery_enabled &&
        before.platform_fleet_enabled === input.platform_fleet_enabled &&
        before.platform_delivery_fee_npr === input.platform_delivery_fee_npr
      ) {
        return withCounts(tx, before);
      }

      const [after] = await tx
        .update(platformSettings)
        .set({
          self_delivery_enabled: input.self_delivery_enabled,
          platform_fleet_enabled: input.platform_fleet_enabled,
          platform_delivery_fee_npr: input.platform_delivery_fee_npr,
          updated_at: sql`now()`,
        })
        .where(eq(platformSettings.id, true))
        .returning();
      if (after === undefined) throw new Error('platform_settings row is missing');

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'LOGISTICS_SETTINGS_CHANGED',
        entityId: PLATFORM_SETTINGS_ENTITY_ID,
        vendorId: null,
        beforeState: logisticsState(before),
        afterState: logisticsState(after),
        context,
      });
      return withCounts(tx, after);
    });
  }
}

async function currentSettings(tx: Transaction, lock = false): Promise<PlatformSettingsRow> {
  const query = tx.select().from(platformSettings);
  const [settings] = await (lock ? query.for('update') : query);
  if (settings === undefined) throw new Error('platform_settings row is missing');
  return settings;
}

async function withCounts(
  tx: Transaction,
  settings: PlatformSettingsRow,
): Promise<LogisticsSettings> {
  const [counts] = await tx
    .select({
      selfDelivery: sql<number>`count(*) FILTER (WHERE ${vendors.fulfillment_mode} = 'SELF_DELIVERY')::int`,
      platformFleet: sql<number>`count(*) FILTER (WHERE ${vendors.fulfillment_mode} = 'PLATFORM_FLEET')::int`,
    })
    .from(vendors)
    .where(eq(vendors.status, 'LIVE'));
  return {
    settings,
    selfDeliveryVendorCount: counts?.selfDelivery ?? 0,
    platformFleetVendorCount: counts?.platformFleet ?? 0,
  };
}

function logisticsState(settings: PlatformSettingsRow) {
  return {
    self_delivery_enabled: settings.self_delivery_enabled,
    platform_fleet_enabled: settings.platform_fleet_enabled,
    platform_delivery_fee_npr: settings.platform_delivery_fee_npr,
  };
}
