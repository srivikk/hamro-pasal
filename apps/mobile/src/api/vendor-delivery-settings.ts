import {
  deliverySettingsRequestSchema,
  deliverySettingsResponseSchema,
  type DeliverySettingsResponseBody,
} from '@hamro-pasal/shared-types';
import type { z } from 'zod';

import { ApiError, apiRequest } from './http';

export const DELIVERY_SETTINGS_PATH = '/api/vendor/delivery-settings';

/** The seven settings as the API takes them (before its own defaults and spelling fixes). */
export type DeliverySettingsDraft = z.input<typeof deliverySettingsRequestSchema>;

/** Codes the Delivery settings form words itself. */
export const DELIVERY_SETTINGS_ERROR_CODES = {
  /** The Super Admin has switched the chosen mode off. */
  modeDisabled: 'DELIVERY_MODE_DISABLED',
  /** Client side: the settings broke the contract and were not sent. */
  invalid: 'INVALID_DELIVERY_SETTINGS',
} as const;

/** GET /api/vendor/delivery-settings: the shop's settings and what the platform allows. */
export function fetchDeliverySettings(): Promise<DeliverySettingsResponseBody> {
  return apiRequest({
    method: 'GET',
    path: DELIVERY_SETTINGS_PATH,
    schema: deliverySettingsResponseSchema,
  });
}

/**
 * PUT /api/vendor/delivery-settings: replaces all seven settings; they apply to new orders at
 * once. Checked with the API's own schema first: settings that break it are not sent. The answer
 * is what the server now holds (its own Palika added, names in the list's spelling).
 */
export async function saveDeliverySettings(
  draft: DeliverySettingsDraft,
): Promise<DeliverySettingsResponseBody> {
  const body = deliverySettingsRequestSchema.safeParse(draft);
  if (!body.success) {
    throw new ApiError(400, DELIVERY_SETTINGS_ERROR_CODES.invalid, 'Invalid delivery settings');
  }
  return apiRequest({
    method: 'PUT',
    path: DELIVERY_SETTINGS_PATH,
    body: body.data,
    schema: deliverySettingsResponseSchema,
  });
}
