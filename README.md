# Real-Time Messaging System

A production-oriented 1:1 messaging module: real-time delivery, media handling,
server-side moderation, and the database design to back a conversation with
10,000+ messages in it.

**Stack:** Angular 22 (zoneless, signals) · NestJS 12 · PostgreSQL 17 + Prisma 7 ·
Socket.IO + Redis · Cloudflare R2 / S3 · TensorFlow.js

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Key technical decisions](#key-technical-decisions)
- [Data model and indexing](#data-model-and-indexing)
- [Real-time behaviour](#real-time-behaviour)
- [Reliability](#reliability)
- [Moderation](#moderation)
- [Security](#security)
- [Performance](#performance)
- [Testing](#testing)
- [Deployment](#deployment)
- [What is not built](#what-is-not-built)

---

## Quick start

Requires Node 22+ and Docker.

```bash
git clone <repo-url> && cd web-assignment
npm install

cp .env.example .env          # defaults work as-is for local development
npm run infra:up              # postgres + redis + minio, with the bucket created

npm run build -w @chat/shared # shared contracts, consumed by both apps
npm run migrate               # create the schema
npm run seed                  # two demo accounts + a 10,050-message conversation

npm run dev                   # API on :3000, web on :4200
```

Open <http://localhost:4200> and sign in. The seed creates two accounts, both with
password `demo-password-123`:

| Email | Name |
|---|---|
| `alice@demo.chat` | Alice Nguyen |
| `bob@demo.chat` | Bob Marsh |

To demo real-time behaviour, sign in as each account in two separate browser
profiles (or one normal window and one private window — two tabs of the same
profile share a cookie jar and would be the same account).

The GIF picker needs a free [Tenor API key](https://developers.google.com/tenor/guides/quickstart)
in `TENOR_API_KEY`. Without one, the picker reports that GIF search is
unconfigured and the rest of the app is unaffected.

---

## Architecture

```
                    ┌──────────────────────────────────────┐
   browser  ────────┤  Angular 22 (zoneless, signals)      │
      │             │  ChatStore · SocketService           │
      │             └──────────────────────────────────────┘
      │  HTTP + WebSocket, one origin
      ▼
┌─────────────────────────────────────────────────────────────┐
│ NestJS                                                      │
│                                                             │
│  AuthGuard (global)  ──►  ConversationAccessService          │
│                              │                              │
│  REST controllers ───────────┼──► MessagesService ◄──── ChatGateway
│                              │        │                (Socket.IO)
│                              │        ├─ ProfanityService       │
│                              │        └─ attachment approval    │
│  AttachmentsService ─► NsfwService ─► worker_threads × 2        │
│         │                                                       │
└─────────┼───────────────────────────────────────────────────────┘
          │              │                    │
      S3 / R2        PostgreSQL            Redis
   (presigned)       (Prisma)     (pub/sub · presence · rate limits)
```

Three workspaces:

| Package | Contents |
|---|---|
| `packages/shared` | Zod schemas, socket event contracts, enums, sticker manifest |
| `apps/api` | NestJS server |
| `apps/web` | Angular client |

`packages/shared` is the reason both ends being TypeScript pays off. Every DTO,
socket event name and payload type has exactly one definition, imported by both
sides. A server change the client does not handle is a compile error rather than
a runtime surprise.

---

## Key technical decisions

### Single origin in production

The API serves the built Angular bundle. This is a security simplification, not a
packaging shortcut: same-origin means the session cookie can be `httpOnly` +
`SameSite=Lax` with no cross-origin credential surface, and the WebSocket
handshake carries it with no configuration. In development the Angular dev server
proxies `/api` and `/socket.io` to the API, so the same single-origin behaviour
holds while developing.

### UUIDv7 primary keys

Every id is a UUIDv7: the leading 48 bits are a millisecond timestamp, so lexical
order is chronological order. Postgres compares `uuid` by bytes, which means
`ORDER BY id` *is* `ORDER BY time`.

The payoff is that history paginates on a **single indexed column**. No composite
`(createdAt, id)` cursor, no tie-breaking, and read cursors compare with a plain
string comparison instead of a timestamp lookup.

### Read state as a cursor, not receipt rows

`ConversationMember` stores `lastReadMessageId` and `lastDeliveredMessageId`. The
alternative, one receipt row per message per member, would mean 20,000 extra rows
for a 10,000-message 1:1 conversation, purely to answer "what is unread".

A cursor answers it with one indexed `COUNT`. Both cursors advance
**monotonically only** — a late or out-of-order event can never walk a
conversation back to unread.

### A hand-rolled rate limiter

`@nestjs/throttler` has no Nest 12 release, and its own documentation notes it
cannot be bound globally for WebSocket handlers. Since message sends happen over
a socket and uploads over HTTP, one shared Redis limiter that both transports call
is simpler than two mechanisms. It also means REST and WebSocket sends share a
bucket, so a client cannot double its allowance by alternating transports.

Implemented as a fixed-window counter in a Lua script, so `INCR` and `EXPIRE` are
atomic and the counter is shared across instances.

### Not a public media bucket

Media URLs point at the API, not at object storage. `GET /api/attachments/:id/content`
checks that the requester owns the attachment or belongs to the conversation it
was sent in, then redirects to a signed URL that expires in five minutes.

A public bucket would mean anyone holding (or guessing) an object URL could read a
private conversation's images. The bucket is never public.

---

## Data model and indexing

```
User ──< ConversationMember >── Conversation ──< Message >── Attachment
                                                    │
                                             ModerationEvent
```

Every index exists for a specific query:

| Index | Query it serves |
|---|---|
| `messages (conversationId, id DESC)` | History pagination **and** unread counts |
| `messages (senderId, clientMessageId)` UNIQUE | Idempotency (see [Reliability](#reliability)) |
| `conversation_members (userId)` | The signed-in user's conversation list |
| `conversations (lastMessageAt DESC)` | Conversation list ordering |
| `conversations (directKey)` UNIQUE | One 1:1 conversation per pair, even under a race |

`directKey` is the sorted pair of user ids. Two people tapping "message" at the
same moment cannot create two parallel conversations, because the unique
constraint makes the upsert idempotent.

Unread counts for the whole conversation list are **one query**, not one per
conversation. The join against each member's own cursor cannot be expressed with
Prisma's `groupBy`, so it is raw SQL — see `unreadCounts` in
`apps/api/src/conversations/conversations.service.ts`.

---

## Real-time behaviour

Socket.IO with the Redis adapter, so a broadcast reaches sockets on every
instance rather than only the one that handled the request.

**Authentication happens once, at the handshake.** Gateway middleware verifies the
session cookie and attaches the principal to `socket.data`; an unauthenticated
socket is rejected before any handler can run. Rooms are joined only after a
membership query, never from a client-supplied id.

Two room types:

- `conv:<id>` — everyone viewing a conversation
- `user:<id>` — every socket one account has open, which is what keeps multiple
  tabs consistent and reaches someone who has the app open on another conversation

**Presence** is tracked per socket in a Redis sorted set scored by last heartbeat.
Per socket, so closing one of three tabs does not flip you offline. Scored by
heartbeat, so entries left behind by a process that died without running its
disconnect handlers are pruned on the next read instead of marking someone online
forever. Every operation prunes first, which makes it self-healing with no sweeper
to run or monitor.

**Typing** is ephemeral and never persisted. The client emits one `typing:start`
and a trailing stop rather than one event per keystroke, and the receiver expires
the indicator locally after 4s so a lost stop event cannot leave it stuck on.

---

## Reliability

The requirement is that a disconnect must not silently lose accepted messages, and
that a retry must not duplicate one. Both are structural rather than best-effort.

**Idempotency.** The client generates a `clientMessageId` (UUIDv7) and renders the
message optimistically. That id is the idempotency key: `UNIQUE (senderId,
clientMessageId)`. On a collision the server returns the message it already
stored instead of erroring, and does **not** re-broadcast it — so a reconnect
replay cannot duplicate the message in anyone else's list.

**Reconnect.** On reconnect the client flushes its outbox and then backfills with
`GET /conversations/:id/messages?after=<lastKnownId>` for each open conversation.
Without that backfill, a brief network blip silently leaves holes in the thread.

**Retry discipline.** Only `OFFLINE` and `TIMEOUT` are queued for retry. A
moderation block or a rate limit is a *decision*, and retrying it would be wrong.

**Multiple tabs.** Every socket for an account shares the `user:<id>` room, so a
send, a read, or a presence change in one tab is reflected in the others.

---

## Moderation

Both paths are enforced inside `MessagesService.create`, which is the **only**
write path. The REST route and the WebSocket handler both call it, so moderation
cannot be skipped by choosing a different transport.

### Profanity

Server-side, using [`obscenity`](https://github.com/jo3-l/obscenity) with a
normalising transformer pipeline:

| Bypass | Handled by |
|---|---|
| `FuCk` | lowercase transformer |
| `fuuuuck` | collapse-duplicates transformer |
| `sh1t`, `$hit`, `c0ck` | leetspeak transformer |
| `fµck` | confusables transformer |
| `f*u*c*k`, `f u c k`, `f.u.c.k` | `collapseSpacedLetters` (see below) |

The recommended transformer set deliberately omits separator stripping, because
globally deleting punctuation merges innocent adjacent words into false matches.
That left the spaced-out forms through, which the requirements call out
explicitly. `collapseSpacedLetters` handles that case narrowly: it joins only runs
of *single* letters, which is the spaced-out-word pattern and never merges
ordinary multi-letter words. Both the raw and collapsed forms are matched.

**The whitelist matters as much as the blacklist.** A filter that blocks
"Scunthorpe", "classic" and "assessment" is worse than no filter. 27 unit tests
cover both directions — see `profanity.service.spec.ts`.

A blocked message is never persisted as visible. The matched term is written to
`moderation_events` for audit but **never returned to the client**: echoing it
would turn the endpoint into an oracle for probing the wordlist.

### Image nudity detection

| Question | Answer |
|---|---|
| **Model** | NSFWJS `MobileNetV2` (TensorFlow.js graph model) |
| **Where inference runs** | In-process, in the Node API container, on CPU. No third-party service, no per-image cost. |
| **Model size** | **3.4 MB** on disk. Ships inside the `nsfwjs` package, so a deployed container has no external dependency at startup. |
| **Cold load** | ~4.6s, paid once at boot and warmed with a throwaway inference, so no user pays it |
| **Inference latency** | ~99ms warm, per image |
| **End-to-end** | **p50 288ms, p95 295ms** (measured, 12 runs, 129KB 1600×1200 JPEG) — covers storage read, magic-byte detection, resize, inference, re-encode, thumbnail, and two storage writes |
| **Classes** | `neutral`, `drawing`, `sexy`, `hentai`, `porn` |

**Decision rule** (thresholds configurable via env):

```
reject if  porn   >= 0.60
       or  hentai >= 0.60
       or  sexy   >= 0.85
       or  (porn + hentai + sexy) >= 0.75
```

Individual thresholds catch a confident single-class prediction. The combined rule
catches what they miss: an image scoring 0.4 porn and 0.4 sexy is clearly not
safe but trips neither threshold alone. `sexy` sits higher than the others because
it fires on swimwear and ordinary photographs of people, so a low threshold there
produces false positives on innocuous images.

Reproduce the latency numbers with `node apps/api/test/nsfw-bench.mjs` against a
running server.

### Why it cannot be bypassed

The upload flow is three steps, and the order is the point:

1. `POST /attachments/presign` — creates a `PENDING` attachment, returns a
   presigned PUT bound to the declared content type and length
2. The browser PUTs bytes **directly to object storage**, never through the API
3. `POST /attachments/:id/moderate` — the server reads the object and decides

A message referencing an attachment is rejected unless that attachment is
`APPROVED` **and** owned by the sender. A client that skips step 3 ends up with an
attachment stuck in `PENDING` that no message can reference. Calling the message
API directly does not help.

Server-side validation in step 3, in order:

- `HEAD` the object for its **actual** size — the declared size is not evidence
- Detect the true type from **magic bytes** (`file-type`), and reject if it
  disagrees with the declared type. A `.png` that is actually an executable is
  rejected here.
- Reject absurd dimensions (decompression bombs)
- Classify
- On approval, **re-encode from decoded pixels** with `sharp`. That strips EXIF
  (which carries GPS and device data) and discards anything appended to the
  container, so a polyglot file cannot survive into storage. The original is
  deleted.
- On rejection, delete the object, mark `REJECTED`, and return a clear message
  **to the sender only**. The recipient never learns the upload happened.

Inference runs on a pool of two `worker_threads`. tfjs-node inference is
synchronous CPU work; 99ms on the main thread would block every open WebSocket on
the instance, so a handful of concurrent uploads would visibly stall chat for
everyone.

---

## Security

| Requirement | How |
|---|---|
| Cannot read conversations you are not in | `ConversationAccessService.assertMember` on every conversation-scoped route and socket event. Returns 403 for both "not a member" and "does not exist", so conversation ids cannot be enumerated. |
| Cannot send as another account | `senderId` is always taken from the verified token. No handler reads an actor id from a request body. |
| File type and size validated | Magic bytes, not filename or declared mime. Size checked against the stored object, not the client's claim. 8MB cap. |
| Server-side authn/authz | `AuthGuard` bound globally — a route is protected unless it explicitly opts out with `@Public()`. Forgetting a guard cannot expose an endpoint. |
| Rate limiting | Per-bucket Redis limiter with `Retry-After` and `X-RateLimit-*` headers |

Other measures: argon2id password hashing (OWASP parameters); refresh tokens
stored as SHA-256 and rotated on every use; a constant-time decoy verification on
unknown emails so login timing does not reveal whether an account exists; helmet;
`httpOnly` + `SameSite=Lax` cookies; zod validation that strips unknown keys, so a
client cannot smuggle extra fields into a write.

Rate limit buckets:

| Bucket | Limit |
|---|---|
| Auth | 10 / min / IP |
| Message send (REST **and** socket) | 20 / 10s / user |
| Upload presign | 10 / min / user |
| Moderation | 15 / min / user |
| GIF search | 30 / min / user |

---

## Performance

**History pagination is O(page), not O(offset).** Measured against the seeded
10,050-message conversation (14,850 rows across 13 conversations):

| Query | Plan | Buffers | Time |
|---|---|---|---|
| Newest page (51 rows) | Index Scan on `messages_conversationId_id_idx` | 4 | 0.032ms |
| Deep page, cursor 200 messages back | Index Scan on `messages_conversationId_id_idx` | 4 | 0.053ms |

Same cost regardless of depth, which is the whole point of keyset pagination.

> The seed deliberately creates 12 background conversations interleaved into the
> same table. With a single conversation, Postgres can answer a history query by
> walking the primary key backwards because every row it meets happens to match,
> which would make the index claim above untestable.

**Client.** Angular 22 zoneless with signals — no Zone.js patching, and a message
list driven by signal state rather than by change-detection sweeps. Message
bubbles are `OnPush` with signal inputs, so a new message re-renders one row
rather than the list. Both pickers are `@defer`-loaded, keeping the initial
transfer at **72.8 kB**.

**Media.** `loading="lazy"` and `decoding="async"`, with a fixed aspect-ratio box
computed from stored dimensions so images and GIFs cause no layout shift. The GIF
picker grid requests Tenor's `tinygif` previews, not full-size GIFs.

**Scroll.** Loading older messages prepends to the list, which would grow the
container upward and jump the reader's position. The list captures scroll height
before the load and restores the offset after, so the message being read stays
exactly where it was.

---

## Testing

```bash
npm test                 # unit: profanity bypasses + NSFW decision rule (36 tests)
npm run test:e2e         # e2e: realtime + media, against a running server
```

The e2e suites need `npm run infra:up`, `npm run seed`, and a running API.

**Unit (36).** Profanity bypass resistance and false-positive avoidance;
the NSFW decision rule, verified against score vectors rather than images.

**`test/realtime.e2e.mjs` (15 checks).** Two real socket clients: handshake
rejection of an invalid token, live delivery, idempotent replay not
re-broadcasting, typing relay, second-tab consistency, presence across multiple
tabs, read receipts, the monotonic cursor refusing to move backwards, and
authorization plus moderation over the socket.

**`test/media.e2e.mjs` (17 checks).** The upload pipeline: direct-to-storage PUT,
sending an unmoderated attachment (refused), EXIF stripping, magic-byte
validation, moderating someone else's attachment (refused), and a non-member
reading media (refused).

Everything was also verified by hand in a browser: two accounts, live delivery,
typing indicators, unread badges, upward pagination through the 10k seed, and
responsive layout with no horizontal overflow at 320, 390 and 1280px.

---

## Deployment

One container serving both the API and the Angular bundle.

```bash
docker build -t chat .
docker run -p 3000:3000 --env-file .env chat
```

The image runs `prisma migrate deploy` at boot, so a deploy needs no separate
release step. It is Debian-based rather than Alpine because tfjs-node ships a
prebuilt glibc native binding.

The API **must** be a long-running container: WebSockets stay open and the model
lives in memory, so serverless is not an option for it.

Managed services it expects: PostgreSQL, Redis, and any S3-compatible object
store. `docker-compose.yml` runs local equivalents (Postgres, Redis, MinIO); only
connection strings differ in production.

---

## What is not built

Called out so the boundaries are explicit rather than discovered:

- **Group conversations.** Scoped out. The schema is already member-based rather
  than two-participant, so groups are a UI addition with no migration.
- **Message edit, delete and reactions.** `deletedAt` exists in the schema and is
  respected by queries, but nothing exposes it.
- **Push notifications**, and read receipts for a conversation open in a
  background tab (marked read on focus instead).
- **Automated browser tests.** The e2e suites drive real sockets and the real
  upload pipeline, but the UI itself was verified manually.
- **Horizontal scale beyond correctness.** The Redis adapter and Redis-backed
  presence and rate limiting mean multiple instances are correct, but this has not
  been load-tested.
