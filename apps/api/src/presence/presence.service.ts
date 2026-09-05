import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A socket is considered live for this long after its last heartbeat. */
const SOCKET_TTL_SECONDS = 60;

/**
 * The `v2` segment is deliberate. This key held a plain Set before it held a
 * sorted set, and issuing ZSET commands against a leftover Set fails with
 * WRONGTYPE on every call. Versioning the name means a rolling deploy reads and
 * writes a fresh key instead of colliding with the old shape.
 */
const userKey = (userId: string) => `presence:v2:user:${userId}`;

/**
 * Presence is tracked per *socket*, in a sorted set scored by the socket's last
 * heartbeat.
 *
 * Per socket, so a user with three tabs open stays online when one closes.
 * Sorted by heartbeat, so entries left behind by a process that died without
 * running its disconnect handlers are pruned on the next read rather than marking
 * someone online forever. Every operation prunes first, which makes the structure
 * self-healing with no separate sweeper to run or monitor.
 */
@Injectable()
export class PresenceService {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /** Returns true when this was the user's first live socket (offline -> online). */
  async addSocket(userId: string, socketId: string): Promise<boolean> {
    const cutoff = Date.now() - SOCKET_TTL_SECONDS * 1000;
    const key = userKey(userId);

    const results = await this.redis.client
      .multi()
      .zremrangebyscore(key, '-inf', cutoff)
      .zadd(key, Date.now(), socketId)
      .zcard(key)
      .expire(key, SOCKET_TTL_SECONDS * 2)
      .exec();

    return Number(results?.[2]?.[1] ?? 0) === 1;
  }

  /** Returns true when this was the user's last live socket (online -> offline). */
  async removeSocket(userId: string, socketId: string): Promise<boolean> {
    const cutoff = Date.now() - SOCKET_TTL_SECONDS * 1000;
    const key = userKey(userId);

    const results = await this.redis.client
      .multi()
      .zremrangebyscore(key, '-inf', cutoff)
      .zrem(key, socketId)
      .zcard(key)
      .exec();

    if (Number(results?.[2]?.[1] ?? 0) > 0) return false;

    await this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date() },
    });
    return true;
  }

  /** Refreshes this socket's score so it is not pruned as stale. */
  async heartbeat(userId: string, socketId: string): Promise<void> {
    const key = userKey(userId);
    await this.redis.client
      .multi()
      .zadd(key, Date.now(), socketId)
      .expire(key, SOCKET_TTL_SECONDS * 2)
      .exec();
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.onlineMap([userId])).get(userId) ?? false;
  }

  /** One round trip for a whole conversation list rather than a call per member. */
  async onlineMap(userIds: string[]): Promise<Map<string, boolean>> {
    if (userIds.length === 0) return new Map();

    const cutoff = Date.now() - SOCKET_TTL_SECONDS * 1000;
    const pipeline = this.redis.client.multi();
    for (const id of userIds) {
      pipeline.zremrangebyscore(userKey(id), '-inf', cutoff);
      pipeline.zcard(userKey(id));
    }
    const results = await pipeline.exec();

    return new Map(
      userIds.map((id, index) => [id, Number(results?.[index * 2 + 1]?.[1] ?? 0) > 0]),
    );
  }
}
