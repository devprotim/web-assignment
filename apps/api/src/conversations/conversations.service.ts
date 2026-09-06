import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationType,
  MessageStatus,
  SOCKET_EVENTS,
  type ConversationMemberView,
  type ConversationView,
} from '@chat/shared';
import { newId } from '../common/util/ids.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { toMessageView } from '../messages/message.mapper.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { ConversationAccessService } from './conversation-access.service.js';
import type { Env } from '../config/env.js';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly access: ConversationAccessService,
    private readonly realtime: RealtimePublisher,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get publicBaseUrl(): string {
    return this.config.get('S3_PUBLIC_URL', { infer: true });
  }

  /**
   * Opens (or reopens) the 1:1 conversation between two users.
   *
   * `directKey` is the sorted pair of user ids under a unique constraint, so two
   * people tapping "message" at the same moment cannot end up with two parallel
   * conversations. The upsert makes this idempotent.
   */
  async openDirect(userId: string, otherUserId: string): Promise<ConversationView> {
    if (userId === otherUserId) {
      throw new BadRequestException('Cannot open a conversation with yourself');
    }

    const other = await this.prisma.user.findUnique({
      where: { id: otherUserId },
      select: { id: true },
    });
    if (!other) throw new NotFoundException('User not found');

    const directKey = [userId, otherUserId].sort().join(':');

    // Distinguishes "brand new" from "reopened" so the notification below fires
    // only once: an existing pair's other member already has this conversation.
    const existed = await this.prisma.conversation.findUnique({
      where: { directKey },
      select: { id: true },
    });

    const conversation = await this.prisma.conversation.upsert({
      where: { directKey },
      create: {
        id: newId(),
        type: ConversationType.DIRECT,
        directKey,
        members: {
          create: [{ userId }, { userId: otherUserId }],
        },
      },
      update: {},
      select: { id: true },
    });

    const views = await this.listFor(userId, [conversation.id]);
    const view = views[0];
    if (!view) throw new NotFoundException('Conversation not found');

    // The creator gets the conversation from this response, and their own
    // client refreshes its list right after. The other member has no reason to
    // re-fetch: nothing they already had changed. Without this push, their
    // client only learns the conversation exists on their next full reload,
    // which made a first message look silently lost until a refresh.
    if (!existed) {
      const otherViews = await this.listFor(otherUserId, [conversation.id]);
      const otherView = otherViews[0];
      if (otherView) {
        this.realtime.toUser(otherUserId, SOCKET_EVENTS.CONVERSATION_UPSERTED, otherView);
      }
    }

    return view;
  }

  async list(userId: string): Promise<ConversationView[]> {
    const ids = await this.access.conversationIdsFor(userId);
    return this.listFor(userId, ids);
  }

  async getOne(userId: string, conversationId: string): Promise<ConversationView> {
    await this.access.assertMember(userId, conversationId);
    const view = (await this.listFor(userId, [conversationId]))[0];
    if (!view) throw new NotFoundException('Conversation not found');
    return view;
  }

  private async listFor(userId: string, conversationIds: string[]): Promise<ConversationView[]> {
    if (conversationIds.length === 0) return [];

    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, displayName: true, avatarUrl: true, lastSeenAt: true },
            },
          },
        },
        messages: {
          where: { status: MessageStatus.VISIBLE, deletedAt: null },
          include: { attachment: true },
          orderBy: { id: 'desc' },
          take: 1,
        },
      },
      orderBy: { lastMessageAt: 'desc' },
    });

    const unread = await this.unreadCounts(userId, conversationIds);

    const memberIds = [
      ...new Set(conversations.flatMap((c) => c.members.map((m) => m.userId))),
    ];
    const online = await this.presence.onlineMap(memberIds);

    return conversations.map((conversation) => {
      const members: ConversationMemberView[] = conversation.members.map((member) => ({
        userId: member.userId,
        displayName: member.user.displayName,
        avatarUrl: member.user.avatarUrl,
        online: online.get(member.userId) ?? false,
        lastSeenAt: member.user.lastSeenAt.toISOString(),
        lastReadMessageId: member.lastReadMessageId,
        lastDeliveredMessageId: member.lastDeliveredMessageId,
      }));

      const lastMessage = conversation.messages[0];

      return {
        id: conversation.id,
        type: conversation.type,
        members,
        lastMessage: lastMessage ? toMessageView(lastMessage, this.publicBaseUrl) : null,
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        unreadCount: unread.get(conversation.id) ?? 0,
      };
    });
  }

  /**
   * Unread counts for every conversation in one round trip.
   *
   * Doing this per conversation would be N queries for a list of N. The join
   * against each member's own `lastReadMessageId` cursor cannot be expressed with
   * Prisma's groupBy, so this is raw SQL. It rides the
   * `(conversationId, id DESC)` index, and because ids are UUIDv7 the `>`
   * comparison is a chronological one.
   */
  private async unreadCounts(
    userId: string,
    conversationIds: string[],
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ conversationId: string; unread: bigint }>>`
      SELECT m."conversationId" AS "conversationId", COUNT(*) AS unread
      FROM messages m
      JOIN conversation_members cm
        ON cm."conversationId" = m."conversationId"
       AND cm."userId" = ${userId}::uuid
      WHERE m."conversationId" = ANY(${conversationIds}::uuid[])
        AND m."senderId" <> ${userId}::uuid
        AND m."status" = 'VISIBLE'
        AND m."deletedAt" IS NULL
        AND (cm."lastReadMessageId" IS NULL OR m."id" > cm."lastReadMessageId")
      GROUP BY m."conversationId"
    `;

    return new Map(rows.map((row) => [row.conversationId, Number(row.unread)]));
  }
}
