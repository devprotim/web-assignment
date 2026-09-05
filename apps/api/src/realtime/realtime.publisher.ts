import { Injectable, Logger } from '@nestjs/common';
import { rooms, type ServerToClientEvents } from '@chat/shared';
import type { Server } from 'socket.io';

/**
 * Indirection between business services and the WebSocket gateway.
 *
 * Services need to broadcast, and the gateway needs to call services. Injecting
 * the gateway into services would be a dependency cycle, so the gateway binds its
 * Socket.IO server here at startup and services publish through this instead.
 *
 * Everything published goes through the Redis adapter, so a broadcast reaches
 * sockets on every instance, not just this one.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);
  private server: Server | null = null;

  bind(server: Server): void {
    this.server = server;
  }

  /** Fan out to everyone currently viewing a conversation. */
  toConversation<E extends keyof ServerToClientEvents>(
    conversationId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    this.emit(rooms.conversation(conversationId), event, ...args);
  }

  /**
   * Fan out to every socket one account has open. This is what keeps multiple
   * tabs of the same account consistent, and what reaches a member who has the
   * app open but is not currently looking at that conversation.
   */
  toUser<E extends keyof ServerToClientEvents>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    this.emit(rooms.user(userId), event, ...args);
  }

  toUsers<E extends keyof ServerToClientEvents>(
    userIds: string[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    for (const userId of userIds) this.toUser(userId, event, ...args);
  }

  private emit(room: string, event: string, ...args: unknown[]): void {
    if (!this.server) {
      this.logger.warn(`Dropped "${event}": no Socket.IO server bound yet`);
      return;
    }
    this.server.to(room).emit(event as never, ...(args as never[]));
  }
}
