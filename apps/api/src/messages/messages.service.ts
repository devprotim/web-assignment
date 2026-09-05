import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageKind,
  MessageStatus,
  ModerationReason,
  ModerationStatus,
  SOCKET_EVENTS,
  type HistoryPage,
  type HistoryQuery,
  type MessageView,
  resolveSticker,
  type SendMessageInput,
} from '@chat/shared';
import type { InputJsonValue } from '../generated/prisma/internal/prismaNamespace.js';
import { newId } from '../common/util/ids.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';
import { ProfanityService } from '../moderation/profanity.service.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { toMessageView, type MessageWithAttachment } from './message.mapper.js';
import type { Env } from '../config/env.js';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly profanity: ProfanityService,
    private readonly realtime: RealtimePublisher,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get publicBaseUrl(): string {
    return this.config.get('S3_PUBLIC_URL', { infer: true });
  }

  /**
   * The only write path for messages. Both the REST endpoint and the WebSocket
   * `message:send` handler call this, so authorization and moderation cannot be
   * skipped by choosing a different transport.
   *
   * `senderId` is a parameter taken from the verified token by the caller, never
   * read from the payload.
   */
  async create(senderId: string, input: SendMessageInput): Promise<MessageView> {
    await this.access.assertMember(senderId, input.conversationId);

    const { content } = input;

    // ---- moderation, before anything is persisted as visible ----------------
    if (content.kind === MessageKind.TEXT && !this.profanity.isClean(content.text)) {
      await this.recordModeration(senderId, 'TEXT', true, ModerationReason.PROFANITY, {
        terms: this.profanity.matchedTerms(content.text),
      });
      throw new UnprocessableEntityException({
        code: 'MESSAGE_BLOCKED',
        reason: ModerationReason.PROFANITY,
        message: 'Your message was blocked because it contains prohibited language.',
      });
    }

    // An image may only be attached if it is *this sender's* attachment and it
    // has already passed moderation. This is the check that makes calling the
    // API directly unable to bypass the nudity scan.
    if (content.kind === MessageKind.IMAGE) {
      const attachment = await this.prisma.attachment.findUnique({
        where: { id: content.attachmentId },
        select: { id: true, ownerId: true, moderationStatus: true },
      });

      if (!attachment || attachment.ownerId !== senderId) {
        throw new UnprocessableEntityException({
          code: 'ATTACHMENT_INVALID',
          reason: ModerationReason.ATTACHMENT_NOT_APPROVED,
          message: 'Attachment not found.',
        });
      }
      if (attachment.moderationStatus !== ModerationStatus.APPROVED) {
        throw new UnprocessableEntityException({
          code: 'ATTACHMENT_NOT_APPROVED',
          reason: ModerationReason.ATTACHMENT_NOT_APPROVED,
          message: 'This image has not passed moderation and cannot be sent.',
        });
      }
    }

    // A sticker must exist in the bundled pack. Without this a client could put
    // an arbitrary id on the wire and make every recipient's UI request a URL of
    // the sender's choosing.
    if (content.kind === MessageKind.STICKER) {
      const sticker = resolveSticker(content.sticker.packId, content.sticker.stickerId);
      if (!sticker) {
        throw new UnprocessableEntityException({
          code: 'UNKNOWN_STICKER',
          message: 'That sticker does not exist.',
        });
      }
    }

    // ---- persist -----------------------------------------------------------
    const data = {
      id: newId(),
      conversationId: input.conversationId,
      senderId,
      clientMessageId: input.clientMessageId,
      kind: content.kind,
      status: MessageStatus.VISIBLE,
      body: content.kind === MessageKind.TEXT ? content.text : null,
      meta:
        content.kind === MessageKind.GIF
          ? content.gif
          : content.kind === MessageKind.STICKER
            ? content.sticker
            : undefined,
      attachmentId: content.kind === MessageKind.IMAGE ? content.attachmentId : null,
    };

    let created: MessageWithAttachment;
    let isNew = true;

    try {
      created = await this.prisma.message.create({ data, include: { attachment: true } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Idempotency: a retry or a reconnect replay carrying the same
      // clientMessageId returns the message that already exists rather than
      // creating a duplicate. This is what makes client retries safe.
      const existing = await this.prisma.message.findUnique({
        where: { senderId_clientMessageId: { senderId, clientMessageId: input.clientMessageId } },
        include: { attachment: true },
      });
      if (!existing) throw error;

      created = existing;
      isNew = false;
      this.logger.debug(`Idempotent replay of ${input.clientMessageId} by ${senderId}`);
    }

    const view = toMessageView(created, this.publicBaseUrl);

    // A replay must not re-broadcast, or reconnecting would duplicate the
    // message in every other client's list.
    if (isNew) {
      await this.prisma.conversation.update({
        where: { id: input.conversationId },
        data: { lastMessageAt: created.createdAt },
      });

      // The sender's own cursor advances implicitly: you have read what you sent.
      await this.prisma.conversationMember.update({
        where: { conversationId_userId: { conversationId: input.conversationId, userId: senderId } },
        data: { lastReadMessageId: created.id, lastDeliveredMessageId: created.id },
      });

      const memberIds = await this.access.memberIds(input.conversationId);
      this.realtime.toUsers(memberIds, SOCKET_EVENTS.MESSAGE_NEW, view);
    }

    return view;
  }

  /**
   * Keyset pagination over the `(conversationId, id DESC)` index.
   *
   * `before` walks backwards through history for infinite upward scroll.
   * `after` backfills everything a client missed while its socket was down,
   * which is what makes reconnection lossless.
   */
  async history(userId: string, conversationId: string, query: HistoryQuery): Promise<HistoryPage> {
    await this.access.assertMember(userId, conversationId);

    const isBackfill = Boolean(query.after);
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        status: MessageStatus.VISIBLE,
        deletedAt: null,
        ...(query.before ? { id: { lt: query.before } } : {}),
        ...(query.after ? { id: { gt: query.after } } : {}),
      },
      include: { attachment: true },
      orderBy: { id: isBackfill ? 'asc' : 'desc' },
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    // Always hand back oldest-first; the client renders in reading order.
    const ordered = isBackfill ? page : [...page].reverse();

    return {
      messages: ordered.map((row) => toMessageView(row, this.publicBaseUrl)),
      nextCursor: hasMore && !isBackfill ? (page.at(-1)?.id ?? null) : null,
      hasMore,
    };
  }

  private async recordModeration(
    userId: string,
    kind: 'TEXT' | 'IMAGE',
    blocked: boolean,
    reason: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.moderationEvent.create({
      data: { id: newId(), userId, kind, blocked, reason, detail: detail as InputJsonValue },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}
