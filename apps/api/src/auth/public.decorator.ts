import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/** Opts a route out of the globally bound AuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
