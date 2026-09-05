import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { PresenceModule } from './presence/presence.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { ChatModule } from './realtime/chat.module.js';
import { StorageModule } from './storage/storage.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { GifModule } from './gif/gif.module.js';
import { UsersModule } from './users/users.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { AuthGuard } from './auth/auth.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // One .env at the repo root, shared with the Prisma CLI config.
      envFilePath: resolve(import.meta.dirname, '../../../.env'),
      validate: validateEnv,
    }),
    // In production the API also serves the built Angular bundle, so the whole
    // app is one origin. That is what lets the session cookie be SameSite=Lax
    // with no CORS credential surface, and lets the WebSocket handshake carry it
    // without configuration. In development the Angular dev server proxies here
    // instead, so the same single-origin behaviour holds while developing.
    ...(process.env.NODE_ENV === 'production'
      ? [
          ServeStaticModule.forRoot({
            rootPath: resolve(import.meta.dirname, '../../web/dist/web/browser'),
            // API routes must win; everything else falls through to index.html
            // so client-side routes survive a refresh.
            exclude: ['/api/{*splat}', '/socket.io/{*splat}'],
          }),
        ]
      : []),
    PrismaModule,
    RedisModule,
    PresenceModule,
    RealtimeModule,
    RateLimitModule,
    AuthModule,
    ConversationsModule,
    StorageModule,
    AttachmentsModule,
    GifModule,
    UsersModule,
    ChatModule,
  ],
  providers: [
    // Routes are authenticated by default; `@Public()` is the explicit opt-out.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
