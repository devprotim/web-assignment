import { Injectable } from '@nestjs/common';
import { SOCKET_EVENTS } from '@chat/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';

/**
 * Delivery and read state.
 *
 * Both are cursors ("everything up to this message"), and both advance
 * monotonically: a receipt for an older message than the one already recorded is
 * ignored. Without that, an out-of-order or delayed event could walk a
 * conversation back to unread, which users read as a bug.
 *
 * Because ids are UUIDv7, comparing ids compares time, so "newer" is a string
 * comparison rather than a timestamp lookup.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async markRead(userId: string, conversationId: string, messageId: string): Promise<void> {
    await this.access.assertMember(userId, conversationId);

    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { lastReadMessageId: true },
    });
    if (member?.lastReadMessageId && member.lastReadMessageId >= messageId) return;

    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: {
        lastReadMessageId: messageId,
        // Reading implies delivery.
        lastDeliveredMessageId: messageId,
      },
    });

    const memberIds = await this.access.memberIds(conversationId);
    this.realtime.toUsers(memberIds, SOCKET_EVENTS.READ_RECEIPT, {
      conversationId,
      userId,
      messageId,
    });
  }

  async markDelivered(userId: string, conversationId: string, messageId: string): Promise<void> {
    await this.access.assertMember(userId, conversationId);

    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { lastDeliveredMessageId: true },
    });
    if (member?.lastDeliveredMessageId && member.lastDeliveredMessageId >= messageId) return;

    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastDeliveredMessageId: messageId },
    });

    const memberIds = await this.access.memberIds(conversationId);
    this.realtime.toUsers(memberIds, SOCKET_EVENTS.DELIVERED_RECEIPT, {
      conversationId,
      userId,
      messageId,
    });
  }
}
