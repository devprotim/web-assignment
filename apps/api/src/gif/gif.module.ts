import { Module } from '@nestjs/common';
import { GifController } from './gif.controller.js';
import { GifService } from './gif.service.js';

@Module({
  controllers: [GifController],
  providers: [GifService],
})
export class GifModule {}
