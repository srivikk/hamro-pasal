/**
 * TEMPORARY: the municipalities a shop can pick for its City / Regional scope. A hard-coded short
 * list until the canonical list of Nepal's 753 Palikas exists in shared-types (or an API serves
 * it): delivery routing matches these names exactly, so they are picked, never typed.
 */
export const MOCK_PALIKAS = [
  'Kathmandu Metropolitan City',
  'Lalitpur Metropolitan City',
  'Bhaktapur Municipality',
  'Kirtipur Municipality',
  'Pokhara Metropolitan City',
  'Bharatpur Metropolitan City',
  'Biratnagar Metropolitan City',
  'Birgunj Metropolitan City',
  'Dharan Sub-Metropolitan City',
  'Nepalgunj Sub-Metropolitan City',
] as const;

export function isKnownPalika(name: string): boolean {
  return MOCK_PALIKAS.some((palika) => palika === name);
}
