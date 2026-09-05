import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request payload against a schema from `@chat/shared`, so the
 * client and server enforce the exact same contract from one definition.
 *
 * Zod strips unknown keys by default, which is the behaviour we want: a client
 * cannot smuggle extra fields (`senderId`, `status`, ...) into a write.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request payload failed validation',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}

/** Convenience for `@Body(zodBody(schema))`. */
export const zodBody = <T>(schema: ZodType<T>) => new ZodValidationPipe(schema);
