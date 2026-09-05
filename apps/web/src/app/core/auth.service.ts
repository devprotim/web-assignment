import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { LoginInput, PublicUser, RegisterInput } from '@chat/shared';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly currentUser = signal<PublicUser | null>(null);
  /** Distinguishes "not signed in" from "we have not checked yet". */
  private readonly checked = signal(false);

  readonly user = this.currentUser.asReadonly();
  readonly isAuthenticated = computed(() => this.currentUser() !== null);
  readonly isReady = this.checked.asReadonly();

  /** Called once at startup to restore a session from the cookie. */
  async restore(): Promise<void> {
    try {
      this.currentUser.set(await firstValueFrom(this.http.get<PublicUser>('/api/auth/me')));
    } catch {
      this.currentUser.set(null);
    } finally {
      this.checked.set(true);
    }
  }

  async login(input: LoginInput): Promise<void> {
    this.currentUser.set(
      await firstValueFrom(this.http.post<PublicUser>('/api/auth/login', input)),
    );
  }

  async register(input: RegisterInput): Promise<void> {
    this.currentUser.set(
      await firstValueFrom(this.http.post<PublicUser>('/api/auth/register', input)),
    );
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/logout', {})).catch(() => undefined);
    this.currentUser.set(null);
    await this.router.navigate(['/login']);
  }
}
