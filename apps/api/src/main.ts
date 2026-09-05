import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Trust the platform proxy so rate limiting sees the real client IP.
    bodyParser: true,
  });
  const config = app.get(ConfigService<Env, true>);
  const isProd = config.get('NODE_ENV', { infer: true }) === 'production';

  app.set('trust proxy', 1);

  // Helmet's default CSP is `img-src 'self' data:` and `connect-src 'self'`,
  // which breaks two things that only show up in a production build (the Angular
  // dev server sends no CSP at all, so both work in development):
  //
  //   - media: an approved image is served as a redirect to a signed URL on the
  //     object store's origin, so `img-src` must allow it
  //   - uploads: the browser PUTs bytes straight to the object store, so
  //     `connect-src` must allow it
  //
  // The origins are derived from configuration rather than hardcoded, so the
  // same policy holds whether storage is MinIO locally or R2 in production.
  const storageOrigins = [
    ...new Set(
      [
        originOf(config.get('S3_ENDPOINT', { infer: true })),
        originOf(config.get('S3_PUBLIC_URL', { infer: true })),
      ].filter((origin): origin is string => origin !== null),
    ),
  ];

  // upgrade-insecure-requests rewrites every http:// subresource to https://.
  // That is right when the app is served over TLS, but it breaks local storage
  // (MinIO over plain http) when running a production build on localhost, so it
  // is enabled only when this deployment is actually on https.
  const servedOverTls = config.get('APP_ORIGIN', { infer: true }).startsWith('https://');

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Angular ships no inline scripts; styles are component-scoped and
          // injected at runtime, which does need 'unsafe-inline'.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', ...storageOrigins, 'https://*.klipy.com'],
          mediaSrc: ["'self'", 'data:', 'blob:', ...storageOrigins, 'https://*.klipy.com'],
          connectSrc: ["'self'", 'ws:', 'wss:', ...storageOrigins],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          ...(servedOverTls ? {} : { upgradeInsecureRequests: null }),
        },
      },
    }),
  );
  app.use(cookieParser());
  app.use(compression());

  app.setGlobalPrefix('api');
  // Validation is per-route via ZodValidationPipe against the schemas in
  // `@chat/shared`, so the client and server enforce one shared contract. Zod
  // strips unknown keys, which gives the same guarantee as `whitelist: true`.

  // In production the Angular bundle is served from this same origin, so no CORS
  // is needed at all. In development the dev server runs on a different port.
  if (!isProd) {
    app.enableCors({
      origin: config.get('APP_ORIGIN', { infer: true }),
      credentials: true,
    });
  }

  // Broadcasts travel through Redis pub/sub so they reach sockets on every
  // instance, not just the one that handled the request.
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on http://localhost:${port}/api`);
}

/** Scheme + host + port of a URL, or null when it is not parseable. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

await bootstrap();
