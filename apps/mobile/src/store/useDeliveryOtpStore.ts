import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { getSecureStorage } from '../storage/secure-mmkv';

export const DELIVERY_OTP_STORE_KEY = 'hamro-pasal.delivery-otps';
export const DELIVERY_OTP_STORE_VERSION = 1;

const otpSchema = z.string().regex(/^\d{4}$/);
const persistedOtpsSchema = z.strictObject({ otps: z.record(z.string(), otpSchema) });

export interface DeliveryOtpState {
  /**
   * Raw 4-digit handoff codes by order id (SPEC journey step 10: shown to the rider). The server
   * keeps only a bcrypt hash, so the customer's copy must survive a relaunch: it lives in the
   * AES-256 encrypted MMKV instance, never in plain storage.
   */
  otps: Record<string, string>;
  /** Stores the latest code for an order. A checkout replay rotates it, so the newest wins. */
  setOtp: (orderId: string, otp: string) => void;
  clearOtp: (orderId: string) => void;
}

export type PersistedDeliveryOtpState = Pick<DeliveryOtpState, 'otps'>;

export type DeliveryOtpStore = UseBoundStore<
  Mutate<StoreApi<DeliveryOtpState>, [['zustand/persist', PersistedDeliveryOtpState]]>
>;

function toPersistedOtps(value: unknown): PersistedDeliveryOtpState {
  const parsed = persistedOtpsSchema.safeParse(value);
  return parsed.success ? parsed.data : { otps: {} };
}

export function createDeliveryOtpStore(storage: StateStorage<void>): DeliveryOtpStore {
  return create<DeliveryOtpState>()(
    persist<DeliveryOtpState, [], [], PersistedDeliveryOtpState>(
      (set, get) => ({
        otps: {},
        setOtp: (orderId, otp) => {
          if (!otpSchema.safeParse(otp).success) {
            throw new RangeError('A delivery OTP is exactly 4 digits');
          }
          set({ otps: { ...get().otps, [orderId]: otp } });
        },
        clearOtp: (orderId) => {
          const { [orderId]: _removed, ...rest } = get().otps;
          set({ otps: rest });
        },
      }),
      {
        name: DELIVERY_OTP_STORE_KEY,
        version: DELIVERY_OTP_STORE_VERSION,
        storage: createJSONStorage<PersistedDeliveryOtpState>(() => storage),
        partialize: ({ otps }): PersistedDeliveryOtpState => ({ otps }),
        migrate: (persisted) => toPersistedOtps(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedOtps(persisted) }),
      },
    ),
  );
}

export const useDeliveryOtpStore: DeliveryOtpStore = createDeliveryOtpStore(
  mmkvStateStorage(getSecureStorage()),
);
