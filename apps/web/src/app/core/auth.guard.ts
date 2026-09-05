import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Waits for the initial session check before deciding, so a page refresh does not
 * briefly bounce an authenticated user to the login screen.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isReady()) await auth.restore();
  return auth.isAuthenticated() ? true : router.createUrlTree(['/login']);
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isReady()) await auth.restore();
  return auth.isAuthenticated() ? router.createUrlTree(['/chat']) : true;
};
