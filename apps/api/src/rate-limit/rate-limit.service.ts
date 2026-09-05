import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. Surfaced as Retry-After. */
  resetIn: number;
}

/**
 * Fixed-window counter in Redis.
 *
 * `@nestjs/throttler` has no Nest 12 release yet, and its own docs note it cannot
 * be bound globally for WebSocket handlers. Since the requirement covers message
 * sends (a socket event) as well as HTTP uploads, one shared limiter that both
 * transports call is simpler than two mechanisms, and it works across instances
 * because the counter lives in Redis rather than in process memory.
 *
 * INCR and EXPIRE run in a single Lua script so two concurrent requests cannot
 * both see a fresh counter and each set their own TTL.
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const [countRaw, ttlRaw] = (await this.redis.client.eval(
      CONSUME_SCRIPT,
      1,
      `ratelimit:${key}`,
      String(windowSeconds),
    )) as [number, number];

    const count = Number(countRaw);
    const resetIn = Number(ttlRaw) > 0 ? Number(ttlRaw) : windowSeconds;

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetIn,
    };
  }
}

/**
 * Buckets, in one place so the limits are reviewable together rather than
 * scattered across decorators.
 */
export const RATE_LIMITS = {
  /** Per IP. Login and register are the credential-stuffing surface. */
  auth: { limit: 10, windowSeconds: 60 },
  /** Per user. Generous enough for fast typing, tight enough to stop flooding. */
  sendMessage: { limit: 20, windowSeconds: 10 },
  /** Per user. Uploads are the most expensive path (storage + model inference). */
  upload: { limit: 10, windowSeconds: 60 },
  /** Per user. Moderation runs a model, so it is metered separately. */
  moderate: { limit: 15, windowSeconds: 60 },
  /** Per user. Proxied to a third-party API whose quota we are spending. */
  gifSearch: { limit: 30, windowSeconds: 60 },
} as const;
