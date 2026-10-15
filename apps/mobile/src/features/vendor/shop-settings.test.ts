import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import {
  createVendorShopStore,
  settingsFor,
  VENDOR_SHOP_STORE_KEY,
} from '../../store/useVendorShopStore';
import {
  addPalika,
  DEFAULT_SHOP_SETTINGS_FORM,
  formFromSettings,
  MAX_SERVICEABLE_PALIKAS,
  sanitizeAmountInput,
  sanitizeTaxIdInput,
  validateShopSettings,
  type ShopSettings,
  type ShopSettingsForm,
} from './shop-settings';

const form = (overrides: Partial<ShopSettingsForm> = {}): ShopSettingsForm => ({
  ...DEFAULT_SHOP_SETTINGS_FORM,
  taxId: '301234567',
  ...overrides,
});

const SETTINGS: ShopSettings = {
  taxId: '301234567',
  fulfillmentMode: 'SELF_DELIVERY',
  deliveryScope: 'RADIUS_BOUND',
  radiusKm: 5,
  serviceablePalikas: [],
  baseDeliveryFeeNpr: 0,
  perKmFeeNpr: 0,
  freeDeliveryAboveNpr: null,
};

describe('PAN input', () => {
  it('keeps ASCII digits only, converts Nepali digits and stops at nine', () => {
    expect(sanitizeTaxIdInput('30-12 34567')).toBe('301234567');
    expect(sanitizeTaxIdInput('३०१२३४५६७')).toBe('301234567');
    expect(sanitizeTaxIdInput('3012345678901')).toBe('301234567');
    expect(sanitizeTaxIdInput('PAN')).toBe('');
  });

  it.each(['', '30123456', '3012345678', '30123456a'])('refuses %p as a PAN', (taxId) => {
    expect(validateShopSettings(form({ taxId }))).toEqual({
      ok: false,
      errors: { taxId: 'taxId' },
    });
  });
});

describe('amount input', () => {
  it('keeps digits and one decimal point with at most two decimals', () => {
    expect(sanitizeAmountInput('1,250.509 km')).toBe('1250.50');
    expect(sanitizeAmountInput('५०')).toBe('50');
    expect(sanitizeAmountInput('1.2.3')).toBe('1.23');
  });
});

describe('validateShopSettings', () => {
  it('builds self delivery in a radius with every charge defaulting to 0', () => {
    expect(validateShopSettings(form({ baseFee: '', perKmFee: '' }))).toEqual({
      ok: true,
      settings: SETTINGS,
    });
  });

  it('takes the three charges of a self-delivery shop', () => {
    const result = validateShopSettings(
      form({ radiusKm: '7.5', baseFee: '40', perKmFee: '12.50', freeAbove: '2000' }),
    );
    expect(result).toEqual({
      ok: true,
      settings: {
        ...SETTINGS,
        radiusKm: 7.5,
        baseDeliveryFeeNpr: 40,
        perKmFeeNpr: 12.5,
        freeDeliveryAboveNpr: 2000,
      },
    });
  });

  it('saves no charges under platform delivery, whatever the fields still hold', () => {
    const result = validateShopSettings(
      form({ fulfillmentMode: 'PLATFORM_FLEET', baseFee: '40', perKmFee: 'x', freeAbove: '0' }),
    );
    expect(result).toEqual({
      ok: true,
      settings: { ...SETTINGS, fulfillmentMode: 'PLATFORM_FLEET' },
    });
  });

  it.each(['', '0', '100.01', '5.123', 'far'])('refuses %p km as a radius', (radiusKm) => {
    expect(validateShopSettings(form({ radiusKm }))).toEqual({
      ok: false,
      errors: { radiusKm: 'radius' },
    });
  });

  it('needs at least one municipality for the city tier, and keeps the list', () => {
    expect(validateShopSettings(form({ deliveryScope: 'CITY_WIDE' }))).toEqual({
      ok: false,
      errors: { palikas: 'palikas' },
    });
    const result = validateShopSettings(
      form({ deliveryScope: 'CITY_WIDE', radiusKm: '', palikas: ['Lalitpur Metropolitan City'] }),
    );
    expect(result).toEqual({
      ok: true,
      settings: {
        ...SETTINGS,
        deliveryScope: 'CITY_WIDE',
        radiusKm: null,
        serviceablePalikas: ['Lalitpur Metropolitan City'],
      },
    });
  });

  it('keeps only municipalities from the list: a mistyped name is never saved', () => {
    expect(
      validateShopSettings(form({ deliveryScope: 'CITY_WIDE', palikas: ['Lalitpur Metro Citty'] })),
    ).toEqual({ ok: false, errors: { palikas: 'palikas' } });

    const result = validateShopSettings(
      form({
        deliveryScope: 'CITY_WIDE',
        palikas: ['Kathmandoo', 'Pokhara Metropolitan City'],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      settings: { serviceablePalikas: ['Pokhara Metropolitan City'] },
    });
  });

  it('needs neither a radius nor municipalities for the national tier', () => {
    const result = validateShopSettings(
      form({ deliveryScope: 'NATION_WIDE', radiusKm: '', palikas: ['Dharan'] }),
    );
    expect(result).toEqual({
      ok: true,
      settings: { ...SETTINGS, deliveryScope: 'NATION_WIDE', radiusKm: null },
    });
  });

  it('reports every bad field at once', () => {
    const result = validateShopSettings(
      form({ taxId: '12', radiusKm: '', baseFee: '1.2.3', perKmFee: '9999999', freeAbove: '0' }),
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        taxId: 'taxId',
        radiusKm: 'radius',
        baseFee: 'amount',
        perKmFee: 'amount',
        freeAbove: 'amount',
      },
    });
  });

  it('round-trips saved settings through the form', () => {
    const saved: ShopSettings = { ...SETTINGS, baseDeliveryFeeNpr: 40, freeDeliveryAboveNpr: 1500 };
    expect(validateShopSettings(formFromSettings(saved))).toEqual({ ok: true, settings: saved });
    expect(formFromSettings(null)).toEqual(DEFAULT_SHOP_SETTINGS_FORM);
  });
});

describe('addPalika', () => {
  it('trims, collapses spaces and appends', () => {
    expect(addPalika(['Kirtipur Municipality'], '  Lalitpur   Metropolitan City ')).toEqual([
      'Kirtipur Municipality',
      'Lalitpur Metropolitan City',
    ]);
  });

  it('ignores a blank name, a name already listed (any case) and a full list', () => {
    const list = ['Kirtipur Municipality'];
    expect(addPalika(list, '   ')).toBe(list);
    expect(addPalika(list, 'kirtipur municipality')).toBe(list);
    const full = Array.from(
      { length: MAX_SERVICEABLE_PALIKAS },
      (_, index) => `Palika ${String(index)}`,
    );
    expect(addPalika(full, 'One More')).toBe(full);
  });
});

describe('useVendorShopStore', () => {
  const freshStore = (engine = new InMemoryMmkv()) => ({
    engine,
    store: createVendorShopStore(mmkvStateStorage(engine)),
  });

  it('starts online with no settings', () => {
    const { store } = freshStore();
    expect(store.getState()).toMatchObject({ online: true, stored: null });
  });

  it('keeps the Online switch and the settings across a relaunch', () => {
    const { engine, store } = freshStore();
    store.getState().setOnline(false);
    store.getState().saveSettings(SETTINGS, 'vendor-user-1');

    const relaunched = createVendorShopStore(mmkvStateStorage(engine));

    expect(relaunched.getState().online).toBe(false);
    expect(relaunched.getState().stored).toEqual({ userId: 'vendor-user-1', settings: SETTINGS });
  });

  it('refuses to save settings that break the rules', () => {
    const { store } = freshStore();
    expect(() => {
      store.getState().saveSettings({ ...SETTINGS, taxId: '12' }, 'vendor-user-1');
    }).toThrow();
    expect(store.getState().stored).toBeNull();
  });

  it('drops stored settings that no longer pass the schema, keeping the switch', () => {
    const engine = new InMemoryMmkv();
    engine.set(
      VENDOR_SHOP_STORE_KEY,
      JSON.stringify({
        state: { online: false, stored: { userId: 'u', settings: { ...SETTINGS, taxId: 'abc' } } },
        version: 1,
      }),
    );

    const { store } = freshStore(engine);

    expect(store.getState()).toMatchObject({ online: false, stored: null });
  });

  it('forgets the local deletion request an older build stored, keeping the rest', () => {
    const engine = new InMemoryMmkv();
    engine.set(
      VENDOR_SHOP_STORE_KEY,
      JSON.stringify({
        state: {
          online: false,
          stored: { userId: 'vendor-user-1', settings: SETTINGS },
          deletionRequest: { userId: 'vendor-user-1', requestedAt: '2026-10-07T06:00:00.000Z' },
        },
        version: 1,
      }),
    );

    const { store } = freshStore(engine);

    expect(store.getState()).toMatchObject({
      online: false,
      stored: { userId: 'vendor-user-1', settings: SETTINGS },
    });
    expect(store.getState()).not.toHaveProperty('deletionRequest');
  });

  it('shows the settings only to the account that saved them', () => {
    const stored = { userId: 'vendor-user-1', settings: SETTINGS };
    expect(settingsFor(stored, 'vendor-user-1')).toEqual(SETTINGS);
    expect(settingsFor(stored, 'vendor-user-2')).toBeNull();
    expect(settingsFor(stored, null)).toBeNull();
    expect(settingsFor(null, 'vendor-user-1')).toBeNull();
  });
});
