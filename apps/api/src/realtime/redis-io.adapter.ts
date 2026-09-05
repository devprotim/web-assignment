import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { RedisService } from '../redis/redis.service.js';

/**
 * Routes Socket.IO broadcasts through Redis pub/sub.
 *
 * Without this, a message sent to a socket on instance A never reaches a
 * recipient connected to instance B, so the app only works on a single process.
 * Pub/sub needs its own connections: a client in subscriber mode cannot issue
 * ordinary commands, which is why these are duplicates rather than the shared
 * command client.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
    const redis = app.get(RedisService);
    this.adapterConstructor = createAdapter(
      redis.duplicate('socket-pub'),
      redis.duplicate('socket-sub'),
    );
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
