import { act, fireEvent, screen } from '@testing-library/react-native';
import { launchImageLibraryAsync } from 'expo-image-picker';

import DisputeScreen from '../../../app/order/[id]/dispute';
import { useAuthStore } from '../../store/useAuthStore';
import { useOrderStore } from '../../store/useOrderStore';
import { ORDER_ID } from '../../test/api-fixtures';
import { FakeSocket } from '../../test/fake-socket';
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

jest.mock('./mock-evidence-upload', () => ({
  uploadDisputeEvidence: () =>
    Promise.resolve({
      url: 'https://evidence.hamropasal.test/disputes/honey.webp',
      content_type: 'image/webp',
    }),
}));

const HOUR = 60 * 60 * 1000;

/** A JWT whose claims name the signed-in customer (the signature is irrelevant client-side). */
function tokenFor(sub: string): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256' })}.${encode({ sub, role: 'CUSTOMER' })}.signature`;
}

const AARAV_ID = 'user-aarav';

/** What a server that forgot the privacy rules would broadcast. */
const vendorMessage = {
  id: 'srv-1',
  client_id: null,
  order_id: ORDER_ID,
  sender: {
    id: 'user-ram',
    first_name: 'Ram',
    last_name: 'Shrestha',
    phone_number: '+9779800000011',
    role: 'VENDOR',
  },
  body: 'Sorry! Can you share a photo?',
  attachments: [],
  sent_at: '2026-09-29T10:00:00.000Z',
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

  it('shows only the first name of other participants, never last name or phone', () => {
    renderWithProviders(<DisputeScreen />);

    mockSocket.serverSend('chat:new_message', vendorMessage);

    expect(screen.getByText('Ram')).toBeOnTheScreen();
    expect(screen.getByText('Sorry! Can you share a photo?')).toBeOnTheScreen();
    const text = allScreenText();
    expect(text).not.toContain('Shrestha');
    expect(text).not.toContain('+9779800000011');
  });

  it('labels a participant without a first name by role', () => {
    renderWithProviders(<DisputeScreen />);

    mockSocket.serverSend('chat:new_message', {
      ...vendorMessage,
      id: 'srv-2',
      sender: { id: 'admin', role: 'SUPER_ADMIN', last_name: 'Adhikari', phone: '+9779800000099' },
    });

    expect(screen.getByText('Hamro Pasal Support')).toBeOnTheScreen();
    expect(allScreenText()).not.toContain('Adhikari');
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

  it('sends a sanitized message: sender reduced to id, first name and role', () => {
    renderWithProviders(<DisputeScreen />);

    fireEvent.changeText(screen.getByTestId('chat-input'), 'The honey jar arrived broken.');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));

    const [sent] = mockSocket.emittedOf('chat:new_message');
    expect(sent).toMatchObject({
      order_id: ORDER_ID,
      body: 'The honey jar arrived broken.',
      sender: { id: AARAV_ID, first_name: null, role: 'CUSTOMER' },
      attachments: [],
    });
    expect(Object.keys((sent as { sender: object }).sender).sort()).toEqual([
      'first_name',
      'id',
      'role',
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/last_name|phone/);
    expect(screen.getByText('You')).toBeOnTheScreen();
    expect(screen.getByText('Sending…')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-input').props.value).toBe('');
  });

  it('marks a message sent once the server acknowledges it', () => {
    renderWithProviders(<DisputeScreen />);
    fireEvent.changeText(screen.getByTestId('chat-input'), 'Hello');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));

    mockSocket.acknowledgeLast('chat:new_message');

    expect(screen.queryByText('Sending…')).toBeNull();
  });

  it('offers a retry when the acknowledgement times out, and resends the same message', () => {
    renderWithProviders(<DisputeScreen />);
    fireEvent.changeText(screen.getByTestId('chat-input'), 'Hello');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));

    mockSocket.acknowledgeLast('chat:new_message', new Error('operation has timed out'));
    fireEvent.press(screen.getByText('Not sent. Tap to retry.'));

    const sends = mockSocket.emittedOf('chat:new_message');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(screen.getByText('Sending…')).toBeOnTheScreen();
  });

  it("replaces its own copy with the server's echo instead of duplicating it", () => {
    renderWithProviders(<DisputeScreen />);
    fireEvent.changeText(screen.getByTestId('chat-input'), 'Hello');
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    const [sent] = mockSocket.emittedOf('chat:new_message') as { client_id: string }[];

    mockSocket.serverSend('chat:new_message', {
      ...vendorMessage,
      id: 'srv-echo',
      client_id: sent?.client_id,
      body: 'Hello',
      sender: {
        id: AARAV_ID,
        first_name: 'Aarav',
        last_name: 'Sharma',
        phone_number: '+9779800000001',
        role: 'CUSTOMER',
      },
    });

    expect(screen.getAllByText('Hello')).toHaveLength(1);
    expect(screen.queryByText('Sending…')).toBeNull();
    expect(allScreenText()).not.toContain('Sharma');
  });

  it('attaches an image as a (mock) R2 upload and sends its URL', async () => {
    mockPickImage.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///honey.jpg',
          mimeType: 'image/jpeg',
          fileSize: 120_000,
          width: 800,
          height: 600,
        },
      ],
    });
    renderWithProviders(<DisputeScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Attach photo' }));
      // Picker and (mock) upload settle as promises; then flush the list's 50 ms batch.
      await jest.advanceTimersByTimeAsync(60);
    });
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));

    expect(mockSocket.emittedOf('chat:new_message')[0]).toMatchObject({
      body: '',
      attachments: [
        { url: 'https://evidence.hamropasal.test/disputes/honey.webp', content_type: 'image/webp' },
      ],
    });
  });

  it('shows when the connection drops, and rejoins the room on reconnection', () => {
    renderWithProviders(<DisputeScreen />);

    mockSocket.drop();
    expect(screen.getByTestId('chat-connection')).toHaveTextContent(
      "Reconnecting… your messages will send when you're back online.",
    );

    mockSocket.reconnect();
    expect(screen.queryByTestId('chat-connection')).toBeNull();
    expect(mockSocket.emittedOf('chat:join')).toHaveLength(2);
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
