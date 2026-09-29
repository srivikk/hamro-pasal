/**
 * Nepal's 7 provinces and 77 districts (federal structure since 2015). The address hierarchy is
 * Province -> District -> Palika -> Ward -> Tole. Western ZIP/postcodes are not used (SPEC).
 */
export const NEPAL_PROVINCES = [
  { id: 1, name: 'Koshi' },
  { id: 2, name: 'Madhesh' },
  { id: 3, name: 'Bagmati' },
  { id: 4, name: 'Gandaki' },
  { id: 5, name: 'Lumbini' },
  { id: 6, name: 'Karnali' },
  { id: 7, name: 'Sudurpashchim' },
] as const;

export type NepalProvinceId = (typeof NEPAL_PROVINCES)[number]['id'];

export const NEPAL_DISTRICTS_BY_PROVINCE: Readonly<Record<NepalProvinceId, readonly string[]>> = {
  1: [
    'Bhojpur',
    'Dhankuta',
    'Ilam',
    'Jhapa',
    'Khotang',
    'Morang',
    'Okhaldhunga',
    'Panchthar',
    'Sankhuwasabha',
    'Solukhumbu',
    'Sunsari',
    'Taplejung',
    'Terhathum',
    'Udayapur',
  ],
  2: ['Bara', 'Dhanusha', 'Mahottari', 'Parsa', 'Rautahat', 'Saptari', 'Sarlahi', 'Siraha'],
  3: [
    'Bhaktapur',
    'Chitwan',
    'Dhading',
    'Dolakha',
    'Kathmandu',
    'Kavrepalanchok',
    'Lalitpur',
    'Makwanpur',
    'Nuwakot',
    'Ramechhap',
    'Rasuwa',
    'Sindhuli',
    'Sindhupalchok',
  ],
  4: [
    'Baglung',
    'Gorkha',
    'Kaski',
    'Lamjung',
    'Manang',
    'Mustang',
    'Myagdi',
    'Nawalpur',
    'Parbat',
    'Syangja',
    'Tanahun',
  ],
  5: [
    'Arghakhanchi',
    'Banke',
    'Bardiya',
    'Dang',
    'Gulmi',
    'Kapilvastu',
    'Palpa',
    'Parasi',
    'Pyuthan',
    'Rolpa',
    'Rukum East',
    'Rupandehi',
  ],
  6: [
    'Dailekh',
    'Dolpa',
    'Humla',
    'Jajarkot',
    'Jumla',
    'Kalikot',
    'Mugu',
    'Rukum West',
    'Salyan',
    'Surkhet',
  ],
  7: [
    'Achham',
    'Baitadi',
    'Bajhang',
    'Bajura',
    'Dadeldhura',
    'Darchula',
    'Doti',
    'Kailali',
    'Kanchanpur',
  ],
};

/** Common alternative spellings, mapped to the canonical district names above. */
const DISTRICT_ALIASES: Readonly<Record<string, string>> = {
  kavre: 'Kavrepalanchok',
  kabhrepalanchok: 'Kavrepalanchok',
  kavrepalanchowk: 'Kavrepalanchok',
  sindhupalchowk: 'Sindhupalchok',
  makawanpur: 'Makwanpur',
  chitawan: 'Chitwan',
  dhanusa: 'Dhanusha',
  tanahu: 'Tanahun',
  kapilbastu: 'Kapilvastu',
  tehrathum: 'Terhathum',
  'nawalparasi east': 'Nawalpur',
  'nawalparasi (east)': 'Nawalpur',
  'nawalparasi west': 'Parasi',
  'nawalparasi (west)': 'Parasi',
  'eastern rukum': 'Rukum East',
  'western rukum': 'Rukum West',
};

const CANONICAL_BY_KEY: ReadonlyMap<string, { district: string; provinceId: NepalProvinceId }> =
  new Map(
    NEPAL_PROVINCES.flatMap(({ id }) =>
      NEPAL_DISTRICTS_BY_PROVINCE[id].map((district) => [
        normaliseKey(district),
        { district, provinceId: id },
      ]),
    ),
  );

function normaliseKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Resolves a user-entered district name (any case / known alias) to its canonical record. */
export function lookupNepalDistrict(
  input: string,
): { district: string; provinceId: NepalProvinceId } | undefined {
  const key = normaliseKey(input);
  return CANONICAL_BY_KEY.get(normaliseKey(DISTRICT_ALIASES[key] ?? key));
}

/**
 * Largest ward number of any Palika (Pokhara Metropolitan City has 33). A per-Palika bound needs
 * the full local-level dataset (753 Palikas), which is not bundled yet.
 */
export const NEPAL_MAX_WARD_NUMBER = 33;

/**
 * Coarse bounding box of Nepal. Pins outside it are certainly invalid. The authoritative
 * tenant check (SPEC §1) is the PostGIS polygon lookup, which this does not replace.
 */
export const NEPAL_BOUNDING_BOX = {
  minLat: 26.3,
  maxLat: 30.5,
  minLng: 80.0,
  maxLng: 88.25,
} as const;
