import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate-limit:options';

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
