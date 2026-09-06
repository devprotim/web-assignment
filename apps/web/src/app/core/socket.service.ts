import { Injectable, signal } from '@angular/core';
import {
  SOCKET_EVENTS,
  type Ack,
  type ConversationView,
  type MessageView,
  type PresenceEvent,
  type ReceiptEvent,
  type SendMessageInput,
  type TypingEvent,
} from '@chat/shared';
import { Subject } from 'rxjs';
import { io, type Socket } from 'socket.io-client';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * Well under the server's SOCKET_TTL_SECONDS (60s), so a socket's presence
 * entry never goes stale between heartbeats even if one is delayed.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly connection = signal<ConnectionState>('disconnected');
  readonly state = this.connection.asReadonly();

  readonly messages$ = new Subject<MessageView>();
  readonly typing$ = new Subject<TypingEvent>();
  readonly presence$ = new Subject<PresenceEvent>();
  readonly readReceipts$ = new Subject<ReceiptEvent>();
  readonly deliveredReceipts$ = new Subject<ReceiptEvent>();
  readonly conversations$ = new Subject<ConversationView>();

  /**
   * Fires after the socket comes back following a drop.
   *
   * Messages sent while we were disconnected were never delivered to this client,
   * so the store listens for this and backfills over REST. Without it, a brief
   * network blip silently leaves holes in the conversation.
   */
  readonly reconnected$ = new Subject<void>();

  connect(): void {
    if (this.socket) return;
    this.connection.set('connecting');

    // No token is passed: the httpOnly session cookie rides along with the
    // handshake automatically, and the server verifies it there.
    this.socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    let hadConnected = false;
    this.socket.on('connect', () => {
      this.connection.set('connected');
      if (hadConnected) this.reconnected$.next();
      hadConnected = true;
      this.startHeartbeat();
    });
    this.socket.on('disconnect', () => {
      this.connection.set('disconnected');
      this.stopHeartbeat();
    });
    this.socket.on('connect_error', () => this.connection.set('disconnected'));

    this.socket.on(SOCKET_EVENTS.MESSAGE_NEW, (m: MessageView) => this.messages$.next(m));
    this.socket.on(SOCKET_EVENTS.MESSAGE_UPDATED, (m: MessageView) => this.messages$.next(m));
    this.socket.on(SOCKET_EVENTS.TYPING, (e: TypingEvent) => this.typing$.next(e));
    this.socket.on(SOCKET_EVENTS.PRESENCE, (e: PresenceEvent) => this.presence$.next(e));
    this.socket.on(SOCKET_EVENTS.READ_RECEIPT, (e: ReceiptEvent) => this.readReceipts$.next(e));
    this.socket.on(SOCKET_EVENTS.DELIVERED_RECEIPT, (e: ReceiptEvent) =>
      this.deliveredReceipts$.next(e),
    );
    this.socket.on(SOCKET_EVENTS.CONVERSATION_UPSERTED, (c: ConversationView) =>
      this.conversations$.next(c),
    );
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.socket?.disconnect();
    this.socket = null;
    this.connection.set('disconnected');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.socket?.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Resolves with the server's ack, or an error ack if the socket is down. */
  async send(input: SendMessageInput): Promise<Ack<MessageView>> {
    if (!this.socket?.connected) {
      return { ok: false, error: { code: 'OFFLINE', message: 'You are offline' } };
    }
    try {
      return await this.socket
        .timeout(10_000)
        .emitWithAck(SOCKET_EVENTS.MESSAGE_SEND, input);
    } catch {
      return { ok: false, error: { code: 'TIMEOUT', message: 'The server did not respond' } };
    }
  }

  subscribeToConversation(conversationId: string): void {
    this.socket?.emit(SOCKET_EVENTS.CONVERSATION_SUBSCRIBE, { conversationId }, () => undefined);
  }

  setTyping(conversationId: string, isTyping: boolean): void {
    this.socket?.emit(
      isTyping ? SOCKET_EVENTS.TYPING_START : SOCKET_EVENTS.TYPING_STOP,
      { conversationId },
    );
  }

  markRead(conversationId: string, messageId: string): void {
    this.socket?.emit(SOCKET_EVENTS.RECEIPT_READ, { conversationId, messageId });
  }

  markDelivered(conversationId: string, messageId: string): void {
    this.socket?.emit(SOCKET_EVENTS.RECEIPT_DELIVERED, { conversationId, messageId });
  }
}
