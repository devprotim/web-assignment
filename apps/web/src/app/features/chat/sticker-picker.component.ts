import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { STICKER_PACKS, type StickerMeta } from '@chat/shared';

@Component({
  selector: 'app-sticker-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel" role="dialog" aria-label="Stickers">
      @for (pack of packs; track pack.id) {
        <h3>{{ pack.name }}</h3>
        <div class="grid">
          @for (sticker of pack.stickers; track sticker.id) {
            <button type="button" [title]="sticker.label" (click)="pick(pack.id, sticker.id)">
              <img [src]="sticker.url" [alt]="sticker.label" width="56" height="56" loading="lazy" />
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .panel {
      width: 300px;
      max-height: 320px;
      overflow-y: auto;
      padding: 12px;
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    button {
      display: grid;
      place-items: center;
      padding: 6px;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      transition: background 120ms ease, transform 120ms ease;
    }
    button:hover { background: var(--surface-sunken); transform: translateY(-1px); }
  `,
})
export class StickerPickerComponent {
  readonly packs = STICKER_PACKS;
  readonly selected = output<StickerMeta>();

  pick(packId: string, stickerId: string): void {
    this.selected.emit({ packId, stickerId });
  }
}
