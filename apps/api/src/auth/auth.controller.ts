import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loginSchema, registerSchema, type PublicUser } from '@chat/shared';
import type { CookieOptions, Request, Response } from 'express';
import { zodBody } from '../common/pipes/zod-validation.pipe.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, type AuthPrincipal } from './auth.types.js';
import { Public } from './public.decorator.js';
import type { Env } from '../config/env.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly presence: PresenceService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @RateLimit({ name: 'auth', ...RATE_LIMITS.auth })
  @Post('register')
  async register(
    @Body(zodBody(registerSchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicUser> {
    const principal = await this.auth.register(body as never);
    await this.establishSession(principal, res);
    return this.auth.getPublicUser(principal.userId, await this.presence.isOnline(principal.userId));
  }

  @Public()
  @RateLimit({ name: 'auth', ...RATE_LIMITS.auth })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginSchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicUser> {
    const principal = await this.auth.login(body as never);
    await this.establishSession(principal, res);
    return this.auth.getPublicUser(principal.userId, await this.presence.isOnline(principal.userId));
  }

  /**
   * Rotates the refresh token and mints a new access token. Public because the
   * access token is expected to be expired by the time this is called.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<PublicUser> {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const rotated = presented ? await this.tokens.rotateRefreshToken(presented) : null;

    if (!rotated) {
      this.clearCookies(res);
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    const user = await this.auth.getPublicUser(
      rotated.userId,
      await this.presence.isOnline(rotated.userId),
    );
    const access = await this.tokens.signAccessToken({
      userId: rotated.userId,
      email: await this.auth.getEmail(rotated.userId),
    });
    res.cookie(ACCESS_COOKIE, access, this.cookieOptions());
    res.cookie(REFRESH_COOKIE, rotated.token, {
      ...this.cookieOptions(),
      expires: rotated.expiresAt,
    });
    return user;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (presented) await this.tokens.revokeRefreshToken(presented);
    this.clearCookies(res);
  }

  @Get('me')
  async me(@CurrentUser() principal: AuthPrincipal): Promise<PublicUser> {
    const online = await this.presence.isOnline(principal.userId);
    return this.auth.getPublicUser(principal.userId, online);
  }

  private async establishSession(principal: AuthPrincipal, res: Response): Promise<void> {
    const access = await this.tokens.signAccessToken(principal);
    const refresh = await this.tokens.issueRefreshToken(principal.userId);
    res.cookie(ACCESS_COOKIE, access, this.cookieOptions());
    res.cookie(REFRESH_COOKIE, refresh.token, {
      ...this.cookieOptions(),
      expires: refresh.expiresAt,
    });
  }

  /**
   * httpOnly so script cannot read the token; sameSite=lax is sufficient because
   * the API and the web client are served from one origin in production.
   */
  private cookieOptions(): CookieOptions {
    const isProd = this.config.get('NODE_ENV', { infer: true }) === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
    };
  }

  private clearCookies(res: Response): void {
    const opts = this.cookieOptions();
    res.clearCookie(ACCESS_COOKIE, opts);
    res.clearCookie(REFRESH_COOKIE, opts);
  }
}
