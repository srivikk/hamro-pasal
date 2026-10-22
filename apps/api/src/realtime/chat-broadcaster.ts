import { CHAT_SOCKET_EVENTS, disputeRoom, type ChatMessage } from '@hamro-pasal/shared-types';

/** Sends a stored chat message to everyone in its order's /chat room. */
export interface ChatRoomBroadcaster {
  emit(orderId: string, message: ChatMessage): void;
}

/** The part of the /chat namespace a broadcast needs. */
interface RoomEmitter {
  to(room: string): {
    emit(event: typeof CHAT_SOCKET_EVENTS.newMessage, message: ChatMessage): unknown;
  };
}

/**
 * 2026-10-21 (Task 5): the Express app is built before the Socket.io server is attached to it, so
 * the HTTP chat route is given this holder and server.ts attaches the /chat namespace once it
 * exists. Until then (and in tests without sockets) a message is stored and served by GET
 * /api/orders/:id/chat, but pushed to nobody.
 */
export class LateChatBroadcaster implements ChatRoomBroadcaster {
  private namespace: RoomEmitter | null = null;

  attach(namespace: RoomEmitter | null): void {
    this.namespace = namespace;
  }

  emit(orderId: string, message: ChatMessage): void {
    this.namespace?.to(disputeRoom(orderId)).emit(CHAT_SOCKET_EVENTS.newMessage, message);
  }
}
