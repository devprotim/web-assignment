import { Module } from '@nestjs/common';
import { MessagesService } from '../messages/messages.service.js';
import { ReceiptsService } from '../messages/receipts.service.js';
import { ProfanityService } from '../moderation/profanity.service.js';
import { ConversationAccessService } from './conversation-access.service.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  controllers: [ConversationsController],
  providers: [
    ConversationsService,
    ConversationAccessService,
    MessagesService,
    ReceiptsService,
    ProfanityService,
  ],
  exports: [ConversationsService, ConversationAccessService, MessagesService, ReceiptsService],
})
export class ConversationsModule {}
