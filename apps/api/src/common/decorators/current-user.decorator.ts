import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthPrincipal } from '../../auth/auth.types.js';

/**
 * The authenticated principal, taken from the verified token only.
 *
 * This is the single source of "who is acting". No handler reads an actor id
 * from the request body, which is what makes "users must not be able to send a
 * message as another account" true by construction rather than by review.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.user) throw new UnauthorizedException('Not authenticated');
    return request.user;
  },
);
