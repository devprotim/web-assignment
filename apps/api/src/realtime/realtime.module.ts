import { Global, Module } from '@nestjs/common';
import { RealtimePublisher } from './realtime.publisher.js';

@Global()
@Module({
  providers: [RealtimePublisher],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
