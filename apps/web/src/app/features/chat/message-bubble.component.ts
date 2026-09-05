import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { resolveSticker } from '@chat/shared';
import { ChatStore, type LocalMessage } from '../../core/chat.store';

@Component({
  selector: 'app-message-bubble',
  // OnPush plus signal inputs: a message re-renders only when its own data
  // changes, not on every store update. With long histories that is the
  // difference between a smooth list and one that stutters on each new message.
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row" [class.mine]="mine()">
      <div class="bubble" [class.mine]="mine()" [class.media]="isMedia()" [class.failed]="message().failed">
        @switch (message().kind) {
          @case ('TEXT') {
            <p class="text">{{ message().text }}</p>
          }
          @case ('GIF') {
            @if (message().gif; as gif) {
              <img
                class="gif"
                [src]="gif.url"
                [width]="gif.width"
                [height]="gif.height"
                [style.aspect-ratio]="gif.width + ' / ' + gif.height"
                loading="lazy"
                decoding="async"
                alt="GIF"
              />
            }
          }
          @case ('STICKER') {
            @if (stickerUrl(); as url) {
              <img class="sticker" [src]="url" width="112" height="112" loading="lazy" decoding="async" [alt]="stickerLabel()" />
            }
          }
          @case ('IMAGE') {
            @if (message().attachment; as attachment) {
              <img
                class="photo"
                [src]="attachment.thumbnailUrl ?? attachment.url"
                [style.aspect-ratio]="aspectRatio()"
                loading="lazy"
                decoding="async"
                alt="Shared image"
              />
            } @else {
              <p class="text muted">Image unavailable</p>
            }
          }
        }

        <footer>
          <time [attr.datetime]="message().createdAt">{{ time() }}</time>
          @if (mine()) {
            <span class="state" [attr.data-state]="state()" [attr.aria-label]="stateLabel()">
              @switch (state()) {
                @case ('pending') { <span class="tick">○</span> }
                @case ('failed') { <span class="tick">!</span> }
                @case ('sent') { <span class="tick">✓</span> }
                @case ('delivered') { <span class="tick">✓✓</span> }
                @case ('read') { <span class="tick read">✓✓</span> }
              }
            </span>
          }
        </footer>
      </div>

      @if (message().failed && message().errorMessage) {
        <p class="error" role="alert">{{ message().errorMessage }}</p>
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .row { display: flex; flex-direction: column; align-items: flex-start; padding: 2px 16px; max-width: 100%; min-width: 0; }
    .row.mine { align-items: flex-end; }
    .bubble {
      max-width: min(560px, 78%);
      min-width: 0;
      padding: 8px 12px 6px;
      border-radius: var(--radius-lg);
      background: var(--bubble-in);
      border-bottom-left-radius: 5px;
    }
    .bubble.mine {
      background: var(--bubble-out);
      color: var(--bubble-out-text);
      border-bottom-left-radius: var(--radius-lg);
      border-bottom-right-radius: 5px;
    }
    .bubble.media { padding: 4px 4px 2px; background: transparent; }
    .bubble.media.mine { background: transparent; }
    .bubble.failed { opacity: 0.65; }
    .text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; font-size: 15px; }
    .muted { color: var(--text-muted); font-style: italic; }
    .gif, .photo {
      display: block;
      max-width: 320px;
      width: 100%;
      height: auto;
      border-radius: var(--radius);
      background: var(--surface-sunken);
    }
    .sticker { display: block; }
    footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      margin-top: 2px;
      font-size: 11px;
      opacity: 0.75;
    }
    .bubble.media footer { padding-right: 6px; }
    .tick { letter-spacing: -2px; }
    .tick.read { color: #9fe8ff; }
    .bubble:not(.mine) .tick.read { color: var(--accent); }
    .error { margin: 3px 16px 0; font-size: 12px; color: var(--danger); }
  `,
})
export class MessageBubbleComponent {
  private readonly store = inject(ChatStore);

  readonly message = input.required<LocalMessage>();
  readonly mine = input.required<boolean>();

  readonly state = computed(() => this.store.deliveryState(this.message()));

  readonly stateLabel = computed(
    () =>
      ({
        pending: 'Sending',
        failed: 'Not sent',
        sent: 'Sent',
        delivered: 'Delivered',
        read: 'Read',
      })[this.state()],
  );

  readonly time = computed(() =>
    new Date(this.message().createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
  );

  private readonly sticker = computed(() => {
    const meta = this.message().sticker;
    return meta ? resolveSticker(meta.packId, meta.stickerId) : null;
  });

  readonly stickerUrl = computed(() => this.sticker()?.url ?? null);
  readonly stickerLabel = computed(() => this.sticker()?.label ?? 'Sticker');

  readonly isMedia = computed(() => this.message().kind !== 'TEXT');

  /** Reserves the right box before the image loads, so nothing shifts. */
  readonly aspectRatio = computed(() => {
    const attachment = this.message().attachment;
    return attachment?.width && attachment?.height
      ? `${attachment.width} / ${attachment.height}`
      : '4 / 3';
  });
}
