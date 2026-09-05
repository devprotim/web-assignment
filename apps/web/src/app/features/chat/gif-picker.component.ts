import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { GifMeta, GifSearchResult } from '@chat/shared';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-gif-picker',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel" role="dialog" aria-label="GIFs">
      <input
        type="search"
        placeholder="Search GIFs"
        [ngModel]="query()"
        (ngModelChange)="query.set($event)"
        aria-label="Search GIFs"
      />

      @if (error()) {
        <p class="notice">{{ error() }}</p>
      } @else if (loading() && items().length === 0) {
        <p class="notice">Searching...</p>
      } @else if (items().length === 0) {
        <p class="notice">Nothing found.</p>
      } @else {
        <div class="grid">
          @for (gif of items(); track gif.id) {
            <button type="button" (click)="selected.emit(gif)">
              <!-- The grid renders Klipy's tiny preview, not the full GIF.
                   24 full-size GIFs is what makes a picker feel heavy. -->
              <img
                [src]="gif.previewUrl"
                [style.aspect-ratio]="gif.width + ' / ' + gif.height"
                loading="lazy"
                decoding="async"
                alt="GIF result"
              />
            </button>
          }
        </div>
      }

      <a class="attribution" href="https://klipy.com" target="_blank" rel="noopener">Powered by KLIPY</a>
    </div>
  `,
  styles: `
    .panel {
      width: 320px;
      height: 360px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    input {
      padding: 8px 10px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: var(--surface);
    }
    .grid {
      flex: 1;
      overflow-y: auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      align-content: start;
    }
    button { padding: 0; border: none; background: none; border-radius: var(--radius-sm); overflow: hidden; }
    img { display: block; width: 100%; height: auto; background: var(--surface-sunken); }
    .notice { margin: auto; color: var(--text-muted); font-size: 13px; text-align: center; padding: 0 12px; }
    .attribution { align-self: center; font-size: 11px; color: var(--text-muted); text-decoration: none; }
  `,
})
export class GifPickerComponent {
  private readonly http = inject(HttpClient);

  readonly selected = output<GifMeta>();

  readonly query = signal('');
  readonly items = signal<GifMeta[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

  constructor() {
    // Debounced so a type-ahead does not fire a request per keystroke, which
    // would burn the upstream quota and trip the server's rate limit.
    effect((onCleanup) => {
      const q = this.query();
      const timer = setTimeout(() => void this.search(q), q ? 300 : 0);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async search(q: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const params = new URLSearchParams({ limit: '24' });
      if (q) params.set('q', q);
      const result = await firstValueFrom(
        this.http.get<GifSearchResult>(`/api/gifs/search?${params}`),
      );
      this.items.set(result.items);
    } catch (error) {
      const body = (error as { error?: { message?: string } })?.error;
      this.error.set(body?.message ?? 'GIF search is unavailable.');
      this.items.set([]);
    } finally {
      this.loading.set(false);
    }
  }
}
