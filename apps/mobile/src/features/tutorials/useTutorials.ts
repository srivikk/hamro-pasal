import { tutorialListResponseSchema, type TutorialView } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '../../api/http';
import { appVariant } from '../../lib/app-variant';

export const TUTORIALS_PATH = '/api/tutorials';

/** GET /api/tutorials?app= (public): this build's active videos, in order. */
export async function fetchTutorials(): Promise<TutorialView[]> {
  const body = await apiRequest({
    method: 'GET',
    path: TUTORIALS_PATH,
    query: { app: appVariant() },
    schema: tutorialListResponseSchema,
    authenticated: false,
  });
  return body.tutorials;
}

export function useTutorials() {
  return useQuery({
    queryKey: ['tutorials', appVariant()],
    queryFn: fetchTutorials,
    staleTime: 10 * 60_000,
    // A missing card is no failure worth retrying loudly.
    retry: false,
  });
}
