/**
 * Shared enums. These mirror the Prisma enums exactly; keeping one definition
 * means a schema change that is not reflected on the client is a compile error.
 */

export const ConversationType = {
  DIRECT: 'DIRECT',
  GROUP: 'GROUP',
} as const;
export type ConversationType = (typeof ConversationType)[keyof typeof ConversationType];

export const MessageKind = {
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  GIF: 'GIF',
  STICKER: 'STICKER',
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

/**
 * PENDING  - accepted but not yet visible (attachment still being moderated)
 * VISIBLE  - delivered to the conversation
 * REJECTED - blocked by moderation; never fanned out to other members
 */
export const MessageStatus = {
  PENDING: 'PENDING',
  VISIBLE: 'VISIBLE',
  REJECTED: 'REJECTED',
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

export const ModerationStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type ModerationStatus = (typeof ModerationStatus)[keyof typeof ModerationStatus];

/**
 * Stable, machine-readable reasons returned to the sender when a send is blocked.
 * The client maps these to copy; the server never returns the matched wordlist.
 */
export const ModerationReason = {
  PROFANITY: 'PROFANITY',
  EXPLICIT_IMAGE: 'EXPLICIT_IMAGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  ATTACHMENT_NOT_APPROVED: 'ATTACHMENT_NOT_APPROVED',
} as const;
export type ModerationReason = (typeof ModerationReason)[keyof typeof ModerationReason];
