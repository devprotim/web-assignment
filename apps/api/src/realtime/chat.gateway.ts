import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  SOCKET_EVENTS,
  rooms,
  sendMessageSchema,
  type Ack,
  type MessageView,
} from '@chat/shared';
import type { Server } from 'socket.io';
import { ACCESS_COOKIE } from '../auth/auth.types.js';
import { TokenService } from '../auth/token.service.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { ReceiptsService } from '../messages/receipts.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { RATE_LIMITS, RateLimitService } from '../rate-limit/rate-limit.service.js';
import { RealtimePublisher } from './realtime.publisher.js';
import type { ChatSocket } from './socket.types.js';

@WebSocketGateway({
  // Same-origin in production, so CORS here only matters for the dev server.
  cors: { origin: true, credentials: true },
  // Prefer real WebSockets but keep polling as a fallback for hostile networks.
  transports: ['websocket', 'polling'],
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly presence: PresenceService,
    private readonly access: ConversationAccessService,
    private readonly messages: MessagesService,
    private readonly receipts: ReceiptsService,
    private readonly limiter: RateLimitService,
    private readonly realtime: RealtimePublisher,
  ) {}

  afterInit(server: Server): void {
    this.realtime.bind(server);

    /**
     * Authentication happens once, here, before any handler can run. An
     * unauthenticated socket is rejected at the handshake rather than being
     * allowed to connect and checked per event.
     */
    server.use(async (socket, next) => {
      try {
        const token = extractToken(socket as ChatSocket);
        if (!token) return next(new Error('UNAUTHENTICATED'));

        const principal = await this.tokens.verifyAccessToken(token);
        (socket as ChatSocket).data.userId = principal.userId;
        (socket as ChatSocket).data.email = principal.email;
        next();
      } catch {
        next(new Error('UNAUTHENTICATED'));
      }
    });
  }

  async handleConnection(socket: ChatSocket): Promise<void> {
    const { userId } = socket.data;

    // Every socket this account has open shares one room, which is what keeps
    // multiple tabs consistent and lets a user be reached wherever they are.
    await socket.join(rooms.user(userId));

    // Join the rooms for conversations this user actually belongs to. Rooms are
    // never joined from a client-supplied id without this membership check.
    const conversationIds = await this.access.conversationIdsFor(userId);
    await Promise.all(conversationIds.map((id) => socket.join(rooms.conversation(id))));

    const cameOnline = await this.presence.addSocket(userId, socket.id);
    if (cameOnline) await this.broadcastPresence(userId, true);

    this.logger.debug(`connected ${userId} (${socket.id}), ${conversationIds.length} rooms`);
  }

  async handleDisconnect(socket: ChatSocket): Promise<void> {
    const userId = socket.data?.userId;
    if (!userId) return;

    // Only the *last* socket going away means the user is offline.
    const wentOffline = await this.presence.removeSocket(userId, socket.id);
    if (wentOffline) await this.broadcastPresence(userId, false);
  }

  @SubscribeMessage(SOCKET_EVENTS.MESSAGE_SEND)
  async onMessageSend(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ack<MessageView>> {
    const { userId } = socket.data;

    const decision = await this.limiter.consume(
      `send:${userId}`, // same bucket as the REST route, so switching transport does not reset it
      RATE_LIMITS.sendMessage.limit,
      RATE_LIMITS.sendMessage.windowSeconds,
    );
    if (!decision.allowed) {
      return fail('RATE_LIMITED', `Slow down. Try again in ${decision.resetIn}s.`);
    }

    const parsed = sendMessageSchema.safeParse(payload);
    if (!parsed.success) return fail('VALIDATION_FAILED', 'Message payload is invalid');

    try {
      // Same service the REST route calls, so moderation and authorization are
      // identical no matter which transport the client uses.
      const message = await this.messages.create(userId, parsed.data);
      return { ok: true, data: message };
    } catch (error) {
      return failFromError(error);
    }
  }

  @SubscribeMessage(SOCKET_EVENTS.CONVERSATION_SUBSCRIBE)
  async onSubscribe(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() payload: { conversationId?: string },
  ): Promise<Ack<{ subscribed: true }>> {
    const conversationId = payload?.conversationId;
    if (!conversationId) return fail('VALIDATION_FAILED', 'conversationId is required');

    try {
      await this.access.assertMember(socket.data.userId, conversationId);
      await socket.join(rooms.conversation(conversationId));
      return { ok: true, data: { subscribed: true } };
    } catch {
      return fail('FORBIDDEN', 'You are not a member of this conversation');
    }
  }

  @SubscribeMessage(SOCKET_EVENTS.CONVERSATION_UNSUBSCRIBE)
  async onUnsubscribe(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() payload: { conversationId?: string },
  ): Promise<void> {
    if (payload?.conversationId) {
      await socket.leave(rooms.conversation(payload.conversationId));
    }
  }

  @SubscribeMessage(SOCKET_EVENTS.TYPING_START)
  async onTypingStart(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() payload: { conversationId?: string },
  ): Promise<void> {
    await this.relayTyping(socket, payload?.conversationId, true);
  }

  @SubscribeMessage(SOCKET_EVENTS.TYPING_STOP)
  async onTypingStop(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() payload: { conversationId?: string },
  ): Promise<void> {
    await this.relayTyping(socket, payload?.conversationId, false);
  }

  @SubscribeMessage(SOCKET_EVENTS.RECEIPT_READ)
  async onRead(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() payload: { conversationId?: string; messageId?: string },
  ): Promise<void> {
    if (!payload?.conversationId || !payload.messageId) return;
    await this.receipts
      .markRead(socket.data.userId, payload.conversationId, payload.messageId)
      .catch(() => undefined);
  }

  @SubscribeMessage(SOCKET_EVENTS.RECEIPT_DELIVERED)
  async onDelivered(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() payload: { conversationId?: string; messageId?: string },
  ): Promise<void> {
    if (!payload?.conversationId || !payload.messageId) return;
    await this.receipts
      .markDelivered(socket.data.userId, payload.conversationId, payload.messageId)
      .catch(() => undefined);
  }

  /**
   * Typing is deliberately ephemeral: never persisted, and emitted to the
   * conversation room excluding the sender, who does not need to see it.
   */
  private async relayTyping(
    socket: ChatSocket,
    conversationId: string | undefined,
    isTyping: boolean,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await this.access.assertMember(socket.data.userId, conversationId);
    } catch {
      return;
    }
    socket.to(rooms.conversation(conversationId)).emit(SOCKET_EVENTS.TYPING, {
      conversationId,
      userId: socket.data.userId,
      isTyping,
    });
  }

  /** Tell everyone who shares a conversation with this user about the change. */
  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    const conversationIds = await this.access.conversationIdsFor(userId);
    const payload = { userId, online, lastSeenAt: new Date().toISOString() };

    for (const conversationId of conversationIds) {
      this.server.to(rooms.conversation(conversationId)).emit(SOCKET_EVENTS.PRESENCE, payload);
    }
  }
}

function extractToken(socket: ChatSocket): string | null {
  const header = socket.handshake.headers.cookie;
  if (header) {
    const fromCookie = readCookie(header, ACCESS_COOKIE);
    if (fromCookie) return fromCookie;
  }
  // Fallback for non-browser clients (and the e2e checks).
  const auth = socket.handshake.auth as { token?: string } | undefined;
  return auth?.token ?? null;
}

/**
 * Minimal Cookie-header lookup. The handshake is not an Express request, so
 * cookie-parser has not run on it, and pulling in a cookie library for one
 * header read is not worth the dependency.
 */
function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function fail(code: string, message: string): Ack<never> {
  return { ok: false, error: { code, message } };
}

function failFromError(error: unknown): Ack<never> {
  const response = (error as { response?: Record<string, unknown> })?.response;
  if (response && typeof response === 'object') {
    return {
      ok: false,
      error: {
        code: String(response.code ?? 'SEND_FAILED'),
        message: String(response.message ?? 'Message could not be sent'),
        reason: response.reason as never,
      },
    };
  }
  return fail('SEND_FAILED', 'Message could not be sent');
}
