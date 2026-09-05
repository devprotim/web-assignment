import type { HttpInterceptorFn } from '@angular/common/http';

/**
 * The session lives in an httpOnly cookie, which script cannot read, so every
 * API call has to opt into sending credentials. Doing it in one interceptor means
 * no individual call can forget.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.url.startsWith('/api') ? req.clone({ withCredentials: true }) : req);
