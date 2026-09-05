import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Redirect } from '@nestjs/common';
import { presignSchema, type AttachmentView, type PresignInput, type PresignResult } from '@chat/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { zodBody } from '../common/pipes/zod-validation.pipe.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.service.js';
import { AttachmentsService } from './attachments.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post('presign')
  @RateLimit({ name: 'upload', ...RATE_LIMITS.upload })
  presign(
    @CurrentUser() me: AuthPrincipal,
    @Body(zodBody(presignSchema)) body: PresignInput,
  ): Promise<PresignResult> {
    return this.attachments.presign(me.userId, body);
  }

  /**
   * Serves an image to an authorised reader.
   *
   * Redirects to a short-lived signed URL rather than proxying the bytes, so the
   * application server stays out of the media data path while the bucket remains
   * private. The redirect target expires in minutes, so a copied link goes stale.
   */
  @Get(':id/content')
  @Redirect()
  async content(
    @CurrentUser() me: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string }> {
    return { url: await this.attachments.resolveContentUrl(me.userId, id, 'full') };
  }

  @Get(':id/thumbnail')
  @Redirect()
  async thumbnail(
    @CurrentUser() me: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string }> {
    return { url: await this.attachments.resolveContentUrl(me.userId, id, 'thumbnail') };
  }

  /**
   * Runs the nudity check. Metered separately from the upload because it is the
   * expensive one: it reads the object and runs model inference.
   */
  @Post(':id/moderate')
  @RateLimit({ name: 'moderate', ...RATE_LIMITS.moderate })
  moderate(
    @CurrentUser() me: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AttachmentView> {
    return this.attachments.moderate(me.userId, id);
  }
}
