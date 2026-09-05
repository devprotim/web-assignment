import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  MessageKind,
  PAGE_SIZE,
  type ConversationView,
  type GifMeta,
  type HistoryPage,
  type MessageView,
  type SendMessageInput,
  type StickerMeta,
} from '@chat/shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { SocketService } from './socket.service';

/** A message plus the local-only state the server has no opinion about. */
export interface LocalMessage extends MessageView {
  /** Rendered optimistically; not yet acknowledged by the server. */
  pending?: boolean;
  failed?: boolean;
  errorMessage?: string;
}

export type DeliveryState = 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

interface ConversationMessages {
  messages: LocalMessage[];
  /** Cursor for the next older page; null once the start is reached. */
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
}

const EMPTY: ConversationMessages = { messages: [], nextCursor: null, hasMore: true, loading: false };

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly http = inject(HttpClient);
  private readonly socket = inject(SocketService);
  private readonly auth = inject(AuthService);

  private readonly conversationList = signal<ConversationView[]>([]);
  private readonly byConversation = signal<Record<string, ConversationMessages>>({});
  private readonly active = signal<string | null>(null);
  private readonly typingBy = signal<Record<string, Record<string, number>>>({});
  /** Messages accepted by the UI but not yet by the server. Survives reconnects. */
  private readonly outbox = signal<SendMessageInput[]>([]);

  readonly conversations = this.conversationList.asReadonly();
  readonly activeId = this.active.asReadonly();
  readonly connection = this.socket.state;

  readonly activeConversation = computed(
    () => this.conversationList().find((c) => c.id === this.active()) ?? null,
  );

  readonly activeMessages = computed(() => {
    const id = this.active();
    return id ? (this.byConversation()[id] ?? EMPTY) : EMPTY;
  });

  readonly totalUnread = computed(() =>
    this.conversationList().reduce((sum, c) => sum + c.unreadCount, 0),
  );

  /** Names of the other people currently typing in the open conversation. */
  readonly activeTypers = computed(() => {
    const id = this.active();
    const me = this.auth.user()?.id;
    if (!id) return [];

    const now = Date.now();
    const entries = this.typingBy()[id] ?? {};
    const conversation = this.conversationList().find((c) => c.id === id);

    return Object.entries(entries)
      // A typing indicator that is never cancelled would stick forever, so they
      // expire locally rather than relying on a stop event arriving.
      .filter(([userId, at]) => userId !== me && now - at < 4000)
      .map(
        ([userId]) =>
          conversation?.members.find((m) => m.userId === userId)?.displayName ?? 'Someone',
      );
  });

  constructor() {
    this.socket.messages$.subscribe((message) => this.onIncoming(message));
    this.socket.typing$.subscribe(({ conversationId, userId, isTyping }) => {
      this.typingBy.update((state) => {
        const forConversation = { ...(state[conversationId] ?? {}) };
        if (isTyping) forConversation[userId] = Date.now();
        else delete forConversation[userId];
        return { ...state, [conversationId]: forConversation };
      });
    });

    this.socket.presence$.subscribe(({ userId, online, lastSeenAt }) => {
      this.conversationList.update((list) =>
        list.map((c) => ({
          ...c,
          members: c.members.map((m) => (m.userId === userId ? { ...m, online, lastSeenAt } : m)),
        })),
      );
    });

    this.socket.readReceipts$.subscribe(({ conversationId, userId, messageId }) =>
      this.advanceCursor(conversationId, userId, messageId, 'read'),
    );
    this.socket.deliveredReceipts$.subscribe(({ conversationId, userId, messageId }) =>
      this.advanceCursor(conversationId, userId, messageId, 'delivered'),
    );

    // A dropped socket means missed messages. Backfill rather than hoping none
    // were sent while we were away.
    this.socket.reconnected$.subscribe(() => void this.resync());

    // Re-expire typing indicators so a stale one disappears without new events.
    effect((onCleanup) => {
      const timer = setInterval(() => this.typingBy.update((s) => ({ ...s })), 1500);
      onCleanup(() => clearInterval(timer));
    });
  }

  async loadConversations(): Promise<void> {
    const list = await firstValueFrom(
      this.http.get<ConversationView[]>('/api/conversations'),
    );
    this.conversationList.set(list);
  }

  /** Returns to the conversation list (used by the mobile back button). */
  closeConversation(): void {
    this.active.set(null);
  }

  async openConversation(conversationId: string): Promise<void> {
    this.active.set(conversationId);
    this.socket.subscribeToConversation(conversationId);

    if (!this.byConversation()[conversationId]) {
      await this.loadHistory(conversationId);
    }
    this.markActiveRead();
  }

  /** Loads the newest page, or the next older one when `before` is supplied. */
  async loadHistory(conversationId: string, before?: string): Promise<void> {
    const current = this.byConversation()[conversationId] ?? EMPTY;
    if (current.loading) return;

    this.patch(conversationId, { loading: true });

    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) params.set('before', before);

    try {
      const page = await firstValueFrom(
        this.http.get<HistoryPage>(`/api/conversations/${conversationId}/messages?${params}`),
      );
      const existing = this.byConversation()[conversationId] ?? EMPTY;
      this.patch(conversationId, {
        messages: before ? [...page.messages, ...existing.messages] : page.messages,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        loading: false,
      });
    } catch {
      this.patch(conversationId, { loading: false });
    }
  }

  async loadOlder(): Promise<void> {
    const id = this.active();
    const state = this.activeMessages();
    if (!id || !state.hasMore || state.loading || !state.nextCursor) return;
    await this.loadHistory(id, state.nextCursor);
  }

  sendText(text: string): void {
    void this.send({ kind: MessageKind.TEXT, text });
  }

  sendGif(gif: GifMeta): void {
    void this.send({ kind: MessageKind.GIF, gif });
  }

  sendSticker(sticker: StickerMeta): void {
    void this.send({ kind: MessageKind.STICKER, sticker });
  }

  sendImage(attachmentId: string): void {
    void this.send({ kind: MessageKind.IMAGE, attachmentId });
  }

  /**
   * Optimistic send.
   *
   * The message appears immediately with a client-generated id, then the server's
   * ack replaces it. Because that id is the idempotency key, a retry after a
   * timeout or a reconnect cannot produce a duplicate: the server recognises the
   * key and returns the message it already stored.
   */
  private async send(content: SendMessageInput['content']): Promise<void> {
    const conversationId = this.active();
    const me = this.auth.user();
    if (!conversationId || !me) return;

    const clientMessageId = crypto.randomUUID();
    const input: SendMessageInput = { conversationId, clientMessageId, content };

    const optimistic: LocalMessage = {
      id: clientMessageId,
      conversationId,
      senderId: me.id,
      clientMessageId,
      kind: content.kind,
      status: 'VISIBLE',
      text: content.kind === MessageKind.TEXT ? content.text : null,
      gif: content.kind === MessageKind.GIF ? content.gif : null,
      sticker: content.kind === MessageKind.STICKER ? content.sticker : null,
      attachment: null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    this.appendLocal(conversationId, optimistic);
    this.socket.setTyping(conversationId, false);

    const ack = await this.socket.send(input);

    if (ack.ok) {
      this.replaceByClientId(conversationId, clientMessageId, ack.data);
      return;
    }

    // Offline or timed out: keep it queued and retry when the socket returns.
    // Anything else is a decision (moderation, rate limit) and must not be retried.
    if (ack.error.code === 'OFFLINE' || ack.error.code === 'TIMEOUT') {
      this.outbox.update((queue) => [...queue, input]);
      this.markFailed(conversationId, clientMessageId, 'Waiting for connection', true);
    } else {
      this.markFailed(conversationId, clientMessageId, ack.error.message, false);
    }
  }

  /** Reconnect recovery: flush anything queued, then backfill what we missed. */
  private async resync(): Promise<void> {
    const queued = this.outbox();
    this.outbox.set([]);
    for (const input of queued) {
      const ack = await this.socket.send(input);
      if (ack.ok) this.replaceByClientId(input.conversationId, input.clientMessageId, ack.data);
      else this.outbox.update((q) => [...q, input]);
    }

    await this.loadConversations().catch(() => undefined);

    // Fetch everything newer than the last message we hold, per open conversation.
    for (const [conversationId, state] of Object.entries(this.byConversation())) {
      const newest = [...state.messages].reverse().find((m) => !m.pending);
      if (!newest) continue;

      try {
        const page = await firstValueFrom(
          this.http.get<HistoryPage>(
            `/api/conversations/${conversationId}/messages?after=${newest.id}&limit=100`,
          ),
        );
        for (const message of page.messages) this.onIncoming(message);
      } catch {
        // Leave it; the next reconnect will try again.
      }
    }
  }

  private onIncoming(message: MessageView): void {
    const state = this.byConversation()[message.conversationId];

    // Our own message coming back over the socket: reconcile rather than append.
    if (state?.messages.some((m) => m.clientMessageId === message.clientMessageId)) {
      this.replaceByClientId(message.conversationId, message.clientMessageId, message);
    } else if (state) {
      this.appendLocal(message.conversationId, message);
    }

    this.bumpConversation(message);

    if (message.senderId !== this.auth.user()?.id) {
      this.socket.markDelivered(message.conversationId, message.id);
      if (message.conversationId === this.active() && document.hasFocus()) {
        this.socket.markRead(message.conversationId, message.id);
        this.clearUnread(message.conversationId);
      }
    }
  }

  markActiveRead(): void {
    const id = this.active();
    if (!id) return;
    const newest = this.activeMessages().messages.at(-1);
    if (!newest || newest.pending) return;

    this.socket.markRead(id, newest.id);
    this.clearUnread(id);
  }

  setTyping(isTyping: boolean): void {
    const id = this.active();
    if (id) this.socket.setTyping(id, isTyping);
  }

  /** How the sender's own message should be ticked in the UI. */
  deliveryState(message: LocalMessage): DeliveryState {
    if (message.failed) return 'failed';
    if (message.pending) return 'pending';

    const conversation = this.conversationList().find((c) => c.id === message.conversationId);
    const me = this.auth.user()?.id;
    const others = conversation?.members.filter((m) => m.userId !== me) ?? [];
    if (others.length === 0) return 'sent';

    if (others.every((m) => m.lastReadMessageId && m.lastReadMessageId >= message.id)) return 'read';
    if (others.every((m) => m.lastDeliveredMessageId && m.lastDeliveredMessageId >= message.id)) {
      return 'delivered';
    }
    return 'sent';
  }

  // ---------------------------------------------------------------- internals

  private patch(conversationId: string, partial: Partial<ConversationMessages>): void {
    this.byConversation.update((state) => ({
      ...state,
      [conversationId]: { ...(state[conversationId] ?? EMPTY), ...partial },
    }));
  }

  private appendLocal(conversationId: string, message: LocalMessage): void {
    this.byConversation.update((state) => {
      const current = state[conversationId] ?? EMPTY;
      if (current.messages.some((m) => m.id === message.id)) return state;
      return {
        ...state,
        [conversationId]: { ...current, messages: [...current.messages, message] },
      };
    });
  }

  private replaceByClientId(
    conversationId: string,
    clientMessageId: string,
    message: MessageView,
  ): void {
    this.byConversation.update((state) => {
      const current = state[conversationId];
      if (!current) return state;
      return {
        ...state,
        [conversationId]: {
          ...current,
          messages: current.messages.map((m) =>
            m.clientMessageId === clientMessageId ? { ...message } : m,
          ),
        },
      };
    });
  }

  private markFailed(
    conversationId: string,
    clientMessageId: string,
    errorMessage: string,
    stillPending: boolean,
  ): void {
    this.byConversation.update((state) => {
      const current = state[conversationId];
      if (!current) return state;
      return {
        ...state,
        [conversationId]: {
          ...current,
          messages: current.messages.map((m) =>
            m.clientMessageId === clientMessageId
              ? { ...m, pending: stillPending, failed: !stillPending, errorMessage }
              : m,
          ),
        },
      };
    });
  }

  private bumpConversation(message: MessageView): void {
    const isMine = message.senderId === this.auth.user()?.id;
    const isOpen = message.conversationId === this.active();

    this.conversationList.update((list) => {
      const next = list.map((c) =>
        c.id === message.conversationId
          ? {
              ...c,
              lastMessage: message,
              lastMessageAt: message.createdAt,
              unreadCount: isMine || isOpen ? c.unreadCount : c.unreadCount + 1,
            }
          : c,
      );
      return [...next].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    });
  }

  private clearUnread(conversationId: string): void {
    this.conversationList.update((list) =>
      list.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)),
    );
  }

  /** Cursors only move forward, matching the server's own guarantee. */
  private advanceCursor(
    conversationId: string,
    userId: string,
    messageId: string,
    kind: 'read' | 'delivered',
  ): void {
    this.conversationList.update((list) =>
      list.map((c) => {
        if (c.id !== conversationId) return c;
        return {
          ...c,
          members: c.members.map((m) => {
            if (m.userId !== userId) return m;
            if (kind === 'read') {
              if (m.lastReadMessageId && m.lastReadMessageId >= messageId) return m;
              return { ...m, lastReadMessageId: messageId, lastDeliveredMessageId: messageId };
            }
            if (m.lastDeliveredMessageId && m.lastDeliveredMessageId >= messageId) return m;
            return { ...m, lastDeliveredMessageId: messageId };
          }),
        };
      }),
    );
  }
}
