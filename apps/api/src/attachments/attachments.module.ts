import { Module } from '@nestjs/common';
import { NsfwService } from '../moderation/nsfw.service.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, NsfwService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
