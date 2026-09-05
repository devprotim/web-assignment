import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import type { GifMeta, StickerMeta } from '@chat/shared';
import { ChatStore } from '../../core/chat.store';
import { UploadService } from '../../core/upload.service';
import { GifPickerComponent } from './gif-picker.component';
import { StickerPickerComponent } from './sticker-picker.component';

type Panel = 'none' | 'stickers' | 'gifs';

@Component({
  selector: 'app-composer',
  imports: [GifPickerComponent, StickerPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      @if (notice(); as message) {
        <p class="notice" role="alert">
          {{ message }}
          <button type="button" class="dismiss" (click)="notice.set('')" aria-label="Dismiss">×</button>
        </p>
      }

      @if (panel() !== 'none') {
        <div class="popover">
          <!-- @defer keeps both pickers out of the initial bundle; neither is
               needed until someone opens one. -->
          @if (panel() === 'stickers') {
            @defer (on immediate) {
              <app-sticker-picker (selected)="sendSticker($event)" />
            } @placeholder { <div class="skeleton"></div> }
          } @else {
            @defer (on immediate) {
              <app-gif-picker (selected)="sendGif($event)" />
            } @placeholder { <div class="skeleton"></div> }
          }
        </div>
      }

      <form class="bar" (submit)="submit($event)">
        <button
          type="button"
          class="icon"
          [class.active]="panel() === 'stickers'"
          (click)="toggle('stickers')"
          aria-label="Stickers"
          title="Stickers"
        >☺</button>
        <button
          type="button"
          class="icon"
          [class.active]="panel() === 'gifs'"
          (click)="toggle('gifs')"
          aria-label="GIFs"
          title="GIFs"
        >GIF</button>
        <button
          type="button"
          class="icon"
          (click)="openFilePicker()"
          [disabled]="uploading()"
          aria-label="Send an image"
          title="Send an image"
        >{{ uploading() ? '…' : '🖼' }}</button>
        <input
          #fileInput
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          (change)="onFile($event)"
        />

        <textarea
          #box
          rows="1"
          placeholder="Write a message"
          aria-label="Message"
          (input)="onInput()"
          (keydown)="onKeydown($event)"
        ></textarea>

        <button type="submit" class="send" aria-label="Send">Send</button>
      </form>
    </div>
  `,
  styles: `
    .wrap { position: relative; border-top: 1px solid var(--border); background: var(--surface); }
    .popover { position: absolute; bottom: calc(100% + 8px); left: 12px; z-index: 20; }
    .skeleton { width: 300px; height: 200px; border-radius: var(--radius); background: var(--surface-sunken); }
    .bar { display: flex; align-items: flex-end; gap: 6px; padding: 10px 12px; }
    .icon {
      flex: none;
      width: 36px; height: 36px;
      display: grid; place-items: center;
      border: none; border-radius: var(--radius-sm);
      background: transparent; color: var(--text-muted);
      font-size: 13px; font-weight: 600;
      transition: background 120ms ease, color 120ms ease;
    }
    .icon:hover:not(:disabled) { background: var(--surface-sunken); color: var(--text); }
    .icon.active { background: var(--accent-soft); color: var(--accent); }
    .icon:disabled { opacity: 0.5; cursor: progress; }
    textarea {
      flex: 1;
      min-height: 36px; max-height: 140px;
      padding: 8px 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      background: var(--surface);
      resize: none; line-height: 1.4;
    }
    textarea:focus { border-color: var(--accent); }
    .send {
      flex: none;
      height: 36px; padding: 0 16px;
      border: none; border-radius: var(--radius-lg);
      background: var(--accent); color: var(--accent-text);
      font-weight: 600;
    }
    .notice {
      display: flex; align-items: center; gap: 8px;
      margin: 0; padding: 9px 12px;
      background: var(--danger-soft); color: var(--danger);
      font-size: 13px;
    }
    .dismiss { margin-left: auto; border: none; background: none; color: inherit; font-size: 18px; line-height: 1; }
  `,
})
export class ComposerComponent {
  private readonly store = inject(ChatStore);
  private readonly uploads = inject(UploadService);

  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly panel = signal<Panel>('none');
  readonly uploading = signal(false);
  readonly notice = signal('');

  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private typingActive = false;

  /** A method rather than a template expression: the `#fileInput` template
   *  reference shadows the viewChild signal inside the template. */
  openFilePicker(): void {
    this.fileInput().nativeElement.click();
  }

  toggle(panel: Panel): void {
    this.panel.update((current) => (current === panel ? 'none' : panel));
  }

  onKeydown(event: KeyboardEvent): void {
    // Enter sends; Shift+Enter is a newline. Standard for chat, and it means the
    // common case needs no mouse.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit(event);
    }
  }

  onInput(): void {
    this.autoGrow();

    // One typing:start, then a trailing stop. Emitting per keystroke would put a
    // socket message on the wire for every character typed.
    if (!this.typingActive) {
      this.typingActive = true;
      this.store.setTyping(true);
    }
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 2000);
  }

  submit(event: Event): void {
    event.preventDefault();
    const el = this.box().nativeElement;
    const text = el.value.trim();
    if (!text) return;

    this.store.sendText(text);
    el.value = '';
    this.autoGrow();
    this.stopTyping();
    this.panel.set('none');
  }

  sendSticker(sticker: StickerMeta): void {
    this.store.sendSticker(sticker);
    this.panel.set('none');
  }

  sendGif(gif: GifMeta): void {
    this.store.sendGif(gif);
    this.panel.set('none');
  }

  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.uploading.set(true);
    this.notice.set('');
    const result = await this.uploads.upload(file);
    this.uploading.set(false);

    if (result.ok) this.store.sendImage(result.attachment.id);
    // A moderation rejection is shown to the sender and to nobody else.
    else this.notice.set(result.message);
  }

  private stopTyping(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    if (this.typingActive) {
      this.typingActive = false;
      this.store.setTyping(false);
    }
  }

  private autoGrow(): void {
    const el = this.box().nativeElement;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }
}
