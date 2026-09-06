import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'chat' },
  {
    path: 'login',
    canActivate: [guestGuard],
    // Lazily loaded so the chat bundle is not shipped to a signed-out visitor.
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    // Which conversation is open lives in a query param (?c=<id>) rather than
    // a path segment, so switching conversations stays on this one route
    // config and Angular reuses the component instead of remounting it.
    path: 'chat',
    canActivate: [authGuard],
    loadComponent: () => import('./features/chat/chat.page').then((m) => m.ChatPage),
  },
  { path: '**', redirectTo: 'chat' },
];
