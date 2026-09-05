import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { newId } from '../common/util/ids.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.js';
import type { AuthPrincipal } from './auth.types.js';

/**
 * Two-token scheme:
 *
 *   access  - short-lived signed JWT, verified statelessly on every request and
 *             on the WebSocket handshake.
 *   refresh - opaque random string. Only its SHA-256 lands in the database, so a
 *             dump of `refresh_tokens` yields nothing usable. Rotated on every
 *             use, and the old row is revoked in the same transaction.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async signAccessToken(principal: AuthPrincipal): Promise<string> {
    return this.jwt.signAsync(principal, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('ACCESS_TOKEN_TTL', { infer: true }),
    });
  }

  async verifyAccessToken(token: string): Promise<AuthPrincipal> {
    return this.jwt.verifyAsync<AuthPrincipal>(token, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issueRefreshToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(48).toString('base64url');
    const days = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: { id: newId(), userId, tokenHash: this.hash(token), expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * Verifies and rotates in one step. Returns null for anything unusable, so the
   * caller cannot accidentally accept a revoked or expired token.
   */
  async rotateRefreshToken(
    token: string,
  ): Promise<{ userId: string; token: string; expiresAt: Date } | null> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(token) },
    });
    if (!existing || existing.revokedAt || existing.expiresAt < new Date()) return null;

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    const next = await this.issueRefreshToken(existing.userId);
    return { userId: existing.userId, ...next };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
