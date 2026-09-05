import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

/**
 * Owns every Redis connection in the process.
 *
 * Redis is used for three distinct jobs, and they cannot share one connection:
 *   - commands   (presence sets, rate-limit counters)  -> `client`
 *   - pub/sub    (Socket.IO cross-instance fanout)     -> dedicated duplicates,
 *     because a connection in subscriber mode cannot issue normal commands.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly connections: Redis[] = [];

  readonly client: Redis;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.client = this.create('commands');
  }

  /** A fresh connection, tracked so shutdown closes all of them. */
  duplicate(label: string): Redis {
    return this.create(label);
  }

  private create(label: string): Redis {
    const client = new Redis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
      // Presence and rate limiting must not throw during a blip; ioredis queues
      // and replays once the connection is back.
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    client.on('error', (err: Error) => this.logger.error(`redis[${label}] ${err.message}`));
    client.on('connect', () => this.logger.log(`redis[${label}] connected`));
    this.connections.push(client);
    return client;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}
