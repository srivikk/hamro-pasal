import { createSessionStore } from '../auth/session-store';
import { createAdminApi, type AdminApi } from './admin-api';
import { createApiClient, type FetchLike } from './client';

/** Test support: one request the admin API made. */
export interface RecordedCall {
  /** "PUT /api/admin/campaigns/<id>". */
  readonly call: string;
  /** The JSON body, parsed; undefined when none was sent. */
  readonly body: unknown;
}

/**
 * Test support: the admin API of a signed-in Super Admin over a fake `fetch` that records every
 * call and answers it with `respond`. A `body` of undefined is an empty answer (204 by default).
 */
export function fakeAdminApi(
  respond: (call: string) => { readonly status?: number; readonly body?: unknown },
): { readonly calls: RecordedCall[]; readonly api: AdminApi } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    const call = `${init.method ?? ''} ${url}`;
    calls.push({
      call,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
    });
    const { status, body } = respond(call);
    return Promise.resolve(
      body === undefined
        ? new Response(null, { status: status ?? 204 })
        : new Response(JSON.stringify(body), { status: status ?? 200 }),
    );
  };
  const session = createSessionStore();
  session.getState().setSession({
    phone: '+9779800000099',
    user: { id: '00000000-0000-4000-8000-000000000099', role: 'SUPER_ADMIN', first_name: null },
    accessToken: 'access-1',
  });
  return { calls, api: createAdminApi(createApiClient({ baseUrl: '', fetch, session })) };
}

/** Test support: the API's error envelope. */
export function refusalOf(status: number, code: string, details?: unknown) {
  return {
    status,
    body: { error: { code, message: code, ...(details === undefined ? {} : { details }) } },
  };
}
