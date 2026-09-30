import { act, fireEvent, screen } from '@testing-library/react-native';
import { launchImageLibraryAsync } from 'expo-image-picker';
import { http, HttpResponse } from 'msw';

import DisputeScreen from '../../../app/order/[id]/dispute';
import { DISPUTE_EVIDENCE_PATH } from '../../api/uploads';
import { useAuthStore } from '../../store/useAuthStore';
import { useOrderStore } from '../../store/useOrderStore';
import { errorBody, evidenceUpload, ORDER_ID, serverChatMessage } from '../../test/api-fixtures';
import { FakeSocket } from '../../test/fake-socket';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

let mockSocket = new FakeSocket();
const mockIo = jest.fn((..._args: unknown[]) => mockSocket);
jest.mock('socket.io-client', () => ({ io: (...args: unknown[]) => mockIo(...args) }));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c' }),
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
const mockPickImage = jest.mocked(launchImageLibraryAsync);

setupApiTestEnvironment();

const HOUR = 60 * 60 * 1000;

/** A JWT whose claims name the signed-in customer (the signature is irrelevant client-side). */
function tokenFor(sub: string): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256' })}.${encode({ sub, role: 'CUSTOMER' })}.signature`;
}

const AARAV_ID = 'user-aarav';
const AARAV = { id: AARAV_ID, first_name: 'Aarav', role: 'CUSTOMER' } as const;

/** The vendor's message as the /chat server broadcasts it. */
const vendorMessage = serverChatMessage();

/** What a server that forgot the privacy rules would broadcast. */
const leakyVendorMessage = {
  ...vendorMessage,
  sender: {
    ...vendorMessage.sender,
    last_name: 'Shrestha',
    phone_number: '+9779800000011',
  },
};

function deliveredAgo(ms: number): void {
  useOrderStore.setState({
    orders: {
      [ORDER_ID]: {
        orderId: ORDER_ID,
        placedAt: Date.now() - ms - HOUR,
        deliveredAt: Date.now() - ms,
        state: 'DELIVERED',
        paymentMethod: 'COD',
        totalNpr: 1250,
      },
    },
  });
}

/** Every piece of text on screen, for privacy assertions. */
function allScreenText(): string {
  return screen
    .getAllByText(/.*/)
    .map((node) => {
      const children: unknown = node.props.children;
      return Array.isArray(children) ? children.join('') : String(children);
    })
    .join(' | ');
}

/** The server accepts the join. */
function acceptJoin(): void {
  mockSocket.answerLast('chat:join', { ok: true, order_id: ORDER_ID });
}

function typeAndSend(text: string): { client_id: string } {
  fireEvent.changeText(screen.getByTestId('chat-input'), text);
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  const sent = mockSocket.emittedOf('chat:new_message').at(-1) as { client_id: string };
  return sent;
}

/** The server's ack for a sent message: the message as it was broadcast. */
function ackSent(clientId: string, body: string, sender: object = AARAV): void {
  mockSocket.answerLast('chat:new_message', {
    ok: true,
    message: {
      ...serverChatMessage({ id: `srv-${clientId}`, client_id: clientId, body }),
      sender,
    },
  });
}

function pickPhoto(fileSize = 120_000): void {
  mockPickImage.mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'file:///honey.jpg',
        mimeType: 'image/jpeg',
        fileName: 'honey.jpg',
        fileSize,
        width: 800,
        height: 600,
      },
    ],
  });
}

async function attachPhoto(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Attach photo' }));
    // Picker and upload settle as promises; then flush the list's 50 ms batch.
    await jest.advanceTimersByTimeAsync(60);
  });
}

// FlatList renders new cells on a 50 ms batching timer. With fake timers that timer only fires
// when a test advances time inside act(), never between a test's act() scopes.
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
  mockPickImage.mockReset();
  useAuthStore.getState().setAccessToken(tokenFor(AARAV_ID));
  deliveredAgo(HOUR);
});

describe('dispute chat screen', () => {
  it('connects to /chat and joins the order room', () => {
    renderWithProviders(<DisputeScreen />);

    expect(mockIo).toHaveBeenCalledWith('http://api.hamropasal.test/chat', expect.anything());
    expect(mockSocket.emittedOf('chat:join')).toEqual([{ order_id: ORDER_ID }]);
  });

  it('shows the server-filtered first name of other participants', () => {
    renderWithProviders(<DisputeScreen />);
    acceptJoin();

    mockSocket.serverSend('chat:new_message', vendorMessage);

    expect(screen.getByText('Ram')).toBeOnTheScreen();
    expect(screen.getByText('Sorry! Can you share a photo?')).toBeOnTheScreen();
  });

  it('never shows a last name or phone, even if a server leaked them', () => {
    renderWithProviders(<DisputeScreen />);
    acceptJoin();

    mockSocket.serverSend('chat:new_message', leakyVendorMessage);

    expect(screen.getByText('Ram')).toBeOnTheScreen();
    const text = allScreenText();
    expect(text).not.toContain('Shrestha');
    expect(text).not.toContain('+9779800000011');
  });

  it('labels a participant without a first name by role', () => {
    renderWithProviders(<DisputeScreen />);

    mockSocket.serverSend(
      'chat:new_message',
      serverChatMessage({
        id: 'srv-2',
        sender: { id: 'admin', first_name: null, role: 'SUPER_ADMIN' },
      }),
    );

    expect(screen.getByText('Hamro Pasal Support')).toBeOnTheScreen();
  });

  it('ignores payloads that break the contract or belong to another order', () => {
    renderWithProviders(<DisputeScreen />);

    mockSocket.serverSend('chat:new_message', { ...vendorMessage, id: 'x', sender: null });
    mockSocket.serverSend('chat:new_message', {
      ...vendorMessage,
      id: 'y',
      order_id: 'other-order',
    });

    expect(screen.queryByText('Sorry! Can you share a photo?')).toBeNull();
    expect(
      screen.getByText('Tell us what went wrong. A Hamro Pasal team member will reply here.'),
    ).toBeOnTheScreen();
  });

  it('sends only the message fields the server reads: no user data leaves the device', () => {
    renderWithProviders(<DisputeScreen />);
    acceptJoin();

    const sent = typeAndSend('  The honey jar arrived broken.  ');

    expect(sent).toEqual({
      client_id: expect.any(String) as string,
      order_id: ORDER_ID,
      body: 'The honey jar arrived broken.',
      attachments: [],
    });
    expect(screen.getByText('You')).toBeOnTheScreen();
    expect(screen.getByText('Sending…')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-input').props.value).toBe('');
  });

  it("replaces its copy with the server's ack (server id and time), without a duplicate echo", () => {
    renderWithProviders(<DisputeScreen />);
    acceptJoin();
    const sent = typeAndSend('Hello');

    ackSent(sent.client_id, 'Hello');
    // The room broadcast of the same message arrives too.
    mockSocket.serverSend('chat:new_message', {
      ...serverChatMessage({
        id: `srv-${sent.client_id}`,
        client_id: sent.client_id,
        body: 'Hello',
      }),
      sender: AARAV,
    });

    expect(screen.queryByText('Sending…')).toBeNull();
    expect(screen.getAllByText('Hello')).toHaveLength(1);
    expect(screen.getByTestId(`chat-message-srv-${sent.client_id}`)).toBeOnTheScreen();
  });

  it('filters a leaky ack too', () => {
    renderWithProviders(<DisputeScreen />);
    acceptJoin();
    const sent = typeAndSend('Hello');

    ackSent(sent.client_id, 'Hello', { ...AARAV, last_name: 'Sharma', phone: '+9779800000001' });

    expect(screen.queryByText('Sending…')).toBeNull();
    expect(allScreenText()).not.toContain('Sharma');
  });

  it.each([
    ['a timeout', null, new Error('operation has timed out')],
    ['a refusal', { ok: false, error: { code: 'DISPUTE_WINDOW_CLOSED', message: 'closed' } }, null],
    ['an ack that breaks the contract', { ok: true }, null],
  ])('offers a retry after %s, and resends the same message', (_label, response, error) => {
    renderWithProviders(<DisputeScreen />);
    acceptJoin();
    typeAndSend('Hello');

    mockSocket.answerLast('chat:new_message', response, error);
    fireEvent.press(screen.getByText('Not sent. Tap to retry.'));

    const sends = mockSocket.emittedOf('chat:new_message');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(screen.getByText('Sending…')).toBeOnTheScreen();
  });

  it('uploads a photo to /api/uploads/dispute-evidence and sends its URL', async () => {
    let uploads = 0;
    server.use(
      http.post(apiUrl(DISPUTE_EVIDENCE_PATH), () => {
        uploads += 1;
        return HttpResponse.json(evidenceUpload(), { status: 201 });
      }),
    );
    pickPhoto();
    renderWithProviders(<DisputeScreen />);
    acceptJoin();

    await attachPhoto();
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));

    expect(uploads).toBe(1);
    const [sent] = mockSocket.emittedOf('chat:new_message') as { client_id: string }[];
    expect(sent).toMatchObject({ body: '', attachments: [evidenceUpload()] });

    // The server's copy carries the same local-dev (http) URL and is shown.
    mockSocket.answerLast('chat:new_message', {
      ok: true,
      message: serverChatMessage({
        id: 'srv-img',
        client_id: sent?.client_id ?? null,
        body: '',
        attachments: [evidenceUpload()],
        sender: AARAV,
      }),
    });
    expect(screen.getByTestId('chat-message-srv-img')).toBeOnTheScreen();
  });

  it('refuses a photo over 5 MB on the device, without uploading it', async () => {
    server.use(
      http.post(apiUrl(DISPUTE_EVIDENCE_PATH), () => {
        throw new Error('must not upload');
      }),
    );
    pickPhoto(5 * 1024 * 1024 + 1);
    renderWithProviders(<DisputeScreen />);

    await attachPhoto();

    expect(screen.getByTestId('chat-attach-error')).toHaveTextContent(
      'This photo is larger than 5 MB. Choose a smaller one.',
    );
  });

  it.each([
    [
      '413 FILE_TOO_LARGE',
      'FILE_TOO_LARGE',
      413,
      'This photo is larger than 5 MB. Choose a smaller one.',
    ],
    [
      '415 UNSUPPORTED_MEDIA_TYPE',
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      'Only JPEG, PNG or WebP photos can be attached.',
    ],
    ['500', 'INTERNAL_SERVER_ERROR', 500, "Couldn't attach this photo. Please try again."],
  ])('explains a %s upload refusal', async (_label, code, status, message) => {
    server.use(
      http.post(apiUrl(DISPUTE_EVIDENCE_PATH), () =>
        HttpResponse.json(errorBody(code), { status }),
      ),
    );
    pickPhoto();
    renderWithProviders(<DisputeScreen />);

    await attachPhoto();

    expect(screen.getByTestId('chat-attach-error')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows when the connection drops, and rejoins the room on reconnection', () => {
    renderWithProviders(<DisputeScreen />);
    acceptJoin();

    mockSocket.drop();
    expect(screen.getByTestId('chat-connection')).toHaveTextContent(
      "Reconnecting… your messages will send when you're back online.",
    );

    mockSocket.reconnect();
    expect(screen.queryByTestId('chat-connection')).toBeNull();
    expect(mockSocket.emittedOf('chat:join')).toHaveLength(2);
  });

  it('retries a join that timed out, on the backoff schedule', () => {
    renderWithProviders(<DisputeScreen />);

    mockSocket.answerLast('chat:join', undefined, new Error('operation has timed out'));
    expect(mockSocket.emittedOf('chat:join')).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(1_000);
    });

    expect(mockSocket.emittedOf('chat:join')).toHaveLength(2);
  });

  it.each([
    ['DISPUTE_WINDOW_CLOSED', 'The 48-hour dispute window for this order has ended.'],
    ['ORDER_NOT_FOUND', "This dispute isn't available."],
  ])('closes when the server refuses the join with %s', (code, message) => {
    renderWithProviders(<DisputeScreen />);

    mockSocket.answerLast('chat:join', { ok: false, error: { code, message: '' } });
    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    expect(screen.getByTestId('dispute-closed')).toHaveTextContent(message);
    expect(mockSocket.emittedOf('chat:join')).toHaveLength(1); // a refusal is never retried
  });

  it('is closed once 48 h have passed since delivery', () => {
    deliveredAgo(48 * HOUR + 60_000);
    renderWithProviders(<DisputeScreen />);

    expect(screen.getByTestId('dispute-closed')).toHaveTextContent(
      'The 48-hour dispute window for this order has ended.',
    );
    expect(mockIo).not.toHaveBeenCalled();
  });
});
