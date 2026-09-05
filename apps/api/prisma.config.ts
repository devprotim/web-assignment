import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Single .env at the repo root, shared by both workspaces.
loadEnv({ path: resolve(import.meta.dirname, '../../.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Every Prisma CLI command loads this file, including `generate`, which
    // does not connect to a database. Using the strict `env()` helper here
    // would fail a Docker build stage that has no DATABASE_URL yet; a plain
    // process.env read with a fallback lets `generate` run without one while
    // `migrate deploy` still fails loudly if the real value is missing.
    url: process.env.DATABASE_URL ?? '',
  },
});
