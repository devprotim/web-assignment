import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import type { ConversationView, PublicUser } from '@chat/shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { ChatStore } from '../../core/chat.store';
import { SocketService } from '../../core/socket.service';
import { ComposerComponent } from './composer.component';
import { MessageListComponent } from './message-list.component';

@Component({
  selector: 'app-chat',
  imports: [ComposerComponent, MessageListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="layout" [class.thread-open]="store.activeId() !== null">
      <aside class="sidebar">
        <header class="sidebar-head">
          <div class="me">
            <span class="avatar">{{ initials(auth.user()?.displayName) }}</span>
            <div>
              <strong>{{ auth.user()?.displayName }}</strong>
              <span class="status" [attr.data-state]="socket.state()">{{ connectionLabel() }}</span>
            </div>
          </div>
          <button class="ghost" type="button" (click)="auth.logout()">Sign out</button>
        </header>

        <div class="new-chat">
          <button class="ghost wide" type="button" (click)="toggleDirectory()">
            {{ showDirectory() ? 'Close' : 'New conversation' }}
          </button>
          @if (showDirectory()) {
            <ul class="directory">
              @for (person of directory(); track person.id) {
                <li>
                  <button type="button" (click)="startWith(person.id)">
                    <span class="avatar small">{{ initials(person.displayName) }}</span>
                    <span>{{ person.displayName }}</span>
                    @if (person.online) { <span class="dot online"></span> }
                  </button>
                </li>
              } @empty {
                <li class="empty">No one else has registered yet.</li>
              }
            </ul>
          }
        </div>

        <ul class="conversations">
          @for (conversation of store.conversations(); track conversation.id) {
            <li>
              <button
                type="button"
                [class.active]="conversation.id === store.activeId()"
                (click)="open(conversation.id)"
              >
                <span class="avatar">
                  {{ initials(other(conversation)?.displayName) }}
                  @if (other(conversation)?.online) { <span class="dot online"></span> }
                </span>
                <span class="detail">
                  <span class="row">
                    <strong>{{ other(conversation)?.displayName ?? 'Conversation' }}</strong>
                    @if (conversation.unreadCount > 0) {
                      <span class="badge">{{ conversation.unreadCount > 99 ? '99+' : conversation.unreadCount }}</span>
                    }
                  </span>
                  <span class="preview">{{ preview(conversation) }}</span>
                </span>
              </button>
            </li>
          } @empty {
            <li class="empty">No conversations yet.</li>
          }
        </ul>
      </aside>

      <section class="thread">
        @if (store.activeConversation(); as conversation) {
          <header class="thread-head">
            <button class="back ghost" type="button" (click)="close()" aria-label="Back">←</button>
            <span class="avatar">{{ initials(other(conversation)?.displayName) }}</span>
            <div>
              <strong>{{ other(conversation)?.displayName }}</strong>
              <span class="presence">
                @if (store.activeTypers().length > 0) {
                  <em>typing…</em>
                } @else if (other(conversation)?.online) {
                  Online
                } @else {
                  Last seen {{ lastSeen(other(conversation)?.lastSeenAt) }}
                }
              </span>
            </div>
          </header>

          @if (socket.state() !== 'connected') {
            <p class="offline" role="status">
              {{ socket.state() === 'connecting' ? 'Connecting…' : 'Offline. Messages will send when you reconnect.' }}
            </p>
          }

          <app-message-list />
          <app-composer />
        } @else {
          <div class="placeholder">
            <p>Select a conversation to start messaging.</p>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    :host { display: block; height: 100dvh; }
    .layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      height: 100%;
      overflow: hidden;
      background: var(--surface);
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--border);
      background: var(--surface);
    }
    .sidebar-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 14px 16px; border-bottom: 1px solid var(--border);
    }
    .me { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .me div { display: grid; min-width: 0; }
    .me strong { font-size: 14px; }
    .status { font-size: 11px; color: var(--text-muted); }
    .status[data-state='connected'] { color: var(--success); }
    .status[data-state='disconnected'] { color: var(--danger); }

    .avatar {
      position: relative;
      flex: none;
      width: 38px; height: 38px;
      display: grid; place-items: center;
      border-radius: 50%;
      background: var(--accent-soft); color: var(--accent);
      font-size: 13px; font-weight: 600;
    }
    .avatar.small { width: 28px; height: 28px; font-size: 11px; }
    .dot {
      position: absolute; right: -1px; bottom: -1px;
      width: 10px; height: 10px; border-radius: 50%;
      border: 2px solid var(--surface);
    }
    .dot.online { background: var(--success); }

    .ghost {
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: transparent; color: var(--text-muted);
      font-size: 12px;
    }
    .ghost:hover { background: var(--surface-sunken); color: var(--text); }
    .ghost.wide { width: 100%; }

    .new-chat { padding: 12px 16px; border-bottom: 1px solid var(--border); }
    .directory { list-style: none; margin: 10px 0 0; padding: 0; max-height: 200px; overflow-y: auto; }
    .directory button {
      display: flex; align-items: center; gap: 8px;
      width: 100%; padding: 6px; border: none; border-radius: var(--radius-sm);
      background: none; color: inherit; font-size: 13px; text-align: left;
    }
    .directory button:hover { background: var(--surface-sunken); }

    .conversations { flex: 1; list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
    .conversations > li + li { margin-top: 2px; }
    .conversations button {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 9px 10px;
      border: none; border-radius: var(--radius);
      background: none; color: inherit; text-align: left;
      transition: background 120ms ease;
    }
    .conversations button:hover { background: var(--surface-sunken); }
    .conversations button.active { background: var(--accent-soft); }
    .detail { display: grid; gap: 2px; min-width: 0; flex: 1; }
    .detail .row { display: flex; align-items: center; gap: 8px; }
    .detail strong { font-size: 14px; flex: 1; }
    .preview {
      font-size: 12px; color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .badge {
      flex: none; min-width: 20px; padding: 1px 6px;
      border-radius: 999px; background: var(--accent); color: var(--accent-text);
      font-size: 11px; font-weight: 600; text-align: center;
    }
    .empty { padding: 16px; color: var(--text-faint); font-size: 13px; }

    .thread { display: grid; grid-template-rows: auto auto 1fr auto; min-height: 0; min-width: 0; overflow: hidden; }
    /* Explicit rows so the grid stays stable when the offline banner (row 2)
       is removed from the DOM by @if rather than merely hidden. */
    .thread-head { grid-row: 1; }
    .offline { grid-row: 2; }
    app-message-list { grid-row: 3; min-height: 0; }
    app-composer { grid-row: 4; }
    .thread-head {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px; border-bottom: 1px solid var(--border);
    }
    .thread-head div { display: grid; }
    .thread-head strong { font-size: 15px; }
    .presence { font-size: 12px; color: var(--text-muted); min-height: 16px; }
    .presence em { color: var(--accent); font-style: normal; }
    .back { display: none; }
    .offline {
      margin: 0; padding: 7px 16px;
      background: var(--danger-soft); color: var(--danger);
      font-size: 12px; text-align: center;
    }
    .placeholder { grid-row: 1 / -1; display: grid; place-items: center; color: var(--text-faint); }

    /* Below 820px the two panes become one: the list, or the open thread. */
    @media (max-width: 820px) {
      .layout { grid-template-columns: 1fr; }
      .thread { display: none; }
      .layout.thread-open .sidebar { display: none; }
      .layout.thread-open .thread { display: grid; }
      .back { display: grid; place-items: center; width: 32px; height: 32px; }
    }
  `,
})
export class ChatPage {
  readonly auth = inject(AuthService);
  readonly store = inject(ChatStore);
  readonly socket = inject(SocketService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  /** Bound to the ?c=<id> query param via withComponentInputBinding(). */
  readonly c = input<string | undefined>(undefined);

  readonly showDirectory = signal(false);
  readonly directory = signal<PublicUser[]>([]);

  readonly connectionLabel = computed(
    () =>
      ({ connected: 'Connected', connecting: 'Connecting…', disconnected: 'Offline' })[
        this.socket.state()
      ],
  );

  constructor() {
    this.socket.connect();
    void this.store.loadConversations();

    // Coming back to the tab marks what is on screen as read, which is what a
    // user expects after glancing at a notification and returning.
    window.addEventListener('focus', () => this.store.markActiveRead());

    // The ?c= query param is the source of truth for which conversation is
    // open, so a reload or a shared /chat?c=<id> link reopens the same one
    // instead of landing on the bare list.
    effect(() => {
      const id = this.c();
      if (id && id !== this.store.activeId()) void this.store.openConversation(id);
    });
  }

  other(conversation: ConversationView) {
    const me = this.auth.user()?.id;
    return conversation.members.find((m) => m.userId !== me) ?? conversation.members[0];
  }

  preview(conversation: ConversationView): string {
    const message = conversation.lastMessage;
    if (!message) return 'No messages yet';
    return (
      { TEXT: message.text ?? '', GIF: 'GIF', STICKER: 'Sticker', IMAGE: 'Photo' }[message.kind] ??
      ''
    );
  }

  initials(name?: string | null): string {
    if (!name) return '?';
    return name
      .split(' ')
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  }

  lastSeen(iso?: string | null): string {
    if (!iso) return 'a while ago';
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(iso).toLocaleDateString();
  }

  open(conversationId: string): void {
    void this.router.navigate(['/chat'], { queryParams: { c: conversationId } });
  }

  close(): void {
    this.store.closeConversation();
    void this.router.navigate(['/chat'], { queryParams: { c: null } });
  }

  async toggleDirectory(): Promise<void> {
    const next = !this.showDirectory();
    this.showDirectory.set(next);
    if (next) {
      this.directory.set(
        await firstValueFrom(this.http.get<PublicUser[]>('/api/users')).catch(() => []),
      );
    }
  }

  async startWith(userId: string): Promise<void> {
    const conversation = await firstValueFrom(
      this.http.post<ConversationView>('/api/conversations/direct', { userId }),
    );
    await this.store.loadConversations();
    this.showDirectory.set(false);
    void this.router.navigate(['/chat'], { queryParams: { c: conversation.id } });
  }
}
