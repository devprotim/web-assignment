import type { AttachmentView, GifMeta, MessageView, StickerMeta } from '@chat/shared';
import type { Attachment, Message } from '../generated/prisma/client.js';

export type MessageWithAttachment = Message & { attachment?: Attachment | null };

/**
 * Prisma row -> wire shape. Every response goes through here so the client never
 * sees internal columns (storage keys, raw moderation scores, deletedAt).
 *
 * Attachment URLs point at the API, not at object storage. The API checks the
 * reader belongs to the conversation before redirecting to a short-lived signed
 * URL, so a leaked link does not expose a private image and the bucket stays
 * entirely non-public.
 */
export function toMessageView(
  message: MessageWithAttachment,
  publicBaseUrl?: string,
): MessageView {
  const meta = (message.meta ?? null) as Record<string, unknown> | null;

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    kind: message.kind,
    status: message.status,
    text: message.body,
    gif: message.kind === 'GIF' ? ((meta as unknown as GifMeta) ?? null) : null,
    sticker: message.kind === 'STICKER' ? ((meta as unknown as StickerMeta) ?? null) : null,
    attachment: message.attachment ? toAttachmentView(message.attachment, publicBaseUrl) : null,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toAttachmentView(attachment: Attachment, _publicBaseUrl?: string): AttachmentView {
  return {
    id: attachment.id,
    url: `/api/attachments/${attachment.id}/content`,
    thumbnailUrl: attachment.thumbnailKey ? `/api/attachments/${attachment.id}/thumbnail` : null,
    mime: attachment.mime,
    width: attachment.width,
    height: attachment.height,
    moderationStatus: attachment.moderationStatus,
  };
}
