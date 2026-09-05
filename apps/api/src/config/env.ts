import { z } from 'zod';

/**
 * Every environment variable the server reads, validated once at boot.
 * A missing or malformed value fails startup loudly instead of surfacing as a
 * confusing runtime error under load.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ORIGIN: z.string().url(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  S3_PUBLIC_URL: z.string().url(),

  NSFW_THRESHOLD_PORN: z.coerce.number().min(0).max(1).default(0.6),
  NSFW_THRESHOLD_HENTAI: z.coerce.number().min(0).max(1).default(0.6),
  NSFW_THRESHOLD_SEXY: z.coerce.number().min(0).max(1).default(0.85),
  NSFW_THRESHOLD_COMBINED: z.coerce.number().min(0).max(1).default(0.75),

  TENOR_API_KEY: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
