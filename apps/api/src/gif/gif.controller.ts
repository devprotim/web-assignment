import { Controller, Get, Query } from '@nestjs/common';
import { gifSearchSchema, type GifSearchInput, type GifSearchResult } from '@chat/shared';
import { zodBody } from '../common/pipes/zod-validation.pipe.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.service.js';
import { GifService } from './gif.service.js';

@Controller('gifs')
export class GifController {
  constructor(private readonly gifs: GifService) {}

  /**
   * Rate limited per user because every call spends quota on an upstream API
   * whose budget is ours, and a type-ahead picker calls it on every keystroke.
   */
  @Get('search')
  @RateLimit({ name: 'gif', ...RATE_LIMITS.gifSearch })
  search(@Query(zodBody(gifSearchSchema)) query: GifSearchInput): Promise<GifSearchResult> {
    return this.gifs.search(query);
  }

  /** Lets the client hide the GIF tab entirely when no key is configured. */
  @Get('status')
  status(): { configured: boolean } {
    return { configured: this.gifs.isConfigured };
  }
}
