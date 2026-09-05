import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenService } from './token.service.js';
import { ACCESS_COOKIE } from './auth.types.js';
import { IS_PUBLIC } from './public.decorator.js';

/**
 * Bound globally, so a route is protected unless it explicitly opts out with
 * `@Public()`. Forgetting to add a guard cannot silently expose an endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    // WebSocket handlers are out of scope here: a socket is authenticated once at
    // the handshake (see ChatGateway.afterInit) and rejected there if invalid, so
    // by the time any handler runs the principal is already on socket.data.
    // Without this the guard would run against a non-HTTP context and throw.
    if (ctx.getType() !== 'http') return true;

    const request = ctx.switchToHttp().getRequest<Request>();
    const token = extractToken(request);
    if (!token) throw new UnauthorizedException('Not authenticated');

    try {
      request.user = await this.tokens.verifyAccessToken(token);
      return true;
    } catch {
      throw new UnauthorizedException('Session expired');
    }
  }
}

/**
 * The cookie is what the browser uses. The Authorization header is accepted too
 * so the API can be exercised directly with curl, which is how the authorization
 * boundaries are demonstrated.
 */
function extractToken(request: Request): string | null {
  const cookie = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  if (cookie) return cookie;

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);

  return null;
}
