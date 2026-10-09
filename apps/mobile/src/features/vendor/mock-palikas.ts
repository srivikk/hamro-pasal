import { PALIKAS } from '@hamro-pasal/shared-types';

/**
 * The municipalities a shop can pick for its City / Regional scope: the list the API itself
 * checks a saved name against (shared-types `PALIKAS`, still a stand-in for Nepal's 753), so a
 * name picked here is never refused there. Delivery routing matches these names exactly: they
 * are picked, never typed.
 */
export const MOCK_PALIKAS: readonly string[] = PALIKAS;

export function isKnownPalika(name: string): boolean {
  return MOCK_PALIKAS.some((palika) => palika === name);
}
