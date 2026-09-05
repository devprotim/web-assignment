import { Global, Module } from '@nestjs/common';
import { PresenceService } from './presence.service.js';

@Global()
@Module({
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
