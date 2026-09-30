import { http, HttpResponse } from 'msw';

import { errorBody, ORDER_ID, serverChatMessage } from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../test/msw';
import { chatHistoryPath, fetchChatHistory } from './chat';
import { CLIENT_ERROR_CODES } from './http';

setupApiTestEnvironment();

describe('GET /api/orders/:id/chat', () => {
  it('sends the Bearer token and returns the transcript in server order', async () => {
    const received: CapturedRequest[] = [];
    const first = serverChatMessage({ id: 'm-1', sent_at: '2026-09-30T09:00:00.000Z' });
    const second = serverChatMessage({ id: 'm-2', sent_at: '2026-09-30T09:05:00.000Z' });
    server.use(
      http.get(apiUrl(chatHistoryPath(ORDER_ID)), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json({ messages: [first, second] });
      }),
    );

    const messages = await fetchChatHistory(ORDER_ID);

    expect(received[0]?.url.pathname).toBe(`/api/orders/${ORDER_ID}/chat`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(messages).toEqual([first, second]);
  });

  it('strips a surname or phone even if the server sent one', async () => {
    const leaky = {
      ...serverChatMessage(),
      sender: {
        id: 'user-ram',
        first_name: 'Ram',
        last_name: 'Shrestha',
        phone_number: '+9779800000011',
        role: 'VENDOR',
      },
    };
    server.use(
      http.get(apiUrl(chatHistoryPath(ORDER_ID)), () => HttpResponse.json({ messages: [leaky] })),
    );

    const messages = await fetchChatHistory(ORDER_ID);

    expect(messages[0]?.sender).toEqual({ id: 'user-ram', first_name: 'Ram', role: 'VENDOR' });
    expect(JSON.stringify(messages)).not.toMatch(/Shrestha|9800000011|last_name|phone/);
  });

  it('surfaces 404 ORDER_NOT_FOUND and contract breaks', async () => {
    server.use(
      http.get(apiUrl(chatHistoryPath(ORDER_ID)), () =>
        HttpResponse.json(errorBody('ORDER_NOT_FOUND'), { status: 404 }),
      ),
    );
    await expect(fetchChatHistory(ORDER_ID)).rejects.toMatchObject({
      status: 404,
      code: 'ORDER_NOT_FOUND',
    });

    server.use(http.get(apiUrl(chatHistoryPath(ORDER_ID)), () => HttpResponse.json({ items: [] })));
    await expect(fetchChatHistory(ORDER_ID)).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});
