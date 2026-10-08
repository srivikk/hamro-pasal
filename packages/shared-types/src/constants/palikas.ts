/**
 * The municipalities (Palikas) a shop may list as served. A stand-in: 20 major ones.
 * Names are the official English forms, compared without regard to letter case.
 */
// TODO: Seed full 753 Palikas from official JSON
export const PALIKAS: readonly string[] = [
  'Kathmandu Metropolitan City',
  'Lalitpur Metropolitan City',
  'Bharatpur Metropolitan City',
  'Pokhara Metropolitan City',
  'Biratnagar Metropolitan City',
  'Birgunj Metropolitan City',
  'Bhaktapur Municipality',
  'Kirtipur Municipality',
  'Madhyapur Thimi Municipality',
  'Dharan Sub-Metropolitan City',
  'Itahari Sub-Metropolitan City',
  'Butwal Sub-Metropolitan City',
  'Hetauda Sub-Metropolitan City',
  'Nepalgunj Sub-Metropolitan City',
  'Dhangadhi Sub-Metropolitan City',
  'Janakpurdham Sub-Metropolitan City',
  'Ghorahi Sub-Metropolitan City',
  'Tulsipur Sub-Metropolitan City',
  'Jitpur Simara Sub-Metropolitan City',
  'Kalaiya Sub-Metropolitan City',
];

const CANONICAL = new Map(PALIKAS.map((name) => [name.toLowerCase(), name]));

/** The list's own spelling of a name, or null when the name is not a known Palika. */
export function canonicalPalika(name: string): string | null {
  return CANONICAL.get(name.trim().toLowerCase()) ?? null;
}
