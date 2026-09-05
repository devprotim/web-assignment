import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  historyQuerySchema,
  sendMessageSchema,
  uuidSchema,
  type ConversationView,
  type HistoryPage,
  type MessageView,
} from '@chat/shared';
import { z } from 'zod';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.service.js';
import { zodBody } from '../common/pipes/zod-validation.pipe.js';
import { MessagesService } from '../messages/messages.service.js';
import { ReceiptsService } from '../messages/receipts.service.js';
import { ConversationsService } from './conversations.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

const openDirectSchema = z.object({ userId: uuidSchema });
const receiptSchema = z.object({ messageId: uuidSchema });

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly receipts: ReceiptsService,
  ) {}

  @Get()
  list(@CurrentUser() me: AuthPrincipal): Promise<ConversationView[]> {
    return this.conversations.list(me.userId);
  }

  @Post('direct')
  openDirect(
    @CurrentUser() me: AuthPrincipal,
    @Body(zodBody(openDirectSchema)) body: { userId: string },
  ): Promise<ConversationView> {
    return this.conversations.openDirect(me.userId, body.userId);
  }

  @Get(':id')
  getOne(
    @CurrentUser() me: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationView> {
    return this.conversations.getOne(me.userId, id);
  }

  /**
   * History and reconnect backfill share one endpoint: `?before=` walks older,
   * `?after=` fetches everything missed while disconnected.
   */
  @Get(':id/messages')
  history(
    @CurrentUser() me: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(historyQuerySchema)) query: never,
  ): Promise<HistoryPage> {
    return this.messages.history(me.userId, id, query);
  }

  /**
   * REST send. Exists so the API is exercisable without a socket (and so the
   * security boundaries can be demonstrated with curl); it runs the exact same
   * MessagesService.create as the WebSocket path.
   */
  @Post(':id/messages')
  @RateLimit({ name: 'send', ...RATE_LIMITS.sendMessage })
  send(
    @CurrentUser() me: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(sendMessageSchema.omit({ conversationId: true }))) body: never,
  ): Promise<MessageView> {
    return this.messages.create(me.userId, { ...(body as object), conversationId: id } as never);
  }

  @Post(':id/read')
  async markRead(
    @CurrentUser() me: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(receiptSchema)) body: { messageId: string },
  ): Promise<{ ok: true }> {
    await this.receipts.markRead(me.userId, id, body.messageId);
    return { ok: true };
  }
}
