import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The single authorization boundary for conversation-scoped work.
 *
 * Every REST handler and every socket event that touches a conversation goes
 * through `assertMember` first. Centralising it is what makes "users must not be
 * able to read conversations they do not belong to" checkable in one place
 * instead of relying on each handler remembering to check.
 */
@Injectable()
export class ConversationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertMember(userId: string, conversationId: string): Promise<void> {
    const membership = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { userId: true },
    });

    if (!membership) {
      // Deliberately 403 for both "not a member" and "does not exist": a 404 here
      // would let an attacker enumerate which conversation ids are real.
      throw new ForbiddenException('You are not a member of this conversation');
    }
  }

  async memberIds(conversationId: string): Promise<string[]> {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    if (members.length === 0) throw new NotFoundException('Conversation not found');
    return members.map((m) => m.userId);
  }

  /** Conversation ids the user belongs to; used to join socket rooms on connect. */
  async conversationIdsFor(userId: string): Promise<string[]> {
    const memberships = await this.prisma.conversationMember.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    return memberships.map((m) => m.conversationId);
  }
}
