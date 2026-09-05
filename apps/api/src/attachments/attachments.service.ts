import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ALLOWED_IMAGE_MIME,
  MAX_UPLOAD_BYTES,
  ModerationReason,
  ModerationStatus,
  type AttachmentView,
  type PresignInput,
  type PresignResult,
} from '@chat/shared';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { newId } from '../common/util/ids.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { toAttachmentView } from '../messages/message.mapper.js';
import { NsfwService, type NsfwScores } from '../moderation/nsfw.service.js';
import type { InputJsonValue } from '../generated/prisma/internal/prismaNamespace.js';
import type { Env } from '../config/env.js';

/** Guards against decompression bombs: a small file can decode to a huge bitmap. */
const MAX_DIMENSION = 8000;

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly nsfw: NsfwService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get publicBaseUrl(): string {
    return this.config.get('S3_PUBLIC_URL', { infer: true });
  }

  /**
   * Step 1: reserve an attachment and hand back a presigned PUT.
   *
   * Nothing here is trusted yet. The declared mime and size only shape the
   * presigned policy; both are re-checked against the actual bytes in `moderate`.
   */
  async presign(userId: string, input: PresignInput): Promise<PresignResult> {
    if (!ALLOWED_IMAGE_MIME.includes(input.mime)) {
      throw new UnprocessableEntityException({
        code: 'UNSUPPORTED_FILE_TYPE',
        reason: ModerationReason.UNSUPPORTED_FILE_TYPE,
        message: 'Only JPEG, PNG and WebP images can be sent.',
      });
    }
    if (input.size > MAX_UPLOAD_BYTES) {
      throw new UnprocessableEntityException({
        code: 'FILE_TOO_LARGE',
        reason: ModerationReason.FILE_TOO_LARGE,
        message: `Images must be ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB or smaller.`,
      });
    }

    const id = newId();
    const storageKey = `uploads/${userId}/${id}.${EXTENSION[input.mime] ?? 'bin'}`;

    await this.prisma.attachment.create({
      data: {
        id,
        ownerId: userId,
        storageKey,
        mime: input.mime,
        size: input.size,
        moderationStatus: ModerationStatus.PENDING,
      },
    });

    return {
      attachmentId: id,
      uploadUrl: await this.storage.presignUpload(storageKey, input.mime, input.size),
      requiredHeaders: { 'Content-Type': input.mime },
    };
  }

  /**
   * Step 2: validate the uploaded bytes and classify them.
   *
   * Runs entirely on the server. A client that skips this call simply ends up
   * with an attachment stuck in PENDING, which MessagesService refuses to attach
   * to a message, so there is no path that puts an unscanned image in front of a
   * recipient.
   */
  async moderate(userId: string, attachmentId: string): Promise<AttachmentView> {
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) throw new NotFoundException('Attachment not found');
    if (attachment.ownerId !== userId) throw new ForbiddenException('Not your attachment');

    // Already decided: return the stored verdict instead of paying for inference
    // again. Also makes the endpoint safe to retry.
    if (attachment.moderationStatus === ModerationStatus.APPROVED) {
      return toAttachmentView(attachment, this.publicBaseUrl);
    }
    if (attachment.moderationStatus === ModerationStatus.REJECTED) {
      throw this.rejection('This image was blocked by moderation.');
    }

    // The size the client declared is not evidence. Check what is actually there.
    const actualSize = await this.storage.headSize(attachment.storageKey);
    if (actualSize === null) {
      throw new UnprocessableEntityException({
        code: 'UPLOAD_MISSING',
        message: 'Upload not found. Please try again.',
      });
    }
    if (actualSize > MAX_UPLOAD_BYTES) {
      await this.reject(attachment.id, attachment.storageKey, userId, null, 'size-exceeded');
      throw this.rejection('That image is too large.');
    }

    const bytes = await this.storage.getObject(attachment.storageKey, MAX_UPLOAD_BYTES);
    if (!bytes) {
      throw new UnprocessableEntityException({
        code: 'UPLOAD_UNREADABLE',
        message: 'Upload could not be read. Please try again.',
      });
    }

    // Trust the magic bytes, never the filename or the declared Content-Type.
    // A .png that is actually something else is rejected here.
    const detected = await fileTypeFromBuffer(bytes);
    if (!detected || !ALLOWED_IMAGE_MIME.includes(detected.mime as never)) {
      await this.reject(attachment.id, attachment.storageKey, userId, null, 'mime-mismatch');
      throw new UnprocessableEntityException({
        code: 'UNSUPPORTED_FILE_TYPE',
        reason: ModerationReason.UNSUPPORTED_FILE_TYPE,
        message: 'That file is not a supported image.',
      });
    }

    const metadata = await sharp(bytes).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      await this.reject(attachment.id, attachment.storageKey, userId, null, 'dimensions');
      throw this.rejection('That image has unsupported dimensions.');
    }

    const verdict = await this.nsfw.classify(bytes);
    this.logger.debug(
      `moderated ${attachment.id}: safe=${verdict.safe} in ${verdict.latencyMs}ms ${JSON.stringify(verdict.scores)}`,
    );

    if (!verdict.safe) {
      await this.reject(
        attachment.id,
        attachment.storageKey,
        userId,
        verdict.scores,
        verdict.rule ?? 'nsfw',
      );
      throw new UnprocessableEntityException({
        code: 'IMAGE_BLOCKED',
        reason: ModerationReason.EXPLICIT_IMAGE,
        message: 'This image was blocked because it appears to contain explicit content.',
      });
    }

    // Re-encode from decoded pixels. This strips EXIF (which carries GPS and
    // device data) and discards anything appended to the container.
    const sanitised = await sharp(bytes).rotate().toFormat('webp', { quality: 82 }).toBuffer();
    const thumbnail = await sharp(bytes)
      .rotate()
      .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .toFormat('webp', { quality: 70 })
      .toBuffer();

    const sanitisedKey = `media/${userId}/${attachment.id}.webp`;
    const thumbnailKey = `media/${userId}/${attachment.id}.thumb.webp`;
    await this.storage.putObject(sanitisedKey, sanitised, 'image/webp');
    await this.storage.putObject(thumbnailKey, thumbnail, 'image/webp');
    // The original, with whatever metadata it carried, is not kept.
    await this.storage.deleteObject(attachment.storageKey);

    const updated = await this.prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        storageKey: sanitisedKey,
        thumbnailKey,
        mime: 'image/webp',
        size: sanitised.length,
        width,
        height,
        moderationStatus: ModerationStatus.APPROVED,
        moderationScores: verdict.scores as unknown as InputJsonValue,
      },
    });

    await this.audit(userId, false, verdict.rule, {
      scores: verdict.scores,
      latencyMs: verdict.latencyMs,
    });

    return toAttachmentView(updated, this.publicBaseUrl);
  }

  /**
   * Authorises a read and returns a short-lived signed URL for the bytes.
   *
   * A user may read an attachment if they own it, or if it is attached to a
   * message in a conversation they belong to. Anything else is a 403, which is
   * what stops a leaked or guessed attachment id from exposing a private image.
   */
  async resolveContentUrl(
    userId: string,
    attachmentId: string,
    variant: 'full' | 'thumbnail',
  ): Promise<string> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: { message: { select: { conversationId: true } } },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    if (attachment.moderationStatus !== ModerationStatus.APPROVED) {
      throw new ForbiddenException('Attachment is not available');
    }

    if (attachment.ownerId !== userId) {
      const conversationId = attachment.message?.conversationId;
      if (!conversationId) throw new ForbiddenException('Attachment is not available');

      const membership = await this.prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { userId: true },
      });
      if (!membership) throw new ForbiddenException('Attachment is not available');
    }

    const key =
      variant === 'thumbnail' && attachment.thumbnailKey
        ? attachment.thumbnailKey
        : attachment.storageKey;

    return this.storage.presignDownload(key);
  }

  /** Marks rejected and removes the bytes; a blocked image is not retained. */
  private async reject(
    attachmentId: string,
    storageKey: string,
    userId: string,
    scores: NsfwScores | null,
    rule: string,
  ): Promise<void> {
    await this.storage.deleteObject(storageKey);
    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: {
        moderationStatus: ModerationStatus.REJECTED,
        moderationScores: (scores ?? undefined) as unknown as InputJsonValue,
      },
    });
    await this.audit(userId, true, rule, { scores });
  }

  private async audit(
    userId: string,
    blocked: boolean,
    rule: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.moderationEvent.create({
      data: {
        id: newId(),
        userId,
        kind: 'IMAGE',
        blocked,
        reason: rule,
        detail: detail as InputJsonValue,
      },
    });
  }

  private rejection(message: string): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'IMAGE_BLOCKED',
      reason: ModerationReason.EXPLICIT_IMAGE,
      message,
    });
  }
}
