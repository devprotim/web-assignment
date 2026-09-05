import { Controller, Get } from '@nestjs/common';
import type { PublicUser } from '@chat/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PresenceService } from '../presence/presence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {}

  /**
   * The people you can start a conversation with.
   *
   * Deliberately returns only the public projection: no email, no password hash,
   * no internal fields. In a real product this would be a search rather than a
   * full directory, but the assignment needs a way to reach a second account.
   */
  @Get()
  async list(@CurrentUser() me: AuthPrincipal): Promise<PublicUser[]> {
    const users = await this.prisma.user.findMany({
      where: { id: { not: me.userId } },
      select: { id: true, displayName: true, avatarUrl: true, lastSeenAt: true },
      orderBy: { displayName: 'asc' },
      take: 100,
    });

    const online = await this.presence.onlineMap(users.map((u) => u.id));

    return users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      online: online.get(user.id) ?? false,
      lastSeenAt: user.lastSeenAt.toISOString(),
    }));
  }
}
