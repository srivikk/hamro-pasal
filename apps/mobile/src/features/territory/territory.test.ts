import {
  checkTerritory,
  decideTerritory,
  isWithinNepalBox,
  NEPAL_TERRITORY_BOX,
  TERRITORY_BLOCKED_MESSAGE,
  type Coordinates,
  type TerritoryDeps,
} from './territory';

const KATHMANDU: Coordinates = { latitude: 27.7045, longitude: 85.3077 };
const NEW_DELHI: Coordinates = { latitude: 28.6139, longitude: 77.209 };
/** India, but inside Nepal's rectangular box. */
const GORAKHPUR: Coordinates = { latitude: 26.7606, longitude: 83.3732 };

describe('SPEC §1 blocking message', () => {
  it('is the SPEC text verbatim, including its spelling', () => {
    expect(TERRITORY_BLOCKED_MESSAGE).toBe('Service Unvailable in your territory');
  });
});

describe('isWithinNepalBox', () => {
  it.each([
    ['Kathmandu', KATHMANDU, true],
    ['Biratnagar', { latitude: 26.4525, longitude: 87.2718 }, true],
    ['Mahendranagar', { latitude: 28.9632, longitude: 80.1776 }, true],
    ['New Delhi', NEW_DELHI, false],
    ['Lhasa', { latitude: 29.652, longitude: 91.1721 }, false],
    ['Dhaka', { latitude: 23.8103, longitude: 90.4125 }, false],
    ['Null Island', { latitude: 0, longitude: 0 }, false],
  ])('%s -> %p', (_name, coordinates, expected) => {
    expect(isWithinNepalBox(coordinates)).toBe(expected);
  });

  it('includes its edges and excludes just past them', () => {
    const { minLat, maxLat, minLng, maxLng } = NEPAL_TERRITORY_BOX;
    expect(isWithinNepalBox({ latitude: minLat, longitude: minLng })).toBe(true);
    expect(isWithinNepalBox({ latitude: maxLat, longitude: maxLng })).toBe(true);
    expect(isWithinNepalBox({ latitude: minLat - 0.001, longitude: 85 })).toBe(false);
    expect(isWithinNepalBox({ latitude: maxLat + 0.001, longitude: 85 })).toBe(false);
    expect(isWithinNepalBox({ latitude: 28, longitude: minLng - 0.001 })).toBe(false);
    expect(isWithinNepalBox({ latitude: 28, longitude: maxLng + 0.001 })).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    expect(isWithinNepalBox({ latitude: Number.NaN, longitude: 85 })).toBe(false);
  });
});

describe('decideTerritory', () => {
  it('blocks anything outside the box, whatever the geocoder says', () => {
    expect(decideTerritory(NEW_DELHI, 'NP').status).toBe('blocked');
  });

  it('allows a position in Nepal', () => {
    expect(decideTerritory(KATHMANDU, 'NP').status).toBe('allowed');
    expect(decideTerritory(KATHMANDU, 'np').status).toBe('allowed');
  });

  it('blocks a foreign position that happens to fall inside the box', () => {
    expect(decideTerritory(GORAKHPUR, 'IN').status).toBe('blocked');
  });

  it('falls back to the box when the country cannot be resolved', () => {
    expect(decideTerritory(KATHMANDU, null).status).toBe('allowed');
  });
});

describe('checkTerritory', () => {
  const deps = (overrides: Partial<TerritoryDeps>): TerritoryDeps => ({
    requestPermission: () => Promise.resolve({ granted: true, canAskAgain: true }),
    getPosition: () => Promise.resolve(KATHMANDU),
    reverseGeocodeCountry: () => Promise.resolve('NP'),
    ...overrides,
  });

  it('allows the device in Nepal', async () => {
    await expect(checkTerritory(deps({}))).resolves.toEqual({
      status: 'allowed',
      coordinates: KATHMANDU,
    });
  });

  it('blocks outside the box without a geocoding call', async () => {
    const reverseGeocodeCountry = jest.fn(() => Promise.resolve('IN'));

    const verdict = await checkTerritory(
      deps({ getPosition: () => Promise.resolve(NEW_DELHI), reverseGeocodeCountry }),
    );

    expect(verdict.status).toBe('blocked');
    expect(reverseGeocodeCountry).not.toHaveBeenCalled();
  });

  it('reports a refused permission (and whether it can be asked again)', async () => {
    await expect(
      checkTerritory(
        deps({ requestPermission: () => Promise.resolve({ granted: false, canAskAgain: false }) }),
      ),
    ).resolves.toEqual({ status: 'permission_denied', canAskAgain: false });
  });

  it('reports no position fix as unavailable', async () => {
    await expect(
      checkTerritory(deps({ getPosition: () => Promise.resolve(null) })),
    ).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('survives a failing geocoder by using the box', async () => {
    const verdict = await checkTerritory(
      deps({ reverseGeocodeCountry: () => Promise.reject(new Error('offline')) }),
    );

    expect(verdict.status).toBe('allowed');
  });
});
