import {
  platformSettings,
  recordAuditLog,
  vendors,
  type Database,
  type Executor,
} from '@hamro-pasal/db';
import {
  MAX_SERVICEABLE_PALIKAS,
  type AuditActor,
  type AuditContext,
  type DeliverySettingsRequest,
  type VendorFulfillmentMode,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import { HttpError } from '../http/errors';
import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import type { VendorRow } from './vendor-compliance-service';

export interface PlatformLogistics {
  readonly selfDeliveryEnabled: boolean;
  readonly platformFleetEnabled: boolean;
  readonly platformDeliveryFeeNpr: number;
}

export interface DeliverySettings {
  readonly vendor: VendorRow;
  readonly platform: PlatformLogistics;
}

/** The vendor chose a delivery mode the Super Admin has switched off. */
export class DeliveryModeDisabledError extends Error {
  constructor(readonly fulfillmentMode: VendorFulfillmentMode) {
    super(`${fulfillmentMode} is not available at the moment`);
    this.name = 'DeliveryModeDisabledError';
  }
}

/** With the shop's own Palika added, the list passes the limit. */
export class TooManyServiceablePalikasError extends Error {
  constructor(readonly max: number) {
    super(`A shop serves at most ${String(max)} municipalities, its own included`);
    this.name = 'TooManyServiceablePalikasError';
  }
}

export function modeEnabled(platform: PlatformLogistics, mode: VendorFulfillmentMode): boolean {
  return mode === 'SELF_DELIVERY' ? platform.selfDeliveryEnabled : platform.platformFleetEnabled;
}

/**
 * A shop's delivery settings (SPEC Dual-Fulfillment, "Delivery Modularity"): the mode, the scope
 * tier and, under self delivery, the charges. They apply to new orders at once; an order keeps
 * the mode and fee it was placed with.
 */
export class VendorDeliverySettingsService {
  constructor(private readonly db: Database) {}

  async get(vendorUserId: string): Promise<DeliverySettings> {
    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.user_id, vendorUserId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
    return { vendor, platform: await platformLogistics(this.db) };
  }

  /**
   * Replaces the settings in one transaction under the vendor row lock, with its audit entry.
   * Saving what is already stored changes and records nothing.
   */
  update(
    actor: AuditActor & { kind: 'USER' },
    input: DeliverySettingsRequest,
    context: AuditContext,
  ): Promise<DeliverySettings> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (before === undefined) throw new VendorAccountNotFoundError(actor.user_id);
      const platform = await platformLogistics(tx);

      // A mode can be chosen only while the Super Admin has it enabled. A shop already on a mode
      // that was switched off may still save its other settings: it is not choosing that mode.
      if (
        input.fulfillment_mode !== before.fulfillment_mode &&
        !modeEnabled(platform, input.fulfillment_mode)
      ) {
        throw new DeliveryModeDisabledError(input.fulfillment_mode);
      }

      const next = {
        fulfillment_mode: input.fulfillment_mode,
        delivery_scope: input.delivery_scope,
        // Only the radius tier sends one; the stored radius is kept for the other tiers.
        radius_km: input.radius_km ?? before.radius_km,
        serviceable_palikas: servedPalikas(before.municipality_palika_string, input),
        base_delivery_fee_npr: input.base_delivery_fee_npr,
        delivery_fee_per_km_npr: input.delivery_fee_per_km_npr,
        free_delivery_above_npr: input.free_delivery_above_npr,
        // Step 7.2. Omitted by an app build from before the field: the stored value is kept.
        min_order_value: input.min_order_value ?? before.min_order_value,
      };
      if (
        next.free_delivery_above_npr !== null &&
        next.free_delivery_above_npr <= next.min_order_value
      ) {
        throw new HttpError(
          422,
          'FREE_DELIVERY_BELOW_MINIMUM_ORDER',
          'Free delivery must start above the minimum order value',
          { min_order_value: next.min_order_value },
        );
      }
      const beforeState = deliveryState(before);
      if (JSON.stringify(beforeState) === JSON.stringify(next)) {
        return { vendor: before, platform };
      }

      const [after] = await tx
        .update(vendors)
        .set(next)
        .where(eq(vendors.id, before.id))
        .returning();
      if (after === undefined) throw new Error(`Vendor ${before.id} vanished`);

      await recordAuditLog(tx, {
        actor,
        action: 'DELIVERY_SETTINGS_CHANGED',
        entityId: before.id,
        vendorId: before.id,
        beforeState,
        afterState: deliveryState(after),
        context,
      });
      return { vendor: after, platform };
    });
  }
}

/**
 * The stored list: the shop's own Palika first, then the others in the order given. Only the
 * CITY_WIDE tier lists others; every other tier serves its own Palika by the list (the scope
 * decides who is actually served).
 */
function servedPalikas(ownPalika: string, input: DeliverySettingsRequest): string[] {
  if (input.delivery_scope !== 'CITY_WIDE') return [ownPalika];
  const own = ownPalika.toLowerCase();
  const others = input.serviceable_palikas.filter((name) => name.toLowerCase() !== own);
  if (others.length + 1 > MAX_SERVICEABLE_PALIKAS) {
    throw new TooManyServiceablePalikasError(MAX_SERVICEABLE_PALIKAS);
  }
  return [ownPalika, ...others];
}

/** The eight settings, in one fixed key order (it is also how "unchanged" is decided). */
function deliveryState(vendor: VendorRow) {
  return {
    fulfillment_mode: vendor.fulfillment_mode,
    delivery_scope: vendor.delivery_scope,
    radius_km: vendor.radius_km,
    serviceable_palikas: vendor.serviceable_palikas,
    base_delivery_fee_npr: vendor.base_delivery_fee_npr,
    delivery_fee_per_km_npr: vendor.delivery_fee_per_km_npr,
    free_delivery_above_npr: vendor.free_delivery_above_npr,
    min_order_value: vendor.min_order_value,
  };
}

async function platformLogistics(executor: Executor): Promise<PlatformLogistics> {
  const [settings] = await executor
    .select({
      selfDeliveryEnabled: platformSettings.self_delivery_enabled,
      platformFleetEnabled: platformSettings.platform_fleet_enabled,
      platformDeliveryFeeNpr: platformSettings.platform_delivery_fee_npr,
    })
    .from(platformSettings);
  if (settings === undefined) throw new Error('platform_settings row is missing');
  return settings;
}
