import { v7 as uuidv7 } from 'uuid';

/**
 * All primary keys are UUIDv7: the first 48 bits are a millisecond timestamp, so
 * lexical order is chronological order. Postgres compares the `uuid` type by
 * bytes, which means `ORDER BY id` is `ORDER BY time` and history paginates on a
 * single indexed column with no composite cursor.
 */
export function newId(): string {
  return uuidv7();
}
