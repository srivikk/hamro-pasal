import {
  logisticsSettingsViewSchema,
  logisticsSettingsWriteSchema,
  MAX_FREE_DELIVERY_THRESHOLD_NPR,
  MAX_PLATFORM_DELIVERY_FEE_NPR,
  type LogisticsSettingsView,
  type LogisticsSettingsWrite,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

/**
 * The contract of GET / PUT /api/admin/settings/logistics lives in `@hamro-pasal/shared-types`
 * (`api/admin-governance.ts`) since the API serves it (Phase 26); the panel's rules below are
 * built on it. Re-exported so the screen and its tests keep one import.
 */
export {
  logisticsSettingsViewSchema,
  logisticsSettingsWriteSchema,
  MAX_FREE_DELIVERY_THRESHOLD_NPR,
  MAX_PLATFORM_DELIVERY_FEE_NPR,
};
export type { LogisticsSettingsView, LogisticsSettingsWrite };

/** The panel's fields, as typed. */
export interface LogisticsFormValues {
  readonly selfDeliveryEnabled: boolean;
  readonly platformFleetEnabled: boolean;
  readonly platformDeliveryFee: string;
  /** 2026-10-21: the platform free-delivery threshold; empty switches it off. */
  readonly freeDeliveryAbove: string;
}

export type LogisticsFormField = 'platformDeliveryFee' | 'freeDeliveryAbove';

export function formFromLogistics(settings: LogisticsSettingsView): LogisticsFormValues {
  return {
    selfDeliveryEnabled: settings.self_delivery_enabled,
    platformFleetEnabled: settings.platform_fleet_enabled,
    platformDeliveryFee: String(settings.platform_delivery_fee_npr),
    freeDeliveryAbove:
      settings.free_delivery_above_npr === null ? '' : String(settings.free_delivery_above_npr),
  };
}

export type LogisticsFormResult =
  | { readonly ok: true; readonly request: LogisticsSettingsWrite }
  | {
      readonly ok: false;
      readonly errors: Readonly<Partial<Record<LogisticsFormField, string>>>;
    };

/** An amount with at most two decimals, else NaN (which fails the schema). */
const amountOf = (text: string): number =>
  /^\d+(\.\d{1,2})?$/.test(text) ? Number(text) : Number.NaN;

/** Checks the panel with the request schema, so the screen and the server cannot disagree. */
export function validateLogisticsForm(values: LogisticsFormValues): LogisticsFormResult {
  const fee = values.platformDeliveryFee.trim();
  const threshold = values.freeDeliveryAbove.trim();
  const parsed = logisticsSettingsWriteSchema.safeParse({
    self_delivery_enabled: values.selfDeliveryEnabled,
    platform_fleet_enabled: values.platformFleetEnabled,
    platform_delivery_fee_npr: amountOf(fee),
    free_delivery_above_npr: threshold === '' ? null : amountOf(threshold),
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const errors: Partial<Record<LogisticsFormField, string>> = {};
  if (parsed.error.issues.some((issue) => issue.path[0] === 'platform_delivery_fee_npr')) {
    errors.platformDeliveryFee = `Enter an amount from 0 to ${formatNpr(MAX_PLATFORM_DELIVERY_FEE_NPR)}, with at most two decimals.`;
  }
  if (parsed.error.issues.some((issue) => issue.path[0] === 'free_delivery_above_npr')) {
    errors.freeDeliveryAbove = `Leave empty to switch it off, or enter an amount above 0 and up to ${formatNpr(MAX_FREE_DELIVERY_THRESHOLD_NPR)}, with at most two decimals.`;
  }
  return { ok: false, errors };
}

/** Whether saving would change anything. */
export function logisticsChanged(
  settings: LogisticsSettingsView,
  request: LogisticsSettingsWrite,
): boolean {
  return (
    settings.self_delivery_enabled !== request.self_delivery_enabled ||
    settings.platform_fleet_enabled !== request.platform_fleet_enabled ||
    settings.platform_delivery_fee_npr !== request.platform_delivery_fee_npr ||
    (request.free_delivery_above_npr !== undefined &&
      settings.free_delivery_above_npr !== request.free_delivery_above_npr)
  );
}

function shops(count: number): string {
  return `${String(count)} shop${count === 1 ? '' : 's'}`;
}

/** Both modes off: the global Emergency Stop. */
export function isEmergencyStop(
  settings: Pick<LogisticsSettingsWrite, 'self_delivery_enabled' | 'platform_fleet_enabled'>,
): boolean {
  return !settings.self_delivery_enabled && !settings.platform_fleet_enabled;
}

export const EMERGENCY_STOP_WARNING =
  'Emergency stop: with both delivery modes off, no shop in the country can take an order and every customer sees “Delivery Unavailable”. Orders already placed are delivered as placed. Shops come back by themselves when a mode is switched on again.';

/**
 * The warning shown before the Emergency Stop is switched on, or before a mode is switched off
 * while shops use it, or null. Such a shop is not
 * orderable (checkout answers 422 VENDOR_UNAVAILABLE) until it chooses an enabled mode itself: the
 * admin does not change a shop's mode. Orders already placed keep the mode they were placed under.
 */
export function modeDisableWarning(
  settings: LogisticsSettingsView,
  request: LogisticsSettingsWrite,
): string | null {
  if (isEmergencyStop(request)) return isEmergencyStop(settings) ? null : EMERGENCY_STOP_WARNING;
  const stopped: string[] = [];
  if (
    settings.self_delivery_enabled &&
    !request.self_delivery_enabled &&
    settings.self_delivery_vendor_count > 0
  ) {
    stopped.push(`${shops(settings.self_delivery_vendor_count)} on self delivery`);
  }
  if (
    settings.platform_fleet_enabled &&
    !request.platform_fleet_enabled &&
    settings.platform_fleet_vendor_count > 0
  ) {
    stopped.push(`${shops(settings.platform_fleet_vendor_count)} on the platform fleet`);
  }
  if (stopped.length === 0) return null;
  return `${stopped.join(' and ')} will stop taking orders until each one chooses an enabled mode in the Vendor App. Orders already placed are delivered as placed.`;
}

/** What a changed platform free-delivery threshold means, and who pays for it. */
export function freeDeliveryChangeNote(
  settings: LogisticsSettingsView,
  request: LogisticsSettingsWrite,
): string | null {
  const next = request.free_delivery_above_npr;
  if (next === undefined || next === settings.free_delivery_above_npr) return null;
  if (next === null) {
    return 'Platform-funded free delivery stops for orders placed from now on. Shops keep their own thresholds.';
  }
  return `From now on, every order whose goods come to ${formatNpr(next)} or more after discounts ships free, at any shop. Hamro Pasal pays the delivery fee to the rider or the shop; no shop is charged for it.`;
}

/** What a changed fee applies to. */
export function feeChangeNote(
  settings: LogisticsSettingsView,
  request: LogisticsSettingsWrite,
): string | null {
  if (settings.platform_delivery_fee_npr === request.platform_delivery_fee_npr) return null;
  return `Platform fleet orders placed from now on are charged ${formatNpr(request.platform_delivery_fee_npr)} (was ${formatNpr(settings.platform_delivery_fee_npr)}). Orders already placed keep their fee.`;
}

export function logisticsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'VALIDATION_FAILED':
        return 'The server refused these settings. Check the delivery charge and try again.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The settings could not be saved. Try again.';
}
