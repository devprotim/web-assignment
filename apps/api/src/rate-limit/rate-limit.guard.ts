import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator.js';
import { RateLimitService } from './rate-limit.service.js';

/**
 * Applies the bucket declared by `@RateLimit(...)` on a route.
 *
 * Keys by user id when authenticated and by IP otherwise, so one account cannot
 * dodge its limit by rotating IPs, and unauthenticated endpoints (login) are
 * still bounded.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimitService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!options) return true;

    // Socket events are rate limited inside the gateway instead, where the user
    // id is on socket.data and an ack can carry the rejection back to the client.
    if (ctx.getType() !== 'http') return true;

    const request = ctx.switchToHttp().getRequest<Request>();
    const response = ctx.switchToHttp().getResponse<Response>();

    const identity = request.user?.userId ?? request.ip ?? 'unknown';
    const decision = await this.limiter.consume(
      `${options.name}:${identity}`,
      options.limit,
      options.windowSeconds,
    );

    response.setHeader('X-RateLimit-Limit', options.limit);
    response.setHeader('X-RateLimit-Remaining', decision.remaining);

    if (!decision.allowed) {
      response.setHeader('Retry-After', decision.resetIn);
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: `Too many requests. Try again in ${decision.resetIn}s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
