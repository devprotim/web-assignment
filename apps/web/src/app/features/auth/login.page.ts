import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <main class="shell">
      <section class="card">
        <header>
          <h1>{{ mode() === 'login' ? 'Welcome back' : 'Create an account' }}</h1>
          <p>{{ mode() === 'login' ? 'Sign in to continue.' : 'It takes a moment.' }}</p>
        </header>

        <form (ngSubmit)="submit()">
          @if (mode() === 'register') {
            <label>
              <span>Display name</span>
              <input name="displayName" [(ngModel)]="displayName" required autocomplete="name" />
            </label>
          }
          <label>
            <span>Email</span>
            <input name="email" type="email" [(ngModel)]="email" required autocomplete="email" />
          </label>
          <label>
            <span>Password</span>
            <input
              name="password"
              type="password"
              [(ngModel)]="password"
              required
              [autocomplete]="mode() === 'login' ? 'current-password' : 'new-password'"
            />
          </label>

          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }

          <button class="primary" type="submit" [disabled]="busy()">
            {{ busy() ? 'Please wait...' : mode() === 'login' ? 'Sign in' : 'Create account' }}
          </button>
        </form>

        <button class="link" type="button" (click)="toggle()">
          {{ mode() === 'login' ? 'Need an account? Register' : 'Already registered? Sign in' }}
        </button>

        <aside class="demo">
          <p>Demo accounts, both with password <code>demo-password-123</code></p>
          <div>
            <button type="button" (click)="fill('alice@demo.chat')">alice&#64;demo.chat</button>
            <button type="button" (click)="fill('bob@demo.chat')">bob&#64;demo.chat</button>
          </div>
        </aside>
      </section>
    </main>
  `,
  styles: `
    .shell {
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(400px, 100%);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 32px;
      box-shadow: var(--shadow);
    }
    h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.02em; }
    header p { margin: 0 0 24px; color: var(--text-muted); font-size: 14px; }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 6px; }
    label span { font-size: 13px; font-weight: 500; color: var(--text-muted); }
    input {
      padding: 10px 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: var(--surface);
      transition: border-color 120ms ease;
    }
    input:focus { border-color: var(--accent); }
    .primary {
      margin-top: 6px;
      padding: 11px 16px;
      border: none;
      border-radius: var(--radius-sm);
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
    .primary:disabled { opacity: 0.6; cursor: progress; }
    .error {
      margin: 0;
      padding: 9px 12px;
      border-radius: var(--radius-sm);
      background: var(--danger-soft);
      color: var(--danger);
      font-size: 13px;
    }
    .link {
      display: block;
      width: 100%;
      margin-top: 16px;
      background: none;
      border: none;
      color: var(--accent);
      font-size: 14px;
    }
    .demo {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-muted);
    }
    .demo p { margin: 0 0 10px; }
    .demo div { display: flex; gap: 8px; }
    .demo button {
      flex: 1;
      padding: 7px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: var(--surface-sunken);
      font-size: 12px;
    }
    code { font-size: 12px; background: var(--surface-sunken); padding: 1px 5px; border-radius: 4px; }
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly mode = signal<'login' | 'register'>('login');
  readonly busy = signal(false);
  readonly error = signal('');

  email = '';
  password = '';
  displayName = '';

  toggle(): void {
    this.mode.update((m) => (m === 'login' ? 'register' : 'login'));
    this.error.set('');
  }

  fill(email: string): void {
    this.mode.set('login');
    this.email = email;
    this.password = 'demo-password-123';
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.mode() === 'login') {
        await this.auth.login({ email: this.email, password: this.password });
      } else {
        await this.auth.register({
          email: this.email,
          password: this.password,
          displayName: this.displayName,
        });
      }
      await this.router.navigate(['/chat']);
    } catch (error) {
      this.error.set(readError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Surfaces the server's message when there is one, rather than a generic failure. */
function readError(error: unknown): string {
  const body = (error as { error?: { message?: string; issues?: { message: string }[] } })?.error;
  if (body?.issues?.length) return body.issues[0].message;
  return body?.message ?? 'Something went wrong. Please try again.';
}
