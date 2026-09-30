import { serverChatMessage } from '../../test/api-fixtures';
import { mergeThread, type ThreadMessage } from './useDisputeChat';

const SELF = 'user-aarav';
const AARAV = { id: SELF, first_name: 'Aarav', role: 'CUSTOMER' } as const;

const at = (minute: number) => `2026-09-30T09:${String(minute).padStart(2, '0')}:00.000Z`;

function live(
  overrides: Parameters<typeof serverChatMessage>[0],
  status: ThreadMessage['status'],
): ThreadMessage {
  const message = serverChatMessage(overrides);
  return { message, mine: message.sender.id === SELF, status };
}

describe('mergeThread (transcript + live messages)', () => {
  it('marks transcript messages as sent (own) or received (others)', () => {
    const thread = mergeThread(
      [
        serverChatMessage({ id: 'a', sender: AARAV, client_id: 'c-a', sent_at: at(0) }),
        serverChatMessage({ id: 'b', sent_at: at(1) }),
      ],
      [],
      SELF,
    );

    expect(thread.map((entry) => [entry.message.id, entry.mine, entry.status])).toEqual([
      ['a', true, 'sent'],
      ['b', false, 'received'],
    ]);
  });

  it('keeps one copy of a message that is both in the transcript and live', () => {
    const shared = serverChatMessage({ id: 'b', sent_at: at(1) });

    const thread = mergeThread([shared], [live({ id: 'b', sent_at: at(1) }, 'received')], SELF);

    expect(thread).toHaveLength(1);
  });

  it("prefers the server's copy of our own message over the local one (matched by client_id)", () => {
    const stored = serverChatMessage({
      id: 'srv-1',
      client_id: 'c-1',
      sender: AARAV,
      sent_at: at(2),
    });
    const local = live({ id: 'c-1', client_id: 'c-1', sender: AARAV, sent_at: at(2) }, 'sending');

    const thread = mergeThread([stored], [local], SELF);

    expect(thread).toEqual([{ message: stored, mine: true, status: 'sent' }]);
  });

  it("does not drop someone else's message that reuses our client_id", () => {
    const stored = serverChatMessage({
      id: 'srv-1',
      client_id: 'c-1',
      sender: AARAV,
      sent_at: at(2),
    });
    const theirs = live({ id: 'srv-2', client_id: 'c-1', sent_at: at(3) }, 'received');

    expect(mergeThread([stored], [theirs], SELF).map((entry) => entry.message.id)).toEqual([
      'srv-1',
      'srv-2',
    ]);
  });

  it('orders everything by time, transcript first on ties', () => {
    const thread = mergeThread(
      [
        serverChatMessage({ id: 'h1', sent_at: at(1) }),
        serverChatMessage({ id: 'h3', sent_at: at(3) }),
      ],
      [
        live({ id: 'l4', sent_at: at(4) }, 'received'),
        live({ id: 'l2', sent_at: at(2) }, 'received'),
        live({ id: 'l3', sent_at: at(3) }, 'received'),
      ],
      SELF,
    );

    expect(thread.map((entry) => entry.message.id)).toEqual(['h1', 'l2', 'h3', 'l3', 'l4']);
  });
});
