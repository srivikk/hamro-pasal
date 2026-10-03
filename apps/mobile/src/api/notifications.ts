import {
  deviceTokenRegisterRequestSchema,
  deviceTokenRegisterResponseSchema,
  type DeviceTokenRegisterRequest,
} from '@hamro-pasal/shared-types';

import { ApiError, apiRequest } from './http';

export const DEVICE_TOKEN_PATH = '/api/notifications/device-token';

/** Client-side: the token or platform broke the request contract; nothing was sent. */
export const INVALID_DEVICE_TOKEN = 'INVALID_DEVICE_TOKEN';

/**
 * POST /api/notifications/device-token (Phase 20): tells the server which Expo push token reaches
 * this device for the signed-in account. Safe to repeat; the server keeps one row per device.
 */
export async function registerDeviceToken(input: DeviceTokenRegisterRequest): Promise<void> {
  const body = deviceTokenRegisterRequestSchema.safeParse(input);
  if (!body.success) {
    throw new ApiError(400, INVALID_DEVICE_TOKEN, body.error.message);
  }
  await apiRequest({
    method: 'POST',
    path: DEVICE_TOKEN_PATH,
    body: body.data,
    schema: deviceTokenRegisterResponseSchema,
  });
}
