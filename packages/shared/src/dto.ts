import { z } from 'zod';
import { ConversationType, MessageKind, MessageStatus, ModerationStatus } from './enums.js';

/** IDs are UUIDv7 everywhere: time-sortable, so a single-column keyset cursor works. */
export const uuidSchema = z.string().uuid();

export const MAX_TEXT_LENGTH = 4000;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PAGE_SIZE = 50;

/* ------------------------------------------------------------------ auth */

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(60),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface PublicUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  online: boolean;
  lastSeenAt: string;
}

/* ----------------------------------------------------------- message body */

export const gifMetaSchema = z.object({
  provider: z.literal('klipy'),
  id: z.string().max(100),
  url: z.string().url().max(2000),
  previewUrl: z.string().url().max(2000),
  width: z.number().int().positive().max(4000),
  height: z.number().int().positive().max(4000),
});
export type GifMeta = z.infer<typeof gifMetaSchema>;

export const stickerMetaSchema = z.object({
  packId: z.string().max(50),
  stickerId: z.string().max(50),
});
export type StickerMeta = z.infer<typeof stickerMetaSchema>;

/**
 * Discriminated on `kind` so an IMAGE can never arrive without an attachmentId
 * and a TEXT can never smuggle one in. Validation is structural, not conditional.
 */
export const sendMessageSchema = z.object({
  conversationId: uuidSchema,
  /** Client-generated idempotency key. Retries and reconnect replays reuse it. */
  clientMessageId: uuidSchema,
  content: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal(MessageKind.TEXT),
      text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
    }),
    z.object({ kind: z.literal(MessageKind.IMAGE), attachmentId: uuidSchema }),
    z.object({ kind: z.literal(MessageKind.GIF), gif: gifMetaSchema }),
    z.object({ kind: z.literal(MessageKind.STICKER), sticker: stickerMetaSchema }),
  ]),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/* --------------------------------------------------------------- entities */

export interface AttachmentView {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  moderationStatus: ModerationStatus;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  kind: MessageKind;
  status: MessageStatus;
  text: string | null;
  gif: GifMeta | null;
  sticker: StickerMeta | null;
  attachment: AttachmentView | null;
  createdAt: string;
}

export interface ConversationMemberView {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  online: boolean;
  lastSeenAt: string;
  lastReadMessageId: string | null;
  lastDeliveredMessageId: string | null;
}

export interface ConversationView {
  id: string;
  type: ConversationType;
  members: ConversationMemberView[];
  lastMessage: MessageView | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

/* ------------------------------------------------------------- pagination */

/**
 * Keyset pagination. `before` walks backwards through history (infinite scroll
 * upward); `after` backfills everything missed while a socket was disconnected.
 * They are mutually exclusive.
 */
export const historyQuerySchema = z
  .object({
    before: uuidSchema.optional(),
    after: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
  })
  .refine((q) => !(q.before && q.after), {
    message: 'Provide either `before` or `after`, not both',
  });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export interface HistoryPage {
  messages: MessageView[];
  /** Cursor for the next older page; null once the conversation start is reached. */
  nextCursor: string | null;
  hasMore: boolean;
}

/* ---------------------------------------------------------------- uploads */

export const presignSchema = z.object({
  mime: z.enum(ALLOWED_IMAGE_MIME),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});
export type PresignInput = z.infer<typeof presignSchema>;

export interface PresignResult {
  attachmentId: string;
  uploadUrl: string;
  /** Headers the client must send verbatim; the presigned policy is bound to them. */
  requiredHeaders: Record<string, string>;
}

/* -------------------------------------------------------------------- gif */

export const gifSearchSchema = z.object({
  q: z.string().trim().max(100).default(''),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});
export type GifSearchInput = z.infer<typeof gifSearchSchema>;

export interface GifSearchResult {
  items: GifMeta[];
  nextCursor: string | null;
}
