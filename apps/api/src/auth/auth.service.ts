import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import type { LoginInput, PublicUser, RegisterInput } from '@chat/shared';
import * as argon2 from 'argon2';
import { newId } from '../common/util/ids.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from './auth.types.js';

/**
 * argon2id with parameters chosen for an interactive login: memory-hard enough to
 * make offline cracking expensive, fast enough not to be its own DoS vector.
 */
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (OWASP baseline)
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class AuthService implements OnModuleInit {
  /**
   * A real argon2 digest of a random secret, computed once at boot. Verifying
   * against it costs the same as verifying a real password, which is what makes
   * the timing of "unknown email" indistinguishable from "wrong password".
   */
  private decoyHash!: string;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    this.decoyHash = await argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  }

  async register(input: RegisterInput): Promise<AuthPrincipal> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictException('An account with that email already exists');

    const user = await this.prisma.user.create({
      data: {
        id: newId(),
        email,
        passwordHash: await argon2.hash(input.password, ARGON2_OPTIONS),
        displayName: input.displayName,
      },
      select: { id: true, email: true },
    });
    return { userId: user.id, email: user.email };
  }

  async login(input: LoginInput): Promise<AuthPrincipal> {
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true },
    });

    if (!user) {
      await argon2.verify(this.decoyHash, input.password).catch(() => false);
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await argon2.verify(user.passwordHash, input.password).catch(() => false);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    return { userId: user.id, email: user.email };
  }

  async getEmail(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    return user.email;
  }

  async getPublicUser(userId: string, online: boolean): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, displayName: true, avatarUrl: true, lastSeenAt: true },
    });
    return {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      online,
      lastSeenAt: user.lastSeenAt.toISOString(),
    };
  }
}
