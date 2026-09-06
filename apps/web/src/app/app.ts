import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    <button
      type="button"
      class="theme-toggle"
      (click)="theme.toggle()"
      [attr.aria-label]="theme.theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
    >
      {{ theme.theme() === 'dark' ? '☀️ Light' : '🌙 Dark' }}
    </button>
  `,
  styles: `
    :host { display: contents; }
    .theme-toggle {
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 100;
      padding: 8px 14px;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      background: var(--surface-raised);
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
      box-shadow: var(--shadow-sm);
    }
    .theme-toggle:hover { background: var(--surface-sunken); }
  `,
})
export class App {
  readonly theme = inject(ThemeService);
}
