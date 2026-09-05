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
    path: 'chat',
    canActivate: [authGuard],
    loadComponent: () => import('./features/chat/chat.page').then((m) => m.ChatPage),
  },
  { path: '**', redirectTo: 'chat' },
];
