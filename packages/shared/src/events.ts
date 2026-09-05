import type { ConversationView, MessageView, SendMessageInput } from './dto.js';
import type { ModerationReason } from './enums.js';

/**
 * The socket contract. `ClientToServer` and `ServerToClient` are applied to the
 * typed Socket.IO generics on both ends, so adding an event on the server
 * without handling it on the client is a compile error rather than a silent drop.
 */

export const SOCKET_EVENTS = {
  // client -> server
  MESSAGE_SEND: 'message:send',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  RECEIPT_READ: 'receipt:read',
  RECEIPT_DELIVERED: 'receipt:delivered',
  CONVERSATION_SUBSCRIBE: 'conversation:subscribe',
  CONVERSATION_UNSUBSCRIBE: 'conversation:unsubscribe',

  // server -> client
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  TYPING: 'typing',
  PRESENCE: 'presence',
  READ_RECEIPT: 'read:receipt',
  DELIVERED_RECEIPT: 'delivered:receipt',
  CONVERSATION_UPSERTED: 'conversation:upserted',
} as const;

/** Every ack follows this shape so the client has one error path, not several. */
export type Ack<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; reason?: ModerationReason } };

export interface TypingEvent {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export interface PresenceEvent {
  userId: string;
  online: boolean;
  lastSeenAt: string;
}

export interface ReceiptEvent {
  conversationId: string;
  userId: string;
  /** Cursor, not a single message: everything up to and including this id. */
  messageId: string;
}

export interface ClientToServerEvents {
  [SOCKET_EVENTS.MESSAGE_SEND]: (
    payload: SendMessageInput,
    ack: (res: Ack<MessageView>) => void,
  ) => void;
  [SOCKET_EVENTS.TYPING_START]: (payload: { conversationId: string }) => void;
  [SOCKET_EVENTS.TYPING_STOP]: (payload: { conversationId: string }) => void;
  [SOCKET_EVENTS.RECEIPT_READ]: (payload: { conversationId: string; messageId: string }) => void;
  [SOCKET_EVENTS.RECEIPT_DELIVERED]: (payload: {
    conversationId: string;
    messageId: string;
  }) => void;
  [SOCKET_EVENTS.CONVERSATION_SUBSCRIBE]: (
    payload: { conversationId: string },
    ack: (res: Ack<{ subscribed: true }>) => void,
  ) => void;
  [SOCKET_EVENTS.CONVERSATION_UNSUBSCRIBE]: (payload: { conversationId: string }) => void;
}

export interface ServerToClientEvents {
  [SOCKET_EVENTS.MESSAGE_NEW]: (payload: MessageView) => void;
  [SOCKET_EVENTS.MESSAGE_UPDATED]: (payload: MessageView) => void;
  [SOCKET_EVENTS.TYPING]: (payload: TypingEvent) => void;
  [SOCKET_EVENTS.PRESENCE]: (payload: PresenceEvent) => void;
  [SOCKET_EVENTS.READ_RECEIPT]: (payload: ReceiptEvent) => void;
  [SOCKET_EVENTS.DELIVERED_RECEIPT]: (payload: ReceiptEvent) => void;
  [SOCKET_EVENTS.CONVERSATION_UPSERTED]: (payload: ConversationView) => void;
}

/** Room naming lives here so the server and the tests cannot disagree about it. */
export const rooms = {
  conversation: (conversationId: string) => `conv:${conversationId}`,
  /** Every socket an account has open, across tabs and devices. */
  user: (userId: string) => `user:${userId}`,
};
