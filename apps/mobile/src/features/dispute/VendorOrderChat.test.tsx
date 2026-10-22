import { act, fireEvent, screen } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorOrderChatScreen from '../../../app/(vendor)/order-chat';
import { chatHistoryPath } from '../../api/chat';
import { useAuthStore } from '../../store/useAuthStore';
import { ORDER_ID, serverChatMessage } from '../../test/api-fixtures';
import { FakeSocket } from '../../test/fake-socket';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

let mockSocket = new FakeSocket();
const mockIo = jest.fn((..._args: unknown[]) => mockSocket);
jest.mock('socket.io-client', () => ({ io: (...args: unknown[]) => mockIo(...args) }));

let mockParams: { id: string; escalated?: string } = { id: '' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));

setupApiTestEnvironment();

/** A JWT whose claims name the shop's own user (the signature is irrelevant client-side). */
function vendorToken(sub: string): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256' })}.${encode({ sub, role: 'VENDOR' })}.signature`;
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

beforeEach(() => {
  jest.useFakeTimers();
  mockSocket = new FakeSocket();
  mockIo.mockClear();
  mockParams = { id: ORDER_ID, escalated: '0' };
  server.use(
    http.get(apiUrl(chatHistoryPath(ORDER_ID)), () =>
      HttpResponse.json({
        messages: [serverChatMessage({ id: 'm1', body: 'The jar arrived broken.' })],
      }),
    ),
  );
  useAuthStore.getState().setAccessToken(vendorToken('user-shop'));
});

describe('Seller app: an order conversation (2026-10-21)', () => {
  it('joins the order room and shows the transcript, without a photo button', async () => {
    renderWithProviders(<VendorOrderChatScreen />);
    await settle();

    expect(mockSocket.emittedOf('chat:join')).toEqual([{ order_id: ORDER_ID }]);
    expect(screen.getByText('The jar arrived broken.')).toBeOnTheScreen();
    // Evidence uploads are the customer's: the shop writes text only.
    expect(screen.queryByTestId('chat-attach')).toBeNull();
  });

  it('escalates under /api/vendors/orders', async () => {
    const posted: string[] = [];
    server.use(
      http.post(apiUrl(`/api/vendors/orders/${ORDER_ID}/escalate`), async ({ request }) => {
        posted.push(new URL(request.url).pathname);
        await request.json();
        return HttpResponse.json({
          conversation: {
            dispute_id: '5d1c2a10-0000-4000-8000-000000000001',
            order_id: ORDER_ID,
            status: 'ESCALATED',
            escalated_at: '2026-10-21T08:00:00.000Z',
            escalation_reason: 'The customer refuses to pay for the order.',
            window_ends_at: null,
          },
        });
      }),
    );
    renderWithProviders(<VendorOrderChatScreen />);
    await settle();
    mockSocket.answerLast('chat:join', { ok: true, order_id: ORDER_ID });

    fireEvent.press(screen.getByTestId('dispute-escalate'));
    fireEvent.changeText(
      screen.getByTestId('dispute-escalate-reason'),
      'The customer refuses to pay for the order.',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Escalate' }));
    await settle();

    expect(posted).toEqual([`/api/vendors/orders/${ORDER_ID}/escalate`]);
    expect(screen.getByTestId('dispute-escalated')).toBeOnTheScreen();
  });

  it('opens an order the board shows as DISPUTED as already escalated', async () => {
    mockParams = { id: ORDER_ID, escalated: '1' };
    renderWithProviders(<VendorOrderChatScreen />);
    await settle();

    expect(screen.getByTestId('dispute-escalated')).toBeOnTheScreen();
    expect(screen.queryByTestId('dispute-escalate')).toBeNull();
  });
});
