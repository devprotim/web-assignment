import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { ChatStore } from '../../core/chat.store';
import { AuthService } from '../../core/auth.service';
import { MessageBubbleComponent } from './message-bubble.component';

@Component({
  selector: 'app-message-list',
  imports: [MessageBubbleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #viewport class="viewport" (scroll)="onScroll()">
      @if (state().loading && state().messages.length === 0) {
        <p class="notice">Loading conversation...</p>
      }
      @if (state().hasMore && state().messages.length > 0) {
        <p class="notice">
          {{ state().loading ? 'Loading earlier messages...' : 'Scroll up for earlier messages' }}
        </p>
      } @else if (state().messages.length > 0) {
        <p class="notice">This is the beginning of the conversation.</p>
      }

      @for (message of state().messages; track message.clientMessageId) {
        <app-message-bubble [message]="message" [mine]="message.senderId === myId()" />
      }

      <div #anchor class="anchor"></div>
    </div>
  `,
  styles: `
    /* min-width: 0 defeats the default "min-width: auto" on grid and flex
       items, which otherwise lets a wide message push the whole column past
       the viewport and scroll the page sideways. */
    :host { display: block; min-height: 0; min-width: 0; }
    .viewport {
      height: 100%;
      min-width: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 12px 0 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .notice {
      margin: 8px auto 14px;
      padding: 4px 12px;
      border-radius: 999px;
      background: var(--surface-sunken);
      color: var(--text-muted);
      font-size: 12px;
    }
    .anchor { height: 1px; flex: none; }
  `,
})
export class MessageListComponent {
  private readonly store = inject(ChatStore);
  private readonly auth = inject(AuthService);

  private readonly viewport = viewChild.required<ElementRef<HTMLDivElement>>('viewport');

  readonly state = this.store.activeMessages;
  readonly myId = computed(() => this.auth.user()?.id ?? '');

  /** Distance from the bottom below which we treat the user as "following". */
  private static readonly FOLLOW_THRESHOLD = 120;

  private pinnedToBottom = true;
  private lastConversationId: string | null = null;

  constructor() {
    effect(() => {
      const conversationId = this.store.activeId();
      const messages = this.state().messages;

      // Switching conversations should land at the newest message.
      const switched = conversationId !== this.lastConversationId;
      this.lastConversationId = conversationId;

      // Two frames, not a microtask: the first lets Angular render the new
      // rows, the second lets the browser lay them out. Scrolling before layout
      // reads a stale scrollHeight and lands at the top of the list.
      this.afterLayout(() => {
        if (switched) {
          this.scrollToBottom('instant');
          this.pinnedToBottom = true;
        } else if (this.pinnedToBottom && messages.length > 0) {
          // Only auto-scroll for a user already at the bottom. Yanking someone
          // out of history they are reading is the classic chat annoyance.
          this.scrollToBottom('smooth');
        }
      });
    });

    afterNextRender(() => this.scrollToBottom('instant'));
  }

  private afterLayout(action: () => void): void {
    requestAnimationFrame(() => requestAnimationFrame(action));
  }

  onScroll(): void {
    const el = this.viewport().nativeElement;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.pinnedToBottom = distanceFromBottom < MessageListComponent.FOLLOW_THRESHOLD;

    if (this.pinnedToBottom) this.store.markActiveRead();

    // Near the top: pull the next older page and hold the viewport still.
    if (el.scrollTop < 200) void this.loadOlderPreservingPosition();
  }

  /**
   * Prepending older messages grows the scroll container upward, which would jump
   * the reader's position. Capturing the height before the load and restoring the
   * offset after keeps the message they were looking at exactly where it was.
   */
  private async loadOlderPreservingPosition(): Promise<void> {
    const el = this.viewport().nativeElement;
    const before = el.scrollHeight;
    const previousTop = el.scrollTop;

    await this.store.loadOlder();

    this.afterLayout(() => {
      const grew = el.scrollHeight - before;
      if (grew > 0) el.scrollTop = previousTop + grew;
    });
  }

  private scrollToBottom(behavior: ScrollBehavior): void {
    const el = this.viewport().nativeElement;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }
}
